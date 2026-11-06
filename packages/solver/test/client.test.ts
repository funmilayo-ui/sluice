import { describe, expect, it } from "vitest";
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { createSolverApp, RemoteSolver, SolverUnavailable, type FillRequest, type UnavailableReason } from "../src/index.js";
import { A, C, PASS, S, harness, mkOrder, ok, signedEntry, userKp } from "./helpers.js";

const TOKEN = "t0ken-".repeat(8);
function remote(over: { fetchImpl?: typeof fetch; token?: string; address?: string; writeTimeoutMs?: number; readTimeoutMs?: number } = {}) {
  const h = harness();
  const app = createSolverApp(h.node, { token: TOKEN });
  const fetchImpl = over.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init));
  const solver = new RemoteSolver({ url: "http://solver.internal:8788/", token: over.token ?? TOKEN, address: over.address ?? h.chain.address, fetchImpl: fetchImpl as typeof fetch, ...(over.writeTimeoutMs ? { writeTimeoutMs: over.writeTimeoutMs } : {}), ...(over.readTimeoutMs ? { readTimeoutMs: over.readTimeoutMs } : {}) });
  return { h, solver };
}
const req = async (): Promise<FillRequest> => {
  const order = mkOrder();
  return { order, assetIn: A, assetOut: C, amountOut: 100n * S, signedUserEntry: (await signedEntry(order)).toXDR("base64"), quoteOut: 105n * S };
};
const reasonOf = async (p: Promise<unknown>): Promise<UnavailableReason | string> => {
  try {
    await p;
    return "no error";
  } catch (e) {
    expect(e).toBeInstanceOf(SolverUnavailable);
    return (e as SolverUnavailable).reason;
  }
};
const respond = (status: number, body: unknown, ctype = "application/json") => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": ctype } })) as unknown as typeof fetch;

describe("RemoteSolver against a real solver service", () => {
  it("is the same port as the in-process node: health, breaker, fill, status, tier 2", async () => {
    const { h, solver } = remote();
    expect((await solver.health()).address).toBe(h.chain.address);
    expect(await solver.canFill()).toEqual({ ok: true });
    h.chain.hedgeSteps.push(ok());
    const out = await solver.fill(await req());
    expect(out).toMatchObject({ kind: "sent", status: "PENDING" });
    if (out.kind !== "sent") return;
    expect(await solver.orderStatus(out.hash)).toEqual({ status: "PENDING" });
    h.chain.land(out.hash);
    await h.node.idle();
    expect(await solver.orderStatus(out.hash)).toMatchObject({ status: "HEDGED", received: "104.0000000" });
    expect(await solver.orderStatus("ef".repeat(32))).toBeUndefined();

    const prep = await solver.prepareTx({ order: mkOrder(), assetIn: A, assetOut: C, amountOut: 100n * S, validForSec: 600 });
    expect(prep.kind).toBe("prepared");
    if (prep.kind !== "prepared") return;
    expect(prep.tx.minResourceFee).toBe(100_000n);
    const tx = TransactionBuilder.fromXDR(prep.tx.xdr, PASS) as Transaction;
    tx.sign(userKp);
    expect(await solver.submitTx({ signedTx: tx.toXDR() })).toEqual({ kind: "sent", hash: prep.tx.hash, status: "PENDING" });
  });
  it("carries a refusal across the wire", async () => {
    const { h, solver } = remote();
    h.chain.rate = null;
    expect(await solver.fill(await req())).toMatchObject({ kind: "refused", reasons: ["no_hedge_quote"] });
  });
  it("reflects an open breaker in canFill, with the reason", async () => {
    const { h, solver } = remote();
    const r = await h.node.fill(await req());
    const hash = (r as { hash: string }).hash;
    h.chain.hedgeSteps.push({ result: { status: "failed", hash: "x", error: "x" } });
    h.chain.rate = (90n * S) / 100n;
    h.chain.land(hash);
    await h.node.idle();
    const g = await solver.canFill();
    expect(g.ok).toBe(false);
    expect(!g.ok && g.reason).toMatch(/circuit breaker/);
  });
});

describe("RemoteSolver turns every failure into SolverUnavailable with a safe reason", () => {
  it.each([
    ["a connection that fails", (async () => { throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.5:8788"); }) as unknown as typeof fetch, "unreachable"],
    ["a timeout", (async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }) as unknown as typeof fetch, "timeout"],
    ["a refused token", respond(401, { error: "unauthorized" }), "unauthorized"],
    ["a server error", respond(500, { error: "boom" }), "failed"],
    ["a bad request", respond(400, { error: "nope" }), "failed"],
    ["an HTML error page", respond(502, "<html>bad gateway</html>", "text/html"), "bad_response"],
    ["an empty 200", respond(200, ""), "bad_response"],
  ])("%s -> %s", async (_n, fetchImpl, reason) => {
    const { solver } = remote({ fetchImpl });
    expect(await reasonOf(solver.health())).toBe(reason);
    expect(await reasonOf(solver.canFill())).toBe(reason);
    expect(await reasonOf(solver.fill(await req()))).toBe(reason);
    expect(await reasonOf(solver.orderStatus("ab".repeat(32)))).toBe(reason);
  });
  it("gives up on a service that never answers, within the timeout", async () => {
    const hang = ((_i: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    const { solver } = remote({ fetchImpl: hang, writeTimeoutMs: 30, readTimeoutMs: 30 });
    const t0 = Date.now();
    expect(await reasonOf(solver.fill(await req()))).toBe("timeout");
    expect(await reasonOf(solver.health())).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("rejects a service that is another solver than configured, and answers it does not understand", async () => {
    const { solver } = remote({ address: "G" + "B".repeat(55) });
    expect(await reasonOf(solver.health())).toBe("mismatch");
    const odd = remote({ fetchImpl: respond(200, { hello: "world" }) });
    expect(await reasonOf(odd.solver.fill(await req()))).toBe("bad_response");
    expect(await reasonOf(odd.solver.health())).toBe("bad_response");
    const prep = remote({ fetchImpl: respond(200, { kind: "prepared", tx: { xdr: 1 } }) });
    expect(await reasonOf(prep.solver.prepareTx({ order: mkOrder(), assetIn: A, assetOut: C, amountOut: 1n, validForSec: 600 }))).toBe("bad_response");
  });
  it("sends the token and nothing else secret, and never puts a URL in an error message that the API shows", async () => {
    const seen: Record<string, string>[] = [];
    const spy = (async (_i: unknown, init?: RequestInit) => { seen.push(init?.headers as Record<string, string>); return new Response(JSON.stringify({ ok: true, address: "x" }), { status: 200 }); }) as unknown as typeof fetch;
    const { solver } = remote({ fetchImpl: spy });
    await reasonOf(solver.health());
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    const failing = remote({ fetchImpl: (async () => { throw new TypeError("connect ECONNREFUSED 10.0.0.5:8788"); }) as unknown as typeof fetch });
    try {
      await failing.solver.health();
    } catch (e) {
      expect((e as SolverUnavailable).reason).toBe("unreachable");
    }
  });
});
