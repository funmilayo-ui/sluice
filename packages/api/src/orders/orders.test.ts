import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, StrKey, Networks, Operation, TransactionBuilder, Account, xdr } from "@stellar/stellar-sdk";
import { Router } from "@sluice/core";
import { encodeOrder } from "@sluice/solver";
import { createApp } from "../app.js";
import { buildPreimage } from "./auth.js";
import { assertNotMainnet, isPublicNetwork, loadOrdersConfig, MainnetRefused } from "./config.js";
import { makeOrderId, orderIdAmount, verifyOrderId } from "./mac.js";
import { createOrdersService, readFill } from "./service.js";
import { ordersFromEnv } from "./routes.js";
import { A, C, config, HASH, NOW, PASS, S, build, prepareBody, settle, solverKp, stranger, user, wallet, fake } from "./fixtures.js";

const json = async (r: Response) => (await r.json()) as any;

describe("orders configuration", () => {
  const complete = {
    ORDERS_SETTLE_CONTRACT: settle,
    ORDERS_RPC_URL: "https://rpc.test",
    ORDERS_HORIZON_URL: "https://horizon.test/",
    ORDERS_NETWORK_PASSPHRASE: Networks.TESTNET,
    ORDERS_SOLVER_SECRET: solverKp.secret(),
    ORDERS_MAC_SECRET: "0123456789abcdef0123",
  };
  it("is disabled when nothing is set", () => {
    expect(loadOrdersConfig({})).toMatchObject({ enabled: false, code: "ORDERS_NOT_CONFIGURED" });
  });
  it("is disabled and names what is missing when half configured", () => {
    const { ORDERS_SOLVER_SECRET: _s, ORDERS_MAC_SECRET: _m, ...half } = complete;
    const r = loadOrdersConfig(half);
    expect(r).toMatchObject({ enabled: false, code: "ORDERS_INCOMPLETE" });
    expect((r as { reason: string }).reason).toContain("ORDERS_SOLVER_SECRET");
    expect((r as { reason: string }).reason).toContain("ORDERS_MAC_SECRET");
  });
  it("is enabled when complete, trims the Horizon URL and scales the order cap to stroops", () => {
    const r = loadOrdersConfig({ ...complete, ORDERS_MAX_ORDER_IN: "250" });
    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.config.horizonUrl).toBe("https://horizon.test");
      expect(r.config.policy.maxOrderIn).toBe(250n * S);
      expect(r.config.policy.minProfitBps).toBe(20);
    }
  });
  it.each([
    ["contract", { ORDERS_SETTLE_CONTRACT: "nope" }],
    ["rpc url", { ORDERS_RPC_URL: "not a url" }],
    ["solver secret", { ORDERS_SOLVER_SECRET: "SNOTAKEY" }],
    ["mac secret", { ORDERS_MAC_SECRET: "short" }],
    ["fee rate", { ORDERS_FEE_OUT_PER_XLM: "lots" }],
    ["bps", { ORDERS_MIN_PROFIT_BPS: "20000" }],
  ])("is disabled with a reason for a bad %s, and never echoes the secret", (_n, patch) => {
    const r = loadOrdersConfig({ ...complete, ...patch });
    expect(r).toMatchObject({ enabled: false, code: "ORDERS_INVALID" });
    expect(JSON.stringify(r)).not.toContain(solverKp.secret());
  });
});

describe("mainnet guard", () => {
  const complete = {
    ORDERS_SETTLE_CONTRACT: settle, ORDERS_RPC_URL: "https://rpc.test", ORDERS_HORIZON_URL: "https://horizon.test",
    ORDERS_SOLVER_SECRET: solverKp.secret(), ORDERS_MAC_SECRET: "0123456789abcdef0123",
  };
  it("recognises the public passphrase however it is spelled", () => {
    expect(isPublicNetwork(Networks.PUBLIC)).toBe(true);
    expect(isPublicNetwork(`  ${Networks.PUBLIC.toUpperCase()} `)).toBe(true);
    expect(isPublicNetwork(Networks.TESTNET)).toBe(false);
    expect(isPublicNetwork(Networks.FUTURENET)).toBe(false);
  });
  it("refuses a fully configured environment on the public network, with its own code", () => {
    const r = loadOrdersConfig({ ...complete, ORDERS_NETWORK_PASSPHRASE: Networks.PUBLIC });
    expect(r).toMatchObject({ enabled: false, code: "ORDERS_MAINNET_REFUSED" });
  });
  it("refuses the public network even when everything else is missing", () => {
    expect(loadOrdersConfig({ ORDERS_NETWORK_PASSPHRASE: Networks.PUBLIC })).toMatchObject({ enabled: false, code: "ORDERS_MAINNET_REFUSED" });
  });
  it("a service cannot be built for the public network, even from a hand-made config", () => {
    expect(() => assertNotMainnet(Networks.PUBLIC)).toThrow(MainnetRefused);
    expect(() => createOrdersService({ ...config, networkPassphrase: Networks.PUBLIC }, fake().deps, fake().solver)).toThrow(/testnet-only/);
  });
  it("serves 501 with its own explained code on every route when built from a mainnet environment", async () => {
    const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: ordersFromEnv({ ...complete, ORDERS_NETWORK_PASSPHRASE: Networks.PUBLIC }) });
    const cfg = await json(await app.request("/v1/orders/config"));
    expect(cfg).toMatchObject({ enabled: false, code: "ORDERS_MAINNET_REFUSED" });
    for (const [method, path] of [["POST", "/v1/orders/prepare"], ["POST", "/v1/orders/submit"], ["GET", `/v1/orders/${HASH}`]] as const) {
      const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(r.status, path).toBe(501);
      expect((await json(r)).explained.code).toBe("ORDERS_MAINNET_REFUSED");
    }
  });
  it("refuses at request time when the RPC itself serves the public network, whatever the config says", async () => {
    const t = build({ rpcPassphrase: Networks.PUBLIC });
    const r = await t.post("/v1/orders/prepare", prepareBody);
    expect(r.status).toBe(503);
    expect((await json(r)).explained.code).toBe("ORDERS_MAINNET_REFUSED");
    expect((await t.app.request(`/v1/orders/${HASH}`)).status).toBe(503);
    expect(t.state.sims).toHaveLength(0);
  });
  it("refuses when the RPC serves some other network than configured", async () => {
    const t = build({ rpcPassphrase: Networks.FUTURENET });
    const r = await t.post("/v1/orders/prepare", prepareBody);
    expect(r.status).toBe(503);
    expect((await json(r)).explained.code).toBe("ORDERS_NETWORK_MISMATCH");
  });
});

describe("ordersFromEnv", () => {
  it("builds a running service from a complete testnet environment, and a disabled one from nothing", async () => {
    const on = ordersFromEnv({
      ORDERS_SETTLE_CONTRACT: settle, ORDERS_RPC_URL: "https://rpc.test", ORDERS_HORIZON_URL: "https://horizon.test",
      ORDERS_NETWORK_PASSPHRASE: Networks.TESTNET, ORDERS_SOLVER_SECRET: solverKp.secret(), ORDERS_MAC_SECRET: "0123456789abcdef0123",
    }, { log: () => undefined });
    expect(on.enabled).toBe(true);
    const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: on });
    expect(await json(await app.request("/v1/orders/config"))).toMatchObject({ enabled: true, network: "testnet", solver: solverKp.publicKey() });
    expect(ordersFromEnv({})).toMatchObject({ enabled: false, code: "ORDERS_NOT_CONFIGURED" });
  });
});

describe("disabled state", () => {
  const app = createApp(new Router({ sources: [], hubs: [] }));
  it("config answers 200 with enabled false", async () => {
    const r = await app.request("/v1/orders/config");
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ enabled: false, code: "ORDERS_NOT_CONFIGURED" });
  });
  it("every other route answers 501 with { error, explained }", async () => {
    for (const [method, path] of [["POST", "/v1/orders/prepare"], ["POST", "/v1/orders/submit"], ["GET", `/v1/orders/${HASH}`]] as const) {
      const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(r.status, path).toBe(501);
      const b = await json(r);
      expect(b.error).toBeTruthy();
      expect(b.explained).toMatchObject({ code: "ORDERS_DISABLED" });
    }
  });
  it("leaves the mainnet routes alone", async () => {
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/v1/quote?assetIn=nope&assetOut=x&amount=1")).status).toBe(400);
  });
});

describe("GET /v1/orders/config", () => {
  it("says what is on offer", async () => {
    const t = build();
    const b = await json(await t.app.request("/v1/orders/config"));
    expect(b).toMatchObject({
      enabled: true, network: "testnet", networkPassphrase: PASS, settleContract: settle, solver: solverKp.publicKey(),
      signing: { credentials: "address-legacy" },
    });
    expect(b.limits.maxOrderIn).toBe("1000.0000000");
    expect(JSON.stringify(b)).not.toContain(solverKp.secret());
    expect(JSON.stringify(b)).not.toContain(config.macSecret);
  });
});

describe("POST /v1/orders/prepare", () => {
  it("prices the order, asks for the missing trustline and returns what the wallet signs", async () => {
    const t = build();
    const r = await t.post("/v1/orders/prepare", prepareBody);
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.solverWillFill).toBe(true);
    expect(b.order).toMatchObject({ user: user.publicKey(), assetIn: A, assetOut: C, amountIn: "100.0000000", createTrustline: true, deadline: NOW / 1000 + 600 });
    expect(b.order.tokenIn).toMatch(/^C/);
    expect(b.order.tokenOut).toMatch(/^C/);
    // 100 A -> 105 C on the book. The solver cannot pay all of it (buffer, fees, profit floor), the user signs for 0.5% less than the maximum.
    const pay = BigInt(b.summary.expected.replace(".", "")), floor = BigInt(b.summary.receiveAtLeast.replace(".", ""));
    expect(b.summary.pay).toBe("100.0000000");
    expect(floor).toBeGreaterThan(0n);
    expect(pay).toBeGreaterThanOrEqual(floor);
    expect(pay).toBeLessThan(105n * S);
    expect(b.orderId).toBe(`${pay}.${b.orderId.split(".")[1]}`);
    expect(b.authEntry).toMatchObject({ credentials: "address-legacy", networkPassphrase: PASS, validUntilLedger: 1000 + 120 });
    // The preimage is the one for exactly this entry and expiry.
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(b.authEntry.xdr, "base64");
    expect(entry.credentials().address().signatureExpirationLedger()).toBe(b.authEntry.validUntilLedger);
    expect(b.authEntry.preimage).toBe(buildPreimage(entry, b.authEntry.validUntilLedger, PASS).toXDR("base64"));
    expect(t.state.sims.length).toBe(2); // a placeholder to price fees, then the real one
  });
  it("does not ask for a trustline the account already has, or for native output", async () => {
    const has = await json(await build({ trust: new Set(["native", A, C]) }).post("/v1/orders/prepare", prepareBody));
    expect(has.order.createTrustline).toBe(false);
    const native = await json(await build({ trust: new Set(["native", A]) }).post("/v1/orders/prepare", { ...prepareBody, assetOut: "native" }));
    expect(native.order.createTrustline).toBe(false);
  });
  it("is stricter about slippage and validity as asked", async () => {
    const loose = await json(await build().post("/v1/orders/prepare", { ...prepareBody, slippageBps: 500, validForSec: 300 }));
    const tight = await json(await build().post("/v1/orders/prepare", { ...prepareBody, slippageBps: 0 }));
    expect(BigInt(loose.summary.receiveAtLeast.replace(".", ""))).toBeLessThan(BigInt(tight.summary.receiveAtLeast.replace(".", "")));
    expect(tight.summary.receiveAtLeast).not.toBe(loose.summary.receiveAtLeast);
    expect(loose.order.deadline).toBe(NOW / 1000 + 300);
  });
  it("declines, with reasons and nothing to sign, when the book has no path", async () => {
    const b = await json(await build({ hedgeRate: null }).post("/v1/orders/prepare", prepareBody));
    expect(b.solverWillFill).toBe(false);
    expect(b.skipReasons).toContain("no_hedge_quote");
    expect(b.explained.code).toBe("SOLVER_WILL_NOT_FILL");
    expect(b.orderId).toBeUndefined();
    expect(b.authEntry).toBeUndefined();
    expect(b.summary.pay).toBe("100.0000000");
  });
  it("declines when the solver holds none of the output asset, or the order is larger than it takes", async () => {
    const t1 = build({ solverC: 0n });
    expect((await json(await t1.post("/v1/orders/prepare", prepareBody))).skipReasons).toContain("inventory_too_low");
    expect(t1.state.sims).toHaveLength(0);
    const big = await json(await build().post("/v1/orders/prepare", { ...prepareBody, amount: "5000" }));
    expect(big.skipReasons).toContain("order_too_large");
  });
  it("declines when the Classic book pays so little there is nothing to give the user", async () => {
    const b = await json(await build({ hedgeRate: 1n }).post("/v1/orders/prepare", prepareBody));
    expect(b.solverWillFill).toBe(false);
    expect(b.skipReasons.length).toBeGreaterThan(0);
  });
  it.each([
    ["not json", "{", 400],
    ["bad account", { ...prepareBody, account: "nope" }, 400],
    ["bad asset", { ...prepareBody, assetIn: "nope" }, 400],
    ["same asset", { ...prepareBody, assetOut: A }, 400],
    ["bad amount", { ...prepareBody, amount: "1.12345678" }, 400],
    ["zero amount", { ...prepareBody, amount: "0" }, 400],
    ["bad slippage", { ...prepareBody, slippageBps: 9999 }, 400],
    ["too short a validity", { ...prepareBody, validForSec: 5 }, 400],
    ["too long a validity", { ...prepareBody, validForSec: 100000 }, 400],
  ])("400 on %s", async (_n, body, status) => {
    const t = build();
    const r = await t.app.request("/v1/orders/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    expect(r.status).toBe(status);
    expect((await json(r)).error).toBeTruthy();
  });
  it("404 for an unfunded account, 502 when Horizon fails", async () => {
    expect((await build({ trust: new Error("account not found on this network") }).post("/v1/orders/prepare", prepareBody)).status).toBe(404);
    expect((await build({ trust: new Error("horizon accounts 500") }).post("/v1/orders/prepare", prepareBody)).status).toBe(502);
  });
  it("422 when the account holds none of the asset to sell", async () => {
    const r = await build({ trust: new Set(["native"]) }).post("/v1/orders/prepare", prepareBody);
    expect(r.status).toBe(422);
    expect((await json(r)).explained.code).toBe("NO_TRUSTLINE");
  });
  it("422 with a plain-words explanation when the simulation fails", async () => {
    const r = await build({ simError: 'HostError: Error(Contract, #10)\n... "resulting balance is not within the allowed range", 0, -5, 100' }).post("/v1/orders/prepare", prepareBody);
    expect(r.status).toBe(422);
    expect((await json(r)).explained.code).toBe("INSUFFICIENT_BALANCE");
  });
});

describe("orderId", () => {
  const order = { user: user.publicKey(), tokenIn: "CA", amountIn: 1n, tokenOut: "CB", minOut: 2n, deadline: 5, createTrustline: true };
  const input = { passphrase: PASS, settleContract: settle, solver: solverKp.publicKey(), order, amountOut: 3n, nonce: "77", validUntilLedger: 9 };
  const id = makeOrderId("k".repeat(20), input);
  const { amountOut: _a, ...rest } = input;
  it("verifies for exactly what was signed and returns the amount it carries", () => {
    expect(id).toMatch(/^3\.[0-9a-f]{64}$/);
    expect(orderIdAmount(id)).toBe(3n);
    expect(verifyOrderId("k".repeat(20), id, rest)).toBe(3n);
  });
  it.each([
    ["amount in", { order: { ...order, amountIn: 2n } }],
    ["min out", { order: { ...order, minOut: 1n } }],
    ["asset out", { order: { ...order, tokenOut: "CC" } }],
    ["asset in", { order: { ...order, tokenIn: "CC" } }],
    ["user", { order: { ...order, user: stranger.publicKey() } }],
    ["deadline", { order: { ...order, deadline: 6 } }],
    ["trustline flag", { order: { ...order, createTrustline: false } }],
    ["expiry ledger", { validUntilLedger: 10 }],
    ["nonce", { nonce: "78" }],
    ["solver", { solver: stranger.publicKey() }],
    ["contract", { settleContract: "CX" }],
    ["network", { passphrase: Networks.FUTURENET }],
  ])("does not verify when %s changes", (_n, patch) => {
    expect(verifyOrderId("k".repeat(20), id, { ...rest, ...patch })).toBeNull();
  });
  it("does not verify with another secret, another amount, or garbage", () => {
    expect(verifyOrderId("z".repeat(20), id, rest)).toBeNull();
    expect(verifyOrderId("k".repeat(20), id.replace(/^3/, "4"), rest)).toBeNull();
    for (const bad of ["", "3", "3.zz", "x.".concat("a".repeat(64)), id.toUpperCase()]) expect(verifyOrderId("k".repeat(20), bad, rest)).toBeNull();
  });
});

describe("POST /v1/orders/submit", () => {
  async function prepared(t = build()) {
    const p = await json(await t.post("/v1/orders/prepare", prepareBody));
    expect(p.solverWillFill).toBe(true);
    return { t, p, signed: await wallet(p) };
  }
  const body = (p: any, signed: string, patch: Record<string, unknown> = {}) => ({ orderId: p.orderId, order: p.order, signedAuthEntry: signed, ...patch });

  it("re-simulates with the user's entry, submits as the solver and returns the hash", async () => {
    const { t, p, signed } = await prepared();
    const r = await t.post("/v1/orders/submit", body(p, signed));
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ hash: HASH, status: "PENDING" });
    const last = t.state.sims.at(-1)!;
    expect(last.signed).toBe(true);
    expect(last.amountOut).toBe(BigInt(p.summary.expected.replace(".", "")));
    expect(t.state.sent).toBe(1);
  });
  it("hands the fill to the solver together with the signed entry and what the API's quote said, and keeps no hedge state itself", async () => {
    const { t, p, signed } = await prepared();
    await t.post("/v1/orders/submit", body(p, signed));
    expect(t.state.fills).toHaveLength(1);
    const f = t.state.fills[0]!;
    expect(f.signedUserEntry).toBe(signed);
    expect(f.assetIn).toBe(A);
    expect(f.assetOut).toBe(C);
    expect(f.amountOut).toBe(BigInt(p.summary.expected.replace(".", "")));
    expect(f.quoteOut).toBe((100n * S * 105n) / 100n);
    expect("hedgeOf" in t.service).toBe(false);
  });

  it.each([
    ["amount_in", (p: any) => ({ order: { ...p.order, amountIn: "99.0000000" } })],
    ["min_out", (p: any) => ({ order: { ...p.order, minOut: "0.0000001" } })],
    ["output asset", (p: any) => ({ order: { ...p.order, assetOut: `SLFD:${p.order.assetOut.split(":")[1]}`, tokenOut: undefined } })],
    ["deadline", (p: any) => ({ order: { ...p.order, deadline: p.order.deadline + 1000 } })],
    ["trustline flag", (p: any) => ({ order: { ...p.order, createTrustline: false } })],
    ["user", (p: any) => ({ order: { ...p.order, user: stranger.publicKey() } })],
    ["the amount the solver agreed to", (p: any) => ({ orderId: `1${p.orderId}` })],
    ["a character of the MAC", (p: any) => ({ orderId: p.orderId.replace(/.$/, (c: string) => (c === "0" ? "1" : "0")) })],
    ["an order id from nowhere", () => ({ orderId: `5.${"0".repeat(64)}` })],
    ["a malformed order id", () => ({ orderId: "hello" })],
  ])("rejects an order whose %s was changed, before simulating or sending anything", async (_n, tamper) => {
    const { t, p, signed } = await prepared();
    const sims = t.state.sims.length;
    const r = await t.post("/v1/orders/submit", body(p, signed, tamper(p)));
    expect(r.status).toBe(400);
    expect((await json(r)).explained.code).toBe("BAD_ORDER_ID");
    expect(t.state.sims.length).toBe(sims);
    expect(t.state.sent).toBe(0);
  });
  it("rejects an entry whose expiry or nonce was changed (the id binds both)", async () => {
    const { t, p, signed } = await prepared();
    const e = xdr.SorobanAuthorizationEntry.fromXDR(signed, "base64");
    e.credentials().address().signatureExpirationLedger(9_999_999);
    const r1 = await t.post("/v1/orders/submit", body(p, e.toXDR("base64")));
    expect((await json(r1)).explained.code).toBe("BAD_ORDER_ID");
    const e2 = xdr.SorobanAuthorizationEntry.fromXDR(signed, "base64");
    e2.credentials().address().nonce(new xdr.Int64(12345n));
    expect((await json(await t.post("/v1/orders/submit", body(p, e2.toXDR("base64"))))).explained.code).toBe("BAD_ORDER_ID");
    expect(t.state.sent).toBe(0);
  });
  it("rejects an entry signed by another key (WRONG_SIGNER) and an unsigned one (BAD_SIGNATURE)", async () => {
    const { t, p } = await prepared();
    const other = await t.post("/v1/orders/submit", body(p, await wallet(p, stranger)));
    expect(other.status).toBe(400);
    expect((await json(other)).explained.code).toBe("WRONG_SIGNER");
    const unsigned = await t.post("/v1/orders/submit", body(p, p.authEntry.xdr));
    expect(unsigned.status).toBe(400);
    expect((await json(unsigned)).explained.code).toBe("BAD_SIGNATURE");
    expect(t.state.sent).toBe(0);
  });
  it("rejects a corrupted signature", async () => {
    const { t, p } = await prepared();
    const e = xdr.SorobanAuthorizationEntry.fromXDR(await wallet(p), "base64");
    const pair = e.credentials().address().signature().vec()![0]!;
    const sigEntry = pair.map()!.find((m) => m.key().sym().toString() === "signature")!;
    const bytes = Buffer.from(sigEntry.val().bytes());
    bytes[0] = bytes[0]! ^ 1;
    sigEntry.val(xdr.ScVal.scvBytes(bytes));
    expect((await json(await t.post("/v1/orders/submit", body(p, e.toXDR("base64"))))).explained.code).toBe("BAD_SIGNATURE");
  });
  it("rejects an entry that authorises something other than this order (ENTRY_MISMATCH)", async () => {
    const t = build({ wrongTree: true });
    const p = await json(await t.post("/v1/orders/prepare", prepareBody));
    const r = await t.post("/v1/orders/submit", body(p, await wallet(p)));
    expect(r.status).toBe(400);
    expect((await json(r)).explained.code).toBe("ENTRY_MISMATCH");
    expect(t.state.sent).toBe(0);
  });
  it("rejects an entry with credentials of another kind", async () => {
    const { t, p } = await prepared();
    const e = xdr.SorobanAuthorizationEntry.fromXDR(p.authEntry.xdr, "base64");
    const src = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: e.rootInvocation() });
    const r = await t.post("/v1/orders/submit", body(p, src.toXDR("base64")));
    expect(r.status).toBe(400);
    expect((await json(r)).explained.code).toBe("UNSUPPORTED_CREDENTIALS");
  });
  it("410 when the signature window has passed, or the order's deadline has", async () => {
    const a = await prepared();
    a.t.state.ledger = a.p.authEntry.validUntilLedger;
    const r1 = await a.t.post("/v1/orders/submit", body(a.p, a.signed));
    expect(r1.status).toBe(410);
    expect((await json(r1)).explained.code).toBe("EXPIRED");
    const b = await prepared();
    b.t.state.nowMs = (b.p.order.deadline + 1) * 1000;
    expect((await b.t.post("/v1/orders/submit", body(b.p, b.signed))).status).toBe(410);
    expect(a.t.state.sent + b.t.state.sent).toBe(0);
  });
  it("409 when the price has moved so the solver would lose money now", async () => {
    const { t, p, signed } = await prepared();
    t.state.hedgeRate = (95n * S) / 100n;
    const r = await t.post("/v1/orders/submit", body(p, signed));
    expect(r.status).toBe(409);
    const b = await json(r);
    expect(b.explained.code).toBe("SOLVER_WILL_NOT_FILL");
    expect(b.skipReasons.length).toBeGreaterThan(0);
    expect(t.state.sent).toBe(0);
  });
  it("410 when too little time is left for the solver to fill and hedge", async () => {
    const { t, p, signed } = await prepared();
    t.state.nowMs = (p.order.deadline - 30) * 1000;
    expect((await t.post("/v1/orders/submit", body(p, signed))).status).toBe(410);
  });
  it.each([
    ["the settle contract's BelowMinOut", `HostError: Error(Contract, #5)\n[Diagnostic Event] contract:${settle}, topics:[error, Error(Contract, #5)], data:["fill"]`, "BELOW_MIN_OUT"],
    ["an expired order", `HostError: Error(Contract, #3)\n[Diagnostic Event] contract:${settle}, topics:[error, Error(Contract, #3)], data:[]`, "EXPIRED"],
    ["a used signature", "HostError: Error(Auth, ExistingValue)", "ALREADY_USED"],
    ["a signature that covers something else", "HostError: Error(Auth, InvalidAction)", "BAD_SIGNATURE"],
    ["a balance that is too low", 'HostError: Error(Contract, #10)\n"resulting balance is not within the allowed range", 0, -5, 100', "INSUFFICIENT_BALANCE"],
    ["anything else", "HostError: Error(WasmVm, InvalidAction)", "SIMULATION_FAILED"],
  ])("422 with a plain-words explanation when the enforcing simulation fails: %s", async (_n, raw, code) => {
    const { t, p, signed } = await prepared();
    t.state.simError = raw;
    const r = await t.post("/v1/orders/submit", body(p, signed));
    expect(r.status).toBe(422);
    expect((await json(r)).explained.code).toBe(code);
    expect(t.state.sent).toBe(0);
  });
  it("another contract's error number is not read as the settle contract's", async () => {
    const { t, p, signed } = await prepared();
    t.state.simError = "HostError: Error(Contract, #5)\n[Diagnostic Event] contract:CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA, topics:[error, Error(Contract, #5)], data:[]";
    expect((await json(await t.post("/v1/orders/submit", body(p, signed)))).explained.code).toBe("SIMULATION_FAILED");
  });
  it("maps the network's refusal and a busy network like /v1/submit does", async () => {
    const a = await prepared();
    a.t.state.sendResult = { hash: HASH, status: "ERROR", codes: ["txBadSeq"] };
    const r1 = await a.t.post("/v1/orders/submit", body(a.p, a.signed));
    expect(r1.status).toBe(422);
    expect((await json(r1)).explained.code).toBe("STALE_SEQUENCE");
    const b = await prepared();
    b.t.state.sendResult = { hash: HASH, status: "TRY_AGAIN_LATER" };
    expect((await b.t.post("/v1/orders/submit", body(b.p, b.signed))).status).toBe(503);
  });
  it.each([
    ["no body", "{"],
    ["no order id", { order: {}, signedAuthEntry: "x" }],
    ["a malformed order", { orderId: "1.x", order: { user: "nope" }, signedAuthEntry: "x" }],
    ["no entry", "ORDER_ONLY"],
    ["an entry that is not xdr", "NOT_XDR"],
  ])("400 on %s", async (n, b) => {
    const { t, p, signed } = await prepared();
    const payload = b === "ORDER_ONLY" ? { orderId: p.orderId, order: p.order } : b === "NOT_XDR" ? body(p, "AAAA") : b;
    const r = await t.app.request("/v1/orders/submit", { method: "POST", headers: { "content-type": "application/json" }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
    expect(r.status, n).toBe(400);
    expect(signed).toBeTruthy();
  });
});

describe("GET /v1/orders/:hash", () => {
  const fillTx = (returned?: bigint, contract = settle) => {
    const tx = new TransactionBuilder(new Account(solverKp.publicKey(), "1"), { fee: "100", networkPassphrase: PASS })
      .addOperation(Operation.invokeContractFunction({ contract, function: "fill", args: [encodeOrder({ user: user.publicKey(), tokenIn: contract, amountIn: 1n, tokenOut: contract, minOut: 1n, deadline: 1, createTrustline: false }), new Address(solverKp.publicKey()).toScVal(), nativeToScVal(2n, { type: "i128" })] }))
      .setTimeout(30).build();
    return { envelopeXdr: tx.toEnvelope().toXDR("base64"), returnValue: returned === undefined ? undefined : nativeToScVal(returned, { type: "i128" }).toXDR("base64") };
  };
  it("NOT_FOUND while it is not in a ledger", async () => {
    const t = build();
    expect(await json(await t.app.request(`/v1/orders/${HASH}`))).toEqual({ hash: HASH, status: "NOT_FOUND" });
  });
  it("SUCCESS carries the amount the user actually received, read from the return value, and the hedge", async () => {
    const t = build({ tx: { hash: HASH, status: "SUCCESS", ledger: 7, createdAt: 99, ...fillTx(94n * S + 5n) } });
    const b = await json(await t.app.request(`/v1/orders/${HASH}`));
    expect(b).toMatchObject({ hash: HASH, status: "SUCCESS", ledger: 7, createdAt: 99, received: "94.0000005" });
    expect(b.hedge).toBeUndefined();
  });
  it("FAILED explains a contract error in words, and other failures from their result codes", async () => {
    const t1 = build({ tx: { hash: HASH, status: "FAILED", ledger: 7, codes: ["txFailed", "invokeHostFunctionTrapped"], contractError: 5, ...fillTx() } });
    const b1 = await json(await t1.app.request(`/v1/orders/${HASH}`));
    expect(b1.status).toBe("FAILED");
    expect(b1.explained).toMatchObject({ code: "BELOW_MIN_OUT" });
    const t2 = build({ tx: { hash: HASH, status: "FAILED", codes: ["txFailed", "invokeHostFunctionResourceLimitExceeded"], ...fillTx() } });
    expect((await json(await t2.app.request(`/v1/orders/${HASH}`))).explained.code).toBe("STALE_SIMULATION");
  });
  it.each([[1, "BAD_AMOUNT"], [2, "SAME_TOKEN"], [3, "EXPIRED"], [4, "BAD_SOLVER"], [5, "BELOW_MIN_OUT"]])("contract error %i is %s", async (n, code) => {
    const t = build({ tx: { hash: HASH, status: "FAILED", codes: ["txFailed"], contractError: n, ...fillTx() } });
    const e = (await json(await t.app.request(`/v1/orders/${HASH}`))).explained;
    expect(e.code).toBe(code);
    expect(e.message.length).toBeGreaterThan(20);
  });
  it("404 for a transaction that is not a fill of this contract", async () => {
    const other = StrKeyContract();
    const t = build({ tx: { hash: HASH, status: "SUCCESS", ledger: 1, ...fillTx(1n, other) } });
    expect((await t.app.request(`/v1/orders/${HASH}`)).status).toBe(404);
    const t2 = build({ tx: { hash: HASH, status: "SUCCESS", ledger: 1 } });
    expect((await t2.app.request(`/v1/orders/${HASH}`)).status).toBe(404);
  });
  it("400 for a bad hash, 502 when the RPC fails", async () => {
    const t = build();
    expect((await t.app.request("/v1/orders/zzz")).status).toBe(400);
    const f = fake();
    f.deps.getTx = async () => { throw new Error("rpc down\nstack"); };
    const svc = createOrdersService(config, f.deps, f.solver);
    const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: { enabled: true, service: svc } });
    const r = await app.request(`/v1/orders/${HASH}`);
    expect(r.status).toBe(502);
    expect((await json(r)).error).toBe("rpc down");
  });
  it("reads a fill and nothing else", () => {
    expect(readFill(fillTx(5n), settle)).toEqual({ received: 5n });
    expect(readFill(fillTx(5n), StrKeyContract())).toBeNull();
    expect(readFill({}, settle)).toBeNull();
    expect(readFill({ envelopeXdr: "garbage" }, settle)).toBeNull();
  });
});

function StrKeyContract(): string {
  return StrKey.encodeContract(randomBytes(32));
}
