import { describe, expect, it } from "vitest";
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { bearer, createSolverApp, fillRequestToWire, prepareTxRequestToWire, secretsEqual, orderFromWire, orderToWire, type FillRequest } from "../src/index.js";
import { A, C, PASS, S, harness, mkOrder, ok, signedEntry, userKp } from "./helpers.js";

const TOKEN = "t0ken-".repeat(8);
function app() {
  const h = harness();
  const a = createSolverApp(h.node, { token: TOKEN });
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    a.request(path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) } });
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  return { h, a, call, post };
}
const fillBody = async (): Promise<ReturnType<typeof fillRequestToWire>> => {
  const order = mkOrder();
  const req: FillRequest = { order, assetIn: A, assetOut: C, amountOut: 100n * S, signedUserEntry: (await signedEntry(order)).toXDR("base64"), quoteOut: 105n * S };
  return fillRequestToWire(req);
};
const json = async (r: Response) => (await r.json()) as any;

describe("secretsEqual / bearer", () => {
  it("compares secrets of any length without throwing, and only equal ones match", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "abc")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
    expect(secretsEqual("é".repeat(100), "é".repeat(100))).toBe(true);
  });
  it("reads only a Bearer header", () => {
    expect(bearer("Bearer xyz")).toBe("xyz");
    expect(bearer("Basic xyz")).toBe("");
    expect(bearer("bearer xyz")).toBe("");
    expect(bearer(undefined)).toBe("");
  });
});

describe("the solver service is authenticated everywhere", () => {
  const routes: [string, string][] = [["GET", "/health"], ["POST", "/fill"], ["POST", "/prepare-tx"], ["POST", "/submit-tx"], ["GET", `/status/${"ab".repeat(32)}`], ["GET", "/exposures"], ["POST", "/exposures/x/retry"], ["POST", "/exposures/x/clear"], ["GET", "/nothing-here"]];
  it.each(routes)("%s %s answers 401 without the token, with a wrong one, and with another scheme", async (method, path) => {
    const { call } = app();
    for (const tok of [null, "wrong", TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const r = await call(path, { method, ...(method === "POST" ? { body: "{}" } : {}) }, tok);
      expect(r.status, `${path} with ${tok}`).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe("Bearer");
      expect(await json(r)).toEqual({ error: "unauthorized" });
    }
    const basic = await app().a.request(path, { method, headers: { authorization: `Basic ${TOKEN}` }, ...(method === "POST" ? { body: "{}" } : {}) });
    expect(basic.status).toBe(401);
  });
  it("refuses to be built with a weak token", () => {
    expect(() => createSolverApp(harness().node, { token: "short" })).toThrow(/at least 16/);
  });
  it("unauthenticated requests never reach the solver: no work, no state", async () => {
    const { call, h } = app();
    await call("/fill", { method: "POST", body: JSON.stringify(await fillBody()) }, "nope");
    expect(h.chain.fillsSent).toHaveLength(0);
  });
});

describe("the solver service", () => {
  it("reports health without any secret", async () => {
    const { call, h } = app();
    const b = await json(await call("/health"));
    expect(b).toMatchObject({ ok: true, address: h.chain.address, accepting: true, openExposures: 0 });
    expect(JSON.stringify(b)).not.toMatch(/S[A-Z2-7]{55}/);
  });
  it("fills, then reports the fill's hedge by hash", async () => {
    const { post, call, h } = app();
    h.chain.hedgeSteps.push(ok());
    const r = await post("/fill", await fillBody());
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({ kind: "sent", status: "PENDING" });
    expect(await json(await call(`/status/${b.hash}`))).toEqual({ known: true, hedge: { status: "PENDING" } });
    h.chain.land(b.hash);
    await h.node.idle();
    expect(await json(await call(`/status/${b.hash}`))).toMatchObject({ known: true, hedge: { status: "HEDGED" } });
    expect(await json(await call(`/status/${"cd".repeat(32)}`))).toEqual({ known: false });
    expect((await call("/status/zz")).status).toBe(400);
  });
  it("answers a refusal as a 200 with its kind, not as an HTTP error", async () => {
    const { post, h } = app();
    h.chain.rate = null;
    const r = await post("/fill", await fillBody());
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ kind: "refused", code: "SOLVER_WILL_NOT_FILL", reasons: ["no_hedge_quote"] });
  });
  it("prepares and submits a user-sourced transaction", async () => {
    const { post } = app();
    const req = { order: mkOrder(), assetIn: A, assetOut: C, amountOut: 100n * S, validForSec: 600 };
    const r = await json(await post("/prepare-tx", prepareTxRequestToWire(req)));
    expect(r.kind).toBe("prepared");
    expect(typeof r.tx.minResourceFee).toBe("string");
    const tx = TransactionBuilder.fromXDR(r.tx.xdr, PASS) as Transaction;
    tx.sign(userKp);
    expect(await json(await post("/submit-tx", { signedTx: tx.toXDR() }))).toEqual({ kind: "sent", hash: r.tx.hash, status: "PENDING" });
  });
  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["no order", { assetIn: A }],
    ["a bad user", async () => ({ ...(await fillBody()), order: { ...(await fillBody()).order, user: "nope" } })],
    ["a negative amount", async () => ({ ...(await fillBody()), amountOut: "-5" })],
    ["a fractional amount", async () => ({ ...(await fillBody()), amountOut: "5.5" })],
    ["a numeric amount", async () => ({ ...(await fillBody()), amountOut: 5 })],
    ["bad assets", async () => ({ ...(await fillBody()), assetIn: "x" })],
    ["no entry", async () => ({ ...(await fillBody()), signedUserEntry: "" })],
    ["a bad quote", async () => ({ ...(await fillBody()), quoteOut: "x" })],
  ])("/fill answers 400 for %s", async (_n, body) => {
    const { post, h } = app();
    const r = await post("/fill", typeof body === "function" ? await body() : body);
    expect(r.status).toBe(400);
    expect(typeof (await json(r)).error).toBe("string");
    expect(h.chain.fillsSent).toHaveLength(0);
  });
  it("/prepare-tx and /submit-tx validate too", async () => {
    const { post } = app();
    expect((await post("/prepare-tx", { order: orderToWire(mkOrder()), assetIn: A, assetOut: C, amountOut: "1", validForSec: "600" })).status).toBe(400);
    expect((await post("/submit-tx", {})).status).toBe(400);
    expect((await post("/submit-tx", "{")).status).toBe(400);
  });
  it("limits the request body", async () => {
    const { post } = app();
    const r = await post("/fill", JSON.stringify({ junk: "x".repeat(300 * 1024) }));
    expect(r.status).toBe(413);
  });
  it("lets an operator list, retry and clear open positions", async () => {
    const { post, call, h } = app();
    const b = await json(await post("/fill", await fillBody()));
    h.chain.hedgeSteps.push({ result: { status: "failed", hash: "x", error: "x" } });
    h.chain.rate = (90n * S) / 100n;
    h.chain.land(b.hash);
    await h.node.idle();
    const list = await json(await call("/exposures"));
    expect(list.exposures).toHaveLength(1);
    expect(list.exposures[0]).toMatchObject({ id: b.hash, amount: "100.0000000", reason: "loss_bound_exceeded" });
    expect((await post("/exposures/x/retry", {})).status).toBe(404);
    expect((await post(`/exposures/${b.hash}/retry`, { maxLossBps: 20000 })).status).toBe(400);
    expect((await post("/exposures/x/clear", {})).status).toBe(404);
    expect(await json(await post(`/exposures/${b.hash}/clear`, {}))).toEqual({ cleared: true });
    expect((await json(await call("/exposures"))).exposures).toHaveLength(0);
    expect((await json(await call("/health"))).accepting).toBe(true);
    h.chain.hedgeSteps.push(ok());
  });
});

describe("wire", () => {
  it("round-trips an order", () => {
    const o = mkOrder();
    expect(orderFromWire(orderToWire(o))).toEqual(o);
  });
  it.each([
    [null], [[]], [{}], [{ ...orderToWire(mkOrder()), user: "G" + "A".repeat(55) }], [{ ...orderToWire(mkOrder()), tokenIn: "x" }],
    [{ ...orderToWire(mkOrder()), deadline: 1.5 }], [{ ...orderToWire(mkOrder()), createTrustline: "yes" }], [{ ...orderToWire(mkOrder()), amountIn: 5 }],
  ])("rejects a malformed order %#", (v) => {
    expect(typeof orderFromWire(v)).toBe("string");
  });
});
