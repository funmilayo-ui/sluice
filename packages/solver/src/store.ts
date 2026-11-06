import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Order } from "./order.js";
import { parse, stringify } from "./serialize.js";
import type { Exposure, FillRecord } from "./recovery.js";

/**
 * Durable state of the solver: what it must still know after a restart. Small on purpose (a handful of records
 * per fill), so the whole thing is one JSON document behind a two-method interface. Swap `FileStore` for a
 * database by implementing `StateStore`; nothing else changes.
 */

/**
 * Where a fill's hedge stands. The user-facing fill status never depends on this.
 *   reserved   tier-2 only: the solver signed its half of a user-sourced transaction; nothing has landed yet
 *   pending    the fill was sent; waiting for it to land
 *   hedging    the fill landed; the first hedge attempt is in flight
 *   hedged     the position was sold on the Classic DEX
 *   retrying   a hedge did not land; the position is open in the exposure ledger and automatic retries are scheduled
 *   unhedged   a hedge did not land and no automatic retry is running (loop off); the solver holds the input
 *   abandoned  automatic retries are spent; the position stays open (and the breaker tripped) until an operator acts
 *   not_needed the fill failed or never landed, so the solver took nothing
 */
export type HedgeState = "reserved" | "pending" | "hedging" | "hedged" | "retrying" | "unhedged" | "abandoned" | "not_needed";

export interface OrderRecord {
  /** Hash of the fill transaction. Also the id of its exposure, if it ever has one. */
  id: string;
  /** `auth-entry`: the solver is the transaction source (tier 1). `tx`: the user is (tier 2). */
  kind: "auth-entry" | "tx";
  order: Order;
  /** Classic ids of the two assets (the order itself only carries their contract ids). */
  assetIn: string;
  assetOut: string;
  amountOut: bigint;
  /** `<user>:<nonce>` of the authorisation entry that was used. A second submission of it is answered, not re-sent. */
  nonceKey: string;
  /** What the API said the hedge would fetch when it priced the order. Diagnostic only: the solver re-quotes. */
  apiQuoteOut?: bigint;
  state: HedgeState;
  /** What the executor needs to hedge (and, later, to judge the loss). Set once the fill was evaluated. */
  fill?: FillRecord;
  hedgeHash?: string;
  /** token_out the landed hedge returned; undefined when unknown. */
  received?: bigint;
  /** Reason code (an `AbandonReason` or a short phrase) and the executor's explanation of the last failure. */
  reason?: string;
  error?: string;
  /** Hedge attempts made so far, across retry cycles. */
  attempts: number;
  /** Automatic retry cycles run so far (each is one `retryExposure`). */
  cycles: number;
  nextRetryAtMs?: number;
  /** A hedge transaction that was signed and being sent when the state was last saved: resolved by hash after a restart. */
  inflightHedge?: { hash: string; expiresAtMs: number };
  /** Stop waiting for the fill to land after this (ms since epoch): its time bounds have passed. */
  expiresAtMs?: number;
  /** When the fill was seen landed. A landed position waiting its turn to be hedged still counts against the solver's balance. */
  landedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SolverState {
  version: 1;
  exposures: Exposure[];
  orders: OrderRecord[];
}

export const emptyState = (): SolverState => ({ version: 1, exposures: [], orders: [] });

export interface StateStore {
  load(): Promise<SolverState>;
  /** Replace the stored state. Must be atomic: after a crash a reader sees the old document or the new one, never a mix. */
  save(state: SolverState): Promise<void>;
  describe(): string;
}

/** In memory. For tests, and for a development process that does not care what a restart forgets. */
export class MemoryStore implements StateStore {
  private doc: string | undefined;
  /** How many times `save` was called, for tests. */
  saves = 0;
  constructor(initial?: SolverState) {
    if (initial) this.doc = stringify(initial);
  }
  async load(): Promise<SolverState> {
    return this.doc === undefined ? emptyState() : checked(parse<SolverState>(this.doc));
  }
  async save(state: SolverState): Promise<void> {
    this.doc = stringify(state); // a copy: later mutation of `state` must not change what was saved
    this.saves++;
  }
  describe(): string {
    return "memory (lost on restart)";
  }
}

/**
 * One JSON file, written atomically: the new document goes to a temporary file in the same directory, is flushed
 * to disk, then renamed over the old one (rename is atomic on POSIX filesystems), and the directory is flushed so
 * the rename itself survives a power cut. File mode 0600: the state names users and amounts.
 *
 * A file that exists but cannot be read as state is an ERROR, not an empty store: silently starting empty would
 * forget open exposures and reopen the circuit breaker.
 */
export class FileStore implements StateStore {
  readonly path: string;
  constructor(readonly dir: string, file = "solver-state.json") {
    this.path = join(dir, file);
  }
  async load(): Promise<SolverState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw e;
    }
    try {
      return checked(parse<SolverState>(text));
    } catch (e) {
      throw new Error(`solver state file ${this.path} is unreadable (${(e as Error).message}); refusing to start empty because that would forget open positions. Fix or move the file.`);
    }
  }
  private writing: Promise<void> = Promise.resolve();
  /** Saves run one at a time in the order called, so two callers can never interleave on the temporary file; the last call's document wins. */
  save(state: SolverState): Promise<void> {
    const text = stringify(state, 1); // serialised now, so what is written is one consistent moment
    const run = this.writing.then(() => this.write(text));
    this.writing = run.catch(() => undefined);
    return run;
  }
  private async write(text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    await fh.close();
    try {
      await rename(tmp, this.path);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    try {
      const d = await open(this.dir, "r");
      await d.sync().finally(() => d.close());
    } catch {
      /* some filesystems cannot fsync a directory; the rename already happened */
    }
  }
  describe(): string {
    return `file ${this.path}`;
  }
}

function checked(s: SolverState): SolverState {
  if (!s || s.version !== 1 || !Array.isArray(s.exposures) || !Array.isArray(s.orders)) throw new Error("not a solver state document (version 1)");
  return s;
}
