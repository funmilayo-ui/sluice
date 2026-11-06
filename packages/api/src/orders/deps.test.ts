import { describe, expect, it } from "vitest";
import { Account, Networks, nativeToScVal, rpc, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { FillSimulationError } from "@sluice/solver";
import { contractErrorOf, defaultOrdersDeps } from "./deps.js";
import { config, recordedEntry, settle, solverKp, user, wallet } from "./fixtures.js";

const order = { user: user.publicKey(), tokenIn: StrKey.encodeContract(randomBytes(32)), amountIn: 100n, tokenOut: StrKey.encodeContract(randomBytes(32)), minOut: 90n, deadline: 2_000_000_000, createTrustline: true };

/** An RPC client that records what it is asked and answers like the network would. It has no way to send: the API never sends fills. */
function fakeServer(over: { simError?: string } = {}) {
  const sims: xdr.SorobanAuthorizationEntry[][] = [];
  const sources: string[] = [];
  const rec = recordedEntry(order);
  const server = {
    getAccount: async (id: string) => new Account(id, "41"),
    getNetwork: async () => ({ passphrase: Networks.TESTNET }),
    getLatestLedger: async () => ({ sequence: 500 }),
    simulateTransaction: async (tx: any) => {
      sims.push(tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().auth());
      sources.push(tx.source);
      if (over.simError) return { error: over.simError, id: "1", latestLedger: 1, events: [], _parsed: true };
      return { id: "1", latestLedger: 1, events: [], _parsed: true, result: { auth: sims.at(-1)!.length === 0 ? [rec] : sims.at(-1), retval: nativeToScVal(1n) }, minResourceFee: "12345", transactionData: new SorobanDataBuilder() };
    },
  };
  return { server: server as unknown as rpc.Server, sims, sources, rec };
}

describe("default orders deps", () => {
  it("is built from the solver's PUBLIC address: the config carries no secret in remote mode and the deps still work", async () => {
    const f = fakeServer();
    const remote = { ...config, solver: { mode: "remote" as const, url: "http://solver.test", token: "t".repeat(32) } };
    const deps = defaultOrdersDeps(remote, { server: f.server });
    const sim = await deps.simulateFill(order, 95n);
    expect(sim.minResourceFee).toBe(12345n);
    expect(f.sources[0]).toBe(solverKp.publicKey());
    expect(JSON.stringify(remote, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(solverKp.secret());
  });
  it("records the user's entry by simulating fill(order, solver, amount_out) with the solver as source", async () => {
    const f = fakeServer();
    const deps = defaultOrdersDeps(config, { server: f.server });
    const sim = await deps.simulateFill(order, 95n);
    expect(sim.userEntry).toBe(f.rec);
    expect(sim.minResourceFee).toBe(12345n);
    expect("send" in sim).toBe(false);
  });
  it("throws FillSimulationError with the raw RPC error when the simulation fails", async () => {
    const deps = defaultOrdersDeps(config, { server: fakeServer({ simError: "HostError: Error(Contract, #5)\nmore" }).server });
    await expect(deps.simulateFill(order, 95n)).rejects.toBeInstanceOf(FillSimulationError);
    await expect(deps.simulateFill(order, 95n)).rejects.toThrow(/Error\(Contract, #5\)\nmore/);
  });
  it("enforces with the user's signed entry in place of the recorded one", async () => {
    const f = fakeServer();
    const deps = defaultOrdersDeps(config, { server: f.server });
    const recorded = (await deps.simulateFill(order, 95n)).userEntry;
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(await wallet({ authEntry: { xdr: recorded.toXDR("base64"), validUntilLedger: 600 } }), "base64");
    await deps.simulateFill(order, 95n, signed);
    expect(f.sims.at(-1)![0]!.toXDR("base64")).toBe(signed.toXDR("base64"));
  });
  it("reads a user's sequence number and simulates a signed transaction as it is", async () => {
    const f = fakeServer();
    const deps = defaultOrdersDeps(config, { server: f.server });
    expect(await deps.accountSequence(user.publicKey())).toBe("41");
    const { userTx } = await import("./fixtures.js");
    const t = await userTx(order, 95n);
    expect((await deps.simulateTx(t.tx)).minResourceFee).toBe(12345n);
    expect(f.sources.at(-1)).toBe(user.publicKey());
  });
  it("reads the network the RPC serves and the latest ledger", async () => {
    const deps = defaultOrdersDeps(config, { server: fakeServer().server });
    expect(await deps.networkPassphrase()).toBe(Networks.TESTNET);
    expect(await deps.latestLedger()).toBe(500);
  });
  it("reads trustlines and the solver's balance from the orders Horizon, not the mainnet one", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: string) => {
      seen.push(String(u));
      if (String(u).endsWith("/accounts/GMISSING")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ sequence: "1", subentry_count: 1, balances: [{ asset_type: "native", balance: "100.0000000" }, { asset_type: "credit_alphanum4", asset_code: "SLFC", asset_issuer: user.publicKey(), balance: "12.5000000" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const deps = defaultOrdersDeps(config, { server: fakeServer().server, fetchImpl });
    expect(await deps.trustlines(user.publicKey())).toEqual(new Set(["native", `SLFC:${user.publicKey()}`]));
    expect(await deps.solverBalance(`SLFC:${user.publicKey()}`)).toBe(125_000_000n);
    expect(await deps.solverBalance(`NOPE:${user.publicKey()}`)).toBe(0n);
    await expect(deps.trustlines("GMISSING")).rejects.toThrow("account not found on this network");
    expect(seen.every((u) => u.startsWith("http://horizon.test/accounts/"))).toBe(true);
  });
});

describe("contractErrorOf", () => {
  const event = (contract: string, code: number | null) =>
    new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: StrKey.decodeContract(contract) as never,
        type: xdr.ContractEventType.diagnostic(),
        body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), code === null ? xdr.ScVal.scvSymbol("x") : xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
          data: xdr.ScVal.scvVoid(),
        })),
      }),
    });
  it("finds the error number raised by the settle contract", () => {
    expect(contractErrorOf([event(settle, 5)], settle)).toBe(5);
  });
  it("ignores errors raised by other contracts, events without one, and absent events", () => {
    expect(contractErrorOf([event(StrKey.encodeContract(randomBytes(32)), 5)], settle)).toBeUndefined();
    expect(contractErrorOf([event(settle, null)], settle)).toBeUndefined();
    expect(contractErrorOf(undefined, settle)).toBeUndefined();
  });
});
