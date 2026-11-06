import { randomBytes } from "node:crypto";
import { Address, Asset, authorizeEntry, Keypair, Networks, StrKey, xdr } from "@stellar/stellar-sdk";
import { Router } from "@sluice/core";
import type { QuotedHedge } from "@sluice/solver";
import { createApp } from "../app.js";
import { expectedTrees } from "./auth.js";
import type { OrdersConfig } from "./config.js";
import { createOrdersService, FillSimulationError, type FillSimulation, type OrdersDeps, type OrdersHooks, type OrderTx } from "./service.js";

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
  solverSecret: solverKp.secret(),
  macSecret: "test-mac-secret-0123456789abcdef",
  feeOutPerXlm: "0.1",
  policy: { maxOrderIn: 1000n * S, hedgeSlippageBps: 50, minProfitBps: 20, improvementShareBps: 5000, minDeadlineBufferSec: 60 },
};

export const NOW = 1_800_000_000_000;

export interface Fake {
  deps: OrdersDeps;
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
    tx: OrderTx;
    hedgeError?: string;
    /** Invocation the fake network records for the user: defaults to the right one. */
    wrongTree?: boolean;
    sims: { amountOut: bigint; signed: boolean }[];
    sent: number;
    hedged: number;
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
    sims: [],
    sent: 0,
    hedged: 0,
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
      return {
        userEntry: signedUser ?? recordedEntry(order, state.wrongTree),
        minResourceFee: 100_000n,
        send: async () => {
          state.sent++;
          return state.sendResult;
        },
      };
    },
    getTx: async () => state.tx,
    hedge: async () => {
      state.hedged++;
      if (state.hedgeError) throw new Error(state.hedgeError);
      return { hash: "cd".repeat(32), received: 104n * S };
    },
  };
  return { deps, state };
}

export function build(over: Partial<Fake["state"]> = {}, hooks?: OrdersHooks) {
  const f = fake(over);
  const service = createOrdersService(config, f.deps, { hooks, pollMs: 1, fillWaitMs: 200 });
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

export { Asset };
