import { buildClassicSwap, horizonSource, sacId, type AssetId, type Leg } from "@sluice/core";
import type { HedgeQuote } from "./evaluate.js";
import type { Order } from "./order.js";

export interface ClassicPair {
  tokenIn: AssetId;
  tokenOut: AssetId;
}

/**
 * Map the order's two Stellar Asset Contract ids back to Classic assets, from the assets this solver trades.
 * Returns null when either token is not a known Classic asset (the solver then has no hedge: skip the order).
 */
export function resolveClassicAssets(order: Order, known: AssetId[], passphrase: string): ClassicPair | null {
  const bySac = new Map(known.map((id) => [sacId(id, passphrase), id] as const));
  const tokenIn = bySac.get(order.tokenIn);
  const tokenOut = bySac.get(order.tokenOut);
  return tokenIn && tokenOut ? { tokenIn, tokenOut } : null;
}

export interface QuotedHedge {
  quote: HedgeQuote;
  leg: Leg;
}

/** Ask Horizon for the best Classic path that sells `order.amountIn` of token_in for token_out. Null when there is no path. */
export async function quoteHedge(order: Order, pair: ClassicPair, horizonUrl: string, nowMs: number = Date.now(), fetchImpl: typeof fetch = fetch): Promise<QuotedHedge | null> {
  const leg = await horizonSource(horizonUrl, fetchImpl).quote({ assetIn: pair.tokenIn, assetOut: pair.tokenOut, amountIn: order.amountIn });
  if (!leg) return null;
  return { leg, quote: { amountIn: leg.amountIn, amountOut: leg.amountOut, quotedAtMs: nowMs } };
}

/**
 * Unsigned path-payment-strict-send transaction that sells the filled input on the Classic DEX back to the solver
 * itself. `minOut` is the decision's `hedgeMinOut`: if the book moved further than the buffer, the hedge fails
 * on chain and the solver keeps the token_in (a known risk: the solver is then left holding unhedged token_in).
 */
export function buildHedgeTx(leg: Leg, o: { source: string; sequence: string; minOut: bigint; passphrase: string; timeoutSec?: number }): string {
  return buildClassicSwap(leg, { source: o.source, sequence: o.sequence, minOut: o.minOut, passphrase: o.passphrase, timeoutSec: o.timeoutSec ?? 120 });
}
