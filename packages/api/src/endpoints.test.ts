import { describe, expect, it } from "vitest";
import {
  buildClassicSwap, buildSoroswapSwap, createStablecoinScorer, Keypair, nativeToScVal, Networks, Router, sacId, Transaction, TransactionBuilder, xdr,
  type BlendPool, type Leg, type QuoteSource, type TxStatus,
} from "@sluice/core";
import { createApp, type Deps } from "./app.js";
import { parseVaults } from "./bootstrap.js";

const XLM = "native";
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const kp = Keypair.random();
const ACCT = kp.publicKey();
const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";

/** A venue paying `num/den` of the input; `calls` counts how often it was asked. */
function venue(id: string, layer: "classic" | "soroban", num: bigint, den: bigint, raw?: unknown) {
  const s = {
    id, layer, calls: 0,
    async quote(req: Parameters<QuoteSource["quote"]>[0]): Promise<Leg> {
      s.calls++;
      return { venue: id, layer, assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.amountIn, amountOut: (req.amountIn * num) / den, hops: [], raw };
    },
  };
  return s;
}
const offline: Partial<Deps> = {
  getAccount: async () => ({ sequence: "42", assets: new Set([XLM, USDC]) }),
  prepare: async (x) => ({ xdr: x, minResourceFee: "1" }),
};
const post = (a: ReturnType<typeof createApp>, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const quoteUrl = `/v1/quote?assetIn=${XLM}&assetOut=${encodeURIComponent(USDC)}&amount=10`;

describe("route identity", () => {
  const classic = venue("classic-path", "classic", 1n, 4n);
  const aqua = venue("aquarius", "soroban", 1n, 5n, { swap_chain_xdr: "AAAAEAAAAAA=" });
  const app = createApp(new Router({ sources: [classic, aqua], hubs: [] }), offline);
  const base = { assetIn: XLM, assetOut: USDC, amount: "10", account: ACCT };

  it("quote returns a key per route and build executes exactly the route that key names", async () => {
    const q = await (await app.request(quoteUrl)).json();
    expect(q.routes.map((r: any) => r.key)).toEqual([`classic-path:${XLM}>${USDC}`, `aquarius:${XLM}>${USDC}`]);
    // The second-ranked route, by name: an index would be ambiguous once prices move.
    const r = await post(app, "/v1/build", { ...base, routeKey: q.routes[1].key });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.route.key).toBe(q.routes[1].key);
    expect(b.steps[0]).toMatchObject({ venue: "aquarius", resourceFee: "1" });
  });
  it("409 when the named route is gone, and no silent substitute", async () => {
    const r = await post(app, "/v1/build", { ...base, routeKey: `phoenix:${XLM}>${USDC}` });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "ROUTE_GONE", available: 2 });
  });
  it("a named route does not fall back to another when its simulation fails", async () => {
    const failing = createApp(new Router({ sources: [classic, aqua], hubs: [] }), { ...offline, prepare: async () => { throw new Error("simulation failed: HostError: Error(Contract, #1)\nlog"); } });
    const r = await post(failing, "/v1/build", { ...base, routeKey: `aquarius:${XLM}>${USDC}` });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: "simulation failed: HostError: Error(Contract, #1)", explained: { code: "SIMULATION_FAILED" }, venue: "aquarius" });
  });
  it("built transactions stay valid long enough for a wallet prompt", async () => {
    const b = await (await post(app, "/v1/build", base)).json();
    const maxTime = Number(new Transaction(b.steps[0].xdr, Networks.PUBLIC).timeBounds!.maxTime);
    expect(maxTime - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(299);
  });
});

describe("quote cache", () => {
  it("shares one fan-out between identical requests, but never serves a build from it", async () => {
    const v = venue("classic-path", "classic", 1n, 4n);
    const app = createApp(new Router({ sources: [v], hubs: [] }), offline);
    await Promise.all([app.request(quoteUrl), app.request(quoteUrl)]);
    await app.request(quoteUrl);
    expect(v.calls).toBe(1);
    await app.request(`${quoteUrl}1`); // a different amount is a different quote
    expect(v.calls).toBe(2);
    await post(app, "/v1/build", { assetIn: XLM, assetOut: USDC, amount: "10", account: ACCT });
    expect(v.calls).toBe(3);
  });
});

describe("assets, asset and account", () => {
  const assets = [{ id: XLM, code: "XLM", contract: sacId(XLM), lists: [] }, { id: USDC, code: "USDC", issuer: USDC.split(":")[1], contract: sacId(USDC), lists: ["A"] }];
  const mk = (over: Partial<Deps> = {}) => createApp(new Router({ sources: [], hubs: [] }), {
    ...offline,
    assets: async () => ({ assets, errors: [], at: 1 }),
    assetInfo: async (id) => (id === USDC ? { authRequired: false, clawback: true, holders: 12 } : null),
    ...over,
  });

  it("serves the merged list, cacheable only when complete", async () => {
    const r = await mk().request("/v1/assets");
    expect((await r.json()).assets).toHaveLength(2);
    expect(r.headers.get("cache-control")).toContain("s-maxage=3600");
    const partial = await mk({ assets: async () => ({ assets, errors: [{ source: "A", error: "HTTP 500" }], at: 1 }) }).request("/v1/assets");
    expect(partial.headers.get("cache-control")).toBe("public, max-age=60");
  });
  it("confirms a pasted asset exists and refuses one that does not", async () => {
    const a = mk();
    expect(await (await a.request(`/v1/asset?id=${encodeURIComponent(USDC)}`)).json()).toMatchObject({ id: USDC, code: "USDC", contract: sacId(USDC), clawback: true, holders: 12 });
    expect(await (await a.request("/v1/asset?id=native")).json()).toMatchObject({ code: "XLM", contract: sacId(XLM) });
    expect((await a.request(`/v1/asset?id=${encodeURIComponent(`FAKE:${ACCT}`)}`)).status).toBe(404);
    expect((await a.request("/v1/asset?id=nope")).status).toBe(400);
    // Matches the address pattern but fails the checksum.
    expect((await a.request(`/v1/asset?id=${encodeURIComponent(`X:G${"A".repeat(55)}`)}`)).status).toBe(400);
    expect((await mk({ assetInfo: async () => { throw new Error("horizon assets 503"); } }).request(`/v1/asset?id=${encodeURIComponent(USDC)}`)).status).toBe(502);
  });
  it("returns balances, 404 for an unfunded account, 400 for a bad address", async () => {
    const balances = [{ asset: XLM, balance: "10.0000000", spendable: "8.5000000", authorized: true }];
    const a = mk({ getAccount: async () => ({ sequence: "7", assets: new Set([XLM]), balances }) });
    expect(await (await a.request(`/v1/account/${ACCT}`)).json()).toEqual({ account: ACCT, sequence: "7", balances });
    expect((await a.request("/v1/account/nope")).status).toBe(400);
    const missing = mk({ getAccount: async () => { throw new Error("account not found on this network"); } });
    expect((await missing.request(`/v1/account/${ACCT}`)).status).toBe(404);
    expect((await mk({ getAccount: async () => { throw new Error("horizon accounts 503"); } }).request(`/v1/account/${ACCT}`)).status).toBe(502);
  });
});

describe("submit and status", () => {
  const leg: Leg = { venue: "classic-path", layer: "classic", assetIn: XLM, assetOut: USDC, amountIn: 10_000_000n, amountOut: 2_000_000n, hops: [] };
  const unsigned = buildClassicSwap(leg, { source: ACCT, sequence: "1", minOut: 1n });
  const signed = (() => { const t = TransactionBuilder.fromXDR(unsigned, Networks.PUBLIC) as Transaction; t.sign(kp); return t.toXDR(); })();
  const HASH = "a".repeat(64);
  const mk = (over: Partial<Deps>) => createApp(new Router({ sources: [], hubs: [] }), { ...offline, ...over });

  it("relays a signed transaction and never an unsigned or malformed one", async () => {
    let relayed = 0;
    const a = mk({ submit: async () => { relayed++; return { hash: HASH, status: "PENDING" }; } });
    expect(await (await post(a, "/v1/submit", { xdr: signed })).json()).toEqual({ hash: HASH, status: "PENDING" });
    expect((await post(a, "/v1/submit", { xdr: unsigned })).status).toBe(400);
    expect((await post(a, "/v1/submit", { xdr: "garbage" })).status).toBe(400);
    expect((await post(a, "/v1/submit", {})).status).toBe(400);
    expect((await a.request("/v1/submit", { method: "POST", body: "[" })).status).toBe(400);
    expect(relayed).toBe(1);
  });
  it("explains a rejection, asks for a retry when the network is busy, 502 when RPC is down", async () => {
    const rejected = await post(mk({ submit: async () => ({ hash: HASH, status: "ERROR", codes: ["txBadSeq"] }) }), "/v1/submit", { xdr: signed });
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).explained).toMatchObject({ code: "STALE_SEQUENCE" });
    expect((await post(mk({ submit: async () => ({ hash: HASH, status: "TRY_AGAIN_LATER" }) }), "/v1/submit", { xdr: signed })).status).toBe(503);
    expect((await post(mk({ submit: async () => { throw new Error("fetch failed"); } }), "/v1/submit", { xdr: signed })).status).toBe(502);
  });
  it("reports pending, the amount a settled swap delivered, and why a failed one failed", async () => {
    const swap = buildSoroswapSwap({ source: ACCT, sequence: "1", path: [sacId(XLM), sacId(USDC)], amountIn: 10n, minOut: 1n });
    const amounts = xdr.ScVal.scvVec([nativeToScVal(10n, { type: "i128" }), nativeToScVal(19_876_543n, { type: "i128" })]).toXDR("base64");
    const states: Record<string, TxStatus> = {
      [HASH]: { hash: HASH, status: "NOT_FOUND" },
      ["b".repeat(64)]: { hash: "b".repeat(64), status: "SUCCESS", ledger: 5, createdAt: 9, envelopeXdr: swap, returnValue: amounts },
      ["c".repeat(64)]: { hash: "c".repeat(64), status: "FAILED", ledger: 6, codes: ["txFailed", "invokeHostFunctionTrapped"] },
    };
    const a = mk({ getTx: async (h) => states[h]! });
    expect(await (await a.request(`/v1/tx/${HASH}`)).json()).toEqual({ hash: HASH, status: "NOT_FOUND" });
    expect(await (await a.request(`/v1/tx/${"B".repeat(64)}`)).json()).toEqual({ hash: "b".repeat(64), status: "SUCCESS", ledger: 5, createdAt: 9, received: "1.9876543" });
    expect((await (await a.request(`/v1/tx/${"c".repeat(64)}`)).json()).explained).toMatchObject({ code: "CONTRACT_REJECTED" });
    expect((await a.request("/v1/tx/xyz")).status).toBe(400);
    expect((await mk({ getTx: async () => { throw new Error("rpc down"); } }).request(`/v1/tx/${HASH}`)).status).toBe(502);
  });
});

describe("vaults", () => {
  const pool: BlendPool = {
    id: POOL, status: 3, statusLabel: "On-ice", supplyOpen: true,
    reserves: [{ asset: USDC, contract: sacId(USDC), index: 1, supplied: "100.0000000", borrowed: "50.0000000", utilization: 0.5, supplyApr: 0.02, borrowApr: 0.05, capRemaining: "900.0000000" }],
  };
  const mk = (over: Partial<Deps> = {}) => createApp(new Router({ sources: [], hubs: [] }), {
    ...offline,
    blendPool: async () => pool,
    blendPositions: async () => [{ asset: USDC, supplied: "12.5000000", collateral: "0.0000000" }],
    ...over,
  });
  const ok = { account: ACCT, vault: POOL, protocol: "blend", asset: USDC, amount: "5" };

  it("lists configured vaults with live pool state, and reports a pool that cannot be read", async () => {
    const j = await (await mk().request("/v1/vaults")).json();
    expect(j.vaults[0]).toMatchObject({ protocol: "blend", name: "Blend Fixed Pool V2", id: POOL, statusLabel: "On-ice", supplyOpen: true });
    expect(j.vaults[0].reserves[0].supplyApr).toBe(0.02);
    const down = await (await mk({ blendPool: async () => { throw new Error("rpc down\nmore"); } }).request("/v1/vaults")).json();
    expect(down).toEqual({ vaults: [], errors: [{ vault: POOL, error: "rpc down" }] });
  });
  it("returns an account's positions per vault", async () => {
    const j = await (await mk().request(`/v1/positions?account=${ACCT}`)).json();
    expect(j.vaults[0]).toMatchObject({ vault: POOL, positions: [{ asset: USDC, supplied: "12.5000000" }] });
    expect((await mk().request("/v1/positions?account=x")).status).toBe(400);
  });
  it("builds a withdrawal as request type 1 with the same checks as a deposit", async () => {
    const j = await (await post(mk(), "/v1/withdraw", ok)).json();
    expect(j).toMatchObject({ kind: "transaction", venue: "blend", unsigned: true });
    const call = (new Transaction(j.xdr, Networks.PUBLIC).operations[0] as any).func.invokeContract();
    expect(call.functionName().toString()).toBe("submit");
    const req = call.args()[3].vec()[0].map();
    expect(req.find((e: any) => e.key().sym().toString() === "request_type").val().u32()).toBe(1);
    expect((await post(mk(), "/v1/withdraw", { ...ok, amount: "0" })).status).toBe(400);
    expect((await post(mk(), "/v1/withdraw", { ...ok, protocol: "defindex" })).status).toBe(501);
    const failed = await post(mk({ prepare: async () => { throw new Error('simulation failed: x\n data:["resulting balance is not within the allowed range", 0, -5, 9]'); } }), "/v1/withdraw", ok);
    expect(failed.status).toBe(422);
    expect((await failed.json()).explained.code).toBe("INSUFFICIENT_BALANCE");
  });
  it("parses BLEND_POOLS and falls back to the verified pool", () => {
    expect(parseVaults(`${POOL}:My pool, bad:x`)).toEqual([{ id: POOL, name: "My pool" }]);
    expect(parseVaults(POOL)).toEqual([{ id: POOL, name: "Blend pool" }]);
    expect(parseVaults(undefined)[0]!.id).toBe(POOL);
    expect(parseVaults("nonsense")[0]!.id).toBe(POOL);
  });
});

describe("stablecoins and cross-origin access", () => {
  it("lists scored assets with a score or the reason there is none", async () => {
    const TUSD = `TUSD:${USDC.split(":")[1]}`;
    const f = (async (u: URL) => {
      const url = new URL(String(u));
      if (url.pathname === "/assets" && url.searchParams.get("asset_code") === "USDC") return new Response(JSON.stringify({ _embedded: { records: [{ flags: {} }] } }), { status: 200 });
      return new Response("no", { status: 500 });
    }) as unknown as typeof fetch;
    const scorer = createStablecoinScorer([USDC, TUSD], { fetchImpl: f });
    const app = createApp(new Router({ sources: [], hubs: [] }), offline, { scorer });
    const j = await (await app.request("/v1/stablecoins")).json();
    expect(j.assets[0]).toMatchObject({ asset: USDC, score: 100, signals: { reference: true } });
    expect(j.assets[0].signals.pegPrice).toBeUndefined();
    expect(j.assets[1]).toMatchObject({ asset: TUSD, error: expect.stringContaining("no executable path") });
    expect(await (await createApp(new Router({ sources: [], hubs: [] }), offline).request("/v1/stablecoins")).json()).toEqual({ assets: [] });
  });
  it("lets other origins call the API", async () => {
    const app = createApp(new Router({ sources: [], hubs: [] }), offline);
    const r = await app.request("/v1/stablecoins", { headers: { origin: "https://wallet.example" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});
