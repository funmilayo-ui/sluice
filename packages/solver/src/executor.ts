import type { Leg } from "@sluice/core";
import type { HedgeQuote } from "./evaluate.js";
import type { QuotedHedge } from "./hedge.js";
import {
  decideHedgeRetry, ExposureLedger, markValue, resolveRecoveryConfig,
  type AbandonReason, type CanFill, type Exposure, type FillRecord, type RecoveryConfig,
} from "./recovery.js";

/**
 * The hedge executor: runs the policy in `recovery.ts` against an injected `HedgeIo`. All I/O is behind that
 * interface (`stellarIo.ts` is the real one), so every branch is unit-tested with a scripted fake.
 */

/** What a hedge submission came back as. See the three failure kinds in `recovery.ts`. */
export type SubmitResult =
  | { status: "success"; hash: string; /** token_out received; null when the adapter could not read it. */ proceedsOut: bigint | null }
  | { status: "rejected"; error: string }
  | { status: "failed"; hash: string; error: string }
  | { status: "unknown"; hash: string; error: string; /** When the transaction can no longer be included (its max time), ms since epoch. */ expiresAtMs: number };

export type TxStatus = "success" | "failed" | "not_found";

export interface HedgeIo {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A FRESH Classic quote for selling `amountIn` of token_in; null when there is no path. May throw. */
  quote(amountIn: bigint): Promise<QuotedHedge | null>;
  /** Build, sign and send one path payment selling `leg.amountIn` with on-chain floor `minOut`. Must not throw: report `unknown`. */
  submit(leg: Leg, minOut: bigint): Promise<SubmitResult>;
  /** Status of a transaction by hash. May throw (flaky network): the executor treats that as "not yet known". */
  txStatus(hash: string): Promise<TxStatus>;
  /** The solver's current token_in balance. May throw. */
  heldIn(): Promise<bigint>;
}

export interface HedgeAttempt {
  n: number;
  kind: "original" | "requote";
  minOut: bigint;
  /** The quote the attempt was priced on. */
  quoteOut: bigint;
  result: SubmitResult;
}

export type HedgeResult =
  | {
      status: "hedged";
      attempts: HedgeAttempt[];
      /** token_out received by the hedge that landed; null when it landed but the amount is unknown (read the balances). */
      proceedsOut: bigint | null;
      /** Hash of the hedge that landed, when known. */
      hash?: string;
      detail: string;
    }
  | { status: "exposed"; attempts: HedgeAttempt[]; reason: AbandonReason; detail: string; exposure: Exposure };

type UnknownOutcome = "success" | "failed" | "never_landed" | "unresolved";

export class HedgeExecutor {
  readonly config: RecoveryConfig;
  readonly ledger: ExposureLedger;
  constructor(private io: HedgeIo, config: Partial<RecoveryConfig> = {}, ledger?: ExposureLedger) {
    this.config = resolveRecoveryConfig(config);
    this.ledger = ledger ?? new ExposureLedger();
  }

  /** Ask before every fill. Refuses while unhedged exposure is above `maxUnhedgedExposureOut`. */
  canFill(): CanFill {
    return this.ledger.canFill(this.config.maxUnhedgedExposureOut);
  }

  get exposures(): Exposure[] {
    return this.ledger.list();
  }

  /** Hedge a settled fill: original quote first, then re-quoted retries inside the loss bound, else an exposure. */
  hedgeFill(fill: FillRecord): Promise<HedgeResult> {
    return this.drive(fill, { first: { leg: fill.quoted.leg, minOut: fill.hedgeMinOut, quoteOut: fill.quoted.quote.amountOut }, pending: [], existing: undefined, maxLossBps: this.config.maxLossBps });
  }

  /**
   * Re-attempt an exposure (the oldest when no id). Settles any unknown submission first, checks the chain for how
   * much is still unsold, re-quotes, and hedges only if the loss bound allows. `opts.maxLossBps` is the explicit
   * operator override to accept a known loss. Returns undefined when there is no such exposure.
   */
  async retryExposure(id?: string, opts: { maxLossBps?: number } = {}): Promise<HedgeResult | undefined> {
    const e = id ? this.ledger.get(id) : this.ledger.list()[0];
    if (!e) return undefined;
    return this.drive(e.fill, { first: undefined, pending: e.pendingHashes, existing: e, maxLossBps: opts.maxLossBps ?? this.config.maxLossBps });
  }

  /** Operator action: drop an exposure from the ledger (for example after hedging it by hand). Resets the breaker if it was the last. */
  clearExposure(id: string): boolean {
    return this.ledger.resolve(id);
  }

  // ------------------------------------------------------------------------------------------------------------

  /** How much of `fill`'s position is still unsold, per the chain. Throws if the balance cannot be read. */
  private async unsold(fill: FillRecord, existing: Exposure | undefined): Promise<bigint> {
    const held = await this.io.heldIn();
    const newer = existing ? this.ledger.amountAfter(fill.tokenIn, existing.seq) : 0n; // later exposures share the same balance
    const excess = held - fill.baselineIn - newer;
    return excess < 0n ? 0n : excess > fill.amountIn ? fill.amountIn : excess;
  }

  /** Poll an unknown submission until the chain settles it, or give up as `unresolved`. Never sends anything. */
  private async resolveUnknown(hash: string, expiresAtMs: number): Promise<UnknownOutcome> {
    const c = this.config;
    const giveUpAt = this.io.now() + c.unknownResolveTimeoutMs;
    for (;;) {
      let st: TxStatus | undefined;
      try {
        st = await this.io.txStatus(hash);
      } catch {
        st = undefined; // flaky read: not an answer
      }
      if (st === "success" || st === "failed") return st;
      if (st === "not_found" && this.io.now() > expiresAtMs + c.expiryGraceMs) return "never_landed";
      if (this.io.now() >= giveUpAt) return "unresolved";
      await this.io.sleep(c.unknownPollMs);
    }
  }

  private async drive(
    fill: FillRecord,
    st: { first: { leg: Leg; minOut: bigint; quoteOut: bigint } | undefined; pending: Exposure["pendingHashes"]; existing: Exposure | undefined; maxLossBps: number },
  ): Promise<HedgeResult> {
    const c = this.config;
    const attempts: HedgeAttempt[] = [];
    let pending = [...st.pending];
    let plan = st.first;
    let extraFees = 0n;
    let amount = fill.amountIn;
    let lastQuote: HedgeQuote | undefined = st.existing ? { amountIn: st.existing.amount, amountOut: st.existing.markValueOut } : fill.quoted.quote;
    let markStale = false;

    const hedged = (detail: string, proceedsOut: bigint | null, hash?: string): HedgeResult => {
      if (st.existing) this.ledger.resolve(st.existing.id);
      return hash ? { status: "hedged", attempts, proceedsOut, hash, detail } : { status: "hedged", attempts, proceedsOut, detail };
    };
    const expose = (reason: AbandonReason, detail: string): HedgeResult => {
      const now = this.io.now();
      const base = {
        amount, markValueOut: lastQuote ? markValue(lastQuote, amount) : 0n, markStale, reason, detail, updatedAtMs: now,
        attempts: (st.existing?.attempts ?? 0) + attempts.length, pendingHashes: pending,
      };
      const exposure = st.existing
        ? this.ledger.update(st.existing.id, base)!
        : this.ledger.add({ ...base, id: fill.id, token: fill.tokenIn, markAsset: fill.tokenOut, atMs: now, fill });
      return { status: "exposed", attempts, reason, detail, exposure };
    };
    /** A submission that may or may not have landed: settle it, or stop. Returns a result to return, or undefined to carry on. */
    const settle = async (u: { hash: string; expiresAtMs: number }): Promise<HedgeResult | undefined> => {
      const out = await this.resolveUnknown(u.hash, u.expiresAtMs);
      if (out === "success") return hedged(`unknown submission ${u.hash} turned out to be included and successful; nothing resent`, null, u.hash);
      if (out === "unresolved") return expose("unknown_status", `submission ${u.hash} could not be settled; nothing resent while it may still land`);
      pending = pending.filter((p) => p.hash !== u.hash); // failed, or provably never landed
      return undefined;
    };

    for (;;) {
      // 1. Nothing is sent while an earlier submission might still land.
      for (const p of [...pending]) {
        const r = await settle(p);
        if (r) return r;
      }
      // 2. Retries (and every retryExposure) first ask the chain what is still unsold: this is the double-hedge guard.
      if (attempts.length > 0 || st.existing || pending.length > 0 || !plan) {
        try {
          amount = await this.unsold(fill, st.existing);
        } catch (e) {
          return expose("quote_error", `could not read the token_in balance (${(e as Error).message}); not sending blind`);
        }
        if (amount === 0n) return hedged("the position is already gone from the chain's balance; nothing to hedge", null);
      }
      // 3. Out of retries?
      if (attempts.length > c.maxRetries) return expose("retries_exhausted", `${attempts.length} hedge attempts did not land`);
      // 4. A retry takes a FRESH quote and must clear the loss bound.
      if (!plan) {
        let q: QuotedHedge | null;
        try {
          q = await this.io.quote(amount);
        } catch (e) {
          return expose("quote_error", `re-quote failed (${(e as Error).message})`);
        }
        if (q) { lastQuote = q.quote; markStale = false; } else markStale = true;
        const d = decideHedgeRetry(fill, q?.quote ?? null, amount, extraFees, { maxLossBps: st.maxLossBps, hedgeSlippageBps: c.hedgeSlippageBps });
        if (d.action === "abandon") return expose(d.reason, d.detail);
        plan = { leg: q!.leg, minOut: d.minOut, quoteOut: q!.quote.amountOut };
      }
      // 5. Send.
      const res = await this.io.submit(plan.leg, plan.minOut);
      attempts.push({ n: attempts.length + 1, kind: attempts.length === 0 && st.first && plan === st.first ? "original" : "requote", minOut: plan.minOut, quoteOut: plan.quoteOut, result: res });
      plan = undefined;
      if (res.status === "success") return hedged(`hedge landed on attempt ${attempts.length}`, res.proceedsOut, res.hash);
      if (res.status === "failed") extraFees += c.attemptFeeOut;
      if (res.status === "unknown") {
        const u = { hash: res.hash, expiresAtMs: res.expiresAtMs };
        pending.push(u);
        const r = await settle(u);
        if (r) return r;
      }
    }
  }
}
