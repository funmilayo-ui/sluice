import { describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { assertNotMainnet, FileStore, isPublicNetwork, loadKnobs, loadSolverServiceConfig, MainnetRefused, MemoryStore, storeFromEnv } from "../src/index.js";
import { SETTLE, S } from "./helpers.js";

const kp = Keypair.random();
const env = {
  SOLVER_SECRET: kp.secret(), SOLVER_AUTH_TOKEN: "t".repeat(40), SOLVER_SETTLE_CONTRACT: SETTLE, SOLVER_RPC_URL: "https://rpc.test", SOLVER_HORIZON_URL: "https://horizon.test/",
  SOLVER_NETWORK_PASSPHRASE: Networks.TESTNET, SLUICE_STATE_DIR: "/var/lib/sluice",
};

describe("the mainnet guard", () => {
  it("recognises the public passphrase however it is spelled", () => {
    expect(isPublicNetwork(Networks.PUBLIC)).toBe(true);
    expect(isPublicNetwork(` ${Networks.PUBLIC.toUpperCase()} `)).toBe(true);
    expect(isPublicNetwork("Public Global Stellar Network ; September 2015 (mirror)")).toBe(true);
    expect(isPublicNetwork(Networks.TESTNET)).toBe(false);
    expect(() => assertNotMainnet(Networks.PUBLIC)).toThrow(MainnetRefused);
    expect(() => assertNotMainnet(Networks.TESTNET)).not.toThrow();
  });
  it("the solver service refuses to start on the public network, with no override", () => {
    const r = loadSolverServiceConfig({ ...env, SOLVER_NETWORK_PASSPHRASE: Networks.PUBLIC, SOLVER_ALLOW_MAINNET: "1", ALLOW_MAINNET: "1" });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("testnet-only") });
    expect(loadSolverServiceConfig({ SOLVER_NETWORK_PASSPHRASE: Networks.PUBLIC })).toMatchObject({ ok: false });
  });
});

describe("loadSolverServiceConfig", () => {
  it("reads a complete configuration", () => {
    const r = loadSolverServiceConfig({ ...env, SOLVER_MAX_ORDER_IN: "250", SOLVER_PORT: "9000", SOLVER_HOST: "0.0.0.0", SOLVER_MAX_LOSS_BPS: "25", SOLVER_MAX_UNHEDGED_OUT: "5" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.node.horizonUrl).toBe("https://horizon.test");
    expect(r.config.node.policy.maxOrderIn).toBe(250n * S);
    expect(r.config.node.recovery).toMatchObject({ maxLossBps: 25, maxUnhedgedExposureOut: 5n * S, maxRetries: 3 });
    expect(r.config).toMatchObject({ port: 9000, host: "0.0.0.0", stateDir: "/var/lib/sluice", token: "t".repeat(40) });
    expect(loadSolverServiceConfig(env)).toMatchObject({ ok: true, config: { port: 8788, host: "127.0.0.1" } });
  });
  it.each(["SOLVER_SECRET", "SOLVER_AUTH_TOKEN", "SOLVER_SETTLE_CONTRACT", "SOLVER_RPC_URL", "SOLVER_HORIZON_URL", "SOLVER_NETWORK_PASSPHRASE"])("names the missing %s", (k) => {
    const { [k]: _gone, ...rest } = env as Record<string, string>;
    const r = loadSolverServiceConfig(rest);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain(k);
  });
  it.each([
    ["a bad secret", { SOLVER_SECRET: "SNOTAKEY" }], ["a short token", { SOLVER_AUTH_TOKEN: "short" }], ["a bad contract", { SOLVER_SETTLE_CONTRACT: "nope" }],
    ["a bad url", { SOLVER_RPC_URL: "ftp://x" }], ["a bad port", { SOLVER_PORT: "99999" }], ["bps out of range", { SOLVER_MIN_PROFIT_BPS: "20000" }], ["a bad fee rate", { SOLVER_FEE_OUT_PER_XLM: "lots" }],
  ])("rejects %s without echoing any secret", (_n, patch) => {
    const r = loadSolverServiceConfig({ ...env, ...patch });
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    expect(text).not.toContain(kp.secret());
    expect(text).not.toContain("t".repeat(40));
  });
  it("will not run without durable state unless that is asked for explicitly", () => {
    const { SLUICE_STATE_DIR: _d, ...noDir } = env;
    const r = loadSolverServiceConfig(noDir);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/forget open positions/);
    expect(loadSolverServiceConfig({ ...noDir, SOLVER_ALLOW_MEMORY_STATE: "1" })).toMatchObject({ ok: true });
  });
});

describe("loadKnobs and storeFromEnv", () => {
  it("uses the prefix it is given and defaults the rest", () => {
    const r = loadKnobs({ ORDERS_MIN_PROFIT_BPS: "40", SOLVER_MIN_PROFIT_BPS: "99" }, "ORDERS_");
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r.policy).toMatchObject({ minProfitBps: 40, hedgeSlippageBps: 50, improvementShareBps: 5000, minDeadlineBufferSec: 60, feeOutPerXlm: "0.1" });
    expect(r.retry).toMatchObject({ tickMs: 15_000, maxCycles: 12 });
    expect(loadKnobs({ SOLVER_RETRY_MAX_CYCLES: "-1" }, "SOLVER_")).toMatch(/SOLVER_RETRY_MAX_CYCLES/);
  });
  it("a state directory means a file store, none means memory", () => {
    expect(storeFromEnv({ SLUICE_STATE_DIR: "/x" })).toMatchObject({ memory: false });
    expect(storeFromEnv({ SLUICE_STATE_DIR: "/x" }).store).toBeInstanceOf(FileStore);
    expect(storeFromEnv({})).toMatchObject({ memory: true });
    expect(storeFromEnv({ SLUICE_STATE_DIR: "  " }).store).toBeInstanceOf(MemoryStore);
  });
});
