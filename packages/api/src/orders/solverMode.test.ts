import { describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { Router } from "@sluice/core";
import { RemoteSolver, SolverUnavailable, type FillOutcome, type HedgeView, type UnavailableReason } from "@sluice/solver";
import { createApp } from "../app.js";
import { loadOrdersConfig } from "./config.js";
import { ordersFromEnv } from "./routes.js";
import { createOrdersService } from "./service.js";
import { A, C, config, HASH, PASS, S, build, fake, prepareBody, settle, solverKp, user, wallet } from "./fixtures.js";

const json = async (r: Response) => (await r.json()) as any;

describe("the solver circuit breaker at the API", () => {
  it("prepare refuses up front with the breaker's skip reason, explained, before anything is priced or simulated", async () => {
    const t = build({ breaker: "circuit breaker: 1 unhedged position(s) worth 95 C stroops exceed the cap of 0 (abc: loss_bound_exceeded)" });
    const r = await t.post("/v1/orders/prepare", prepareBody);
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({ solverWillFill: false, skipReasons: ["circuit_breaker"], explained: { code: "SOLVER_WILL_NOT_FILL", detail: "circuit_breaker" } });
    expect(b.explained.message).toMatch(/paused new orders/);
    expect(b.orderId).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain("loss_bound_exceeded"); // the operator's reason stays with the operator
    expect(t.state.sims).toHaveLength(0);
  });
  it("submit refuses with 409 when the breaker opened after prepare, and the solver is never asked to fill", async () => {
    const t = build();
    const p = await json(await t.post("/v1/orders/prepare", prepareBody));
    const signed = await wallet(p);
    t.state.breaker = "tripped";
    const r = await t.post("/v1/orders/submit", { orderId: p.orderId, order: p.order, signedAuthEntry: signed });
    expect(r.status).toBe(409);
    const b = await json(r);
    expect(b).toMatchObject({ skipReasons: ["circuit_breaker"], explained: { code: "SOLVER_WILL_NOT_FILL" } });
    expect(t.state.sent).toBe(0);
    expect(t.state.sims.filter((s) => s.signed)).toHaveLength(0);
  });
  it("a breaker that closes again lets the next order through", async () => {
    const t = build({ breaker: "tripped" });
    expect((await json(await t.post("/v1/orders/prepare", prepareBody))).solverWillFill).toBe(false);
    t.state.breaker = undefined;
    expect((await json(await t.post("/v1/orders/prepare", prepareBody))).solverWillFill).toBe(true);
  });
});

describe("GET /v1/orders/:hash and the hedge", () => {
  const fillTxFields = async () => {
    // A real fill transaction envelope, so the endpoint recognises it as a fill of the settle contract.
    const { userTx } = await import("./fixtures.js");
    const order = { user: user.publicKey(), tokenIn: settle, amountIn: 1n, tokenOut: settle, minOut: 1n, deadline: 1, createTrustline: false };
    return { envelopeXdr: (await userTx(order, 2n)).tx.toEnvelope().toXDR("base64") };
  };
  const views: HedgeView[] = [
    { status: "PENDING" },
    { status: "HEDGING" },
    { status: "HEDGED", hash: "cd".repeat(32), received: "104.0000000" },
    { status: "RETRYING", attempts: 2, reason: "loss_bound_exceeded", error: "worst case below the bound", nextRetryAt: 1_800_000_300 },
    { status: "UNHEDGED", attempts: 1, reason: "retries_exhausted", error: "3 hedge attempts did not land" },
    { status: "ABANDONED", attempts: 9, reason: "loss_bound_exceeded", error: "automatic retries are spent" },
    { status: "NOT_NEEDED", reason: "the fill failed, so the solver took nothing" },
  ];
  it.each(views.map((v) => [v.status, v] as const))("reports the solver's %s hedge exactly, and the fill's own status is untouched", async (_n, view) => {
    const t = build({ tx: { hash: HASH, status: "SUCCESS", ledger: 7, createdAt: 9, returnValue: undefined, ...(await fillTxFields()) } });
    t.state.hedges.set(HASH, view);
    const b = await json(await t.app.request(`/v1/orders/${HASH}`));
    expect(b.status).toBe("SUCCESS");
    expect(b.ledger).toBe(7);
    expect(b.hedge).toEqual(view);
  });
  it("reports the hedge of a fill that is not in a ledger yet", async () => {
    const t = build();
    t.state.hedges.set(HASH, { status: "PENDING" });
    expect(await json(await t.app.request(`/v1/orders/${HASH}`))).toEqual({ hash: HASH, status: "NOT_FOUND", hedge: { status: "PENDING" } });
  });
  it("a solver that cannot be asked leaves the fill status alone and says the hedge is UNKNOWN, even on a fresh API instance that has never reached the solver", async () => {
    // Found by the live restart test (w5): a restarted API with the solver already down must still report the fill from the chain.
    const t = build({ tx: { hash: HASH, status: "SUCCESS", ledger: 7, ...(await fillTxFields()) }, solverDown: "timeout" });
    const r = await t.app.request(`/v1/orders/${HASH}`);
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({ status: "SUCCESS", ledger: 7, hedge: { status: "UNKNOWN" } });
    expect(JSON.stringify(b)).not.toMatch(/timeout|http|fake solver/i);
    // and a fill that is not in a ledger yet, and one that failed, are reported the same way
    const pending = build({ solverDown: "unreachable" });
    expect(await json(await pending.app.request(`/v1/orders/${HASH}`))).toMatchObject({ status: "NOT_FOUND", hedge: { status: "UNKNOWN" } });
    const failed = build({ tx: { hash: HASH, status: "FAILED", codes: ["txFailed"], contractError: 5, ...(await fillTxFields()) }, solverDown: "failed" });
    expect(await json(await failed.app.request(`/v1/orders/${HASH}`))).toMatchObject({ status: "FAILED", explained: { code: "BELOW_MIN_OUT" }, hedge: { status: "UNKNOWN" } });
  });
});

describe("a solver service that fails maps to clean, explained API errors", () => {
  const reasons: UnavailableReason[] = ["unreachable", "timeout", "unauthorized", "failed", "bad_response", "mismatch"];
  it.each(reasons)("prepare answers 503 SOLVER_UNAVAILABLE (%s) without leaking addresses or stack traces", async (reason) => {
    const t = build({ solverDown: reason });
    const r = await t.post("/v1/orders/prepare", prepareBody);
    expect(r.status).toBe(503);
    const b = await json(r);
    expect(b.explained).toMatchObject({ code: "SOLVER_UNAVAILABLE", detail: reason });
    expect(b.explained.message).toMatch(/Nothing was signed/);
    expect(JSON.stringify(b)).not.toMatch(/fake solver|http:|at /);
    expect(t.state.sims).toHaveLength(0);
  });
  it("submit answers 503 SOLVER_UNAVAILABLE when the solver goes away between prepare and submit; nothing is claimed sent", async () => {
    const t = build();
    const p = await json(await t.post("/v1/orders/prepare", prepareBody));
    const signed = await wallet(p);
    t.state.solverDown = "timeout";
    const r = await t.post("/v1/orders/submit", { orderId: p.orderId, order: p.order, signedAuthEntry: signed });
    expect(r.status).toBe(503);
    expect((await json(r)).explained.code).toBe("SOLVER_UNAVAILABLE");
    expect(t.state.sent).toBe(0);
  });
  it("a fill that times out inside the solver client surfaces as 503, and resubmitting reaches the same hash", async () => {
    const t = build();
    const p = await json(await t.post("/v1/orders/prepare", prepareBody));
    const signed = await wallet(p);
    const body = { orderId: p.orderId, order: p.order, signedAuthEntry: signed };
    const orig = t.solver.fill.bind(t.solver);
    let calls = 0;
    t.solver.fill = async (req) => {
      if (calls++ === 0) throw new SolverUnavailable("timed out", "the request may have been processed", "timeout");
      return orig(req);
    };
    expect((await t.post("/v1/orders/submit", body)).status).toBe(503);
    const again = await t.post("/v1/orders/submit", body);
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ hash: HASH, status: "PENDING" });
  });
  it("the config endpoint keeps answering when the solver is down: it reads configuration, not the solver", async () => {
    const t = build({ solverDown: "unreachable" });
    const r = await t.app.request("/v1/orders/config");
    expect(r.status).toBe(200);
    expect((await json(r)).enabled).toBe(true);
  });
  it("refuses a solver service that is configured for another contract or network", async () => {
    const f = fake();
    f.solver.health = async () => ({ ok: true, address: solverKp.publicKey(), networkPassphrase: PASS, settleContract: "C" + "A".repeat(55), accepting: true, openExposures: 0, recoveryLoop: true, store: "x" });
    const service = createOrdersService(config, f.deps, f.solver);
    const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: { enabled: true, service } });
    const r = await app.request("/v1/orders/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(prepareBody) });
    expect(r.status).toBe(503);
    expect((await json(r)).explained.code).toBe("ORDERS_SOLVER_MISMATCH");
  });
  it("refuses a solver port that is another solver than the configured address", () => {
    const f = fake();
    expect(() => createOrdersService({ ...config, solverAddress: Keypair.random().publicKey() }, f.deps, f.solver)).toThrow(/different solver/);
  });
  const outcomes: [string, FillOutcome, number, string | undefined][] = [
    ["a policy refusal", { kind: "refused", code: "SOLVER_WILL_NOT_FILL", reasons: ["below_min_profit"], message: "x" }, 409, "SOLVER_WILL_NOT_FILL"],
    ["the breaker", { kind: "refused", code: "CIRCUIT_BREAKER", reasons: ["circuit_breaker"], message: "x" }, 409, "SOLVER_WILL_NOT_FILL"],
    ["too little time", { kind: "refused", code: "SOLVER_WILL_NOT_FILL", reasons: ["deadline_too_close"], message: "x" }, 410, "EXPIRED"],
    ["an expired order", { kind: "invalid", code: "EXPIRED", message: "x" }, 410, "EXPIRED"],
    ["a bad entry", { kind: "invalid", code: "ENTRY_MISMATCH", message: "no" }, 400, "ENTRY_MISMATCH"],
    ["a failed simulation", { kind: "sim_failed", message: "HostError: Error(Auth, ExistingValue)\nmore" }, 422, "ALREADY_USED"],
    ["a network rejection", { kind: "rejected", codes: ["txBadSeq"], hash: HASH }, 422, "STALE_SEQUENCE"],
    ["a busy network", { kind: "busy", message: "busy", hash: HASH }, 503, undefined],
    ["an internal error", { kind: "error", message: "horizon down\nstack" }, 502, undefined],
  ];
  it.each(outcomes)("maps %s", async (_n, outcome, status, code) => {
    const t = build({ outcome });
    const p = await json(await t.post("/v1/orders/prepare", prepareBody));
    const r = await t.post("/v1/orders/submit", { orderId: p.orderId, order: p.order, signedAuthEntry: await wallet(p) });
    expect(r.status).toBe(status);
    const b = await json(r);
    if (code) expect(b.explained.code).toBe(code);
    expect(b.error).not.toContain("\n");
  });
});

describe("solver mode configuration", () => {
  const base = {
    ORDERS_SETTLE_CONTRACT: settle, ORDERS_RPC_URL: "https://rpc.test", ORDERS_HORIZON_URL: "https://horizon.test",
    ORDERS_NETWORK_PASSPHRASE: Networks.TESTNET, ORDERS_MAC_SECRET: "0123456789abcdef0123",
  };
  const remote = { ...base, ORDERS_SOLVER_MODE: "remote", ORDERS_SOLVER_URL: "https://solver.internal:8788/", ORDERS_SOLVER_TOKEN: "t".repeat(40), ORDERS_SOLVER_ADDRESS: solverKp.publicKey() };
  const local = { ...base, ORDERS_SOLVER_MODE: "local", ORDERS_SOLVER_SECRET: solverKp.secret() };

  it("remote mode needs only a URL, a token and the solver's public address, and the resulting config holds no secret", () => {
    const r = loadOrdersConfig(remote);
    expect(r.enabled).toBe(true);
    if (!r.enabled) return;
    expect(r.config.solver).toEqual({ mode: "remote", url: "https://solver.internal:8788", token: "t".repeat(40) });
    expect(r.config.solverAddress).toBe(solverKp.publicKey());
    expect(JSON.stringify(r.config, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/S[A-Z2-7]{55}/);
  });
  it("remote mode refuses to start with the solver secret present: the API must not hold the key", () => {
    const r = loadOrdersConfig({ ...remote, ORDERS_SOLVER_SECRET: solverKp.secret() });
    expect(r).toMatchObject({ enabled: false, code: "ORDERS_INVALID" });
    expect(JSON.stringify(r)).not.toContain(solverKp.secret());
    expect((r as { reason: string }).reason).toMatch(/must not hold the solver key/);
  });
  it.each([
    ["URL", { ORDERS_SOLVER_URL: undefined }], ["token", { ORDERS_SOLVER_TOKEN: undefined }], ["address", { ORDERS_SOLVER_ADDRESS: undefined }],
  ])("remote mode without the %s is incomplete", (_n, patch) => {
    expect(loadOrdersConfig({ ...remote, ...patch })).toMatchObject({ enabled: false, code: "ORDERS_INCOMPLETE" });
  });
  it.each([
    ["a short token", { ORDERS_SOLVER_TOKEN: "short" }],
    ["a bad address", { ORDERS_SOLVER_ADDRESS: "GNOPE" }],
    ["a secret as the address", { ORDERS_SOLVER_ADDRESS: solverKp.secret() }],
    ["a bad URL", { ORDERS_SOLVER_URL: "ftp://x" }],
    ["an unknown mode", { ORDERS_SOLVER_MODE: "cloud" }],
  ])("remote mode with %s is invalid", (_n, patch) => {
    const r = loadOrdersConfig({ ...remote, ...patch });
    expect(r).toMatchObject({ enabled: false, code: "ORDERS_INVALID" });
    expect(JSON.stringify(r)).not.toContain(solverKp.secret());
  });
  it("local mode is explicit and refuses a URL next to the secret, so there is never doubt which solver signs", () => {
    expect(loadOrdersConfig(local)).toMatchObject({ enabled: true });
    expect(loadOrdersConfig({ ...local, ORDERS_SOLVER_URL: "https://solver.internal" })).toMatchObject({ enabled: false, code: "ORDERS_INVALID" });
  });
  it("without ORDERS_SOLVER_MODE a secret means local (the old configuration keeps working) and a URL alone means remote", () => {
    const { ORDERS_SOLVER_MODE: _m, ...legacy } = local;
    const r = loadOrdersConfig(legacy);
    expect(r.enabled && r.config.solver.mode).toBe("local");
    const { ORDERS_SOLVER_MODE: _n, ...inferred } = remote;
    const r2 = loadOrdersConfig(inferred);
    expect(r2.enabled && r2.config.solver.mode).toBe("remote");
  });
  it("carries the state directory and recovery settings through to an in-process solver", () => {
    const r = loadOrdersConfig({ ...local, SLUICE_STATE_DIR: "/var/lib/sluice", ORDERS_MAX_LOSS_BPS: "25", ORDERS_RETRY_MAX_CYCLES: "4" });
    expect(r.enabled && r.config.stateDir).toBe("/var/lib/sluice");
    expect(r.enabled && r.config.recovery.maxLossBps).toBe(25);
    expect(r.enabled && r.config.retry.maxCycles).toBe(4);
    expect(loadOrdersConfig({ ...local, ORDERS_MAX_LOSS_BPS: "20000" })).toMatchObject({ enabled: false, code: "ORDERS_INVALID" });
  });
  it("wires a RemoteSolver without a background loop for remote mode, and a started-on-demand in-process solver for local mode", () => {
    const rem = ordersFromEnv(remote, { log: () => undefined });
    expect(rem.enabled).toBe(true);
    expect(rem.enabled && rem.background).toBeUndefined();
    const loc = ordersFromEnv(local, { log: () => undefined });
    expect(loc.enabled && typeof loc.background?.start).toBe("function");
  });
  it("advertises both signing tiers and keeps the documented credentials field", async () => {
    const t = build();
    const b = await json(await t.app.request("/v1/orders/config"));
    expect(b.signing).toEqual({ credentials: "address-legacy", tiers: ["auth-entry", "tx"] });
    expect(b).toMatchObject({ enabled: true, solver: solverKp.publicKey(), settleContract: settle });
  });
  it("RemoteSolver is a SolverPort for the configured address", () => {
    const s = new RemoteSolver({ url: "http://x", token: "t".repeat(32), address: solverKp.publicKey() });
    expect(s.address).toBe(solverKp.publicKey());
  });
});

void A; void C; void S;
