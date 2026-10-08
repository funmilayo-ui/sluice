/** Canonical asset id: "native" or "CODE:ISSUER". */
export type AssetId = string;

export type Layer = "classic" | "soroban";

/**
 * ATOMIC_SOROBAN: every leg is a Soroban contract call; one InvokeHostFunctionOp, fully atomic.
 * CLASSIC_ONLY:   a single PathPayment operation; atomic, venue chosen by core per hop.
 * TWO_STEP:       Classic + Soroban legs; Soroban allows one operation per transaction, so
 *                 the legs are separate transactions and NOT atomic.
 */
export type Atomicity = "ATOMIC_SOROBAN" | "CLASSIC_ONLY" | "TWO_STEP";

export interface QuoteRequest {
  assetIn: AssetId;
  assetOut: AssetId;
  /** Amount in stroops (7 decimals) of assetIn. Exact-in only for v0. */
  amountIn: bigint;
  /** Max tolerated slippage for min-out guards. Default 50 (0.5%). */
  slippageBps?: number;
}

export interface Leg {
  venue: string;
  layer: Layer;
  assetIn: AssetId;
  assetOut: AssetId;
  amountIn: bigint;
  amountOut: bigint;
  /** Intermediate assets the venue reported, excluding assetIn/assetOut. */
  hops: AssetId[];
  /** Venue-specific payload needed to build the transaction (e.g. Aquarius swap_chain_xdr). */
  raw?: unknown;
}

export interface RiskNote {
  code: "NON_ATOMIC" | "STABLECOIN_PENALTY" | "PARTIAL_FILL_POSSIBLE" | "STALE_QUOTE" | "UNSCORED_ASSET";
  message: string;
}

export interface Route {
  legs: Leg[];
  atomicity: Atomicity;
  assetIn: AssetId;
  assetOut: AssetId;
  amountIn: bigint;
  /** Quoted output of the final leg. */
  amountOut: bigint;
  /** Output after atomicity and stablecoin haircuts; used for ranking only. */
  effectiveOut: bigint;
  /** Per-leg minimum outputs derived from slippageBps. */
  minOuts: bigint[];
  risks: RiskNote[];
}

export interface QuoteSource {
  id: string;
  layer: Layer;
  /** Return null when the venue cannot route the pair. Throw only on transport errors. */
  quote(req: QuoteRequest): Promise<Leg | null>;
  /** Optional: load slow one-off state (a pool list) ahead of the first quote. Must not throw. */
  warm?(): Promise<void>;
}

export interface RouterConfig {
  sources: QuoteSource[];
  /** Hub assets tried as the bridge between layers for TWO_STEP routes. */
  hubs: AssetId[];
  /** Ranking haircut applied to TWO_STEP routes, in bps of output. Default 50. */
  twoStepPenaltyBps?: number;
  /** Optional per-asset ranking penalty in bps (e.g. from stablecoin scoring). */
  assetPenaltyBps?: (asset: AssetId) => number;
  /**
   * Venue ids that the deployed Sluice router contract can chain atomically (soroswap, phoenix, comet). When set,
   * routes with two legs on different chainable venues are produced as ATOMIC_SOROBAN. Leave unset until the
   * contract is deployed and `SLUICE_ROUTER_CONTRACT` is configured: such routes cannot execute without it.
   */
  chainVenues?: string[];
  /** Per-source timeout in ms. Default 4000. */
  timeoutMs?: number;
}

/**
 * Minimal JSON key-value cache a source can be given so slow discovery survives across processes (a
 * serverless function starts cold often). Values must be JSON-serialisable. Without one, sources cache in memory.
 */
export interface KvCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSec: number): Promise<void>;
}
