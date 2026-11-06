import type { SkipReason } from "./evaluate.js";
import type { Order } from "./order.js";

/**
 * What the API asks of a solver, whether the solver runs in the same process (`SolverNode`) or behind HTTP
 * (`RemoteSolver`). The API never sees the solver's key; it sees this.
 */

export type RefusalReason = SkipReason | "circuit_breaker";

/** Tier 1: the user signed an authorisation entry; the solver is the transaction source. */
export interface FillRequest {
  order: Order;
  /** Classic ids of the order's two assets (`native` or `CODE:ISSUER`). The solver checks they are the order's token ids. */
  assetIn: string;
  assetOut: string;
  /** What the solver pays, token_out stroops. The solver re-prices and may refuse. */
  amountOut: bigint;
  /** The user's signed SorobanAuthorizationEntry, base64. */
  signedUserEntry: string;
  /** What the API's hedge quote said the position would fetch. Recorded for diagnosis; never relied on. */
  quoteOut?: bigint;
}

/** Tier 2: the user is the transaction source and the solver signs only its own authorisation entry. */
export interface PrepareTxRequest {
  order: Order;
  assetIn: string;
  assetOut: string;
  amountOut: bigint;
  /** How long the prepared transaction (and the solver's signature in it) stays valid. */
  validForSec: number;
  quoteOut?: bigint;
}

export interface SubmitTxRequest {
  /** The transaction the solver prepared, signed by the user, base64 XDR. */
  signedTx: string;
}

export interface PreparedTx {
  xdr: string;
  hash: string;
  source: string;
  sequence: string;
  minResourceFee: bigint;
  maxTimeSec: number;
  solverNonce: string;
  solverValidUntilLedger: number;
}

export type Refused =
  | { kind: "refused"; code: "CIRCUIT_BREAKER" | "SOLVER_WILL_NOT_FILL"; reasons: RefusalReason[]; message: string };

/** Anything that is the request's fault, with a stable code (`EXPIRED`, `ENTRY_MISMATCH`, `WRONG_SIGNER`, `BAD_SIGNATURE`, `UNKNOWN_RESERVATION`, `BAD_REQUEST`, ...). */
export type Invalid = { kind: "invalid"; code: string; message: string };

export type FillOutcome =
  | { kind: "sent"; hash: string; status: "PENDING" | "DUPLICATE" }
  | Refused
  | Invalid
  /** The network refused the simulation; `message` is the raw RPC error. */
  | { kind: "sim_failed"; message: string }
  /** The network refused the transaction. */
  | { kind: "rejected"; codes: string[]; hash?: string }
  /** The network (or the solver) is busy: nothing was sent, try again. */
  | { kind: "busy"; message: string; hash?: string }
  /** Something between the solver and the network failed before anything was sent. */
  | { kind: "error"; message: string };

export type PrepareTxOutcome = { kind: "prepared"; tx: PreparedTx } | Refused | Invalid | { kind: "sim_failed"; message: string } | { kind: "busy"; message: string } | { kind: "error"; message: string };

/**
 * The solver's account of one fill's hedge, as `GET /v1/orders/:hash` reports it.
 *   PENDING    the fill has not landed yet
 *   HEDGING    the fill landed; the first hedge attempt is running
 *   HEDGED     the position was sold on the Classic DEX
 *   RETRYING   a hedge did not land; bounded automatic retries are scheduled (`nextRetryAt`)
 *   UNHEDGED   a hedge did not land and nothing is retrying it (no recovery loop is running); the solver holds the input
 *   ABANDONED  automatic retries are spent. The position stays open, the breaker stays tripped, an operator must act
 *   NOT_NEEDED the fill failed or never landed, so the solver took nothing
 * None of these change the user's fill status: that is read from the chain.
 */
export type HedgeView =
  | { status: "PENDING" | "HEDGING" }
  | { status: "HEDGED"; hash?: string; received?: string }
  | { status: "RETRYING"; attempts: number; reason?: string; error?: string; /** Unix seconds. */ nextRetryAt?: number }
  | { status: "UNHEDGED" | "ABANDONED"; attempts: number; reason?: string; error: string }
  | { status: "NOT_NEEDED"; reason: string };

export interface SolverHealth {
  ok: true;
  /** The solver's public address. */
  address: string;
  networkPassphrase: string;
  settleContract: string;
  /** False while the circuit breaker is open. */
  accepting: boolean;
  breaker?: string;
  openExposures: number;
  /** Whether the background recovery loop is running in the process that owns the key. */
  recoveryLoop: boolean;
  store: string;
}

/** Whether the solver takes new fills: the circuit breaker, in the one shape both modes can give. */
export type Admission = { ok: true } | { ok: false; reason: string };

export interface SolverPort {
  readonly address: string;
  health(): Promise<SolverHealth>;
  /** The circuit breaker. Asked before any pricing or simulation work. */
  canFill(): Promise<Admission> | Admission;
  fill(req: FillRequest): Promise<FillOutcome>;
  prepareTx(req: PrepareTxRequest): Promise<PrepareTxOutcome>;
  submitTx(req: SubmitTxRequest): Promise<FillOutcome>;
  /** Undefined when the solver has no record of this transaction. */
  orderStatus(hash: string): Promise<HedgeView | undefined>;
}

/** Why the solver service could not be used. Short and safe to show: it never carries a URL or an address. */
export type UnavailableReason = "unreachable" | "timeout" | "unauthorized" | "failed" | "bad_response" | "mismatch";

/** The solver service could not be reached or answered nonsense. The API maps it to 503 `SOLVER_UNAVAILABLE`. */
export class SolverUnavailable extends Error {
  /** `message` is for logs. `reason` is the safe summary the API shows. */
  constructor(message: string, readonly detail?: string, readonly reason: UnavailableReason = "failed") {
    super(message);
    this.name = "SolverUnavailable";
  }
}
