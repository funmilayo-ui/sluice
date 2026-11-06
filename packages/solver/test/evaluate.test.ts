import { describe, expect, it } from "vitest";
import { evaluateFill, feeToOut, realisedPnl, type FillDecision, type HedgeQuote, type Order, type SolverParams } from "../src/index.js";

const S = 10_000_000n;
const NOW = 1_800_000_000_000;
const order: Order = {
  user: "GUSER", tokenIn: "CA", amountIn: 100n * S, tokenOut: "CC", minOut: 90n * S,
  deadline: NOW / 1000 + 900, createTrustline: true,
};
const params: SolverParams = {
  nowMs: NOW, minDeadlineBufferSec: 120, maxOrderIn: 1000n * S, solverBalanceOut: 1000n * S,
  hedgeSlippageBps: 50, minProfitBps: 20, networkFeeOut: 0n, improvementShareBps: 0,
};
const hedge = (out: bigint, amountIn = order.amountIn): HedgeQuote => ({ amountIn, amountOut: out, quotedAtMs: NOW });
const fill = (d: ReturnType<typeof evaluateFill>): FillDecision => {
  if (d.action !== "fill") throw new Error(`expected fill, got skip ${d.reasons.join(",")}`);
  return d;
};
const skip = (d: ReturnType<typeof evaluateFill>) => {
  if (d.action !== "skip") throw new Error("expected skip");
  return d;
};

describe("evaluateFill: fill", () => {
  it("pays exactly min_out at 0% improvement and books the whole spread", () => {
    const d = fill(evaluateFill(order, hedge(97n * S), params));
    expect(d.amountOut).toBe(order.minOut);
    expect(d.userImprovement).toBe(0n);
    expect(d.expectedProfitOut).toBe(7n * S); // 97 - 90
    expect(d.hedgeMinOut).toBe((97n * S * 9950n) / 10000n); // slippage buffer 50 bps
    expect(d.worstCaseProfitOut).toBe(d.hedgeMinOut - order.minOut);
    expect(d.expectedProfitBps).toBe(721); // 7/97
  });
  it("shares the surplus above min_out and never drops below the minimum profit", () => {
    const d = fill(evaluateFill(order, hedge(97n * S), { ...params, improvementShareBps: 5000 }));
    const H = (97n * S * 9950n) / 10000n;
    const P = (H * 20n + 9999n) / 10000n;
    const maxPay = H - P;
    expect(d.amountOut).toBe(order.minOut + (maxPay - order.minOut) / 2n);
    expect(d.userImprovement).toBeGreaterThan(0n);
    expect(d.worstCaseProfitOut).toBeGreaterThanOrEqual(P);
    expect(d.expectedProfitOut).toBeGreaterThan(d.worstCaseProfitOut);
  });
  it("100% share leaves exactly the profit floor in the buffered case", () => {
    const d = fill(evaluateFill(order, hedge(97n * S), { ...params, improvementShareBps: 10000 }));
    const H = (97n * S * 9950n) / 10000n;
    expect(d.worstCaseProfitOut).toBe((H * 20n + 9999n) / 10000n);
  });
  it("subtracts network fees from profit and from the payable amount", () => {
    const fee = 5n * S;
    const d = fill(evaluateFill(order, hedge(97n * S), { ...params, networkFeeOut: fee }));
    expect(d.expectedProfitOut).toBe(2n * S);
    expect(d.feesOut).toBe(fee);
  });
  it("is always at least min_out and never exceeds the inventory", () => {
    const d = fill(evaluateFill(order, hedge(120n * S), { ...params, improvementShareBps: 10000, solverBalanceOut: 95n * S }));
    expect(d.amountOut).toBe(95n * S);
    expect(d.amountOut).toBeGreaterThanOrEqual(order.minOut);
  });
  it("fills at the exact inventory / cap / deadline boundaries", () => {
    expect(evaluateFill(order, hedge(97n * S), { ...params, solverBalanceOut: order.minOut }).action).toBe("fill");
    expect(evaluateFill(order, hedge(97n * S), { ...params, maxOrderIn: order.amountIn }).action).toBe("fill");
    expect(evaluateFill({ ...order, deadline: NOW / 1000 + 120 }, hedge(97n * S), params).action).toBe("fill");
  });
});

describe("evaluateFill: skip", () => {
  it("skips when the hedge output is below min_out (the hedge loses money)", () => {
    const d = skip(evaluateFill(order, hedge(89n * S), params));
    expect(d.reasons).toEqual(["hedge_below_amount_out"]);
  });
  it("skips when the hedge only covers min_out thanks to nothing but the slippage buffer", () => {
    // quote 90.2 covers min_out 90, but the buffered 89.75 does not
    const d = skip(evaluateFill(order, hedge(902_000_000n), params));
    expect(d.reasons).toEqual(["hedge_below_amount_out"]);
  });
  it("skips below the minimum profit, and reports what it could have paid", () => {
    // buffered hedge 90.1 - 20 bps floor ~ 89.92 < 90
    const d = skip(evaluateFill(order, hedge(9_055n * S / 100n), params));
    expect(d.reasons).toEqual(["below_min_profit"]);
    expect(d.maxPayableOut).toBeLessThan(order.minOut);
  });
  it("skips when fees eat the spread", () => {
    const d = skip(evaluateFill(order, hedge(97n * S), { ...params, networkFeeOut: 8n * S }));
    expect(d.reasons).toEqual(["hedge_below_amount_out"]);
  });
  it("skips with no hedge quote", () => expect(skip(evaluateFill(order, null, params)).reasons).toEqual(["no_hedge_quote"]));
  it("skips on zero depth and on a partial quote", () => {
    expect(skip(evaluateFill(order, hedge(0n), params)).reasons).toEqual(["hedge_too_thin"]);
    expect(skip(evaluateFill(order, hedge(60n * S, 60n * S), params)).reasons).toEqual(["hedge_too_thin"]);
  });
  it("skips a quote for a different size", () => expect(skip(evaluateFill(order, hedge(97n * S, 200n * S), params)).reasons).toEqual(["hedge_quote_mismatch"]));
  it("skips a stale quote, and one with no timestamp when freshness is required", () => {
    const p = { ...params, maxQuoteAgeSec: 10 };
    expect(skip(evaluateFill(order, { ...hedge(97n * S), quotedAtMs: NOW - 11_000 }, p)).reasons).toEqual(["hedge_quote_stale"]);
    expect(evaluateFill(order, { ...hedge(97n * S), quotedAtMs: NOW - 10_000 }, p).action).toBe("fill");
    expect(skip(evaluateFill(order, { amountIn: order.amountIn, amountOut: 97n * S }, p)).reasons).toEqual(["hedge_quote_stale"]);
  });
  it("skips when the deadline is too close or already passed", () => {
    expect(skip(evaluateFill({ ...order, deadline: NOW / 1000 + 119 }, hedge(97n * S), params)).reasons).toEqual(["deadline_too_close"]);
    expect(skip(evaluateFill({ ...order, deadline: NOW / 1000 - 1 }, hedge(97n * S), params)).reasons).toEqual(["deadline_too_close"]);
  });
  it("skips when inventory cannot cover min_out", () => {
    expect(skip(evaluateFill(order, hedge(97n * S), { ...params, solverBalanceOut: order.minOut - 1n })).reasons).toEqual(["inventory_too_low"]);
  });
  it("skips over the size cap", () => {
    expect(skip(evaluateFill(order, hedge(97n * S), { ...params, maxOrderIn: order.amountIn - 1n })).reasons).toEqual(["order_too_large"]);
  });
  it("skips invalid orders", () => {
    for (const bad of [{ amountIn: 0n }, { minOut: 0n }, { tokenOut: order.tokenIn }]) {
      expect(skip(evaluateFill({ ...order, ...bad }, hedge(97n * S), params)).reasons).toContain("invalid_order");
    }
  });
  it("lists every failed check, not only the first", () => {
    const d = skip(evaluateFill({ ...order, deadline: NOW / 1000 + 5 }, null, { ...params, maxOrderIn: 1n, solverBalanceOut: 0n }));
    expect(d.reasons).toEqual(["deadline_too_close", "order_too_large", "inventory_too_low", "no_hedge_quote"]);
    expect(d.maxPayableOut).toBeUndefined();
  });
  it("rejects nonsense parameters instead of deciding", () => {
    expect(() => evaluateFill(order, hedge(97n * S), { ...params, minProfitBps: -1 })).toThrow(RangeError);
    expect(() => evaluateFill(order, hedge(97n * S), { ...params, hedgeSlippageBps: 10_001 })).toThrow(RangeError);
    expect(() => evaluateFill(order, hedge(97n * S), { ...params, improvementShareBps: 1.5 })).toThrow(RangeError);
    expect(() => evaluateFill(order, hedge(97n * S), { ...params, networkFeeOut: -1n })).toThrow(RangeError);
  });
});

describe("feeToOut", () => {
  it("converts XLM stroops to token_out stroops and rounds up", () => {
    expect(feeToOut(1_000_000n, "0.1")).toBe(100_000n);
    expect(feeToOut(1n, "0.1")).toBe(1n);
    expect(feeToOut(0n, "0.1")).toBe(0n);
    expect(() => feeToOut(1n, "abc")).toThrow();
  });
});

describe("realisedPnl", () => {
  it("a fully hedged fill is the token_out delta minus fees", () => {
    const p = realisedPnl({ tokenIn: 0n, tokenOut: 1000n * S }, { tokenIn: 0n, tokenOut: 1007n * S }, { num: 97n, den: 100n }, 1n * S);
    expect(p).toMatchObject({ deltaIn: 0n, deltaOut: 7n * S, inventoryPnlOut: 7n * S, netPnlOut: 6n * S });
  });
  it("an unhedged position is valued at the mark, not ignored", () => {
    const p = realisedPnl({ tokenIn: 0n, tokenOut: 1000n * S }, { tokenIn: 100n * S, tokenOut: 905n * S }, { num: 97n, den: 100n }, 0n);
    expect(p.inventoryPnlOut).toBe(-95n * S + 97n * S);
  });
  it("rejects a zero denominator", () => expect(() => realisedPnl({ tokenIn: 0n, tokenOut: 0n }, { tokenIn: 0n, tokenOut: 0n }, { num: 1n, den: 0n }, 0n)).toThrow(RangeError));
});
