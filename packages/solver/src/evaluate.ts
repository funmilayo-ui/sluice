import type { Order } from "./order.js";

/**
 * A Classic hedge quote: selling `amountIn` of the order's token_in for token_out on the Classic DEX yields
 * `amountOut`. Structurally a subset of core's `Leg`, so `horizonSource(...).quote(...)` output can be passed
 * straight in. All amounts are 7-decimal stroops.
 */
export interface HedgeQuote {
  amountIn: bigint;
  amountOut: bigint;
  /** When the quote was taken (ms since epoch). Optional; used only with `maxQuoteAgeSec`. */
  quotedAtMs?: number;
}

export interface SolverParams {
  /** Current time, ms since epoch. Injected so the decision is deterministic. */
  nowMs: number;
  /** Refuse an order whose deadline is closer than this many seconds. Covers signing, simulation, inclusion and the hedge. */
  minDeadlineBufferSec: number;
  /** Largest `amount_in` this solver will take on, in token_in stroops. */
  maxOrderIn: bigint;
  /** The solver's current balance of token_out (what it pays out), in stroops. */
  solverBalanceOut: bigint;
  /** Assume the hedge fills this many bps worse than quoted. Also becomes the hedge's on-chain minimum output. */
  hedgeSlippageBps: number;
  /** Required profit, in bps of the (slippage-adjusted) hedge output, that must survive the buffer and the fees. */
  minProfitBps: number;
  /** Total network fees for the fill and the hedge, already converted to token_out stroops. */
  networkFeeOut: bigint;
  /** Share, in bps, of the surplus between `min_out` and the break-even payout that is handed to the user. */
  improvementShareBps: number;
  /** Optional: refuse a hedge quote older than this many seconds (needs `quotedAtMs`). */
  maxQuoteAgeSec?: number;
}

export type SkipReason =
  | "invalid_order"
  | "deadline_too_close"
  | "order_too_large"
  | "inventory_too_low"
  | "no_hedge_quote"
  | "hedge_too_thin"
  | "hedge_quote_mismatch"
  | "hedge_quote_stale"
  | "hedge_below_amount_out"
  | "below_min_profit";

export interface FillDecision {
  action: "fill";
  /** What to pass as `amount_out`: `min_out` plus the user's share of the surplus. Always >= `order.minOut`. */
  amountOut: bigint;
  /** `amountOut - minOut`: the price improvement given to the user. */
  userImprovement: bigint;
  /** Hedge proceeds at the quoted price, minus fees, minus `amountOut`. What the solver expects to book. */
  expectedProfitOut: bigint;
  /** Same with the hedge at the slippage buffer. The floor the solver has accepted; always >= the minimum profit. */
  worstCaseProfitOut: bigint;
  /** `expectedProfitOut` in bps of the quoted hedge output. */
  expectedProfitBps: number;
  /** Use as the hedge path payment's `destMin`: the buffered output the profit check assumed. */
  hedgeMinOut: bigint;
  feesOut: bigint;
}

export interface SkipDecision {
  action: "skip";
  /** Every check that failed (not just the first), most fundamental first. */
  reasons: SkipReason[];
  /** The most the solver could pay `amount_out` and still clear the profit floor; undefined without a usable hedge. */
  maxPayableOut?: bigint;
}

export type Decision = FillDecision | SkipDecision;

const BPS = 10_000n;

function checkBps(name: string, v: number) {
  if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new RangeError(`${name} must be an integer in 0..10000, got ${v}`);
}

/**
 * Decide whether to fill `order`, hedging on the Classic DEX at `hedge`, and at what `amount_out`.
 *
 * Economics, all in token_out stroops:
 *   H        = hedge.amountOut * (1 - hedgeSlippageBps)                 hedge proceeds we are willing to rely on
 *   F        = networkFeeOut                                            fill + hedge fees
 *   P        = ceil(H * minProfitBps)                                   required profit
 *   maxPay   = H - F - P                                                most we can pay and still clear the floor
 * Fill iff maxPay >= min_out (so we can always at least pay what the user signed for). We then pay
 *   amount_out = min_out + floor((maxPay - min_out) * improvementShareBps)
 * so improvementShareBps = 0 pays exactly min_out and keeps all surplus, 10000 gives the user everything above
 * the profit floor. Profit is therefore never below P in the buffered case. A skip lists every failed check.
 * Pure: no I/O, no clock; the caller supplies the balance, the quote and the time.
 */
export function evaluateFill(order: Order, hedge: HedgeQuote | null, params: SolverParams): Decision {
  checkBps("hedgeSlippageBps", params.hedgeSlippageBps);
  checkBps("minProfitBps", params.minProfitBps);
  checkBps("improvementShareBps", params.improvementShareBps);
  if (params.networkFeeOut < 0n) throw new RangeError("networkFeeOut must be >= 0");

  const reasons: SkipReason[] = [];
  const nowSec = Math.floor(params.nowMs / 1000);

  if (order.amountIn <= 0n || order.minOut <= 0n || order.tokenIn === order.tokenOut) reasons.push("invalid_order");
  if (order.deadline - nowSec < params.minDeadlineBufferSec) reasons.push("deadline_too_close");
  if (order.amountIn > params.maxOrderIn) reasons.push("order_too_large");
  if (params.solverBalanceOut < order.minOut) reasons.push("inventory_too_low");

  let usable: HedgeQuote | null = null;
  if (!hedge) {
    reasons.push("no_hedge_quote");
  } else if (hedge.amountOut <= 0n || hedge.amountIn < order.amountIn) {
    reasons.push("hedge_too_thin");
  } else if (hedge.amountIn > order.amountIn) {
    reasons.push("hedge_quote_mismatch");
  } else if (params.maxQuoteAgeSec !== undefined && (hedge.quotedAtMs === undefined || params.nowMs - hedge.quotedAtMs > params.maxQuoteAgeSec * 1000)) {
    reasons.push("hedge_quote_stale");
  } else {
    usable = hedge;
  }

  let maxPayableOut: bigint | undefined;
  let H = 0n;
  let P = 0n;
  const F = params.networkFeeOut;
  if (usable) {
    H = (usable.amountOut * (BPS - BigInt(params.hedgeSlippageBps))) / BPS;
    P = (H * BigInt(params.minProfitBps) + BPS - 1n) / BPS;
    maxPayableOut = H - F - P;
    if (H - F < order.minOut) reasons.push("hedge_below_amount_out");
    else if (maxPayableOut < order.minOut) reasons.push("below_min_profit");
  }

  if (reasons.length > 0 || !usable || maxPayableOut === undefined) {
    return maxPayableOut === undefined ? { action: "skip", reasons } : { action: "skip", reasons, maxPayableOut };
  }

  let amountOut = order.minOut + ((maxPayableOut - order.minOut) * BigInt(params.improvementShareBps)) / BPS;
  if (amountOut > params.solverBalanceOut) amountOut = params.solverBalanceOut; // >= minOut: checked above
  const expected = usable.amountOut - F - amountOut;
  return {
    action: "fill",
    amountOut,
    userImprovement: amountOut - order.minOut,
    expectedProfitOut: expected,
    worstCaseProfitOut: H - F - amountOut,
    expectedProfitBps: Number((expected * BPS) / usable.amountOut),
    hedgeMinOut: H,
    feesOut: F,
  };
}

/** Convert a fee paid in the network's native asset (stroops of XLM) into token_out stroops at `outPerXlm` (a decimal string like "0.1"). */
export function feeToOut(feeStroops: bigint, outPerXlm: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(outPerXlm);
  if (!m) throw new Error(`invalid price: ${outPerXlm}`);
  const rate = BigInt(m[1]!) * 10_000_000n + BigInt((m[2] ?? "").padEnd(7, "0") || "0");
  return (feeStroops * rate + 9_999_999n) / 10_000_000n; // round up: never understate a cost
}
