import { describe, expect, it } from "vitest";
import {
  decideHedgeRetry, evaluateFill, ExposureLedger, fillRecordFrom, guardedEvaluate, HedgeExecutor, resolveRecoveryConfig,
  type FillRecord, type HedgeIo, type Order, type QuotedHedge, type SolverParams, type SubmitResult, type TxStatus,
} from "../src/index.js";
import type { Leg } from "@sluice/core";

const S = 10_000_000n;
const q = (out: bigint, amountIn = 100n * S): QuotedHedge => ({
  quote: { amountIn, amountOut: out, quotedAtMs: 0 },
  leg: { venue: "horizon", layer: "classic", assetIn: "A", assetOut: "C", amountIn, amountOut: out, hops: [] } as Leg,
});
// Paid 95 C to the user, expected to sell the 100 A for 96 C (on-chain floor 95.52). Loss bound 1% of 96 = 0.96 C.
const fill: FillRecord = {
  id: "fill1", tokenIn: "A", tokenOut: "C", amountIn: 100n * S, amountOutPaid: 95n * S, expectedProfitOut: 9n * S / 10n,
  feesOut: S / 50n, quoted: q(96n * S), hedgeMinOut: (96n * S * 9950n) / 10_000n, baselineIn: 0n,
};

interface Step { result: SubmitResult; lands?: boolean }
/** A scripted chain: `held` is the solver's token_in; a submit with `lands` really sells it. */
function fake(o: { submits?: Step[]; quotes?: (QuotedHedge | null | Error)[]; held?: bigint; txStatus?: (hash: string, now: number) => TxStatus | Error; heldThrows?: boolean } = {}) {
  const log = { submits: [] as { minOut: bigint; amountIn: bigint }[], quotes: [] as bigint[], statusChecks: [] as string[] };
  const st = { now: 0, held: o.held ?? 100n * S, landed: new Set<string>() };
  const submits = [...(o.submits ?? [])];
  const quotes = [...(o.quotes ?? [])];
  const io: HedgeIo = {
    now: () => st.now,
    sleep: async (ms) => void (st.now += ms),
    async quote(amountIn) {
      log.quotes.push(amountIn);
      const next = quotes.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("test: no scripted quote");
      return next;
    },
    async submit(leg, minOut) {
      log.submits.push({ minOut, amountIn: leg.amountIn });
      const step = submits.shift();
      if (!step) throw new Error("test: unexpected extra hedge submission (double hedge?)");
      if (step.lands) {
        st.held -= leg.amountIn;
        if ("hash" in step.result) st.landed.add(step.result.hash);
      }
      return step.result;
    },
    async txStatus(hash) {
      log.statusChecks.push(hash);
      const s = o.txStatus ? o.txStatus(hash, st.now) : st.landed.has(hash) ? "success" : "not_found";
      if (s instanceof Error) throw s;
      return s;
    },
    async heldIn() {
      if (o.heldThrows) throw new Error("rpc down");
      return st.held;
    },
  };
  return { io, log, st };
}
const ok = (hash = "h-ok", proceedsOut = 96n * S): Step => ({ result: { status: "success", hash, proceedsOut }, lands: true });
const failed = (hash = "h-fail"): Step => ({ result: { status: "failed", hash, error: "txFailed: pathPaymentStrictSendUnderDestmin" } });
const rejected = (): Step => ({ result: { status: "rejected", error: "tx_bad_seq" } });
const floorOf = (out: bigint) => (out * 9950n) / 10_000n;
const exec = (f: ReturnType<typeof fake>, cfg = {}) => new HedgeExecutor(f.io, cfg);

describe("config", () => {
  it("defaults and validates", () => {
    const c = resolveRecoveryConfig();
    expect(c).toMatchObject({ maxRetries: 3, maxLossBps: 100, maxUnhedgedExposureOut: 0n });
    expect(() => resolveRecoveryConfig({ maxRetries: -1 })).toThrow(RangeError);
    expect(() => resolveRecoveryConfig({ maxLossBps: 10_001 })).toThrow(RangeError);
    expect(() => resolveRecoveryConfig({ maxUnhedgedExposureOut: -1n })).toThrow(RangeError);
  });
});

describe("decideHedgeRetry (pure)", () => {
  const cfg = { maxLossBps: 100, hedgeSlippageBps: 50 };
  it("hedges when the buffered re-quote stays inside the loss bound, and the floor is the buffered quote", () => {
    const d = decideHedgeRetry(fill, q(95n * S).quote, 100n * S, 0n, cfg);
    expect(d.action).toBe("hedge");
    if (d.action !== "hedge") return;
    expect(d.minOut).toBe(floorOf(95n * S));
    expect(d.lossBoundOut).toBe((96n * S * 100n) / 10_000n); // 0.96 C
    expect(d.expectedNetPnlOut).toBe(95n * S - 95n * S - S / 50n); // sells for exactly what was paid, minus fees
    expect(d.worstNetPnlOut).toBeGreaterThanOrEqual(-d.lossBoundOut);
  });
  it("refuses a re-quote whose floor would realise more than the bound", () => {
    const d = decideHedgeRetry(fill, q(93n * S).quote, 100n * S, 0n, cfg);
    expect(d).toMatchObject({ action: "abandon", reason: "loss_bound_exceeded" });
  });
  it("sits exactly on the boundary: accepts at the bound, refuses one stroop below", () => {
    // floor must be >= cost + fees - bound = 95 + 0.02 - 0.96 = 94.06 C
    const need = 95n * S + S / 50n - (96n * S * 100n) / 10_000n;
    const quoteFor = (floor: bigint) => (floor * 10_000n + 9949n) / 9950n; // smallest quote whose floor is >= `floor`
    const accept = decideHedgeRetry(fill, q(quoteFor(need)).quote, 100n * S, 0n, cfg);
    expect(accept.action).toBe("hedge");
    const refuse = decideHedgeRetry(fill, q(quoteFor(need) - 2n).quote, 100n * S, 0n, cfg);
    expect(refuse.action).toBe("abandon");
  });
  it("counts the fee of failed attempts against the bound", () => {
    const base = decideHedgeRetry(fill, q(946_000_000n).quote, 100n * S, 0n, cfg);
    const withFees = decideHedgeRetry(fill, q(946_000_000n).quote, 100n * S, S, cfg);
    expect(base.action).toBe("hedge");
    expect(withFees.action).toBe("abandon");
  });
  it("abandons on no path and on a quote for a different size", () => {
    expect(decideHedgeRetry(fill, null, 100n * S, 0n, cfg)).toMatchObject({ action: "abandon", reason: "no_path" });
    expect(decideHedgeRetry(fill, q(96n * S, 50n * S).quote, 100n * S, 0n, cfg)).toMatchObject({ action: "abandon", reason: "quote_mismatch" });
  });
  it("pro-rates cost and bound for a partial position", () => {
    const d = decideHedgeRetry(fill, q(475_000_000n, 50n * S).quote, 50n * S, 0n, cfg); // 47.5 C for 50 A: same price as paid
    expect(d.action).toBe("hedge");
    if (d.action === "hedge") expect(d.lossBoundOut).toBe(((96n * S) / 2n * 100n) / 10_000n);
  });
});

describe("HedgeExecutor", () => {
  it("hedges with the original quote and floor, no re-quote, no exposure", async () => {
    const f = fake({ submits: [ok()] });
    const e = exec(f);
    const r = await e.hedgeFill(fill);
    expect(r.status).toBe("hedged");
    expect(f.log.submits).toEqual([{ minOut: fill.hedgeMinOut, amountIn: 100n * S }]);
    expect(f.log.quotes).toHaveLength(0);
    expect(e.exposures).toHaveLength(0);
    expect(e.canFill()).toEqual({ ok: true });
    if (r.status === "hedged") expect(r.attempts[0]).toMatchObject({ kind: "original", n: 1 });
  });

  it("retry succeeds on the 2nd try: first fails on chain, re-quote within the bound, floor from the NEW quote", async () => {
    const f = fake({ submits: [failed(), ok("h2", 95n * S)], quotes: [q(95n * S)] });
    const e = exec(f);
    const r = await e.hedgeFill(fill);
    expect(r.status).toBe("hedged");
    expect(f.log.submits.map((s) => s.minOut)).toEqual([fill.hedgeMinOut, floorOf(95n * S)]);
    expect(f.log.quotes).toEqual([100n * S]);
    expect(e.exposures).toHaveLength(0);
    if (r.status === "hedged") {
      expect(r.attempts.map((a) => [a.kind, a.result.status])).toEqual([["original", "failed"], ["requote", "success"]]);
      expect(r.proceedsOut).toBe(95n * S);
      expect(r.hash).toBe("h2");
    }
  });

  it("a rejected submission (never on chain) is re-quoted and retried too", async () => {
    const f = fake({ submits: [rejected(), ok()], quotes: [q(96n * S)] });
    const r = await exec(f).hedgeFill(fill);
    expect(r.status).toBe("hedged");
    expect(f.log.submits).toHaveLength(2);
  });

  it("every retry takes a fresh quote and the bound is rechecked: a second, worse quote stops it", async () => {
    const f = fake({ submits: [failed("a"), failed("b")], quotes: [q(95n * S), q(93n * S)] });
    const e = exec(f);
    const r = await e.hedgeFill(fill);
    expect(r).toMatchObject({ status: "exposed", reason: "loss_bound_exceeded" });
    expect(f.log.quotes).toHaveLength(2);
    expect(f.log.submits).toHaveLength(2); // nothing sent at 93
    expect(e.exposures[0]!.attempts).toBe(2);
  });

  it("loss bound exceeded: no dump, exposure recorded with all fields, breaker trips, next order refused with the reason", async () => {
    const f = fake({ submits: [failed()], quotes: [q(93n * S)] });
    const e = exec(f);
    f.st.now = 1234;
    const r = await e.hedgeFill(fill);
    expect(r.status).toBe("exposed");
    expect(f.log.submits).toHaveLength(1); // the original attempt only; the 93 C quote was refused, not hit
    expect(e.exposures).toHaveLength(1);
    expect(e.exposures[0]).toMatchObject({
      id: "fill1", token: "A", amount: 100n * S, markValueOut: 93n * S, markAsset: "C", markStale: false, reason: "loss_bound_exceeded", atMs: 1234, attempts: 1,
    });
    expect(e.exposures[0]!.detail).toMatch(/bound/);
    const g = e.canFill();
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.exposureOut).toBe(93n * S);
      expect(g.reason).toMatch(/circuit breaker.*fill1: loss_bound_exceeded/);
    }
  });

  it("no path at all: exposed with a stale mark (last known price)", async () => {
    const f = fake({ submits: [failed()], quotes: [null] });
    const e = exec(f);
    const r = await e.hedgeFill(fill);
    expect(r).toMatchObject({ status: "exposed", reason: "no_path" });
    expect(e.exposures[0]).toMatchObject({ markStale: true, markValueOut: 96n * S });
  });

  it("stops after maxRetries retries: 1 original + N, then retries_exhausted", async () => {
    const f = fake({ submits: [failed("1"), failed("2"), failed("3"), failed("4")], quotes: [q(96n * S), q(96n * S), q(96n * S), q(96n * S)] });
    const r = await exec(f, { maxRetries: 3 }).hedgeFill(fill);
    expect(r).toMatchObject({ status: "exposed", reason: "retries_exhausted" });
    expect(f.log.submits).toHaveLength(4);
    const g = fake({ submits: [failed()], quotes: [] });
    expect(await exec(g, { maxRetries: 0 }).hedgeFill(fill)).toMatchObject({ status: "exposed", reason: "retries_exhausted" });
    expect(g.log.submits).toHaveLength(1);
    expect(g.log.quotes).toHaveLength(0);
  });

  it("a quote error or an unreadable balance stops the retry rather than sending blind", async () => {
    const a = fake({ submits: [failed()], quotes: [new Error("horizon down")] });
    expect(await exec(a).hedgeFill(fill)).toMatchObject({ status: "exposed", reason: "quote_error" });
    const b = fake({ submits: [failed()], quotes: [q(96n * S)], heldThrows: true });
    expect(await exec(b).hedgeFill(fill)).toMatchObject({ status: "exposed", reason: "quote_error" });
    expect(b.log.submits).toHaveLength(1);
  });

  describe("unknown status", () => {
    const lost = (hash: string, expiresAtMs = 120_000): SubmitResult => ({ status: "unknown", hash, error: "timeout", expiresAtMs });

    it("the lost submission actually landed: found by hash, nothing is resent", async () => {
      const f = fake({ submits: [{ result: lost("h1"), lands: true }] }); // no more scripted submits: a second one would throw
      const e = exec(f);
      const r = await e.hedgeFill(fill);
      expect(r.status).toBe("hedged");
      expect(f.log.submits).toHaveLength(1);
      expect(f.log.quotes).toHaveLength(0);
      expect(f.log.statusChecks).toContain("h1");
      expect(e.exposures).toHaveLength(0);
    });

    it("the lost submission was included but FAILED: then it is safe to re-quote and retry", async () => {
      const f = fake({ submits: [{ result: lost("h1") }, ok("h2")], quotes: [q(96n * S)], txStatus: (h) => (h === "h1" ? "failed" : "not_found") });
      const r = await exec(f).hedgeFill(fill);
      expect(r.status).toBe("hedged");
      expect(f.log.submits).toHaveLength(2);
    });

    it("not found yet is NOT an answer: waits for its time bounds to pass before believing it, then retries", async () => {
      const f = fake({ submits: [{ result: lost("h1", 10_000) }, ok("h2")], quotes: [q(96n * S)] }); // never lands, expires at t=10s
      const r = await exec(f).hedgeFill(fill);
      expect(r.status).toBe("hedged");
      expect(f.st.now).toBeGreaterThan(10_000 + 30_000); // waited out expiry + grace
      expect(f.log.submits).toHaveLength(2);
      expect(f.log.statusChecks.length).toBeGreaterThan(2);
    });

    it("status says not found past expiry but the balance shows the position is gone: believes the chain balance, never resends", async () => {
      // the tx landed but the RPC status index is behind: held already dropped, status stays not_found
      const f = fake({ submits: [{ result: lost("h1", 5_000) }], txStatus: () => "not_found" });
      f.st.held = 0n; // the lost hedge did sell the position
      const r = await exec(f).hedgeFill(fill);
      expect(r.status).toBe("hedged");
      expect(f.log.submits).toHaveLength(1);
    });

    it("cannot be settled in time: exposure unknown_status with the hash attached, nothing resent; breaker trips; later settled by retryExposure", async () => {
      let status: TxStatus | Error = new Error("rpc down");
      const f = fake({ submits: [{ result: lost("h1") }], txStatus: () => status });
      const e = exec(f, { unknownResolveTimeoutMs: 20_000 });
      const r = await e.hedgeFill(fill);
      expect(r).toMatchObject({ status: "exposed", reason: "unknown_status" });
      expect(f.log.submits).toHaveLength(1);
      expect(e.exposures[0]!.pendingHashes).toEqual([{ hash: "h1", expiresAtMs: 120_000 }]);
      expect(e.canFill().ok).toBe(false);

      // retryExposure with the status still unreadable: still nothing sent
      const again = await e.retryExposure();
      expect(again).toMatchObject({ status: "exposed", reason: "unknown_status" });
      expect(f.log.submits).toHaveLength(1);

      // the RPC recovers and reports the original hedge landed: exposure cleared, STILL one submission in total
      status = "success";
      f.st.held = 0n;
      const done = await e.retryExposure();
      expect(done).toMatchObject({ status: "hedged" });
      expect(f.log.submits).toHaveLength(1);
      expect(e.exposures).toHaveLength(0);
      expect(e.canFill().ok).toBe(true);
    });
  });

  describe("circuit breaker and exposure recovery", () => {
    const exposeIt = async (quoteOut = 93n * S, cfg = {}) => {
      const f = fake({ submits: [failed()], quotes: [q(quoteOut)] });
      const e = exec(f, cfg);
      await e.hedgeFill(fill);
      return { f, e };
    };

    it("blocks fills while exposed; guardedEvaluate refuses with the breaker reason and does not run the evaluation", async () => {
      const { e } = await exposeIt();
      let ran = false;
      const d = guardedEvaluate(e, () => ((ran = true), { action: "skip", reasons: [] }));
      expect(d).toMatchObject({ action: "refuse", reason: "circuit_breaker" });
      expect(ran).toBe(false);
      expect((d as { detail: string }).detail).toMatch(/circuit breaker/);
    });

    it("a clean breaker lets the evaluation through, with the real evaluateFill", () => {
      const e = exec(fake());
      const order: Order = { user: "GU", tokenIn: "CA", amountIn: 100n * S, tokenOut: "CC", minOut: 90n * S, deadline: 2e9, createTrustline: true };
      const params: SolverParams = { nowMs: 1e12, minDeadlineBufferSec: 120, maxOrderIn: 1000n * S, solverBalanceOut: 1000n * S, hedgeSlippageBps: 50, minProfitBps: 20, networkFeeOut: 0n, improvementShareBps: 0 };
      const d = guardedEvaluate(e, () => evaluateFill(order, { amountIn: 100n * S, amountOut: 96n * S }, params));
      expect(d.action).toBe("fill");
    });

    it("the cap is a threshold: exposure at or under it does not trip the breaker", async () => {
      const { e } = await exposeIt(93n * S, { maxUnhedgedExposureOut: 93n * S });
      expect(e.exposures).toHaveLength(1);
      expect(e.canFill().ok).toBe(true);
      const { e: e2 } = await exposeIt(93n * S, { maxUnhedgedExposureOut: 93n * S - 1n });
      expect(e2.canFill().ok).toBe(false);
    });

    it("retryExposure while the market is still bad: refuses again, sends nothing, breaker stays tripped", async () => {
      const { f, e } = await exposeIt();
      f.st.now = 5_000;
      (f.io as { quote: unknown }).quote = async () => q(92n * S);
      const r = await e.retryExposure();
      expect(r).toMatchObject({ status: "exposed", reason: "loss_bound_exceeded" });
      expect(f.log.submits).toHaveLength(1);
      expect(e.exposures[0]).toMatchObject({ updatedAtMs: 5_000, atMs: 0, markValueOut: 92n * S });
      expect(e.canFill().ok).toBe(false);
    });

    it("retryExposure after liquidity returns: hedges, clears the exposure, breaker resets", async () => {
      const { f, e } = await exposeIt();
      (f.io as { quote: unknown }).quote = async () => q(96n * S);
      let sent = 0; // the chain sells the position when this hedge is submitted
      f.io.submit = async (leg, minOut) => {
        f.log.submits.push({ minOut, amountIn: leg.amountIn });
        sent++;
        f.st.held -= leg.amountIn;
        return { status: "success", hash: "h-late", proceedsOut: 96n * S };
      };
      const r = await e.retryExposure();
      expect(r).toMatchObject({ status: "hedged", proceedsOut: 96n * S });
      expect(sent).toBe(1);
      expect(e.exposures).toHaveLength(0);
      expect(e.canFill()).toEqual({ ok: true });
      expect(await e.retryExposure()).toBeUndefined(); // nothing left to retry
    });

    it("retryExposure hedges only what the chain says is still unsold", async () => {
      const { f, e } = await exposeIt();
      f.st.held = 40n * S; // 60 A were sold some other way
      let seenIn = 0n;
      (f.io as { quote: unknown }).quote = async (a: bigint) => ((seenIn = a), q(384_000_000n, a));
      f.io.submit = async (leg) => ((f.st.held -= leg.amountIn), { status: "success", hash: "h", proceedsOut: 38n * S });
      const r = await e.retryExposure();
      expect(seenIn).toBe(40n * S);
      expect(r?.status).toBe("hedged");
    });

    it("an operator can accept a known loss explicitly with a wider bound; the default never does", async () => {
      const { f, e } = await exposeIt();
      (f.io as { quote: unknown }).quote = async () => q(93n * S);
      f.io.submit = async (leg, minOut) => ((f.st.held -= leg.amountIn), f.log.submits.push({ minOut, amountIn: leg.amountIn }), { status: "success", hash: "h", proceedsOut: 93n * S });
      expect(await e.retryExposure()).toMatchObject({ status: "exposed" });
      const r = await e.retryExposure(undefined, { maxLossBps: 400 });
      expect(r!.status).toBe("hedged");
      expect(e.canFill().ok).toBe(true);
    });

    it("clearExposure resets the breaker manually", async () => {
      const { e } = await exposeIt();
      expect(e.canFill().ok).toBe(false);
      expect(e.clearExposure("fill1")).toBe(true);
      expect(e.canFill().ok).toBe(true);
      expect(e.clearExposure("fill1")).toBe(false);
    });

    it("exposures of different assets are capped separately; the ledger reports changes for persistence", () => {
      const seen: number[] = [];
      const l = new ExposureLedger((all) => seen.push(all.length));
      const base = { token: "A", amount: 1n, markStale: false, reason: "no_path" as const, detail: "", atMs: 0, updatedAtMs: 0, attempts: 1, pendingHashes: [], fill };
      l.add({ ...base, id: "x", markValueOut: 5n, markAsset: "C" });
      l.add({ ...base, id: "y", markValueOut: 5n, markAsset: "D" });
      expect(l.canFill(5n).ok).toBe(true);
      l.add({ ...base, id: "z", markValueOut: 1n, markAsset: "C" });
      expect(l.canFill(5n).ok).toBe(false);
      l.resolve("z");
      expect(l.canFill(5n).ok).toBe(true);
      expect(seen).toEqual([1, 2, 3, 2]);
    });
  });

  it("fillRecordFrom copies the decision's numbers", () => {
    const order: Order = { user: "GU", tokenIn: "CA", amountIn: 100n * S, tokenOut: "CC", minOut: 90n * S, deadline: 2e9, createTrustline: true };
    const params: SolverParams = { nowMs: 1e12, minDeadlineBufferSec: 120, maxOrderIn: 1000n * S, solverBalanceOut: 1000n * S, hedgeSlippageBps: 50, minProfitBps: 20, networkFeeOut: S / 50n, improvementShareBps: 5000 };
    const quoted = q(96n * S);
    const d = evaluateFill(order, quoted.quote, params);
    if (d.action !== "fill") throw new Error("expected fill");
    const r = fillRecordFrom(d, { id: "x", tokenIn: "A", tokenOut: "C", amountIn: order.amountIn, quoted, baselineIn: 7n });
    expect(r).toMatchObject({ amountOutPaid: d.amountOut, hedgeMinOut: d.hedgeMinOut, feesOut: S / 50n, expectedProfitOut: d.expectedProfitOut, baselineIn: 7n });
  });
});
