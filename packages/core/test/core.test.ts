import { describe, expect, it } from "vitest";
import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
import { planExecution, AQUARIUS_ROUTER, SOROSWAP_ROUTER, buildAquariusSwap, buildSluiceRouterSwap, applyBps, buildClassicSwap, classify, formatAmount, parseAmount, penaltyFn, planZap, Router, scoreStablecoin, sacId } from "../src/index.js";
import type { Leg } from "../src/index.js";
import { AQUA, fakeSource, USDC, XLM } from "./helpers.js";

const leg = (layer: "classic" | "soroban"): Leg => ({
  venue: "v", layer, assetIn: XLM, assetOut: USDC, amountIn: 1n, amountOut: 1n, hops: [],
});

describe("amounts", () => {
  it("round-trips 7-decimal values", () => {
    expect(parseAmount("12.3456789")).toBe(123456789n);
    expect(formatAmount(123456789n)).toBe("12.3456789");
    expect(formatAmount(parseAmount("0.0000001"))).toBe("0.0000001");
  });
  it("rejects more than 7 decimals and garbage", () => {
    expect(() => parseAmount("1.12345678")).toThrow();
    expect(() => parseAmount("abc")).toThrow();
  });
  it("applies bps", () => expect(applyBps(10_000n, 50)).toBe(9_950n));
});

describe("classify", () => {
  it("soroban-only is atomic", () => expect(classify([leg("soroban"), leg("soroban")])).toBe("ATOMIC_SOROBAN"));
  it("single classic leg is one path payment", () => expect(classify([leg("classic")])).toBe("CLASSIC_ONLY"));
  it("mixed layers cannot be atomic", () => expect(classify([leg("classic"), leg("soroban")])).toBe("TWO_STEP"));
  it("rejects empty", () => expect(() => classify([])).toThrow());
});

describe("router", () => {
  const classic = fakeSource("classic", "classic", { [`${XLM}>${USDC}`]: 1_000, [`${USDC}>${AQUA}`]: 5_000 });
  const soroban = fakeSource("amm", "soroban", { [`${XLM}>${USDC}`]: 990, [`${USDC}>${AQUA}`]: 5_100 });

  it("ranks the best single venue first and tags atomicity", async () => {
    const r = new Router({ sources: [classic, soroban], hubs: [] });
    const { routes } = await r.quote({ assetIn: XLM, assetOut: USDC, amountIn: parseAmount("100") });
    expect(routes[0]!.legs[0]!.venue).toBe("classic");
    expect(routes[0]!.atomicity).toBe("CLASSIC_ONLY");
    expect(routes[1]!.atomicity).toBe("ATOMIC_SOROBAN");
  });

  it("builds a cross-layer route through a hub and flags it non-atomic", async () => {
    // XLM>AQUA exists nowhere directly. Best path: classic XLM>USDC then soroban USDC>AQUA.
    const r = new Router({ sources: [classic, soroban], hubs: [USDC] });
    const { routes } = await r.quote({ assetIn: XLM, assetOut: AQUA, amountIn: parseAmount("100") });
    const cross = routes.find((x) => x.atomicity === "TWO_STEP");
    expect(cross).toBeDefined();
    expect(cross!.legs.map((l) => l.layer)).toEqual(["classic", "soroban"]);
    expect(cross!.risks.some((x) => x.code === "NON_ATOMIC")).toBe(true);
    expect(cross!.effectiveOut).toBeLessThan(cross!.amountOut);
    expect(cross!.minOuts).toHaveLength(2);
  });

  it("does not synthesise same-layer two-leg routes", async () => {
    const r = new Router({ sources: [soroban], hubs: [USDC] });
    const { routes } = await r.quote({ assetIn: XLM, assetOut: AQUA, amountIn: parseAmount("1") });
    expect(routes).toHaveLength(0);
  });

  it("keeps working when a source throws and reports it", async () => {
    const bad = { id: "bad", layer: "soroban" as const, quote: async () => { throw new Error("boom"); } };
    const r = new Router({ sources: [classic, bad], hubs: [] });
    const { routes, errors } = await r.quote({ assetIn: XLM, assetOut: USDC, amountIn: parseAmount("1") });
    expect(routes).toHaveLength(1);
    expect(errors).toEqual([{ source: "bad", error: "boom" }]);
  });

  it("times out slow sources", async () => {
    const slow = { id: "slow", layer: "soroban" as const, quote: () => new Promise<null>(() => {}) };
    const r = new Router({ sources: [slow], hubs: [], timeoutMs: 20 });
    const { errors } = await r.quote({ assetIn: XLM, assetOut: USDC, amountIn: 1n });
    expect(errors[0]!.error).toMatch(/timed out/);
  });

  it("demotes routes through a poorly scored stablecoin", async () => {
    const scores = new Map([[USDC, scoreStablecoin({ pegPrice: 0.97, depthNearPeg: 100, authRequired: false, clawback: false })]]);
    const plain = new Router({ sources: [classic, soroban], hubs: [] });
    const scored = new Router({ sources: [classic, soroban], hubs: [], assetPenaltyBps: penaltyFn(scores) });
    const a = (await plain.quote({ assetIn: XLM, assetOut: USDC, amountIn: parseAmount("100") })).routes[0]!;
    const b = (await scored.quote({ assetIn: XLM, assetOut: USDC, amountIn: parseAmount("100") })).routes[0]!;
    expect(b.effectiveOut).toBeLessThan(a.effectiveOut);
    expect(b.risks.some((x) => x.code === "STABLECOIN_PENALTY")).toBe(true);
  });
});

describe("stablecoin scoring", () => {
  it("scores a healthy coin at 100 with no penalty", () => {
    const s = scoreStablecoin({ pegPrice: 1, depthNearPeg: 1_000_000, authRequired: false, clawback: false });
    expect(s).toMatchObject({ score: 100, penaltyBps: 0 });
  });
  it("explains every deduction", () => {
    const s = scoreStablecoin({ pegPrice: 0.98, depthNearPeg: 500, authRequired: true, clawback: true, topHolderShare: 0.9 });
    expect(s.score).toBeLessThan(50);
    expect(s.reasons.length).toBe(5);
    expect(s.penaltyBps).toBeGreaterThan(100);
  });
});

describe("zap", () => {
  const vault = { vault: "CVAULT", underlying: USDC, protocol: "defindex" as const };
  it("skips the swap when already holding the underlying", async () => {
    const r = new Router({ sources: [], hubs: [] });
    const p = await planZap(r, { assetIn: USDC, assetOut: USDC, amountIn: 1n }, vault);
    expect(p).toMatchObject({ noSwapNeeded: true, fullyAtomic: true, swap: null });
  });
  it("marks a Classic swap as not atomic with the deposit", async () => {
    const r = new Router({ sources: [fakeSource("classic", "classic", { [`${XLM}>${USDC}`]: 1_000 })], hubs: [] });
    const p = await planZap(r, { assetIn: XLM, assetOut: USDC, amountIn: 1_000_000n }, vault);
    expect(p.fullyAtomic).toBe(false);
    expect(p.notes[0]).toMatch(/deposit/);
  });
  it("is atomic for a Soroban swap", async () => {
    const r = new Router({ sources: [fakeSource("amm", "soroban", { [`${XLM}>${USDC}`]: 1_000 })], hubs: [] });
    const p = await planZap(r, { assetIn: XLM, assetOut: USDC, amountIn: 1_000_000n }, vault);
    expect(p.fullyAtomic).toBe(true);
  });
});

describe("classic executor", () => {
  it("builds a PathPaymentStrictSend with min-out and path", () => {
    const kp = Keypair.random();
    const l: Leg = { venue: "classic-path", layer: "classic", assetIn: XLM, assetOut: AQUA, amountIn: parseAmount("10"), amountOut: parseAmount("100"), hops: [USDC] };
    const xdr = buildClassicSwap(l, { source: kp.publicKey(), sequence: "1", minOut: parseAmount("99.5"), passphrase: Networks.PUBLIC });
    const tx = new Transaction(xdr, Networks.PUBLIC);
    const op = tx.operations[0]!;
    expect(op.type).toBe("pathPaymentStrictSend");
    if (op.type === "pathPaymentStrictSend") {
      expect(op.sendAmount).toBe("10.0000000");
      expect(op.destMin).toBe("99.5000000");
      expect(op.path).toHaveLength(1);
    }
  });
  it("refuses a soroban leg", () => {
    expect(() => buildClassicSwap(leg("soroban"), { source: Keypair.random().publicKey(), sequence: "1", minOut: 1n })).toThrow();
  });
});

describe("sac ids", () => {
  it("derives the known XLM SAC on mainnet", () => {
    expect(sacId("native")).toBe("CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA");
  });
});

describe("soroban builders", () => {
  const SRC = Keypair.random().publicKey();
  const T1 = sacId(USDC);
  const T2 = sacId(AQUA);
  it("builds an Aquarius swap_chained call that carries the API's swaps_chain verbatim", async () => {
    const { xdr, scValToNative, nativeToScVal } = await import("@stellar/stellar-sdk");
    const chain = xdr.ScVal.scvVec([]).toXDR("base64");
    const txXdr = buildAquariusSwap({ source: SRC, sequence: "1", swapChainXdr: chain, tokenIn: T1, amountIn: 10n, minOut: 9n });
    const tx = new Transaction(txXdr, Networks.PUBLIC);
    const op = tx.operations[0]!;
    expect(op.type).toBe("invokeHostFunction");
    const fn = (op as any).func.invokeContract();
    expect(fn.functionName().toString()).toBe("swap_chained");
    const args = fn.args();
    expect(args).toHaveLength(5);
    expect(args[1]!.toXDR("base64")).toBe(chain);
    expect(scValToNative(args[3]!)).toBe(10n);
    expect(scValToNative(args[4]!)).toBe(9n);
    expect(nativeToScVal(1n, { type: "u128" }).switch().name).toBe("scvU128");
    expect(args[3]!.switch().name).toBe("scvU128");
  });
  it("builds a Sluice router call with map-encoded legs and i128/u64 numbers", () => {
    const txXdr = buildSluiceRouterSwap({
      source: SRC, sequence: "1", routerContract: SOROSWAP_ROUTER,
      legs: [{ kind: "Phoenix", venue: AQUARIUS_ROUTER, path: [T1, T2] }], amountIn: 100n, minOut: 90n, deadline: 2_000_000_000n,
    });
    const op = new Transaction(txXdr, Networks.PUBLIC).operations[0]! as any;
    const fn = op.func.invokeContract();
    expect(fn.functionName().toString()).toBe("swap_exact_in");
    const a = fn.args();
    expect(a[2].switch().name).toBe("scvI128");
    expect(a[4].switch().name).toBe("scvU64");
    // Soroban structs are maps with keys sorted alphabetically.
    const leg = a[1].vec()[0].map();
    expect(leg.map((e: any) => e.key().sym().toString())).toEqual(["kind", "path", "venue"]);
    // Unit enum variants encode as a one-element vec holding the variant symbol.
    expect(leg[0].val().vec()[0].sym().toString()).toBe("Phoenix");
  });
});

describe("planExecution", () => {
  const kp = Keypair.random().publicKey();
  const classicLeg: Leg = { venue: "classic-path", layer: "classic", assetIn: XLM, assetOut: USDC, amountIn: parseAmount("10"), amountOut: parseAmount("2"), hops: [] };
  const aquaLeg: Leg = { venue: "aquarius", layer: "soroban", assetIn: USDC, assetOut: AQUA, amountIn: parseAmount("2"), amountOut: parseAmount("500"), hops: [], raw: { swap_chain_xdr: "AAAAEAAAAAA=" } };
  const mk = (legs: Leg[]) => new Router({ sources: [], hubs: [] }) && ({ legs, atomicity: classify(legs), minOuts: legs.map((l) => applyBps(l.amountOut, 50)) } as any);

  it("pre-builds only leg 1 of a two-step route and defers the rest", () => {
    const steps = planExecution(mk([classicLeg, aquaLeg]), { account: kp, sequence: "5" });
    expect(steps.map((s) => s.kind)).toEqual(["transaction", "deferred"]);
    expect((steps[1] as any).reason).toMatch(/re-quote/);
  });
  it("builds an atomic aquarius route and flags it for simulation", () => {
    const steps = planExecution(mk([aquaLeg]), { account: kp, sequence: "5" });
    expect(steps[0]).toMatchObject({ kind: "transaction", venue: "aquarius", needsSimulation: true });
  });
  it("builds a classic-only route without simulation", () => {
    const steps = planExecution(mk([classicLeg]), { account: kp, sequence: "5" });
    expect(steps[0]).toMatchObject({ kind: "transaction", layer: "classic", needsSimulation: false });
  });
  it("refuses to guess for an unverified venue or missing payload", () => {
    const soro: Leg = { ...aquaLeg, venue: "soroswap", raw: undefined };
    expect(planExecution(mk([soro]), { account: kp, sequence: "5" })[0]!.kind).toBe("unsupported");
    const noRaw: Leg = { ...aquaLeg, raw: {} };
    expect(planExecution(mk([noRaw]), { account: kp, sequence: "5" })[0]!.kind).toBe("unsupported");
  });
});

describe("comet math", () => {
  // Real mainnet data point (2026-10-08): Blend Comet pool, 5 USDC in, pool returned 6,991,583,332 BLND stroops.
  it("matches a real on-chain swap to within the one-stroop safety margin", async () => {
    const { cometAmountOut } = await import("../src/index.js");
    const out = cometAmountOut({ balIn: 466828018n, balOut: 279152368428n, wIn: 2000000n, wOut: 8000000n, fee: 30000n, amountIn: 50000000n });
    expect(out).toBe(6991583332n);
  });
  it("refuses trades above the max in-ratio and non-positive inputs", async () => {
    const { cometAmountOut } = await import("../src/index.js");
    const base = { balIn: 1_000_000n, balOut: 1_000_000n, wIn: 5000000n, wOut: 5000000n, fee: 30000n };
    expect(cometAmountOut({ ...base, amountIn: 500_001n })).toBe(0n);
    expect(cometAmountOut({ ...base, amountIn: 0n })).toBe(0n);
    expect(cometAmountOut({ ...base, amountIn: 100_000n })).toBeGreaterThan(0n);
  });
});

describe("phoenix and comet builders", () => {
  const SRC = Keypair.random().publicKey();
  const T1 = sacId(USDC);
  const T2 = sacId(AQUA);
  it("encodes Phoenix swap with Some(min) as a bare i128 and the rest as void", async () => {
    const { buildPhoenixSwap } = await import("../src/index.js");
    const op = new Transaction(buildPhoenixSwap({ source: SRC, sequence: "1", pool: T2, offerAsset: T1, amountIn: 7n, minOut: 5n }), Networks.PUBLIC).operations[0]! as any;
    const fn = op.func.invokeContract();
    expect(fn.functionName().toString()).toBe("swap");
    const a = fn.args();
    expect(a).toHaveLength(7);
    expect(a[2].switch().name).toBe("scvI128");
    expect(a[3].switch().name).toBe("scvI128");
    expect([4, 5, 6].map((i) => a[i].switch().name)).toEqual(["scvVoid", "scvVoid", "scvVoid"]);
  });
  it("encodes Comet swap_exact_amount_in with the user last", async () => {
    const { buildCometSwap, COMET_MAX_PRICE } = await import("../src/index.js");
    const { scValToNative } = await import("@stellar/stellar-sdk");
    const op = new Transaction(buildCometSwap({ source: SRC, sequence: "1", pool: T2, tokenIn: T1, tokenOut: T2, amountIn: 7n, minOut: 5n }), Networks.PUBLIC).operations[0]! as any;
    const fn = op.func.invokeContract();
    expect(fn.functionName().toString()).toBe("swap_exact_amount_in");
    const a = fn.args();
    expect(a).toHaveLength(6);
    expect(scValToNative(a[4])).toBe(COMET_MAX_PRICE);
    expect(scValToNative(a[5])).toBe(SRC);
  });
  it("plans phoenix and comet legs as simulatable transactions", () => {
    const kp = Keypair.random().publicKey();
    const ph: Leg = { venue: "phoenix", layer: "soroban", assetIn: XLM, assetOut: USDC, amountIn: 10n, amountOut: 9n, hops: [], raw: { pool: T2, offerAsset: sacId(XLM) } };
    const co: Leg = { venue: "comet", layer: "soroban", assetIn: USDC, assetOut: AQUA, amountIn: 10n, amountOut: 9n, hops: [], raw: { pool: T2, tokenIn: T1, tokenOut: T2 } };
    const mk = (l: Leg) => ({ legs: [l], atomicity: "ATOMIC_SOROBAN", minOuts: [8n] }) as any;
    expect(planExecution(mk(ph), { account: kp, sequence: "1" })[0]).toMatchObject({ kind: "transaction", venue: "phoenix", needsSimulation: true });
    expect(planExecution(mk(co), { account: kp, sequence: "1" })[0]).toMatchObject({ kind: "transaction", venue: "comet", needsSimulation: true });
    expect(planExecution(mk({ ...ph, raw: undefined }), { account: kp, sequence: "1" })[0]!.kind).toBe("unsupported");
  });
});

describe("stablecoin data feed", () => {
  const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const COIN = `TUSD:${ISSUER}`;
  const mkFetch = (priceBySize: Record<string, string>, flags: object = {}, assetsOk = true) =>
    (async (u: URL) => {
      const url = new URL(String(u));
      if (url.pathname === "/paths/strict-send") {
        const amt = url.searchParams.get("source_amount")!;
        const out = priceBySize[Number(amt).toString()];
        return new Response(JSON.stringify({ _embedded: { records: out ? [{ destination_amount: out }] : [] } }), { status: 200 });
      }
      if (url.pathname === "/assets") return new Response(JSON.stringify({ _embedded: { records: assetsOk ? [{ flags }] : [] } }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

  it("derives peg price, depth and issuer flags from executable quotes", async () => {
    const { fetchStablecoinSignals } = await import("../src/index.js");
    // 100 units -> 99.9, 1,000 -> 999, 10,000 -> 9,900 (about 1% worse), 100,000 -> no path
    const f = mkFetch({ "100": "99.9000000", "1000": "999.0000000", "10000": "9900.0000000" }, { auth_required: true, auth_clawback_enabled: false });
    const s = await fetchStablecoinSignals(COIN, { fetchImpl: f });
    expect(s.pegPrice).toBeCloseTo(0.999, 6);
    expect(s.depthNearPeg).toBe(1_000);
    expect(s.authRequired).toBe(true);
    expect(s.clawback).toBe(false);
    expect(s.topHolderShare).toBeUndefined();
  });
  it("honours an expected non-USD price", async () => {
    const { fetchStablecoinSignals } = await import("../src/index.js");
    const f = mkFetch({ "100": "117.0000000", "1000": "1170.0000000", "10000": "11700.0000000", "100000": "117000.0000000" });
    const s = await fetchStablecoinSignals(COIN, { fetchImpl: f, expectedPrice: 1.17 });
    expect(s.pegPrice).toBeCloseTo(1, 6);
    expect(s.depthNearPeg).toBe(100_000);
  });
  it("throws instead of guessing when there is no path or the asset is unknown", async () => {
    const { fetchStablecoinSignals } = await import("../src/index.js");
    await expect(fetchStablecoinSignals(COIN, { fetchImpl: mkFetch({}) })).rejects.toThrow(/no executable path/);
    await expect(fetchStablecoinSignals(COIN, { fetchImpl: mkFetch({ "100": "99", "1000": "990", "10000": "9900", "100000": "99000" }, {}, false) })).rejects.toThrow(/not found/);
    await expect(fetchStablecoinSignals("native")).rejects.toThrow(/not a stablecoin/);
  });
  it("scorer caches scores, keeps old ones on failure and gives unscored assets no penalty", async () => {
    const { createStablecoinScorer } = await import("../src/index.js");
    let ok = true;
    const good = mkFetch({ "100": "96.0000000", "1000": "960.0000000", "10000": "9600.0000000", "100000": "96000.0000000" });
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const scorer = createStablecoinScorer([COIN], { fetchImpl: ((u: URL) => (ok ? good : bad)(u)) as typeof fetch });
    await scorer.refresh();
    const first = scorer.penaltyBps(COIN);
    expect(first).toBeGreaterThan(0);
    ok = false;
    await scorer.refresh();
    expect(scorer.penaltyBps(COIN)).toBe(first);
    expect(scorer.errors.has(COIN)).toBe(true);
    expect(scorer.penaltyBps(`OTHER:${ISSUER}`)).toBe(0);
  });
});

describe("same-layer chains through the Sluice contract", () => {
  const venueA = (id: string, rates: Record<string, number>) => {
    const s = fakeSource(id, "soroban", rates);
    return s;
  };
  const a = venueA("phoenix", { [`${XLM}>${USDC}`]: 2_000 });
  const b = venueA("comet", { [`${USDC}>${AQUA}`]: 10_000 });
  const arb = venueA("aquarius", { [`${USDC}>${AQUA}`]: 10_000 });

  it("is off by default and on when chainVenues is set", async () => {
    const off = await new Router({ sources: [a, b], hubs: [USDC] }).quote({ assetIn: XLM, assetOut: AQUA, amountIn: parseAmount("1") });
    expect(off.routes).toHaveLength(0);
    const on = await new Router({ sources: [a, b], hubs: [USDC], chainVenues: ["phoenix", "comet"] }).quote({ assetIn: XLM, assetOut: AQUA, amountIn: parseAmount("1") });
    expect(on.routes).toHaveLength(1);
    expect(on.routes[0]!.atomicity).toBe("ATOMIC_SOROBAN");
    expect(on.routes[0]!.legs.map((l) => l.venue)).toEqual(["phoenix", "comet"]);
  });
  it("never chains venues the contract cannot run, or a venue with itself", async () => {
    const r = await new Router({ sources: [a, arb], hubs: [USDC], chainVenues: ["phoenix", "comet"] }).quote({ assetIn: XLM, assetOut: AQUA, amountIn: parseAmount("1") });
    expect(r.routes).toHaveLength(0);
  });

  const chain = (): any => {
    const l1: Leg = { venue: "phoenix", layer: "soroban", assetIn: XLM, assetOut: USDC, amountIn: 10n, amountOut: 20n, hops: [], raw: { pool: sacId(AQUA), offerAsset: sacId(XLM) } };
    const l2: Leg = { venue: "comet", layer: "soroban", assetIn: USDC, assetOut: AQUA, amountIn: 20n, amountOut: 18n, hops: [], raw: { pool: sacId(AQUA), tokenIn: sacId(USDC), tokenOut: sacId(AQUA) } };
    return { legs: [l1, l2], atomicity: "ATOMIC_SOROBAN", amountIn: 10n, minOuts: [19n, 17n] };
  };
  it("plans one router-contract transaction and marks the rest included", () => {
    const kp = Keypair.random().publicKey();
    const steps = planExecution(chain(), { account: kp, sequence: "1", routerContract: SOROSWAP_ROUTER, deadline: 2_000_000_000n });
    expect(steps.map((s) => s.kind)).toEqual(["transaction", "deferred"]);
    const op = new Transaction((steps[0] as any).xdr, Networks.PUBLIC).operations[0]! as any;
    const fn = op.func.invokeContract();
    expect(fn.functionName().toString()).toBe("swap_exact_in");
    const legs = fn.args()[1].vec();
    expect(legs).toHaveLength(2);
    expect(legs.map((l: any) => l.map()[0].val().vec()[0].sym().toString())).toEqual(["Phoenix", "Comet"]);
    expect(Number(fn.args()[3].i128().lo().toString())).toBe(17); // min out is the final leg's
  });
  it("refuses without a router contract or with an unsupported leg", () => {
    const kp = Keypair.random().publicKey();
    expect(planExecution(chain(), { account: kp, sequence: "1" }).every((s) => s.kind === "unsupported")).toBe(true);
    const c = chain();
    c.legs[1] = { ...c.legs[1], venue: "aquarius", raw: {} };
    const steps = planExecution(c, { account: kp, sequence: "1", routerContract: SOROSWAP_ROUTER });
    expect(steps.every((s) => s.kind === "unsupported")).toBe(true);
    expect((steps[0] as any).reason).toMatch(/Leg 1/);
  });
});
