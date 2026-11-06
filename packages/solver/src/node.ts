import { Transaction, TransactionBuilder, xdr, Keypair } from "@stellar/stellar-sdk";
import { formatAmount, sacId } from "@sluice/core";
import { checkSignature, reviewEntry } from "./auth.js";
import type { ChainTx, SolverChain } from "./chain.js";
import { evaluateFill, feeToOut, type Decision, type SolverParams } from "./evaluate.js";
import { HedgeExecutor, type HedgeIo, type HedgeResult } from "./executor.js";
import { FillSimulationError } from "./fillTx.js";
import { assertNotMainnet, isPublicNetwork } from "./guard.js";
import type { ClassicPair, QuotedHedge } from "./hedge.js";
import type { Order } from "./order.js";
import type {
  Admission, FillOutcome, FillRequest, HedgeView, PrepareTxOutcome, PrepareTxRequest, SolverHealth, SolverPort, SubmitTxRequest,
} from "./port.js";
import {
  ExposureLedger, fillRecordFrom, markValue, resolveRecoveryConfig, type CanFill, type Exposure, type FillRecord, type RecoveryConfig,
} from "./recovery.js";
import { emptyState, type OrderRecord, type SolverState, type StateStore } from "./store.js";

/** What the solver is willing to do: the part of the configuration that decides whether a fill makes money. */
export interface SolverPolicy {
  /** Refuse an order whose deadline is closer than this many seconds. */
  minDeadlineBufferSec: number;
  /** Largest `amount_in` taken on, token_in stroops. */
  maxOrderIn: bigint;
  hedgeSlippageBps: number;
  minProfitBps: number;
  improvementShareBps: number;
  /** Token_out per 1 XLM, to price fees when the order does not pay out XLM. Testnet has no market to read it from. */
  feeOutPerXlm: string;
}

/** Automatic retries of an open exposure. Bounded: after `maxCycles` the position is ABANDONED and waits for an operator. */
export interface RetryPolicy {
  /** How often the recovery loop wakes. */
  tickMs: number;
  /** Wait before the first retry cycle; doubles each cycle up to `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Automatic `retryExposure` cycles per position (each is itself bounded by the executor's `maxRetries` and loss bound). */
  maxCycles: number;
}

export const DEFAULT_RETRY: RetryPolicy = { tickMs: 15_000, baseDelayMs: 30_000, maxDelayMs: 600_000, maxCycles: 12 };

export interface SolverNodeOptions {
  chain: SolverChain;
  store: StateStore;
  passphrase: string;
  settleContract: string;
  policy: SolverPolicy;
  recovery?: Partial<RecoveryConfig>;
  retry?: Partial<RetryPolicy>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the tracker asks whether a fill has landed. */
  pollMs?: number;
  /** Ledger close time is not this process's clock: how long past a fill's time bounds to keep waiting for it. */
  graceMs?: number;
  /** Most prepared-but-unsubmitted tier-2 transactions held at once. */
  maxReservations?: number;
  log?: (msg: string, detail?: unknown) => void;
}

const BASE_FEE_STROOPS = 100n;
const MAX_RECORDS = 1000;
const TERMINAL = new Set<OrderRecord["state"]>(["hedged", "not_needed"]);
const firstLine = (s: string) => (s.split("\n")[0] ?? s).slice(0, 300);

/**
 * The solver: owns the key (through its `SolverChain`), decides whether to fill, sends the fill, hedges it, retries a
 * failed hedge inside the recovery policy, and keeps all of it in a `StateStore` so a restart loses nothing.
 *
 * The same class runs in two places: inside the API process (explicit development mode) and behind the HTTP service
 * in `service.ts` (the production path). The user-facing fill status never depends on anything here: it is read
 * from the chain by the API.
 */
export class SolverNode implements SolverPort {
  readonly address: string;
  readonly ledger: ExposureLedger;
  private readonly chain: SolverChain;
  private readonly store: StateStore;
  private readonly recovery: RecoveryConfig;
  private readonly retry: RetryPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly orders = new Map<string, OrderRecord>();
  private readonly byNonce = new Map<string, string>();
  private readonly executors = new Map<string, { ex: HedgeExecutor; io: HedgeIo }>();
  private readonly trackers = new Set<Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  private hedging: string | undefined;
  private networkOk = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tickRun: Promise<void> | undefined;
  private running = false;
  private closed = false;
  private restoring: Promise<void> | undefined;

  constructor(private readonly o: SolverNodeOptions) {
    assertNotMainnet(o.passphrase);
    this.chain = o.chain;
    this.store = o.store;
    this.address = o.chain.address;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.recovery = resolveRecoveryConfig({ hedgeSlippageBps: o.policy.hedgeSlippageBps, ...o.recovery });
    this.retry = { ...DEFAULT_RETRY, ...o.retry };
    this.ledger = new ExposureLedger(() => this.persist());
  }

  private log(msg: string, detail?: unknown) {
    this.o.log?.(msg, detail);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Persistence

  private snapshot(): SolverState {
    return { version: 1, exposures: this.ledger.list(), orders: [...this.orders.values()] };
  }
  /** Save the state; the returned promise rejects if the store failed. Saves are serialised, latest snapshot wins. */
  private save(): Promise<void> {
    const run = this.saving.then(() => this.o.store.save(this.snapshot()));
    this.saving = run.catch((e) => this.log("saving solver state failed", (e as Error).message));
    return run;
  }
  private persist(): void {
    void this.save().catch(() => undefined);
  }
  private prune(): void {
    if (this.orders.size <= MAX_RECORDS) return;
    for (const [id, r] of this.orders) {
      if (this.orders.size <= MAX_RECORDS) break;
      if (TERMINAL.has(r.state)) {
        this.orders.delete(id);
        this.byNonce.delete(r.nonceKey);
      }
    }
  }

  /**
   * Load the stored state and pick up where the last process stopped: positions still open go back into the ledger (so the
   * circuit breaker is as tripped as it was), fills that were sent but not seen landing are tracked again, and a hedge that
   * was mid-flight is settled by its hash before anything is sent again.
   */
  restore(): Promise<void> {
    this.restoring ??= this.doRestore();
    return this.restoring;
  }
  private async doRestore(): Promise<void> {
    const st = await this.store.load();
    this.ledger.restore(st.exposures);
    for (const rec of st.orders) {
      this.orders.set(rec.id, rec);
      this.byNonce.set(rec.nonceKey, rec.id);
    }
    const now = this.now();
    for (const e of this.ledger.list()) if (!this.orders.has(e.id)) this.orders.set(e.id, this.recordFromExposure(e, now));
    for (const rec of this.orders.values()) {
      if (rec.state === "hedging" || rec.state === "retrying" || rec.state === "unhedged" || rec.state === "abandoned") {
        if (!this.ledger.get(rec.id)) {
          // The state says a position is open (or was being hedged) but the ledger has no exposure: the process stopped between the two
          // writes. Re-open it; retryExposure asks the chain whether anything is left to sell before it sends.
          const pendingHashes = rec.inflightHedge ? [rec.inflightHedge] : [];
          this.addExposure(rec, "unknown_status", rec.state === "hedging" ? "the process stopped while this position was being hedged; the chain decides what is left to sell" : "the exposure was missing from the stored ledger", pendingHashes);
        }
        if (rec.state === "hedging") {
          rec.state = "unhedged";
          rec.reason = "unknown_status";
          rec.error = "the process stopped while this position was being hedged; the chain decides what is left to sell";
          rec.nextRetryAtMs = now;
        }
        rec.inflightHedge = undefined; // now carried by the exposure's pendingHashes
      }
    }
    for (const rec of this.orders.values()) if (rec.state === "pending") this.startTracker(rec);
    this.log("solver state restored", { orders: this.orders.size, exposures: this.ledger.list().length, store: this.store.describe() });
    await this.save().catch(() => undefined);
  }

  private recordFromExposure(e: Exposure, now: number): OrderRecord {
    return {
      id: e.id, kind: "auth-entry", order: { user: "", tokenIn: "", amountIn: e.amount, tokenOut: "", minOut: 0n, deadline: 0, createTrustline: false },
      assetIn: e.token, assetOut: e.markAsset, amountOut: e.fill.amountOutPaid, nonceKey: `exposure:${e.id}`, state: "unhedged", fill: e.fill,
      reason: e.reason, error: e.detail, attempts: e.attempts, cycles: 0, nextRetryAtMs: now, createdAtMs: e.atMs, updatedAtMs: now,
    };
  }

  private addExposure(rec: OrderRecord, reason: Exposure["reason"], detail: string, pendingHashes: Exposure["pendingHashes"] = []): Exposure {
    const fill = rec.fill!;
    const now = this.now();
    return this.ledger.add({
      id: rec.id, token: fill.tokenIn, amount: fill.amountIn, markValueOut: markValue(fill.quoted.quote, fill.amountIn), markAsset: fill.tokenOut,
      markStale: true, reason, detail, atMs: now, updatedAtMs: now, attempts: rec.attempts, pendingHashes, fill,
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Questions the API asks

  /** The circuit breaker, derived from the exposure ledger. Sync: only valid after `restore()`. */
  private admission(): CanFill {
    return this.ledger.canFill(this.recovery.maxUnhedgedExposureOut);
  }
  async canFill(): Promise<Admission> {
    await this.restore();
    const g = this.admission();
    return g.ok ? { ok: true } : { ok: false, reason: g.reason };
  }
  async health(): Promise<SolverHealth> {
    await this.restore();
    const g = this.admission();
    return {
      ok: true,
      address: this.address,
      networkPassphrase: this.o.passphrase,
      settleContract: this.o.settleContract,
      accepting: g.ok,
      ...(g.ok ? {} : { breaker: g.reason }),
      openExposures: this.ledger.list().length,
      recoveryLoop: this.running,
      store: this.store.describe(),
    };
  }

  async orderStatus(hash: string): Promise<HedgeView | undefined> {
    await this.restore();
    const rec = this.orders.get(hash);
    return rec ? this.view(rec) : undefined;
  }

  /** Open positions, oldest first, with the hedge state of each. For operators. */
  exposures(): { id: string; amount: string; asset: string; reason: string; detail: string; state: string; attempts: number; cycles: number }[] {
    return this.ledger.list().map((e) => {
      const r = this.orders.get(e.id);
      return { id: e.id, amount: formatAmount(e.amount), asset: e.token, reason: e.reason, detail: e.detail, state: r?.state ?? "unknown", attempts: e.attempts, cycles: r?.cycles ?? 0 };
    });
  }

  private view(rec: OrderRecord): HedgeView {
    switch (rec.state) {
      case "reserved":
      case "pending":
        return { status: "PENDING" };
      case "hedging":
        return { status: "HEDGING" };
      case "hedged":
        return { status: "HEDGED", ...(rec.hedgeHash ? { hash: rec.hedgeHash } : {}), ...(rec.received !== undefined ? { received: formatAmount(rec.received) } : {}) };
      case "retrying":
        return { status: "RETRYING", attempts: rec.attempts, ...(rec.reason ? { reason: rec.reason } : {}), ...(rec.error ? { error: firstLine(rec.error) } : {}), ...(rec.nextRetryAtMs ? { nextRetryAt: Math.floor(rec.nextRetryAtMs / 1000) } : {}) };
      case "unhedged":
      case "abandoned":
        return { status: rec.state === "unhedged" ? "UNHEDGED" : "ABANDONED", attempts: rec.attempts, ...(rec.reason ? { reason: rec.reason } : {}), error: firstLine(rec.error ?? "the hedge did not land") };
      case "not_needed":
        return { status: "NOT_NEEDED", reason: rec.reason ?? "the solver took nothing" };
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Pricing shared by both tiers

  private params(nowMs: number, solverBalanceOut: bigint, networkFeeOut: bigint, improvementShareBps: number): SolverParams {
    const p = this.o.policy;
    return {
      nowMs, minDeadlineBufferSec: p.minDeadlineBufferSec, maxOrderIn: p.maxOrderIn, solverBalanceOut, hedgeSlippageBps: p.hedgeSlippageBps,
      minProfitBps: p.minProfitBps, improvementShareBps, networkFeeOut, maxQuoteAgeSec: 60,
    };
  }
  private feeOut(assetOut: string, stroops: bigint): bigint {
    return assetOut === "native" ? stroops : feeToOut(stroops, this.o.policy.feeOutPerXlm);
  }

  private async ensureNetwork(): Promise<FillOutcome | undefined> {
    if (this.networkOk) return undefined;
    let reported: string;
    try {
      reported = await this.chain.networkPassphrase();
    } catch (e) {
      return { kind: "error", message: `could not reach the settlement network: ${firstLine((e as Error).message)}` };
    }
    if (isPublicNetwork(reported)) return { kind: "invalid", code: "ORDERS_MAINNET_REFUSED", message: "Settlement orders are refused on the public network until the contract is audited." };
    if (reported !== this.o.passphrase) return { kind: "invalid", code: "ORDERS_NETWORK_MISMATCH", message: "The solver's RPC serves a different network than the one it is configured for." };
    this.networkOk = true;
    return undefined;
  }

  private breaker(): FillOutcome | undefined {
    const g = this.admission();
    return g.ok ? undefined : { kind: "refused", code: "CIRCUIT_BREAKER", reasons: ["circuit_breaker"], message: g.reason };
  }

  /** The assets must be the ones the order's contract ids stand for, or the hedge would sell something else. */
  private checkAssets(order: Order, assetIn: string, assetOut: string): FillOutcome | undefined {
    try {
      if (sacId(assetIn, this.o.passphrase) === order.tokenIn && sacId(assetOut, this.o.passphrase) === order.tokenOut && assetIn !== assetOut) return undefined;
    } catch { /* falls through */ }
    return { kind: "invalid", code: "BAD_REQUEST", message: "assetIn / assetOut do not match the order's token contracts" };
  }

  /** The solver's own price check: its quote, its balance, its policy. Never the API's say-so. */
  private async evaluate(order: Order, pair: ClassicPair, amountOut: bigint, networkFeeOut: bigint): Promise<{ decision: Decision; quoted: QuotedHedge | null } | FillOutcome> {
    let quoted: QuotedHedge | null;
    let balance: bigint;
    try {
      [quoted, balance] = await Promise.all([this.chain.hedgeQuote(order.amountIn, pair), this.chain.solverBalance(pair.tokenOut)]);
    } catch (e) {
      return { kind: "error", message: firstLine((e as Error).message) };
    }
    const decision = evaluateFill({ ...order, minOut: amountOut }, quoted?.quote ?? null, this.params(this.now(), balance, networkFeeOut, 0));
    return { decision, quoted };
  }

  private skip(d: Extract<Decision, { action: "skip" }>): FillOutcome {
    return { kind: "refused", code: "SOLVER_WILL_NOT_FILL", reasons: d.reasons, message: `the solver declined this fill: ${d.reasons.join(", ")}` };
  }

  // ------------------------------------------------------------------------------------------------------------
  // Tier 1: the user signed an authorisation entry

  async fill(req: FillRequest): Promise<FillOutcome> {
    await this.restore();
    if (this.closed) return { kind: "busy", message: "the solver is shutting down" };
    const { order, assetIn, assetOut, amountOut } = req;
    const net = await this.ensureNetwork();
    if (net) return net;
    const blocked = this.breaker();
    if (blocked) return blocked;
    const badAssets = this.checkAssets(order, assetIn, assetOut);
    if (badAssets) return badAssets;

    let entry: xdr.SorobanAuthorizationEntry;
    try {
      entry = xdr.SorobanAuthorizationEntry.fromXDR(req.signedUserEntry, "base64");
    } catch {
      return { kind: "invalid", code: "BAD_REQUEST", message: "signedUserEntry is not a SorobanAuthorizationEntry in base64 XDR" };
    }
    // The solver pays and signs: it re-checks what the API already checked.
    const problem = reviewEntry(entry, order, this.o.settleContract) ?? checkSignature(entry, order, this.o.passphrase);
    if (problem) return { kind: "invalid", code: problem.code, message: problem.message };
    const creds = entry.credentials().address();
    const nonceKey = `${order.user}:${creds.nonce().toString()}`;
    const known = this.byNonce.get(nonceKey);
    if (known) return { kind: "sent", hash: known, status: "DUPLICATE" };

    let latest: number;
    try {
      latest = await this.chain.latestLedger();
    } catch (e) {
      return { kind: "error", message: firstLine((e as Error).message) };
    }
    if (creds.signatureExpirationLedger() <= latest + 2 || order.deadline <= Math.floor(this.now() / 1000) + 15) {
      return { kind: "invalid", code: "EXPIRED", message: "The order or its signature has expired." };
    }

    let sim;
    try {
      sim = await this.chain.simulateFill(order, amountOut, entry);
    } catch (e) {
      if (e instanceof FillSimulationError) return { kind: "sim_failed", message: e.message };
      return { kind: "error", message: firstLine((e as Error).message) };
    }
    const pair: ClassicPair = { tokenIn: assetIn, tokenOut: assetOut };
    const ev = await this.evaluate(order, pair, amountOut, this.feeOut(assetOut, sim.minResourceFee + 2n * BASE_FEE_STROOPS));
    if ("kind" in ev) return ev;
    if (ev.decision.action === "skip") return this.skip(ev.decision);
    const decision = ev.decision;
    const quoted = ev.quoted!;

    let baselineIn = 0n;
    try {
      baselineIn = await this.executorFor(pair).io.heldIn();
    } catch { /* the hedge re-reads the balance when it starts */ }

    let recorded: string | undefined;
    let outcome;
    try {
      outcome = await sim.send(async (hash) => {
        const now = this.now();
        const fill: FillRecord = fillRecordFrom(decision, { id: hash, tokenIn: assetIn, tokenOut: assetOut, amountIn: order.amountIn, quoted, baselineIn });
        const rec: OrderRecord = {
          id: hash, kind: "auth-entry", order, assetIn, assetOut, amountOut, nonceKey, ...(req.quoteOut !== undefined ? { apiQuoteOut: req.quoteOut } : {}),
          state: "pending", fill, attempts: 0, cycles: 0, expiresAtMs: now + 300_000 + (this.o.graceMs ?? 30_000), createdAtMs: now, updatedAtMs: now,
        };
        this.orders.set(hash, rec);
        this.byNonce.set(nonceKey, hash);
        this.prune();
        try {
          await this.save(); // the fill is on disk BEFORE the network can see it
        } catch (e) {
          this.orders.delete(hash);
          this.byNonce.delete(nonceKey);
          throw e;
        }
        recorded = hash;
      });
    } catch (e) {
      if (!recorded) {
        return { kind: "error", message: firstLine((e as Error).message) };
      }
      // Sent, or maybe sent: the node may have received it. The tracker settles the truth; the user can resubmit and gets the same hash.
      this.startTracker(this.orders.get(recorded)!);
      return { kind: "sent", hash: recorded, status: "PENDING" };
    }
    const rec = this.orders.get(outcome.hash)!;
    if (outcome.status === "PENDING" || outcome.status === "DUPLICATE") {
      this.startTracker(rec);
      return { kind: "sent", hash: outcome.hash, status: outcome.status };
    }
    // Refused by the network: nothing was taken, so there is nothing to hedge and the signature stays usable.
    this.setState(rec, "not_needed", { reason: outcome.status === "TRY_AGAIN_LATER" ? "the network was busy and did not accept the fill" : `the network refused the fill: ${(outcome.codes ?? []).join(", ")}` });
    this.byNonce.delete(nonceKey);
    return outcome.status === "TRY_AGAIN_LATER" ? { kind: "busy", message: "the network is busy, submit again in a few seconds", hash: outcome.hash } : { kind: "rejected", codes: outcome.codes ?? [], hash: outcome.hash };
  }

  // ------------------------------------------------------------------------------------------------------------
  // Tier 2: the user is the transaction source

  async prepareTx(req: PrepareTxRequest): Promise<PrepareTxOutcome> {
    await this.restore();
    if (this.closed) return { kind: "busy", message: "the solver is shutting down" };
    const { order, assetIn, assetOut, amountOut } = req;
    const net = await this.ensureNetwork();
    if (net) return net as PrepareTxOutcome;
    const blocked = this.breaker();
    if (blocked) return blocked as PrepareTxOutcome;
    const badAssets = this.checkAssets(order, assetIn, assetOut);
    if (badAssets) return badAssets as PrepareTxOutcome;
    if (!Number.isInteger(req.validForSec) || req.validForSec < 60 || req.validForSec > 3600) return { kind: "invalid", code: "BAD_REQUEST", message: "validForSec must be 60..3600" };
    if (order.deadline <= Math.floor(this.now() / 1000) + 15) return { kind: "invalid", code: "EXPIRED", message: "The order has expired." };
    const open = [...this.orders.values()].filter((r) => r.state === "reserved").length;
    if (open >= (this.o.maxReservations ?? 200)) return { kind: "busy", message: "the solver is holding too many unsigned transactions; try again shortly" };

    const pair: ClassicPair = { tokenIn: assetIn, tokenOut: assetOut };
    // The user pays the fill's fee in this tier; the solver's only network cost is the hedge payment.
    const ev = await this.evaluate(order, pair, amountOut, this.feeOut(assetOut, BASE_FEE_STROOPS));
    if ("kind" in ev) return ev as PrepareTxOutcome;
    if (ev.decision.action === "skip") return this.skip(ev.decision) as PrepareTxOutcome;
    const decision = ev.decision;
    const quoted = ev.quoted!;

    let prepared;
    try {
      prepared = await this.chain.prepareUserTx(order, amountOut, req.validForSec);
    } catch (e) {
      if (e instanceof FillSimulationError) return { kind: "sim_failed", message: e.message };
      return { kind: "error", message: firstLine((e as Error).message) };
    }
    let baselineIn = 0n;
    try {
      baselineIn = await this.executorFor(pair).io.heldIn();
    } catch { /* re-read when the hedge starts */ }
    const now = this.now();
    const fill = fillRecordFrom(decision, { id: prepared.hash, tokenIn: assetIn, tokenOut: assetOut, amountIn: order.amountIn, quoted, baselineIn });
    const rec: OrderRecord = {
      id: prepared.hash, kind: "tx", order, assetIn, assetOut, amountOut, nonceKey: `${this.address}:${prepared.solverNonce}`,
      ...(req.quoteOut !== undefined ? { apiQuoteOut: req.quoteOut } : {}),
      state: "reserved", fill, attempts: 0, cycles: 0, expiresAtMs: prepared.maxTimeSec * 1000 + (this.o.graceMs ?? 30_000), createdAtMs: now, updatedAtMs: now,
    };
    this.orders.set(rec.id, rec);
    this.byNonce.set(rec.nonceKey, rec.id);
    this.prune();
    try {
      await this.save(); // the solver has signed: a fill of this transaction must never go untracked
    } catch (e) {
      this.orders.delete(rec.id);
      this.byNonce.delete(rec.nonceKey);
      return { kind: "error", message: `could not record the reservation: ${firstLine((e as Error).message)}` };
    }
    return {
      kind: "prepared",
      tx: {
        xdr: prepared.xdr, hash: prepared.hash, source: prepared.source, sequence: prepared.sequence, minResourceFee: prepared.minResourceFee,
        maxTimeSec: prepared.maxTimeSec, solverNonce: prepared.solverNonce, solverValidUntilLedger: prepared.solverValidUntilLedger,
      },
    };
  }

  async submitTx(req: SubmitTxRequest): Promise<FillOutcome> {
    await this.restore();
    if (this.closed) return { kind: "busy", message: "the solver is shutting down" };
    let tx: Transaction;
    try {
      const parsed = TransactionBuilder.fromXDR(req.signedTx, this.o.passphrase);
      if (!(parsed instanceof Transaction)) throw new Error("fee bump");
      tx = parsed;
    } catch {
      return { kind: "invalid", code: "BAD_REQUEST", message: "signedTx is not a transaction envelope for this network" };
    }
    const hash = tx.hash().toString("hex");
    const rec = this.orders.get(hash);
    if (!rec || rec.kind !== "tx") return { kind: "invalid", code: "UNKNOWN_RESERVATION", message: "The solver did not prepare this transaction, or it has changed since. Prepare again." };
    if (rec.state !== "reserved") return { kind: "sent", hash, status: "DUPLICATE" };
    const blocked = this.breaker();
    if (blocked) return blocked;
    const user = Keypair.fromPublicKey(rec.order.user);
    if (!tx.signatures.some((s) => s.hint().equals(user.signatureHint()) && user.verify(tx.hash(), s.signature()))) {
      return { kind: "invalid", code: "BAD_SIGNATURE", message: "The transaction is not signed by the order's account." };
    }
    if (this.now() > (rec.expiresAtMs ?? 0) - (this.o.graceMs ?? 30_000) - 5_000) return { kind: "invalid", code: "EXPIRED", message: "This transaction has expired. Prepare a new one." };
    let sent;
    try {
      sent = await this.chain.sendSigned(req.signedTx);
    } catch (e) {
      return { kind: "error", message: firstLine((e as Error).message) };
    }
    if (sent.status === "PENDING" || sent.status === "DUPLICATE") {
      rec.state = "pending";
      rec.updatedAtMs = this.now();
      await this.save().catch(() => undefined);
      this.startTracker(rec);
      return { kind: "sent", hash, status: sent.status };
    }
    // Not accepted. The reservation stays: the user may fix the cause (for example a stale sequence) and the tick still watches the hash.
    return sent.status === "TRY_AGAIN_LATER" ? { kind: "busy", message: "the network is busy, submit again in a few seconds", hash } : { kind: "rejected", codes: sent.codes ?? [], hash };
  }

  // ------------------------------------------------------------------------------------------------------------
  // After the fill: wait for it to land, hedge it

  private setState(rec: OrderRecord, state: OrderRecord["state"], patch: Partial<OrderRecord> = {}) {
    Object.assign(rec, patch, { state, updatedAtMs: this.now() });
    this.persist();
  }

  private startTracker(rec: OrderRecord): void {
    const run = this.track(rec).catch((e) => this.log("tracker failed", (e as Error).message));
    this.trackers.add(run);
    void run.finally(() => this.trackers.delete(run));
  }

  /** Poll until the fill lands (then hedge), fails (nothing to hedge) or its time bounds pass (it never will). */
  private async track(rec: OrderRecord): Promise<void> {
    const poll = this.o.pollMs ?? 1500;
    while (!this.closed) {
      let tx: ChainTx | undefined;
      try {
        tx = await this.chain.getTx(rec.id);
      } catch { /* a flaky read is not an answer */ }
      if (tx?.status === "SUCCESS") return this.landed(rec);
      if (tx?.status === "FAILED") {
        // A failed transaction rolls back, nonce included: the same signature may be tried again.
        this.byNonce.delete(rec.nonceKey);
        this.setState(rec, "not_needed", { reason: "the fill failed, so the solver took nothing" });
        return;
      }
      if (this.now() > (rec.expiresAtMs ?? 0)) {
        this.byNonce.delete(rec.nonceKey);
        this.setState(rec, "not_needed", { reason: "the fill never landed before its time bounds expired" });
        return;
      }
      await this.sleep(poll);
    }
  }

  private landed(rec: OrderRecord): Promise<void> {
    if (rec.state !== "pending" && rec.state !== "reserved") return Promise.resolve();
    rec.state = "pending";
    rec.landedAtMs = this.now();
    rec.updatedAtMs = rec.landedAtMs;
    this.persist();
    return this.enqueue(() => this.firstHedge(rec));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private executorFor(pair: ClassicPair): { ex: HedgeExecutor; io: HedgeIo } {
    const key = `${pair.tokenIn}>${pair.tokenOut}`;
    let hit = this.executors.get(key);
    if (!hit) {
      const io = this.chain.hedgeIo(pair, (hash, expiresAtMs) => this.markInflight(hash, expiresAtMs));
      hit = { ex: new HedgeExecutor(io, this.recovery, this.ledger), io };
      this.executors.set(key, hit);
    }
    return hit;
  }

  /** A hedge is about to be sent: remember its hash first, so a restart can ask the chain what became of it. */
  private async markInflight(hash: string, expiresAtMs: number): Promise<void> {
    const rec = this.hedging ? this.orders.get(this.hedging) : undefined;
    if (!rec) return;
    rec.inflightHedge = { hash, expiresAtMs };
    rec.updatedAtMs = this.now();
    await this.save();
  }

  /** What else sits in the solver's balance of this token, so a retry can tell how much of THIS position is left. */
  private otherPositions(rec: OrderRecord): bigint {
    let sum = this.ledger.list().filter((e) => e.token === rec.assetIn && e.id !== rec.id).reduce((s, e) => s + e.amount, 0n);
    for (const r of this.orders.values()) if (r.id !== rec.id && r.assetIn === rec.assetIn && r.state === "pending" && r.landedAtMs !== undefined) sum += r.order.amountIn;
    return sum;
  }

  private async firstHedge(rec: OrderRecord): Promise<void> {
    if (this.closed) return;
    const pair: ClassicPair = { tokenIn: rec.assetIn, tokenOut: rec.assetOut };
    const { ex, io } = this.executorFor(pair);
    this.hedging = rec.id;
    try {
      // Hedges run one at a time, so now is when the balance holds exactly the open positions plus this one.
      try {
        const held = await io.heldIn();
        const baseline = held - rec.order.amountIn - this.otherPositions(rec);
        rec.fill = { ...rec.fill!, baselineIn: baseline < 0n ? 0n : baseline };
      } catch { /* keep the baseline read when the fill was sent */ }
      this.setState(rec, "hedging");
      await this.save().catch(() => undefined);
      let res: HedgeResult;
      try {
        res = await ex.hedgeFill(rec.fill!);
      } catch (e) {
        // Whatever threw, a hedge may have been sent. Treat the position as open and let the chain say.
        this.applyExposure(rec, "unknown_status", `the hedge step failed unexpectedly (${firstLine((e as Error).message)}); the chain decides what is left to sell`);
        return;
      }
      this.applyResult(rec, res);
    } finally {
      this.hedging = undefined;
    }
  }

  private applyExposure(rec: OrderRecord, reason: Exposure["reason"], detail: string) {
    if (!this.ledger.get(rec.id)) this.addExposure(rec, reason, detail, rec.inflightHedge ? [rec.inflightHedge] : []);
    this.afterFailure(rec, reason, detail);
  }

  private afterFailure(rec: OrderRecord, reason: string, detail: string) {
    const abandoned = rec.cycles >= this.retry.maxCycles;
    rec.inflightHedge = undefined;
    this.setState(rec, abandoned ? "abandoned" : this.running ? "retrying" : "unhedged", {
      reason, error: detail, ...(abandoned ? { nextRetryAtMs: undefined } : { nextRetryAtMs: this.now() + this.delayFor(rec.cycles) }),
    });
    if (abandoned) this.log("hedge abandoned: the position stays open until an operator acts", { id: rec.id, reason, detail });
  }

  private applyResult(rec: OrderRecord, res: HedgeResult) {
    rec.attempts += res.attempts.length;
    rec.inflightHedge = undefined;
    if (res.status === "hedged") {
      this.setState(rec, "hedged", { ...(res.hash ? { hedgeHash: res.hash } : {}), ...(res.proceedsOut !== null ? { received: res.proceedsOut } : {}), reason: undefined, error: undefined, nextRetryAtMs: undefined });
      return;
    }
    this.afterFailure(rec, res.reason, res.detail);
  }

  private delayFor(cycles: number): number {
    return Math.min(this.retry.baseDelayMs * 2 ** cycles, this.retry.maxDelayMs);
  }

  /** One retry cycle for an open position: the executor re-quotes, checks the chain and the loss bound, and hedges or leaves it open. */
  private retryOne(rec: OrderRecord, opts: { maxLossBps?: number } = {}): Promise<HedgeResult | undefined> {
    return this.enqueue(async () => {
      if (this.closed || !this.ledger.get(rec.id)) return undefined;
      const { ex } = this.executorFor({ tokenIn: rec.assetIn, tokenOut: rec.assetOut });
      this.hedging = rec.id;
      try {
        let res: HedgeResult | undefined;
        try {
          res = await ex.retryExposure(rec.id, opts);
        } catch (e) {
          rec.cycles++;
          this.afterFailure(rec, "unknown_status", `the retry failed unexpectedly (${firstLine((e as Error).message)})`);
          return undefined;
        }
        if (!res) return undefined;
        rec.cycles++;
        this.applyResult(rec, res);
        return res;
      } finally {
        this.hedging = undefined;
      }
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // The recovery loop

  /** One pass of the loop: settle tier-2 reservations, then retry every open position that is due. Exposed for tests and operators. */
  async tick(): Promise<void> {
    await this.restore();
    const now = this.now();
    for (const rec of [...this.orders.values()]) {
      if (rec.state !== "reserved") continue;
      let tx: ChainTx | undefined;
      try {
        tx = await this.chain.getTx(rec.id);
      } catch { continue; }
      if (tx.status === "SUCCESS") void this.landed(rec).catch((e) => this.log("hedge after reservation failed", (e as Error).message));
      else if (tx.status === "FAILED") this.setState(rec, "not_needed", { reason: "the fill failed, so the solver took nothing" });
      else if (now > (rec.expiresAtMs ?? 0)) this.setState(rec, "not_needed", { reason: "the prepared transaction expired unused" });
    }
    for (const e of this.ledger.list()) {
      const rec = this.orders.get(e.id);
      if (!rec || rec.state === "abandoned" || rec.state === "hedging" || rec.state === "pending") continue;
      if (rec.nextRetryAtMs !== undefined && rec.nextRetryAtMs > now) continue;
      if (rec.cycles >= this.retry.maxCycles) {
        this.setState(rec, "abandoned", { nextRetryAtMs: undefined });
        continue;
      }
      if (rec.state === "unhedged") this.setState(rec, "retrying");
      await this.retryOne(rec);
    }
  }

  /** Start the background recovery loop. The timer is unref'd: it never keeps the process alive. */
  start(): void {
    if (this.running || this.closed) return;
    this.running = true;
    const now = this.now();
    for (const rec of this.orders.values()) {
      if (rec.state === "unhedged" && this.ledger.get(rec.id)) this.setState(rec, "retrying", { nextRetryAtMs: rec.nextRetryAtMs ?? now });
    }
    const loop = () => {
      this.tickRun = this.tick()
        .catch((e) => this.log("recovery tick failed", (e as Error).message))
        .finally(() => {
          this.tickRun = undefined;
          if (!this.running) return;
          this.timer = setTimeout(loop, this.retry.tickMs);
          this.timer.unref?.();
        });
    };
    this.timer = setTimeout(loop, Math.min(this.retry.tickMs, 1000));
    this.timer.unref?.();
  }

  /** Stop the loop and wait for a pass that is already running. Does not cancel hedges that are in flight. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.tickRun;
  }

  /** Stop everything: no new fills, trackers exit, then wait for queued work and the last save. */
  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
    await this.idle();
    await this.save().catch(() => undefined);
  }

  /** Resolves when no tracker or hedge is running. */
  async idle(): Promise<void> {
    for (;;) {
      const work = [...this.trackers];
      if (work.length === 0) break;
      await Promise.all(work);
    }
    await this.queue;
    await this.saving;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Operator actions

  /** Retry an open position now. `maxLossBps` is the explicit operator override that accepts a known loss. */
  async retryNow(id: string, opts: { maxLossBps?: number } = {}): Promise<HedgeView | undefined> {
    await this.restore();
    const rec = this.orders.get(id);
    if (!rec || !this.ledger.get(id)) return undefined;
    if (rec.state === "abandoned" || rec.state === "unhedged") this.setState(rec, "retrying");
    await this.retryOne(rec, opts);
    return this.view(rec);
  }

  /** Drop an open position from the ledger, for example after hedging it by hand. Resets the breaker if it was the last. */
  async clearExposure(id: string): Promise<boolean> {
    await this.restore();
    const ok = this.ledger.resolve(id);
    const rec = this.orders.get(id);
    if (ok && rec) this.setState(rec, "hedged", { reason: "cleared by an operator", error: undefined, nextRetryAtMs: undefined });
    return ok;
  }

  state(): SolverState {
    return this.orders.size === 0 && this.ledger.list().length === 0 ? emptyState() : this.snapshot();
  }
}
