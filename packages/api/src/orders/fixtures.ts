import { randomBytes } from "node:crypto";
import { Account, Address, Asset, authorizeEntry, Keypair, nativeToScVal, Networks, Operation, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { Router } from "@sluice/core";
import {
  encodeOrder, expectedSolverTree, FillSimulationError, SolverUnavailable, type FillOutcome, type FillRequest, type HedgeView, type Order, type PrepareTxOutcome,
  type PrepareTxRequest, type QuotedHedge, type SolverPort, type UnavailableReason,
} from "@sluice/solver";
import { createApp } from "../app.js";
import { expectedTrees } from "./auth.js";
import type { OrdersConfig } from "./config.js";
import { createOrdersService, type FillSimulation, type OrdersDeps, type OrderTx } from "./service.js";

export const PASS = Networks.TESTNET;
export const S = 10_000_000n;
export const user = Keypair.random();
export const stranger = Keypair.random();
export const solverKp = Keypair.random();
export const issuer = Keypair.random();
export const settle = StrKey.encodeContract(randomBytes(32));
export const A = `SLFA:${issuer.publicKey()}`;
export const C = `SLFC:${issuer.publicKey()}`;
export const HASH = "ab".repeat(32);

export const config: OrdersConfig = {
  settleContract: settle,
  rpcUrl: "http://rpc.test",
  horizonUrl: "http://horizon.test",
  networkPassphrase: PASS,
  solver: { mode: "local", secret: solverKp.secret() },
  solverAddress: solverKp.publicKey(),
  macSecret: "test-mac-secret-0123456789abcdef",
  feeOutPerXlm: "0.1",
  policy: { maxOrderIn: 1000n * S, hedgeSlippageBps: 50, minProfitBps: 20, improvementShareBps: 5000, minDeadlineBufferSec: 60 },
  recovery: {},
  retry: {},
};

export const NOW = 1_800_000_000_000;

export interface Fake {
  deps: OrdersDeps;
  solver: SolverPort;
  state: {
    nowMs: number;
    ledger: number;
    rpcPassphrase: string;
    trust: Set<string> | Error;
    solverC: bigint;
    /** What the Classic book pays for 1 unit of the order's amountIn, in stroops of out per whole input unit. */
    hedgeRate: bigint | null;
    simError?: string;
    sendResult: { hash: string; status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR"; codes?: string[] };
    /** When set, the solver answers every fill / submit-tx with exactly this. */
    outcome?: FillOutcome;
    tx: OrderTx;
    /** Invocation the fake network records for the user: defaults to the right one. */
    wrongTree?: boolean;
    /** The circuit breaker: a reason means it is open. */
    breaker?: string;
    /** Every call to the solver throws SolverUnavailable with this reason. */
    solverDown?: UnavailableReason;
    /** What the solver reports for each fill hash. */
    hedges: Map<string, HedgeView>;
    /** The user's account sequence on the fake network (tier 2). */
    userSeq: string;
    sims: { amountOut: bigint; signed: boolean }[];
    txSims: number;
    fills: FillRequest[];
    prepares: PrepareTxRequest[];
    submittedTxs: string[];
    sent: number;
    /** Transactions the fake solver prepared, by hash. */
    reserved: Map<string, { order: Order; amountOut: bigint }>;
  };
}

/** A recorded entry, as the network's recording simulation would return it: address credentials, no signature. */
export function recordedEntry(order: Parameters<typeof expectedTrees>[0], wrong = false): xdr.SorobanAuthorizationEntry {
  const trees = expectedTrees(wrong ? { ...order, amountIn: order.amountIn + 1n } : order, settle);
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(order.user).toScAddress(),
        nonce: new xdr.Int64(BigInt(`0x${randomBytes(6).toString("hex")}`)),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: trees[0]!,
  });
}

/** Tier 2: the transaction the solver prepares for the user to sign, built with real XDR and a real solver signature. */
export async function userTx(
  order: Order,
  amountOut: bigint,
  o: { sequence?: string; validUntilLedger?: number; nowSec?: number; timeoutSec?: number; source?: string; solverKey?: Keypair; args?: xdr.ScVal[]; extraAuth?: xdr.SorobanAuthorizationEntry[]; noTimeout?: boolean; fee?: string } = {},
): Promise<{ tx: Transaction; xdr: string; hash: string; nonce: string; validUntilLedger: number }> {
  const op = Operation.invokeContractFunction({
    contract: settle,
    function: "fill",
    args: o.args ?? [encodeOrder(order), new Address(solverKp.publicKey()).toScVal(), nativeToScVal(amountOut, { type: "i128" })],
  });
  const validUntilLedger = o.validUntilLedger ?? 1000 + 130;
  const nonce = new xdr.Int64(BigInt(`0x${randomBytes(6).toString("hex")}`));
  const solverEntry = await authorizeEntry(
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: new Address(solverKp.publicKey()).toScAddress(), nonce, signatureExpirationLedger: 0, signature: xdr.ScVal.scvVec([]) }),
      ),
      rootInvocation: expectedSolverTree(order, solverKp.publicKey(), amountOut, settle),
    }),
    o.solverKey ?? solverKp,
    validUntilLedger,
    PASS,
  );
  const userEntry = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: expectedTrees(order, settle)[0]! });
  const b = new TransactionBuilder(new Account(o.source ?? order.user, o.sequence ?? "100"), { fee: o.fee ?? "140000", networkPassphrase: PASS, ...(o.noTimeout ? { timebounds: { minTime: 0, maxTime: 0 } } : {}) }).addOperation(op);
  if (!o.noTimeout) b.setTimeout(o.timeoutSec ?? 600);
  const built = b.build();
  const env = built.toEnvelope();
  // The test clock is fixed (NOW), far from the wall clock `setTimeout` used: pin the time bounds to it.
  if (!o.noTimeout) {
    const nowSec = o.nowSec ?? Math.floor(NOW / 1000);
    env.v1().tx().cond(xdr.Preconditions.precondTime(new xdr.TimeBounds({ minTime: xdr.Uint64.fromString("0"), maxTime: xdr.Uint64.fromString(String(nowSec + (o.timeoutSec ?? 600))) })));
  }
  env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth([userEntry, solverEntry, ...(o.extraAuth ?? [])]);
  const tx = new Transaction(env, PASS);
  return { tx, xdr: tx.toXDR(), hash: tx.hash().toString("hex"), nonce: nonce.toString(), validUntilLedger };
}

/** The wallet's `signTransaction`: sign the envelope with `key`, return the signed XDR. */
export function signTx(txXdr: string, key: Keypair = user): string {
  const tx = TransactionBuilder.fromXDR(txXdr, PASS) as Transaction;
  tx.sign(key);
  return tx.toXDR();
}

export function fake(over: Partial<Fake["state"]> = {}): Fake {
  const state: Fake["state"] = {
    nowMs: NOW,
    ledger: 1000,
    rpcPassphrase: PASS,
    trust: new Set(["native", A]),
    solverC: 1000n * S,
    hedgeRate: 105n * S / 100n, // 1.05 C per A
    sendResult: { hash: HASH, status: "PENDING" },
    tx: { hash: HASH, status: "NOT_FOUND" },
    hedges: new Map(),
    userSeq: "99",
    sims: [],
    txSims: 0,
    fills: [],
    prepares: [],
    submittedTxs: [],
    sent: 0,
    reserved: new Map(),
    ...over,
  };
  const deps: OrdersDeps = {
    now: () => state.nowMs,
    networkPassphrase: async () => state.rpcPassphrase,
    latestLedger: async () => state.ledger,
    trustlines: async () => {
      if (state.trust instanceof Error) throw state.trust;
      return state.trust;
    },
    solverBalance: async () => state.solverC,
    hedgeQuote: async (order): Promise<QuotedHedge | null> =>
      state.hedgeRate === null ? null : { quote: { amountIn: order.amountIn, amountOut: (order.amountIn * state.hedgeRate) / S, quotedAtMs: state.nowMs }, leg: {} as never },
    simulateFill: async (order, amountOut, signedUser): Promise<FillSimulation> => {
      state.sims.push({ amountOut, signed: !!signedUser });
      if (state.simError) throw new FillSimulationError(state.simError);
      return { userEntry: signedUser ?? recordedEntry(order, state.wrongTree), minResourceFee: 100_000n };
    },
    simulateTx: async () => {
      state.txSims++;
      if (state.simError) throw new FillSimulationError(state.simError);
      return { minResourceFee: 100_000n };
    },
    accountSequence: async () => state.userSeq,
    getTx: async () => state.tx,
  };
  const down = () => {
    if (state.solverDown) throw new SolverUnavailable("fake solver is down", "test", state.solverDown);
  };
  const outcomeOfSend = (): FillOutcome => {
    if (state.outcome) return state.outcome;
    const r = state.sendResult;
    if (r.status === "PENDING" || r.status === "DUPLICATE") return { kind: "sent", hash: r.hash, status: r.status };
    if (r.status === "TRY_AGAIN_LATER") return { kind: "busy", message: "busy", hash: r.hash };
    return { kind: "rejected", codes: r.codes ?? [], hash: r.hash };
  };
  const solver: SolverPort = {
    address: solverKp.publicKey(),
    async health() {
      down();
      return { ok: true, address: solverKp.publicKey(), networkPassphrase: PASS, settleContract: settle, accepting: !state.breaker, openExposures: state.breaker ? 1 : 0, recoveryLoop: true, store: "fake" };
    },
    async canFill() {
      down();
      return state.breaker ? { ok: false, reason: state.breaker } : { ok: true };
    },
    async fill(req) {
      down();
      state.fills.push(req);
      state.sent++;
      return outcomeOfSend();
    },
    async prepareTx(req): Promise<PrepareTxOutcome> {
      down();
      state.prepares.push(req);
      if (state.outcome && state.outcome.kind !== "sent") return state.outcome as PrepareTxOutcome;
      const t = await userTx(req.order, req.amountOut, { validUntilLedger: state.ledger + Math.ceil(req.validForSec / 5) + 2, timeoutSec: req.validForSec, sequence: state.userSeq });
      state.reserved.set(t.hash, { order: req.order, amountOut: req.amountOut });
      return {
        kind: "prepared",
        tx: { xdr: t.xdr, hash: t.hash, source: req.order.user, sequence: String(BigInt(state.userSeq) + 1n), minResourceFee: 100_000n, maxTimeSec: Math.floor(NOW / 1000) + req.validForSec, solverNonce: t.nonce, solverValidUntilLedger: t.validUntilLedger },
      };
    },
    async submitTx(req) {
      down();
      state.submittedTxs.push(req.signedTx);
      const tx = TransactionBuilder.fromXDR(req.signedTx, PASS) as Transaction;
      if (state.outcome) return state.outcome;
      if (!state.reserved.has(tx.hash().toString("hex"))) return { kind: "invalid", code: "UNKNOWN_RESERVATION", message: "The solver did not prepare this transaction." };
      state.sent++;
      return { kind: "sent", hash: tx.hash().toString("hex"), status: "PENDING" };
    },
    async orderStatus(hash) {
      down();
      return state.hedges.get(hash);
    },
  };
  return { deps, solver, state };
}

export function build(over: Partial<Fake["state"]> = {}) {
  const f = fake(over);
  const service = createOrdersService(config, f.deps, f.solver);
  const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: { enabled: true, service } });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...f, service, app, post };
}

export const prepareBody = { account: user.publicKey(), assetIn: A, assetOut: C, amount: "100" };

/** The user's wallet: signs the preimage the server sent, with `key`, and returns the signed entry as base64. */
export async function wallet(prepared: { authEntry: { xdr: string; validUntilLedger: number } }, key: Keypair = user): Promise<string> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(prepared.authEntry.xdr, "base64");
  return (await authorizeEntry(entry, key, prepared.authEntry.validUntilLedger, PASS)).toXDR("base64");
}

export { Asset, StrKey, Networks };
