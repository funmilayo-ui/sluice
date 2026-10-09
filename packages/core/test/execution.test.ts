import { describe, expect, it } from "vitest";
import { Asset, Keypair, nativeToScVal, Networks, Operation, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import {
  blendRates, buildChangeTrust, buildClassicSwap, buildCometSwap, buildSoroswapSwap, buildVaultDeposit, buildVaultWithdraw, createAssetList, createCachedLookup, createGate,
  createStablecoinScorer, describeReserve, EXPLAINED_RESULT_CODES, explainCodes, explainSimulation, fetchStablecoinSignals, mergeAssetLists,
  parseHorizonAccount, parseSignedTx, planExecution, receivedAmount, resultCodes, Router, routeKey, sacId, scoreStablecoin, SOROSWAP_ROUTER,
} from "../src/index.js";
import type { Leg } from "../src/index.js";
import { AQUA, fakeSource, USDC, XLM } from "./helpers.js";

const kp = Keypair.random();
const G = kp.publicKey();
const POOL = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";
const classicLeg: Leg = { venue: "classic-path", layer: "classic", assetIn: XLM, assetOut: USDC, amountIn: 10_000_000n, amountOut: 2_000_000n, hops: [] };
const b64 = (v: xdr.ScVal) => v.toXDR("base64");
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

describe("routeKey", () => {
  it("is stable across re-quotes at a different price and unique within a quote", async () => {
    const mk = (rate: number) => new Router({
      sources: [fakeSource("classic-path", "classic", { [`${XLM}>${USDC}`]: rate, [`${USDC}>${AQUA}`]: 5_000 }), fakeSource("amm", "soroban", { [`${XLM}>${USDC}`]: 990, [`${USDC}>${AQUA}`]: 5_100 })],
      hubs: [USDC],
    });
    const a = (await mk(1_000).quote({ assetIn: XLM, assetOut: USDC, amountIn: 10n ** 9n })).routes;
    const b = (await mk(900).quote({ assetIn: XLM, assetOut: USDC, amountIn: 10n ** 9n })).routes;
    // The price change flips the ranking, so an index would now point at the other venue.
    expect(a[0]!.legs[0]!.venue).not.toBe(b[0]!.legs[0]!.venue);
    expect(a.map(routeKey).sort()).toEqual(b.map(routeKey).sort());
    const cross = (await mk(1_000).quote({ assetIn: XLM, assetOut: AQUA, amountIn: 10n ** 9n })).routes;
    expect(new Set(cross.map(routeKey)).size).toBe(cross.length);
    expect(routeKey(cross.find((r) => r.legs.length === 2)!)).toContain("|");
  });
});

describe("stablecoin penalty note", () => {
  it("names the asset that caused it, taking the worst when several are penalised", async () => {
    const r = new Router({
      sources: [fakeSource("amm", "soroban", { [`${XLM}>${USDC}`]: 1_000, [`${USDC}>${AQUA}`]: 5_000 }), fakeSource("classic-path", "classic", { [`${XLM}>${USDC}`]: 990 })],
      hubs: [USDC],
      assetPenaltyBps: (a) => (a === USDC ? 22 : a === AQUA ? 5 : 0),
    });
    const { routes } = await r.quote({ assetIn: XLM, assetOut: AQUA, amountIn: 10n ** 9n });
    const note = routes[0]!.risks.find((x) => x.code === "STABLECOIN_PENALTY")!;
    expect(note.message).toBe("This route passes through USDC, which is ranked down by 22 bps for its current health score.");
    expect(routes[0]!.effectiveOut).toBeLessThan(routes[0]!.amountOut);
  });
});

describe("transaction validity window", () => {
  const maxTime = (x: string) => Number((TransactionBuilder.fromXDR(x, Networks.PUBLIC) as Transaction).timeBounds!.maxTime);
  const now = Math.floor(Date.now() / 1000);
  it("defaults to 60s and honours timeoutSec in every builder", () => {
    const route = { legs: [classicLeg], atomicity: "CLASSIC_ONLY" as const, assetIn: XLM, assetOut: USDC, amountIn: 10_000_000n, amountOut: 2_000_000n, effectiveOut: 2_000_000n, minOuts: [1_990_000n], risks: [] };
    const short = planExecution(route, { account: G, sequence: "1" })[0]!;
    const long = planExecution(route, { account: G, sequence: "1", timeoutSec: 300 })[0]!;
    if (short.kind !== "transaction" || long.kind !== "transaction") throw new Error("expected transactions");
    expect(maxTime(short.xdr) - now).toBeLessThanOrEqual(61);
    expect(maxTime(long.xdr) - now).toBeGreaterThanOrEqual(299);
    expect(maxTime(buildChangeTrust(USDC, { source: G, sequence: "1", timeoutSec: 300 })) - now).toBeGreaterThanOrEqual(299);
    expect(maxTime(buildVaultDeposit({ vault: POOL, underlying: USDC, protocol: "blend" }, USDC, 5n, { source: G, sequence: "1", timeoutSec: 300 })) - now).toBeGreaterThanOrEqual(299);
  });
});

describe("blend withdraw", () => {
  const reqType = (x: string) => {
    const op = (TransactionBuilder.fromXDR(x, Networks.PUBLIC) as Transaction).toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const req = op.args()[3]!.vec()![0]!.map()!;
    return { fn: op.functionName().toString(), type: req.find((e) => e.key().sym().toString() === "request_type")!.val().u32() };
  };
  it("is the same submit call with request type 1, deposit stays 0", () => {
    const t = { vault: POOL, underlying: USDC, protocol: "blend" as const };
    expect(reqType(buildVaultWithdraw(t, USDC, 5n, { source: G, sequence: "1" }))).toEqual({ fn: "submit", type: 1 });
    expect(reqType(buildVaultDeposit(t, USDC, 5n, { source: G, sequence: "1" }))).toEqual({ fn: "submit", type: 0 });
    expect(() => buildVaultWithdraw({ ...t, protocol: "defindex" }, USDC, 5n, { source: G, sequence: "1" })).toThrow(/not implemented/);
    expect(() => buildVaultWithdraw(t, USDC, 0n, { source: G, sequence: "1" })).toThrow(/positive/);
  });
});

describe("parseSignedTx", () => {
  const unsigned = buildClassicSwap(classicLeg, { source: G, sequence: "1", minOut: 1n });
  it("accepts a signed single-operation transaction", () => {
    const tx = TransactionBuilder.fromXDR(unsigned, Networks.PUBLIC) as Transaction;
    tx.sign(kp);
    expect(parseSignedTx(tx.toXDR()).operations).toHaveLength(1);
  });
  it("refuses unsigned, multi-operation, fee-bump and garbage envelopes", () => {
    expect(() => parseSignedTx(unsigned)).toThrow(/not signed/);
    expect(() => parseSignedTx("AAAA")).toThrow(/not a valid/);
    const acct = { accountId: () => G, sequenceNumber: () => "1", incrementSequenceNumber() {} };
    const two = new TransactionBuilder(acct as never, { fee: "100", networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC.split(":")[1]!) }))
      .addOperation(Operation.changeTrust({ asset: new Asset("AQUA", AQUA.split(":")[1]!) }))
      .setTimeout(60).build();
    two.sign(kp);
    expect(() => parseSignedTx(two.toXDR())).toThrow(/exactly one operation/);
    const inner = TransactionBuilder.fromXDR(unsigned, Networks.PUBLIC) as Transaction;
    inner.sign(kp);
    const bump = TransactionBuilder.buildFeeBumpTransaction(kp, "200", inner, Networks.PUBLIC);
    bump.sign(kp);
    expect(() => parseSignedTx(bump.toXDR())).toThrow(/fee bump/);
  });
});

/** A TransactionResult as the network returns it for one path payment. */
function pathPaymentResult(inner: xdr.PathPaymentStrictSendResult, ok: boolean): xdr.TransactionResult {
  const ops = [xdr.OperationResult.opInner(xdr.OperationResultTr.pathPaymentStrictSend(inner))];
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result: ok ? xdr.TransactionResultResult.txSuccess(ops) : xdr.TransactionResultResult.txFailed(ops),
    ext: new xdr.TransactionResultExt(0),
  });
}
const paid = (amount: string) =>
  xdr.PathPaymentStrictSendResult.pathPaymentStrictSendSuccess(
    new xdr.PathPaymentStrictSendResultSuccess({
      offers: [],
      last: new xdr.SimplePaymentResult({ destination: kp.xdrAccountId(), asset: new Asset("USDC", USDC.split(":")[1]!).toXDRObject(), amount: xdr.Int64.fromString(amount) }),
    }),
  );

describe("resultCodes and explainCodes", () => {
  it("reads the transaction code and the failing operation's code", () => {
    const failed = pathPaymentResult(xdr.PathPaymentStrictSendResult.pathPaymentStrictSendUnderDestmin(), false);
    expect(resultCodes(failed)).toEqual(["txFailed", "pathPaymentStrictSendUnderDestmin"]);
    const badSeq = new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString("0"), result: xdr.TransactionResultResult.txBadSeq(), ext: new xdr.TransactionResultExt(0) });
    expect(resultCodes(badSeq)).toEqual(["txBadSeq"]);
  });
  it("explains the specific operation failure, not the generic txFailed", () => {
    expect(explainCodes(["txFailed", "pathPaymentStrictSendUnderDestmin"])).toMatchObject({ code: "SLIPPAGE" });
    expect(explainCodes(["txBadSeq"])).toMatchObject({ code: "STALE_SEQUENCE" });
    expect(explainCodes(["txTooLate"]).message).toMatch(/expired/);
    expect(explainCodes(["txFailed", "somethingNew"])).toMatchObject({ code: "FAILED", detail: "txFailed, somethingNew" });
  });
  it("only maps code names the SDK actually defines", () => {
    const real = new Set(
      [xdr.TransactionResultCode, xdr.OperationResultCode, xdr.PathPaymentStrictSendResultCode, xdr.ChangeTrustResultCode, xdr.InvokeHostFunctionResultCode]
        .flatMap((e) => (e as unknown as { values(): { name: string }[] }).values().map((v) => v.name)),
    );
    expect(EXPLAINED_RESULT_CODES.filter((c) => !real.has(c))).toEqual([]);
  });
});

describe("explainSimulation", () => {
  // First line plus the decisive event, as returned by mainnet RPC on 2026-10-08.
  const head = "simulation failed: HostError: Error(Contract, #10)\n\nEvent log (newest first):\n";
  it("recognises an asset contract balance failure", () => {
    const raw = `${head}   2: [Failed Diagnostic Event (not emitted)] contract:CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range", 0, -9000000000000000, 9223372036854775807]`;
    expect(explainSimulation(raw)).toMatchObject({ code: "INSUFFICIENT_BALANCE", detail: "simulation failed: HostError: Error(Contract, #10)" });
  });
  it("tells an over-limit trustline from a shortfall", () => {
    const raw = `${head}   2: contract:C, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range", 0, 5000, 1000]`;
    expect(explainSimulation(raw).code).toBe("LINE_FULL");
  });
  it("recognises Soroswap's min-out error only when the router raised it", () => {
    const ev = (c: string) => `simulation failed: HostError: Error(Contract, #507)\n\n   0: [Diagnostic Event] contract:${c}, topics:[error, Error(Contract, #507)], data:"escalating"`;
    expect(explainSimulation(ev(SOROSWAP_ROUTER)).code).toBe("SLIPPAGE");
    expect(explainSimulation(ev(POOL)).code).toBe("SIMULATION_FAILED");
  });
  it("reads Blend's own error numbers only for a Blend call", () => {
    // #1217 is what mainnet returned for a withdrawal with nothing supplied (2026-10-08).
    const raw = "simulation failed: HostError: Error(Contract, #1217)\n\nEvent log";
    expect(explainSimulation(raw, "blend")).toMatchObject({ code: "NOTHING_TO_WITHDRAW" });
    expect(explainSimulation(raw).code).toBe("SIMULATION_FAILED");
    expect(explainSimulation("simulation failed: HostError: Error(Contract, #1220)", "blend").code).toBe("SUPPLY_CAP");
    expect(explainSimulation("simulation failed: HostError: Error(Contract, #9999)", "blend").code).toBe("SIMULATION_FAILED");
  });
  it("falls back to a plain statement and never leaks the event log into the detail", () => {
    const e = explainSimulation("simulation failed: HostError: Error(Contract, #337)\n\nEvent log (newest first):\n 0: lots of detail");
    expect(e.code).toBe("SIMULATION_FAILED");
    expect(e.detail).toBe("simulation failed: HostError: Error(Contract, #337)");
    expect(explainSimulation("classic-path timed out after 4000ms").code).toBe("NETWORK");
  });
});

describe("receivedAmount", () => {
  it("reads a Classic path payment from the result, not the quote", () => {
    const envelopeXdr = buildClassicSwap(classicLeg, { source: G, sequence: "1", minOut: 1n });
    const resultXdr = pathPaymentResult(paid("1987654"), true).toXDR("base64");
    expect(receivedAmount({ envelopeXdr, resultXdr })).toEqual({ kind: "classic", amount: 1_987_654n });
    const failed = pathPaymentResult(xdr.PathPaymentStrictSendResult.pathPaymentStrictSendUnderDestmin(), false).toXDR("base64");
    expect(receivedAmount({ envelopeXdr, resultXdr: failed })).toBeNull();
    expect(receivedAmount({ envelopeXdr })).toBeNull();
  });
  it("reads each Soroban venue's return shape", () => {
    const soroswap = buildSoroswapSwap({ source: G, sequence: "1", path: [sacId(XLM), sacId(USDC)], amountIn: 10n, minOut: 1n });
    expect(receivedAmount({ envelopeXdr: soroswap, returnValue: b64(xdr.ScVal.scvVec([i128(10n), i128(7n)])) })).toEqual({ kind: "swap_exact_tokens_for_tokens", amount: 7n });
    const comet = buildCometSwap({ source: G, sequence: "1", pool: POOL, tokenIn: sacId(USDC), tokenOut: sacId(XLM), amountIn: 10n, minOut: 1n });
    expect(receivedAmount({ envelopeXdr: comet, returnValue: b64(xdr.ScVal.scvVec([i128(42n), i128(999n)])) })).toEqual({ kind: "swap_exact_amount_in", amount: 42n });
  });
  it("returns null for transactions that are not swaps, and for garbage", () => {
    const trust = buildChangeTrust(USDC, { source: G, sequence: "1" });
    expect(receivedAmount({ envelopeXdr: trust, resultXdr: "AAAA" })).toBeNull();
    const deposit = buildVaultDeposit({ vault: POOL, underlying: USDC, protocol: "blend" }, USDC, 5n, { source: G, sequence: "1" });
    expect(receivedAmount({ envelopeXdr: deposit, returnValue: b64(i128(5n)) })).toBeNull();
    expect(receivedAmount({ envelopeXdr: "not xdr" })).toBeNull();
    expect(receivedAmount({})).toBeNull();
  });
});

describe("parseHorizonAccount", () => {
  it("computes spendable XLM after reserve and liabilities, and lists trustlines", () => {
    const a = parseHorizonAccount({
      sequence: "77", subentry_count: 3, num_sponsoring: 1, num_sponsored: 0,
      balances: [
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC.split(":")[1], balance: "25.0000000", limit: "1000.0000000", selling_liabilities: "5.0000000", is_authorized: true },
        { asset_type: "liquidity_pool_shares", balance: "9.0000000" },
        { asset_type: "native", balance: "10.0000000", selling_liabilities: "1.0000000" },
      ],
    });
    // Reserve = (2 + 3 + 1) * 0.5 = 3 XLM; 10 - 3 - 1 = 6.
    expect(a.balances[0]).toEqual({ asset: "native", balance: "10.0000000", spendable: "6.0000000", authorized: true });
    expect(a.balances[1]).toMatchObject({ asset: USDC, balance: "25.0000000", spendable: "20.0000000", limit: "1000.0000000" });
    expect(a.balances).toHaveLength(2);
    expect([...a.assets]).toEqual(["native", USDC]);
    expect(a.sequence).toBe("77");
  });
  it("never reports a negative spendable amount", () => {
    const a = parseHorizonAccount({ sequence: "1", balances: [{ asset_type: "native", balance: "0.5000000" }] });
    expect(a.balances[0]!.spendable).toBe("0.0000000");
  });
});

describe("asset lists", () => {
  const usdcIssuer = USDC.split(":")[1]!;
  const lists = [
    { name: "A", assets: [
      { code: "USDC", issuer: usdcIssuer, name: "USD Coin", domain: "centre.io", icon: "https://x.test/usdc.png" },
      { code: "XLM", contract: sacId("native"), icon: "https://x.test/xlm.png" },
      { code: "BAD", issuer: "not-an-issuer" },
      { code: "SORO", contract: "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM" },
      { code: "EVIL", issuer: AQUA.split(":")[1], icon: "javascript:alert(1)" },
      null,
    ] },
    { name: "B", assets: [{ code: "USDC", issuer: usdcIssuer, name: "Other name" }, { code: "AQUA", issuer: AQUA.split(":")[1] }] },
    { name: "C", assets: "not an array" },
  ];
  it("merges, validates and orders: XLM, then most-listed, then by position in the lists", () => {
    const m = mergeAssetLists(lists);
    expect(m.map((a) => a.code)).toEqual(["XLM", "USDC", "AQUA", "EVIL"]);
    // Same number of lists: the one a list places higher comes first, whatever its code.
    const ranked = mergeAssetLists([{ name: "A", assets: [{ code: "ZED", issuer: usdcIssuer }, { code: "ABC", issuer: usdcIssuer }] }]);
    expect(ranked.map((a) => a.code)).toEqual(["XLM", "ZED", "ABC"]);
    expect(m[0]).toMatchObject({ id: "native", contract: sacId("native"), icon: "https://x.test/xlm.png" });
    expect(m[1]).toMatchObject({ id: USDC, name: "USD Coin", lists: ["A", "B"], contract: sacId(USDC) });
    expect(m.find((a) => a.code === "EVIL")!.icon).toBeUndefined();
  });
  it("caches, reports failed lists, retries them soon and keeps the last good result", async () => {
    let calls = 0;
    let down = false;
    const f = (async (u: string) => {
      calls++;
      if (down || u.endsWith("/b")) return new Response("no", { status: 500 });
      return new Response(JSON.stringify({ assets: lists[0]!.assets }), { status: 200 });
    }) as unknown as typeof fetch;
    const list = createAssetList({ sources: [{ name: "A", url: "https://l.test/a" }, { name: "B", url: "https://l.test/b" }], fetchImpl: f, ttlMs: 1 });
    const first = await list.get();
    expect(first.assets.map((a) => a.code)).toContain("USDC");
    expect(first.errors).toEqual([{ source: "B", error: "HTTP 500" }]);
    await list.get();
    expect(calls).toBe(2); // a partial result is held for a minute, not refetched per request
    down = true;
    const all = createAssetList({ sources: [{ name: "A", url: "https://l.test/a" }], fetchImpl: f });
    expect((await all.get()).assets.map((a) => a.code)).toEqual(["XLM"]);
  });
});

describe("cached name lookup", () => {
  type Cb = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;
  const V4 = { address: "1.2.3.4", family: 4 };
  const V6 = { address: "2001:db8::1", family: 6 };
  const ask = (lookup: ReturnType<typeof createCachedLookup>, host: string, options: object | number = { all: true }) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) => lookup(host, options as never, (err, address, family) => resolve({ err, address, family })));

  it("resolves a name once and answers every shape of question from it", async () => {
    const asked: [string, object][] = [];
    const release: (() => void)[] = [];
    const original = (h: string, o: object, cb: Cb) => { asked.push([h, o]); release.push(() => cb(null, [V4, V6])); };
    const lookup = createCachedLookup(original);
    // Two connections and an early warm-up ask at once, with different options: one request goes out.
    const all = Promise.all([ask(lookup, "a.test"), ask(lookup, "a.test", {}), ask(lookup, "a.test", { family: 6 })]);
    expect(asked).toEqual([["a.test", { all: true }]]);
    release[0]!();
    const [every, first, six] = await all;
    expect(every.address).toEqual([V4, V6]);
    expect(first).toMatchObject({ address: "1.2.3.4", family: 4 });
    expect(six).toMatchObject({ address: "2001:db8::1", family: 6 });
    // Later questions of any shape come from memory, as copies the caller may change.
    expect((await ask(lookup, "a.test", 4)).address).toBe("1.2.3.4");
    expect((await ask(lookup, "a.test", { all: true, family: "IPv4" })).address).toEqual([V4]);
    const copy = (await ask(lookup, "a.test")).address as object[];
    copy.length = 0;
    expect((await ask(lookup, "a.test")).address).toEqual([V4, V6]);
    expect(asked).toHaveLength(1);
    // Another name is another lookup.
    void ask(lookup, "b.test");
    expect(asked).toHaveLength(2);
  });

  it("serves a stale answer at once while refreshing behind it, and never caches a failure", async () => {
    let clock = 0;
    let fail = true;
    let ip = "1.1.1.1";
    let calls = 0;
    const original = (_h: string, _o: object, cb: Cb) => { calls++; queueMicrotask(() => (fail ? cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })) : cb(null, [{ address: ip, family: 4 }]))); };
    const lookup = createCachedLookup(original, 1000, 10_000, () => clock);
    expect((await ask(lookup, "a.test", {})).err?.code).toBe("ENOTFOUND");
    fail = false;
    expect((await ask(lookup, "a.test", {})).address).toBe("1.1.1.1"); // the failure was not remembered
    expect(calls).toBe(2);
    clock = 5000; // past the TTL, inside the stale window
    ip = "2.2.2.2";
    expect((await ask(lookup, "a.test", {})).address).toBe("1.1.1.1"); // old answer, immediately
    expect(calls).toBe(3); // and a refresh was started
    await new Promise((r) => setTimeout(r, 0));
    expect((await ask(lookup, "a.test", {})).address).toBe("2.2.2.2");
    clock = 50_000; // past the stale window: wait for a fresh answer
    ip = "3.3.3.3";
    expect((await ask(lookup, "a.test", {})).address).toBe("3.3.3.3");
  });

  it("does not pin later callers to a lookup that hangs: after a short wait a second one is asked", async () => {
    let clock = 0;
    const attempts: Cb[] = [];
    const lookup = createCachedLookup((_h: string, _o: object, cb: Cb) => { attempts.push(cb); }, 1000, 10_000, () => clock, 1500);
    const answers: unknown[] = [];
    const first = ask(lookup, "a.test", {}).then((r) => answers.push(r.address));
    clock = 500;
    const soon = ask(lookup, "a.test", {}).then((r) => answers.push(r.address)); // joins the first attempt
    expect(attempts).toHaveLength(1);
    clock = 2000;
    const later = ask(lookup, "a.test", {}).then((r) => answers.push(r.address)); // the first is taking too long: ask again
    expect(attempts).toHaveLength(2);
    attempts[1]!(null, [V4]); // the second attempt answers; the first is still hanging
    await Promise.all([first, soon, later]);
    expect(answers).toEqual(["1.2.3.4", "1.2.3.4", "1.2.3.4"]);
    // The hung attempt finally fails: nobody is told twice, and the good answer stays cached.
    attempts[0]!(Object.assign(new Error("EAI_AGAIN"), { code: "EAI_AGAIN" }));
    expect((await ask(lookup, "a.test", {})).address).toBe("1.2.3.4");
    expect(answers).toHaveLength(3);
  });

  it("reports a failure only when every attempt has failed", async () => {
    let clock = 0;
    const attempts: Cb[] = [];
    const lookup = createCachedLookup((_h: string, _o: object, cb: Cb) => { attempts.push(cb); }, 1000, 10_000, () => clock, 1500);
    const a = ask(lookup, "a.test", {});
    clock = 2000;
    const b = ask(lookup, "a.test", {});
    const down = Object.assign(new Error("EAI_AGAIN"), { code: "EAI_AGAIN" });
    attempts[0]!(down);
    let settled = false;
    void a.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // one attempt is still out
    attempts[1]!(down);
    expect((await a).err?.code).toBe("EAI_AGAIN");
    expect((await b).err?.code).toBe("EAI_AGAIN");
  });

  it("reports not found when a name has no address of the family asked for, or none at all", async () => {
    const lookup = createCachedLookup((h: string, _o: object, cb: Cb) => cb(null, h === "empty.test" ? [] : [V4]));
    expect((await ask(lookup, "a.test", { family: 6 })).err?.code).toBe("ENOTFOUND");
    expect((await ask(lookup, "empty.test", {})).err?.code).toBe("ENOTFOUND");
  });

  it("accepts the callback-only call shape and a resolver that answers synchronously", async () => {
    const lookup = createCachedLookup((_h: string, _o: object, cb: Cb) => cb(null, [V4]));
    const got = await new Promise<unknown>((r) => lookup("a.test", ((_e: unknown, address: unknown) => r(address)) as never));
    expect(got).toBe("1.2.3.4");
  });
});

describe("concurrency gate", () => {
  it("runs at most the allowed number at once, in arrival order, and survives failures", async () => {
    const gate = createGate(3);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        gate(async () => {
          started.push(i);
          peak = Math.max(peak, ++running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
          if (i === 4) throw new Error("boom");
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(started).toEqual([...Array(12).keys()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(11);
    expect(results[4]).toMatchObject({ status: "rejected" });
    // A failure released its slot: the gate still works afterwards.
    expect(await gate(async () => "after")).toBe("after");
  });
});

describe("asset list recovery", () => {
  it("answers at once from what it holds while a failed load is retried behind it", async () => {
    let up = false;
    let calls = 0;
    const f = (async () => {
      calls++;
      if (!up) return new Response("no", { status: 503 });
      return new Response(JSON.stringify({ assets: [{ code: "USDC", issuer: USDC.split(":")[1] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const list = createAssetList({ sources: [{ name: "A", url: "https://l.test/a" }], fetchImpl: f });
    // Cold start with the list host down: XLM only, and the failure is reported.
    const cold = await list.get();
    expect(cold.assets.map((a) => a.code)).toEqual(["XLM"]);
    expect(cold.errors).toHaveLength(1);
    // The host recovers. The next caller is not made to wait: it gets the held answer and triggers a retry.
    up = true;
    expect((await list.get()).assets.map((a) => a.code)).toEqual(["XLM"]);
    await new Promise((r) => setTimeout(r, 10));
    const healed = await list.get();
    expect(healed.assets.map((a) => a.code)).toEqual(["XLM", "USDC"]);
    expect(healed.errors).toEqual([]);
    // A complete list is then served from cache.
    const before = calls;
    await list.get();
    expect(calls).toBe(before);
  });
});

describe("blend reserve figures", () => {
  // USDC reserve of the Fixed V2 pool as read from mainnet on 2026-10-08.
  const raw = {
    asset: sacId(USDC),
    config: { c_factor: 9500000, decimals: 7, enabled: true, index: 1, l_factor: 9500000, max_util: 9000000, r_base: 300000, r_one: 400000, r_three: 50000000, r_two: 1200000, reactivity: 20, supply_cap: 10000000000000000n, util: 8000000 },
    data: { b_rate: 1151605011835n, b_supply: 477103429756848n, backstop_credit: 903210617697n, d_rate: 1242100654586n, d_supply: 350310030005663n, ir_mod: 15151703n, last_time: 1791468327n },
  };
  it("values supply and borrow at the bToken and dToken rates", () => {
    const r = describeReserve(USDC, raw, 2000000);
    expect(r.supplied).toBe("54943470.0871654"); // 477103429756848 * 1151605011835 / 1e12 stroops
    expect(r.borrowed).toBe("43512031.7578075"); // 350310030005663 * 1242100654586 / 1e12 stroops
    expect(r.utilization).toBeCloseTo(0.79194, 4);
    expect(r.index).toBe(1);
  });
  it("follows the contract's rate curve in each segment", () => {
    const cfg = raw.config;
    // Below target: ((u / target) * r_one + r_base) * ir_mod.
    const low = blendRates(cfg, 0.4, 10_000_000n, 2_000_000);
    expect(low.borrowApr).toBeCloseTo((0.5 * 0.04 + 0.03) * 1, 9);
    expect(low.supplyApr).toBeCloseTo(low.borrowApr * 0.4 * 0.8, 9);
    // Between target and 95%.
    expect(blendRates(cfg, 0.875, 10_000_000n, 0).borrowApr).toBeCloseTo(0.5 * 0.12 + 0.04 + 0.03, 9);
    // Above 95%: r_three ramps on top of the modified intersection.
    expect(blendRates(cfg, 0.975, 20_000_000n, 0).borrowApr).toBeCloseTo(0.5 * 5 + 2 * (0.12 + 0.04 + 0.03), 9);
    expect(blendRates(cfg, 0, 10_000_000n, 2_000_000).supplyApr).toBe(0);
    const live = describeReserve(USDC, raw, 2000000);
    expect(live.borrowApr).toBeGreaterThan(0.09);
    expect(live.borrowApr).toBeLessThan(0.12);
    expect(live.supplyApr).toBeCloseTo(live.borrowApr * live.utilization * 0.8, 9);
  });
});

describe("stablecoin reference asset", () => {
  const f = (async (u: URL) => {
    const url = new URL(String(u));
    if (url.pathname === "/assets") return new Response(JSON.stringify({ _embedded: { records: [{ flags: { auth_clawback_enabled: true } }] } }), { status: 200 });
    throw new Error("the reference asset must not be priced against itself");
  }) as unknown as typeof fetch;
  it("reports peg and depth as not measured instead of perfect", async () => {
    const s = await fetchStablecoinSignals(USDC, { fetchImpl: f });
    expect(s).toMatchObject({ reference: true, clawback: true, sizesProbed: [] });
    expect(s.pegPrice).toBeUndefined();
    expect(s.depthNearPeg).toBeUndefined();
    // Only the issuer flag counts against it.
    expect(scoreStablecoin(s)).toEqual({ score: 90, penaltyBps: 20, reasons: ["issuer clawback enabled"] });
  });
  it("refreshIfStale fetches once for concurrent callers and not again while fresh", async () => {
    let calls = 0;
    const counting = ((u: URL) => { calls++; return f(u); }) as typeof fetch;
    const scorer = createStablecoinScorer([USDC], { fetchImpl: counting });
    await Promise.all([scorer.refreshIfStale(), scorer.refreshIfStale()]);
    await scorer.refreshIfStale();
    expect(calls).toBe(1);
    expect(scorer.penaltyBps(USDC)).toBe(20);
    let none = 0;
    await createStablecoinScorer([], { fetchImpl: (() => { none++; }) as never }).refreshIfStale();
    expect(none).toBe(0);
  });
});
