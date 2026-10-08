import { describe, expect, it } from "vitest";
import { Sluice, SluiceError } from "./index.js";

const ok = { routes: [], best: null, partial: false, errors: [] };

describe("Sluice sdk", () => {
  it("builds the quote URL with optional slippage", async () => {
    let seen = "";
    const f = (async (u: URL) => { seen = u.toString(); return new Response(JSON.stringify(ok), { status: 200 }); }) as unknown as typeof fetch;
    const r = await new Sluice("http://x", f).quote({ assetIn: "native", assetOut: "USDC:G", amount: "1", slippageBps: 25 });
    expect(r.partial).toBe(false);
    expect(seen).toBe("http://x/v1/quote?assetIn=native&assetOut=USDC%3AG&amount=1&slippageBps=25");
  });
  it("throws SluiceError with the server message", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "bad amount" }), { status: 400 })) as unknown as typeof fetch;
    await expect(new Sluice("http://x", f).quote({ assetIn: "native", assetOut: "A:G", amount: "z" })).rejects.toMatchObject({ status: 400, message: "bad amount" });
    expect(new SluiceError(1, "m")).toBeInstanceOf(Error);
  });
});

describe("Sluice sdk build", () => {
  it("posts the body and returns steps", async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: URL, i: RequestInit) => { init = i; return new Response(JSON.stringify({ route: {}, steps: [], unsigned: true }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await new Sluice("http://x", f).build({ assetIn: "native", assetOut: "A:G", amount: "1", account: "G", atomicOnly: true });
    expect(r.unsigned).toBe(true);
    expect(JSON.parse(String(init!.body)).atomicOnly).toBe(true);
  });
  it("sends atomicOnly on quote", async () => {
    let seen = "";
    const f = (async (u: URL) => { seen = u.toString(); return new Response(JSON.stringify({ routes: [], best: null, partial: false, errors: [] }), { status: 200 }); }) as unknown as typeof fetch;
    await new Sluice("http://x", f).quote({ assetIn: "native", assetOut: "A:G", amount: "1", atomicOnly: true });
    expect(seen).toContain("atomicOnly=1");
  });
});

describe("Sluice sdk deposit and unwind", () => {
  it("posts deposit with blend as the default protocol", async () => {
    let body: any;
    const f = (async (_u: URL, i: RequestInit) => { body = JSON.parse(String(i.body)); return new Response(JSON.stringify({ kind: "transaction", venue: "blend", xdr: "x", resourceFee: "1", unsigned: true }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await new Sluice("http://x", f).deposit({ account: "G", vault: "C", asset: "USDC:G", amount: "5" });
    expect(r.venue).toBe("blend");
    expect(body.protocol).toBe("blend");
  });
  it("unwind builds the reverse route for the held amount, atomic only", async () => {
    let body: any;
    const f = (async (_u: URL, i: RequestInit) => { body = JSON.parse(String(i.body)); return new Response(JSON.stringify({ route: {}, steps: [], unsigned: true }), { status: 200 }); }) as unknown as typeof fetch;
    await new Sluice("http://x", f).unwind({ account: "G", heldAsset: "USDC:G", originalAsset: "native", heldAmount: "19.95" });
    expect(body).toMatchObject({ assetIn: "USDC:G", assetOut: "native", amount: "19.95", atomicOnly: true });
  });
});

describe("Sluice sdk execution and data", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  it("names a route by key when building", async () => {
    let body: any;
    const f = (async (_u: URL, i: RequestInit) => { body = JSON.parse(String(i.body)); return json({ route: {}, steps: [], unsigned: true, skipped: [] }); }) as unknown as typeof fetch;
    await new Sluice("http://x", f).build({ assetIn: "native", assetOut: "A:G", amount: "1", account: "G", routeKey: "aquarius:native>A:G" });
    expect(body.routeKey).toBe("aquarius:native>A:G");
  });
  it("carries the plain-words explanation and the body on errors", async () => {
    const explained = { code: "SLIPPAGE", message: "price moved", detail: "x" };
    const f = (async () => json({ error: "simulation failed", explained, code: "ROUTE_GONE" }, 422)) as unknown as typeof fetch;
    await expect(new Sluice("http://x", f).withdraw({ account: "G", vault: "C", asset: "A:G", amount: "1" })).rejects.toMatchObject({ status: 422, explained, body: { code: "ROUTE_GONE" } });
  });
  it("survives a non-JSON error body", async () => {
    const f = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    await expect(new Sluice("http://x", f).assets()).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
  });
  it("submits signed XDR and polls until the transaction settles", async () => {
    const seen: string[] = [];
    let polls = 0;
    const f = (async (u: URL, i?: RequestInit) => {
      seen.push(`${i?.method ?? "GET"} ${u.pathname}`);
      if (u.pathname === "/v1/submit") { expect(JSON.parse(String(i!.body))).toEqual({ xdr: "SIGNED" }); return json({ hash: "h1", status: "PENDING" }); }
      return json(++polls < 3 ? { hash: "h1", status: "NOT_FOUND" } : { hash: "h1", status: "SUCCESS", received: "1.5000000" });
    }) as unknown as typeof fetch;
    const s = new Sluice("http://x", f);
    const sent = await s.submit("SIGNED");
    expect(await s.waitForTx(sent.hash, { intervalMs: 1 })).toMatchObject({ status: "SUCCESS", received: "1.5000000" });
    expect(seen).toEqual(["POST /v1/submit", "GET /v1/tx/h1", "GET /v1/tx/h1", "GET /v1/tx/h1"]);
  });
  it("gives up waiting without claiming failure", async () => {
    const f = (async () => json({ hash: "h", status: "NOT_FOUND" })) as unknown as typeof fetch;
    await expect(new Sluice("http://x", f).waitForTx("h", { timeoutMs: 5, intervalMs: 1 })).rejects.toMatchObject({ status: 408 });
  });
  it("addresses the read endpoints", async () => {
    const seen: string[] = [];
    const f = (async (u: URL) => { seen.push(u.pathname + u.search); return json({}); }) as unknown as typeof fetch;
    const s = new Sluice("http://x", f);
    await Promise.all([s.assets(), s.asset("A:G"), s.account("GABC"), s.stablecoin("A:G"), s.stablecoins(), s.vaults(), s.positions("GABC")]);
    expect(seen).toEqual(["/v1/assets", "/v1/asset?id=A%3AG", "/v1/account/GABC", "/v1/stablecoin?asset=A%3AG", "/v1/stablecoins", "/v1/vaults", "/v1/positions?account=GABC"]);
  });
});
