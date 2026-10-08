import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Router, type QuoteSource } from "@sluice/core";
import { createApp } from "./app.js";

const XLM = "native";
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const src: QuoteSource = {
  id: "fake",
  layer: "soroban",
  async quote(req) {
    return { venue: "fake", layer: "soroban", assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.amountIn, amountOut: req.amountIn / 2n, hops: [] };
  },
};
const app = createApp(new Router({ sources: [src], hubs: [] }));

describe("GET /v1/quote", () => {
  it("returns a serialised best route", async () => {
    const r = await app.request(`/v1/quote?assetIn=${XLM}&assetOut=${encodeURIComponent(USDC)}&amount=10`);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.best.atomicity).toBe("ATOMIC_SOROBAN");
    expect(b.best.amountOut).toBe("5.0000000");
    expect(b.best.legs[0].minOut).toBe("4.9750000");
    expect(b.partial).toBe(false);
  });
  it.each([
    ["bad asset", `assetIn=nope&assetOut=${encodeURIComponent(USDC)}&amount=1`],
    ["same asset", `assetIn=${XLM}&assetOut=${XLM}&amount=1`],
    ["bad amount", `assetIn=${XLM}&assetOut=${encodeURIComponent(USDC)}&amount=1.123456789`],
    ["zero amount", `assetIn=${XLM}&assetOut=${encodeURIComponent(USDC)}&amount=0`],
    ["bad slippage", `assetIn=${XLM}&assetOut=${encodeURIComponent(USDC)}&amount=1&slippageBps=99999`],
  ])("400 on %s", async (_n, qs) => {
    expect((await app.request(`/v1/quote?${qs}`)).status).toBe(400);
  });
  it("health", async () => expect((await app.request("/health")).status).toBe(200));
});

describe("web app", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sluice-web-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Sluice</title>");
  writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(path.join(dir, "secret.env"), "KEY=1");
  writeFileSync(path.join(path.dirname(dir), "outside.html"), "<p>outside</p>");
  const web = createApp(new Router({ sources: [src], hubs: [] }), {}, { webDir: dir });

  it("serves the page with security headers and never caches it", async () => {
    const r = await web.request("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>Sluice</title>");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cache-control")).toBe("no-cache");
  });
  it("serves hashed assets as immutable", async () => {
    const r = await web.request("/assets/index-abc123.js");
    expect(r.headers.get("content-type")).toContain("text/javascript");
    expect(r.headers.get("cache-control")).toContain("immutable");
  });
  it("serves nothing outside the directory or of an unknown type", async () => {
    for (const p of ["/secret.env", "/../outside.html", "/%2e%2e/outside.html", "/..%2Foutside.html", "/missing.js", "/assets/"]) {
      expect((await web.request(p)).status, p).toBe(404);
    }
  });
  it("leaves API routes alone and serves no files when there is no web directory", async () => {
    expect((await web.request("/health")).status).toBe(200);
    expect((await web.request("/v1/stablecoins")).headers.get("content-type")).toContain("application/json");
    expect((await app.request("/")).status).toBe(404);
  });
});

describe("POST /v1/build", () => {
  const ACCT = "GDZZZCQQNVJSZLTI6V5BV34SLEHATGUYNURVYY4JDMVYSV5RQ3RP3QJ4";
  const classicSrc: QuoteSource = {
    id: "classic-path", layer: "classic",
    async quote(req) { return { venue: "classic-path", layer: "classic", assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.amountIn, amountOut: req.amountIn / 4n, hops: [] }; },
  };
  const stableStub = async () => ({ score: 90, penaltyBps: 20, reasons: ["thin depth"], signals: { pegPrice: 0.999, depthNearPeg: 1000, authRequired: false, clawback: false, sizesProbed: [100] } }) as never;
  const acctWith = (...assets: string[]) => async () => ({ sequence: "42", assets: new Set(["native", ...assets]) });
  const deps = { getAccount: acctWith(USDC), prepare: async (x: string) => ({ xdr: x, minResourceFee: "1" }), stablecoin: stableStub };
  const post = (a: ReturnType<typeof createApp>, body: unknown) =>
    a.request("/v1/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const base = { assetIn: XLM, assetOut: USDC, amount: "10", account: ACCT };

  it("returns an unsigned classic transaction", async () => {
    const a = createApp(new Router({ sources: [classicSrc], hubs: [] }), deps);
    const r = await post(a, base);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.unsigned).toBe(true);
    expect(b.steps[0]).toMatchObject({ kind: "transaction", layer: "classic", needsSimulation: false });
    expect(b.steps[0].xdr.length).toBeGreaterThan(50);
  });
  it("simulates soroban steps and reports 422 when simulation fails", async () => {
    const aqua: QuoteSource = {
      id: "aquarius", layer: "soroban",
      async quote(req) { return { venue: "aquarius", layer: "soroban", assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.amountIn, amountOut: req.amountIn / 4n, hops: [], raw: { swap_chain_xdr: "AAAAEAAAAAA=" } }; },
    };
    const bad = { ...deps, prepare: async () => { throw new Error("simulation failed: insufficient balance"); } };
    const r = await post(createApp(new Router({ sources: [aqua], hubs: [] }), bad), base);
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/insufficient balance/);
    const ok = await post(createApp(new Router({ sources: [aqua], hubs: [] }), deps), base);
    expect((await ok.json()).steps[0]).toMatchObject({ venue: "aquarius", resourceFee: "1" });
  });
  it.each([
    ["bad account", { ...base, account: "nope" }, 400],
    ["same asset", { ...base, assetOut: XLM }, 400],
    ["zero amount", { ...base, amount: "0" }, 400],
    ["negative route index", { ...base, routeIndex: -1 }, 400],
    ["missing route", { ...base, routeIndex: 5 }, 404],
  ])("%s", async (_n, body, status) => {
    const a = createApp(new Router({ sources: [classicSrc], hubs: [] }), deps);
    expect((await post(a, body)).status).toBe(status);
  });
  it("502 when the account lookup fails", async () => {
    const a = createApp(new Router({ sources: [classicSrc], hubs: [] }), { ...deps, getAccount: async () => { throw new Error("account not found on this network"); } });
    expect((await post(a, base)).status).toBe(502);
  });
  it("rejects a non-JSON body", async () => {
    const a = createApp(new Router({ sources: [classicSrc], hubs: [] }), deps);
    const r = await a.request("/v1/build", { method: "POST", body: "{" });
    expect(r.status).toBe(400);
  });
});

describe("POST /v1/build fallback", () => {
  const ACCT = "GDZZZCQQNVJSZLTI6V5BV34SLEHATGUYNURVYY4JDMVYSV5RQ3RP3QJ4";
  const POOL = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";
  const TOK = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
  const aquarius: QuoteSource = {
    id: "aquarius", layer: "soroban",
    async quote(req) { return { venue: "aquarius", layer: "soroban", assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.amountIn, amountOut: req.amountIn * 3n, hops: [], raw: { swap_chain_xdr: "AAAAEAAAAAA=" } }; },
  };
  const comet: QuoteSource = {
    id: "comet", layer: "soroban",
    async quote(req) { return { venue: "comet", layer: "soroban", assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.amountIn, amountOut: req.amountIn * 2n, hops: [], raw: { pool: POOL, tokenIn: TOK, tokenOut: TOK } }; },
  };
  const body = { assetIn: XLM, assetOut: USDC, amount: "1", account: ACCT };
  const post = (a: ReturnType<typeof createApp>, b: unknown) => a.request("/v1/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  // First simulation (the best route, aquarius) fails; later ones succeed.
  const depsFailingOnce = () => {
    let n = 0;
    return { getAccount: async () => ({ sequence: "1", assets: new Set(["native", USDC]) }), stablecoin: async () => ({}) as never, prepare: async (x: string) => { if (n++ === 0) throw new Error("simulation failed: pool broken\nlong detail"); return { xdr: x, minResourceFee: "9" }; } };
  };

  it("falls back to the next route and reports what it skipped", async () => {
    const r = await post(createApp(new Router({ sources: [aquarius, comet], hubs: [] }), depsFailingOnce()), body);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.route.legs[0].venue).toBe("comet");
    expect(j.skipped).toEqual([{ venue: "aquarius", error: "simulation failed: pool broken" }]);
    expect(j.steps[0].resourceFee).toBe("9");
  });
  it("does not fall back when routeIndex is explicit", async () => {
    const r = await post(createApp(new Router({ sources: [aquarius, comet], hubs: [] }), depsFailingOnce()), { ...body, routeIndex: 0 });
    expect(r.status).toBe(422);
    expect((await r.json()).skipped).toHaveLength(1);
  });
  it("returns 422 with every skipped venue when all routes fail", async () => {
    const allFail = { getAccount: async () => ({ sequence: "1", assets: new Set(["native", USDC]) }), stablecoin: async () => ({}) as never, prepare: async () => { throw new Error("simulation failed: nope"); } };
    const r = await post(createApp(new Router({ sources: [aquarius, comet], hubs: [] }), allFail), body);
    expect(r.status).toBe(422);
    expect((await r.json()).skipped.map((s: any) => s.venue)).toEqual(["aquarius", "comet"]);
  });
});


describe("trustlines and stablecoin endpoint", () => {
  const ACCT = "GDZZZCQQNVJSZLTI6V5BV34SLEHATGUYNURVYY4JDMVYSV5RQ3RP3QJ4";
  const aq: QuoteSource = {
    id: "aquarius", layer: "soroban",
    async quote(req) { return { venue: "aquarius", layer: "soroban", assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.amountIn, amountOut: req.amountIn * 3n, hops: [], raw: { swap_chain_xdr: "AAAAEAAAAAA=" } }; },
  };
  const stable = async () => ({ score: 90, penaltyBps: 20, reasons: [], signals: {} }) as never;
  const post = (a: ReturnType<typeof createApp>, b: unknown) => a.request("/v1/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const body = { assetIn: XLM, assetOut: USDC, amount: "1", account: ACCT };

  it("adds a changeTrust prerequisite, advances the sequence and ships the swap unsimulated", async () => {
    let prepared = 0;
    const deps = { getAccount: async () => ({ sequence: "100", assets: new Set(["native"]) }), prepare: async (x: string) => { prepared++; return { xdr: x, minResourceFee: "1" }; }, stablecoin: stable };
    const j = await (await post(createApp(new Router({ sources: [aq], hubs: [] }), deps), body)).json();
    expect(j.steps.map((s: any) => s.kind)).toEqual(["prerequisite", "transaction"]);
    expect(j.steps[0]).toMatchObject({ type: "changeTrust", asset: USDC });
    expect(j.steps[1]).toMatchObject({ simulated: false });
    expect(prepared).toBe(0);
    const { Transaction, Networks } = await import("@sluice/core");
    expect(new Transaction(j.steps[0].xdr, Networks.PUBLIC).sequence).toBe("101");
    expect(new Transaction(j.steps[1].xdr, Networks.PUBLIC).sequence).toBe("102");
  });
  it("adds no prerequisite when the trustline exists", async () => {
    const deps = { getAccount: async () => ({ sequence: "100", assets: new Set(["native", USDC]) }), prepare: async (x: string) => ({ xdr: x, minResourceFee: "1" }), stablecoin: stable };
    const j = await (await post(createApp(new Router({ sources: [aq], hubs: [] }), deps), body)).json();
    expect(j.steps.map((s: any) => s.kind)).toEqual(["transaction"]);
  });
  it("GET /v1/stablecoin validates input and returns the score", async () => {
    const a = createApp(new Router({ sources: [aq], hubs: [] }), { getAccount: async () => ({ sequence: "1", assets: new Set() }), prepare: async (x) => ({ xdr: x, minResourceFee: "0" }), stablecoin: stable });
    expect((await a.request("/v1/stablecoin?asset=native")).status).toBe(400);
    expect((await a.request("/v1/stablecoin?asset=nope")).status).toBe(400);
    const r = await a.request(`/v1/stablecoin?asset=${encodeURIComponent(USDC)}`);
    expect(r.status).toBe(200);
    expect((await r.json()).score).toBe(90);
    const bad = createApp(new Router({ sources: [aq], hubs: [] }), { getAccount: async () => ({ sequence: "1", assets: new Set() }), prepare: async (x) => ({ xdr: x, minResourceFee: "0" }), stablecoin: async () => { throw new Error("no executable path"); } });
    expect((await bad.request(`/v1/stablecoin?asset=${encodeURIComponent(USDC)}`)).status).toBe(502);
  });
});

describe("POST /v1/deposit", () => {
  const ACCT = "GDZZZCQQNVJSZLTI6V5BV34SLEHATGUYNURVYY4JDMVYSV5RQ3RP3QJ4";
  const VAULT = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
  const mk = (prepare: (x: string) => Promise<{ xdr: string; minResourceFee: string }>) =>
    createApp(new Router({ sources: [], hubs: [] }), { getAccount: async () => ({ sequence: "5", assets: new Set(["native"]) }), prepare, stablecoin: async () => ({}) as never });
  const post = (a: ReturnType<typeof createApp>, b: unknown) => a.request("/v1/deposit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const ok = { account: ACCT, vault: VAULT, protocol: "blend", asset: USDC, amount: "5" };
  const pass = async (x: string) => ({ xdr: x, minResourceFee: "7" });

  it("returns an unsigned simulated deposit", async () => {
    const j = await (await post(mk(pass), ok)).json();
    expect(j).toMatchObject({ kind: "transaction", venue: "blend", resourceFee: "7", unsigned: true });
    const { Transaction, Networks } = await import("@sluice/core");
    const op = new Transaction(j.xdr, Networks.PUBLIC).operations[0] as any;
    expect(op.func.invokeContract().functionName().toString()).toBe("submit");
    const req = op.func.invokeContract().args()[3].vec()[0].map();
    expect(req.map((e: any) => e.key().sym().toString())).toEqual(["address", "amount", "request_type"]);
  });
  it("501 for unverified protocols, 422 when simulation fails, 400 on bad input", async () => {
    expect((await post(mk(pass), { ...ok, protocol: "defindex" })).status).toBe(501);
    expect((await post(mk(async () => { throw new Error("simulation failed: not enough USDC\nx"); }), ok)).status).toBe(422);
    for (const bad of [{ ...ok, account: "x" }, { ...ok, vault: "x" }, { ...ok, amount: "0" }, { ...ok, asset: "x" }]) {
      expect((await post(mk(pass), bad)).status).toBe(400);
    }
  });
});
