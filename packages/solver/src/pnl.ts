export interface Inventory {
  /** token_in balance (the asset the user sold, which the solver hedges away). */
  tokenIn: bigint;
  /** token_out balance (what the solver pays the user and receives from the hedge). */
  tokenOut: bigint;
}

export interface RealisedPnl {
  deltaIn: bigint;
  deltaOut: bigint;
  /** Net inventory change valued in token_out: deltaOut + deltaIn at `mark`. Zero deltaIn means a fully hedged fill. */
  inventoryPnlOut: bigint;
  /** Fees paid, in token_out terms. */
  feesOut: bigint;
  netPnlOut: bigint;
}

/**
 * Realised P&L from two inventory snapshots. Any token_in left over (a hedge that did not run, or ran partly)
 * is valued at `mark` (token_out per token_in, as num/den, normally the hedge quote's price) so an unhedged
 * position shows up as exposure instead of being ignored.
 */
export function realisedPnl(before: Inventory, after: Inventory, mark: { num: bigint; den: bigint }, feesOut: bigint): RealisedPnl {
  if (mark.den <= 0n) throw new RangeError("mark.den must be > 0");
  const deltaIn = after.tokenIn - before.tokenIn;
  const deltaOut = after.tokenOut - before.tokenOut;
  const inventoryPnlOut = deltaOut + (deltaIn * mark.num) / mark.den;
  return { deltaIn, deltaOut, inventoryPnlOut, feesOut, netPnlOut: inventoryPnlOut - feesOut };
}
