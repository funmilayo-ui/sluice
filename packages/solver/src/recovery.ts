import type { Decision, HedgeQuote } from "./evaluate.js";
import type { QuotedHedge } from "./hedge.js";

/**
 * Failed-hedge recovery: the PURE half (decisions, the exposure ledger, the circuit breaker). No I/O, no clock,
 * no network. `executor.ts` drives these with an injected `HedgeIo`.
 *
 * THE POLICY (this is the contract the executor and its tests implement)
 *
 *  1. After a fill the solver holds `amountIn` of token_in it has not sold. It hedges at once with the ORIGINAL
 *     quote and the original on-chain floor (`hedgeMinOut`), because that is the plan the profit check approved.
 *  2. If that hedge does not land, the solver may RE-QUOTE and try again, at most `maxRetries` more times.
 *     Never blindly: each retry takes a fresh quote and re-checks the money first (`decideHedgeRetry`):
 *       - the realised result must stay inside the loss bound: net P&L >= -(maxLossBps of the originally quoted
 *         hedge proceeds). "Net" counts what was paid to the user, the estimated fees, and the fee of every
 *         failed attempt so far;
 *       - the retry's on-chain floor (`destMin`) is the re-quote less the slippage buffer, and that floor is
 *         itself required to be inside the loss bound. So the bound is not a hope about the quote: the chain
 *         enforces it, and a retry can never realise a loss larger than the bound.
 *  3. If no retry is acceptable (no path, re-quote outside the bound, budget spent) the solver does NOT dump at
 *     any price. It leaves the token_in unhedged, writes an exposure (token, amount, mark value, reason, time)
 *     to the ledger, and the circuit breaker trips: `canFill()` refuses new fills while the ledger's unhedged
 *     mark value exceeds `maxUnhedgedExposureOut`. Default cap 0: any open exposure blocks new fills.
 *  4. The breaker is DERIVED from the ledger, so it resets itself when the exposure is hedged
 *     (`retryExposure`, which goes through the same loss-bound check) or removed by an operator
 *     (`clearExposure`). An operator can also pass a looser `maxLossBps` to `retryExposure` to accept a known
 *     loss on purpose; nothing in this package ever does that on its own.
 *  5. Three failure kinds are never mixed up:
 *       rejected   the network refused the transaction; it is not in any ledger and cannot appear later.
 *                  Safe to re-quote and retry (the submit adapter rebuilds with a fresh sequence number).
 *       failed     included in a ledger and the operation failed (under destMin, no path). The fee is spent, no
 *                  asset moved. Safe to re-quote and retry.
 *       unknown    we sent it and do not know what happened (timeout, lost response, flaky read). It MAY be in
 *                  a ledger now or land later until its time bounds expire. Nothing is retried until the chain
 *                  says: the tx hash is final, or it is not found AFTER its time bounds expired AND the
 *                  solver's token_in balance still shows the position is unsold. If that cannot be settled
 *                  inside `unknownResolveTimeoutMs`, the position is recorded as an exposure with reason
 *                  `unknown_status`, the pending hash stays attached to it, and nothing is sent. Every later
 *                  attempt starts by resolving those hashes. A hedge is therefore never sent twice.
 *
 * ASSUMPTIONS: marks of different exposures are summed per `markAsset` (the reference solver has one token_out);
 * one hedge in flight per token_in at a time (the baseline balance used for the double-hedge guard is per fill).
 */

const BPS = 10_000n;

export interface RecoveryConfig {
  /** Re-quote-and-retry attempts after the first (original-quote) hedge. Default 3. */
  maxRetries: number;
  /** Largest acceptable realised loss, in bps of the fill's originally quoted hedge proceeds. Default 100 (1%). */
  maxLossBps: number;
  /** Buffer under a re-quote that becomes the retry's on-chain minimum. Default 50, matching `hedgeSlippageBps`. */
  hedgeSlippageBps: number;
  /** Circuit breaker: refuse new fills while unhedged exposure (mark value, token_out stroops) is above this. Default 0n. */
  maxUnhedgedExposureOut: bigint;
  /** Cost of one failed (included) hedge attempt, in token_out stroops, added to the loss. Default 0n. */
  attemptFeeOut: bigint;
  /** How long to wait for an unknown submission to be settled before recording an exposure. Default 120s. */
  unknownResolveTimeoutMs: number;
  /** Pause between status polls while resolving an unknown submission. Default 3s. */
  unknownPollMs: number;
  /** Extra wait past a transaction's max time before "not found" is believed (ledger/clock skew). Default 30s. */
  expiryGraceMs: number;
}

export const DEFAULT_RECOVERY: RecoveryConfig = {
  maxRetries: 3,
  maxLossBps: 100,
  hedgeSlippageBps: 50,
  maxUnhedgedExposureOut: 0n,
  attemptFeeOut: 0n,
  unknownResolveTimeoutMs: 120_000,
  unknownPollMs: 3_000,
  expiryGraceMs: 30_000,
};

export function resolveRecoveryConfig(over: Partial<RecoveryConfig> = {}): RecoveryConfig {
  const c = { ...DEFAULT_RECOVERY, ...over };
  if (!Number.isInteger(c.maxRetries) || c.maxRetries < 0) throw new RangeError(`maxRetries must be an integer >= 0, got ${c.maxRetries}`);
  for (const k of ["maxLossBps", "hedgeSlippageBps"] as const) {
    if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 10_000) throw new RangeError(`${k} must be an integer in 0..10000, got ${c[k]}`);
  }
  if (c.maxUnhedgedExposureOut < 0n || c.attemptFeeOut < 0n) throw new RangeError("exposure cap and attempt fee must be >= 0");
  return c;
}

/** Everything the executor needs to know about a settled fill in order to hedge it, retry it and judge the loss. */
export interface FillRecord {
  /** A label for logs and the ledger, normally the fill's transaction hash. */
  id: string;
  /** Identifier of the token that is held unhedged (the asset id or SAC id the solver reports). */
  tokenIn: string;
  tokenOut: string;
  /** token_in received from the user. */
  amountIn: bigint;
  /** token_out paid to the user. */
  amountOutPaid: bigint;
  /** `FillDecision.expectedProfitOut`, for reporting. */
  expectedProfitOut: bigint;
  /** `FillDecision.feesOut`: estimated fill + hedge fees in token_out stroops. */
  feesOut: bigint;
  /** The quote the fill was priced on, and the plan the first hedge follows. */
  quoted: QuotedHedge;
  /** `FillDecision.hedgeMinOut`: on-chain floor of the first hedge. */
  hedgeMinOut: bigint;
  /** Solver's token_in balance BEFORE the fill, used to tell how much of the position is still unsold. */
  baselineIn: bigint;
}

/** Build a FillRecord from an evaluated fill. A thin convenience so callers cannot mix up the fields. */
export function fillRecordFrom(
  d: Extract<Decision, { action: "fill" }>,
  o: { id: string; tokenIn: string; tokenOut: string; amountIn: bigint; quoted: QuotedHedge; baselineIn: bigint },
): FillRecord {
  return {
    id: o.id, tokenIn: o.tokenIn, tokenOut: o.tokenOut, amountIn: o.amountIn, amountOutPaid: d.amountOut,
    expectedProfitOut: d.expectedProfitOut, feesOut: d.feesOut, quoted: o.quoted, hedgeMinOut: d.hedgeMinOut, baselineIn: o.baselineIn,
  };
}

export type AbandonReason = "no_path" | "quote_mismatch" | "loss_bound_exceeded" | "retries_exhausted" | "quote_error" | "unknown_status";

export type RetryDecision =
  | {
      action: "hedge";
      /** On-chain floor to send: the re-quote less the buffer, already checked against the loss bound. */
      minOut: bigint;
      expectedProceedsOut: bigint;
      /** Net P&L at the re-quote / at the floor, in token_out stroops (negative is a loss). */
      expectedNetPnlOut: bigint;
      worstNetPnlOut: bigint;
      lossBoundOut: bigint;
    }
  | { action: "abandon"; reason: Extract<AbandonReason, "no_path" | "quote_mismatch" | "loss_bound_exceeded">; detail: string; lossBoundOut: bigint; worstNetPnlOut?: bigint };

/**
 * Should the solver hedge `amount` of token_in at this FRESH `quote`? Pure; see the policy at the top of the file.
 * `extraFeesOut` is what failed attempts already cost. Cost basis is pro-rated when `amount` < `fill.amountIn`.
 */
export function decideHedgeRetry(
  fill: Pick<FillRecord, "amountIn" | "amountOutPaid" | "feesOut" | "quoted">,
  quote: HedgeQuote | null,
  amount: bigint,
  extraFeesOut: bigint,
  cfg: Pick<RecoveryConfig, "maxLossBps" | "hedgeSlippageBps">,
): RetryDecision {
  const lossBoundOut = (BigInt(cfg.maxLossBps) * fill.quoted.quote.amountOut * amount) / (BPS * fill.amountIn);
  if (!quote || quote.amountOut <= 0n) return { action: "abandon", reason: "no_path", detail: "no Classic path for the position", lossBoundOut };
  if (quote.amountIn !== amount) return { action: "abandon", reason: "quote_mismatch", detail: `quote is for ${quote.amountIn}, position is ${amount}`, lossBoundOut };
  const cost = (fill.amountOutPaid * amount + fill.amountIn - 1n) / fill.amountIn; // round up: never understate a cost
  const fees = (fill.feesOut * amount) / fill.amountIn + extraFeesOut;
  const floor = (quote.amountOut * (BPS - BigInt(cfg.hedgeSlippageBps))) / BPS;
  const worstNetPnlOut = floor - cost - fees;
  if (worstNetPnlOut < -lossBoundOut) {
    return { action: "abandon", reason: "loss_bound_exceeded", detail: `worst case ${worstNetPnlOut} < -${lossBoundOut} (bound)`, lossBoundOut, worstNetPnlOut };
  }
  return { action: "hedge", minOut: floor, expectedProceedsOut: quote.amountOut, expectedNetPnlOut: quote.amountOut - cost - fees, worstNetPnlOut, lossBoundOut };
}

/** Net P&L of a hedge that returned `proceedsOut`, in token_out stroops (before any unrelated inventory change). */
export function hedgeNetPnl(fill: Pick<FillRecord, "amountOutPaid" | "feesOut">, proceedsOut: bigint, extraFeesOut = 0n): bigint {
  return proceedsOut - fill.amountOutPaid - fill.feesOut - extraFeesOut;
}

export interface Exposure {
  id: string;
  /** Token left unhedged, and the amount, in stroops. */
  token: string;
  amount: bigint;
  /** What the position is worth in `markAsset` at the latest fresh quote (or the original one when no quote exists). */
  markValueOut: bigint;
  markAsset: string;
  /** True when no fresh quote existed (book gone), so the mark is the last known price and may overstate. */
  markStale: boolean;
  reason: AbandonReason;
  detail: string;
  /** When the exposure was first recorded, and when it was last re-evaluated (ms since epoch). */
  atMs: number;
  updatedAtMs: number;
  attempts: number;
  /** Submissions whose outcome was never established. Resolved before anything is sent again. */
  pendingHashes: { hash: string; expiresAtMs: number }[];
  /** Recorded so the position can be retried later with the same cost basis. */
  fill: FillRecord;
  seq: number;
}

export type CanFill = { ok: true } | { ok: false; reason: string; exposureOut: bigint; capOut: bigint };

/** In-memory exposure ledger. `onChange` lets a caller persist it (a crash between fill and hedge is otherwise unrecorded). */
export class ExposureLedger {
  private entries = new Map<string, Exposure>();
  private seq = 0;
  constructor(private onChange?: (all: Exposure[]) => void) {}

  add(e: Omit<Exposure, "seq">): Exposure {
    const full = { ...e, seq: ++this.seq };
    this.entries.set(full.id, full);
    this.onChange?.(this.list());
    return full;
  }
  update(id: string, patch: Partial<Omit<Exposure, "id" | "seq" | "fill" | "atMs">>): Exposure | undefined {
    const cur = this.entries.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.entries.set(id, next);
    this.onChange?.(this.list());
    return next;
  }
  resolve(id: string): boolean {
    const had = this.entries.delete(id);
    if (had) this.onChange?.(this.list());
    return had;
  }
  get(id: string): Exposure | undefined {
    return this.entries.get(id);
  }
  list(): Exposure[] {
    return [...this.entries.values()].sort((a, b) => a.seq - b.seq);
  }
  /** Sum of exposure amounts of `token` recorded AFTER `seq` (their balance is part of the solver's holdings too). */
  amountAfter(token: string, seq: number): bigint {
    return this.list().filter((e) => e.token === token && e.seq > seq).reduce((s, e) => s + e.amount, 0n);
  }
  /** Unhedged mark value per `markAsset`. */
  totals(): Map<string, bigint> {
    const m = new Map<string, bigint>();
    for (const e of this.entries.values()) m.set(e.markAsset, (m.get(e.markAsset) ?? 0n) + e.markValueOut);
    return m;
  }
  /** The circuit breaker. Tripped while any asset's unhedged mark value is above the cap; resets by itself when the ledger shrinks. */
  canFill(capOut: bigint): CanFill {
    let worst: { asset: string; v: bigint } | undefined;
    for (const [asset, v] of this.totals()) if (v > capOut && (!worst || v > worst.v)) worst = { asset, v };
    if (!worst) return { ok: true };
    const open = this.list().filter((e) => e.markAsset === worst!.asset);
    return {
      ok: false,
      exposureOut: worst.v,
      capOut,
      reason: `circuit breaker: ${open.length} unhedged position(s) worth ${worst.v} ${worst.asset} stroops exceed the cap of ${capOut} (${open.map((e) => `${e.id}: ${e.reason}`).join("; ")})`,
    };
  }
}

/** The outcome of asking the breaker before a fill: either the evaluation, or a refusal that carries the breaker reason. */
export type GuardedDecision = Decision | { action: "refuse"; reason: "circuit_breaker"; detail: string };

/**
 * Wrap `evaluateFill`: `guard.canFill()` is asked first and a tripped breaker short-circuits to a refusal.
 * `guard` is a `HedgeExecutor` or anything with `canFill()`. The evaluation is a thunk so a refused order
 * costs no simulation or quote.
 */
export function guardedEvaluate(guard: { canFill(): CanFill }, evaluate: () => Decision): GuardedDecision {
  const g = guard.canFill();
  return g.ok ? evaluate() : { action: "refuse", reason: "circuit_breaker", detail: g.reason };
}

/** Value `amount` of token_in at a quote's price (token_out stroops, rounded down). */
export function markValue(q: Pick<HedgeQuote, "amountIn" | "amountOut">, amount: bigint): bigint {
  return q.amountIn > 0n ? (q.amountOut * amount) / q.amountIn : 0n;
}
