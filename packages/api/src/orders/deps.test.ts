import { describe, expect, it } from "vitest";
import { Account, Address, Keypair, Networks, nativeToScVal, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { decodeOrder } from "@sluice/solver";
import { contractErrorOf, defaultOrdersDeps } from "./deps.js";
import { FillSimulationError } from "./service.js";
import { config, recordedEntry, settle, solverKp, user, wallet } from "./fixtures.js";

const order = { user: user.publicKey(), tokenIn: StrKey.encodeContract(randomBytes(32)), amountIn: 100n, tokenOut: StrKey.encodeContract(randomBytes(32)), minOut: 90n, deadline: 2_000_000_000, createTrustline: true };

/** An RPC client that records what it is asked and answers like the network would. */
function fakeServer(over: { simError?: string } = {}) {
  const sims: xdr.SorobanAuthorizationEntry[][] = [];
  const sent: string[] = [];
  let seq = 41n;
  const rec = recordedEntry(order);
  const server = {
    getAccount: async () => new Account(solverKp.publicKey(), seq.toString()),
    getNetwork: async () => ({ passphrase: Networks.TESTNET }),
    getLatestLedger: async () => ({ sequence: 500 }),
    simulateTransaction: async (tx: any) => {
      sims.push(tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().auth());
      if (over.simError) return { error: over.simError, id: "1", latestLedger: 1, events: [], _parsed: true };
      return { id: "1", latestLedger: 1, events: [], _parsed: true, result: { auth: sims.at(-1)!.length === 0 ? [rec] : sims.at(-1), retval: nativeToScVal(1n) }, minResourceFee: "12345", transactionData: new (await import("@stellar/stellar-sdk")).SorobanDataBuilder() };
    },
    sendTransaction: async (tx: any) => {
      sent.push(tx.toXDR());
      seq = BigInt(tx.sequence);
      return { status: "PENDING", hash: "ab".repeat(32), latestLedger: 1, latestLedgerCloseTime: 1 };
    },
  };
  return { server: server as unknown as rpc.Server, sims, sent, rec, setSeq: (n: bigint) => (seq = n) };
}

describe("default orders deps", () => {
  it("records the user's entry by simulating fill(order, solver, amount_out) with the solver as source", async () => {
    const f = fakeServer();
    const deps = defaultOrdersDeps(config, { server: f.server });
    const sim = await deps.simulateFill(order, 95n);
    expect(sim.userEntry).toBe(f.rec);
    expect(sim.minResourceFee).toBe(12345n);
    await expect(sim.send()).rejects.toThrow(/recording/);
  });
  it("throws FillSimulationError with the raw RPC error when the simulation fails", async () => {
    const deps = defaultOrdersDeps(config, { server: fakeServer({ simError: "HostError: Error(Contract, #5)\nmore" }).server });
    await expect(deps.simulateFill(order, 95n)).rejects.toBeInstanceOf(FillSimulationError);
    await expect(deps.simulateFill(order, 95n)).rejects.toThrow(/Error\(Contract, #5\)\nmore/);
  });
  it("enforces with the user's signed entry in place of the recorded one, signs as the solver and sends the next sequence", async () => {
    const f = fakeServer();
    const deps = defaultOrdersDeps(config, { server: f.server });
    const recorded = (await deps.simulateFill(order, 95n)).userEntry;
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(await wallet({ authEntry: { xdr: recorded.toXDR("base64"), validUntilLedger: 600 } }), "base64");
    const sim = await deps.simulateFill(order, 95n, signed);
    expect(f.sims.at(-1)![0]!.toXDR("base64")).toBe(signed.toXDR("base64"));
    const r = await sim.send();
    expect(r).toMatchObject({ status: "PENDING", hash: "ab".repeat(32) });
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const tx = TransactionBuilder.fromXDR(f.sent[0]!, Networks.TESTNET) as any;
    expect(tx.source).toBe(solverKp.publicKey());
    expect(tx.sequence).toBe("42");
    expect(tx.signatures).toHaveLength(1);
    expect(Keypair.fromPublicKey(solverKp.publicKey()).verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    const op = tx.operations[0];
    expect(op.func.invokeContract().functionName().toString()).toBe("fill");
    expect(Address.fromScAddress(op.func.invokeContract().contractAddress()).toString()).toBe(settle);
    const args = op.func.invokeContract().args();
    expect(decodeOrder(args[0]!)).toEqual(order);
    expect(Address.fromScVal(args[1]!).toString()).toBe(solverKp.publicKey());
    expect(args[2]!.i128().lo().toString()).toBe("95");
  });
  it("hands out consecutive sequence numbers while the node still reports the old one", async () => {
    const f = fakeServer();
    const deps = defaultOrdersDeps(config, { server: f.server });
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(await wallet({ authEntry: { xdr: f.rec.toXDR("base64"), validUntilLedger: 600 } }), "base64");
    const one = await deps.simulateFill(order, 95n, signed);
    const two = await deps.simulateFill(order, 96n, signed);
    f.setSeq(41n); // the node has not counted either transaction yet
    await one.send();
    f.setSeq(41n);
    await two.send();
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    expect(f.sent.map((x) => (TransactionBuilder.fromXDR(x, Networks.TESTNET) as any).sequence)).toEqual(["42", "43"]);
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
