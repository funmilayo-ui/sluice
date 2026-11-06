/**
 * TESTNET ONLY. TEST HARNESS, NOT PART OF THE APP. Never run against mainnet.
 *
 * Serves a TEST BUILD of the web app (made with SLUICE_TEST_WALLET=1, see docs/WALLET_TEST_PASS.md) next to an API
 * that has settlement orders switched on against the Stellar testnet, so the Settle flow can be driven in a browser
 * that has no wallet extension.
 *
 * What it sets up, as scripts/w4-orders-api-testnet.ts does: an issuer with assets SLFA and SLFC, a market maker
 * with resting offers that sell SLFC for SLFA (the Classic liquidity the solver hedges into), a user who holds SLFA
 * and has NO SLFC trustline, a solver, and a freshly deployed settle contract.
 *
 * The "wallet": the user's throwaway key lives only in this process's memory. The test build's shim
 * (apps/web/src/lib/testWallet.ts) asks this server for the user's address and for a signature over a preimage
 * (`/__test/wallet/*`, which exist only here, never in the Sluice API). It signs sha256(preimage) with that key,
 * which is all a real wallet's signAuthEntry does. No key is written to disk or printed.
 *
 * Build the contract first:  cd contracts && stellar contract build --manifest-path settle/Cargo.toml
 * Build the test web app:    cd apps/web && SLUICE_TEST_WALLET=1 pnpm exec vite build --outDir dist-testwallet
 * Run:                       SLUICE_IPV4_FIRST=1 HARNESS_PORT=8788 pnpm exec tsx apps/web/e2e/settle-testnet-harness.ts
 *   HARNESS_WEB_DIR   directory of the web build to serve (default apps/web/dist-testwallet)
 *   HARNESS_FIXTURE   if set, a path to write the PUBLIC fixture details to (addresses and asset ids only)
 *   HARNESS_USER_ADDRESS
 *       REAL-WALLET MODE (docs/WALLET_TEST_PASS.md). A public G... address of a TESTNET account you control in a
 *       real wallet. No throwaway user key is made and the /__test/wallet endpoints answer 404. The harness funds
 *       that address from friendbot, waits until you have added a trustline for SLFA in your wallet, then pays
 *       it 1000 SLFA. Serve a normal build (HARNESS_WEB_DIR=apps/web/dist): there is no shim in it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preferIpv4, Router } from "../../../packages/core/src/index.js";
import { createApp } from "../../../packages/api/src/app.js";
import { loadOrdersConfig } from "../../../packages/api/src/orders/config.js";
import { createOrdersService } from "../../../packages/api/src/orders/service.js";
import { defaultOrdersDeps } from "../../../packages/api/src/orders/deps.js";
import { serve } from "../../../packages/api/node_modules/@hono/node-server/dist/index.js";
import {
  Address, Asset, BASE_FEE, Keypair, Networks, Operation, rpc, Transaction, TransactionBuilder, xdr,
} from "../../../packages/api/node_modules/@stellar/stellar-sdk/lib/index.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const PASS = Networks.TESTNET;
if (PASS !== "Test SDF Network ; September 2015") throw new Error("testnet only");
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WASM = path.join(ROOT, "contracts/target/wasm32v1-none/release/sluice_settle.wasm");
const WEB_DIR = path.resolve(process.env.HARNESS_WEB_DIR ?? path.join(ROOT, "apps/web/dist-testwallet"));
const PORT = Number(process.env.HARNESS_PORT ?? 8788);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${label}: ${(last as Error)?.message ?? last}`);
}
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
const retryingFetch: typeof fetch = (input, init) => retry("horizon", async () => {
  const r = await timedFetch(input, init);
  if (r.status >= 500) throw new Error(`horizon ${r.status}`);
  return r;
});

const server = new rpc.Server(RPC);
const apiServer = new Proxy(server, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver);
    if (typeof v !== "function") return v;
    const readOnly = ["getLatestLedger", "getAccount", "simulateTransaction", "getTransaction", "getNetwork"].includes(String(prop));
    return readOnly ? (...a: unknown[]) => retry(String(prop), () => (v as (...x: unknown[]) => Promise<unknown>).apply(target, a)) : v.bind(target);
  },
});
async function waitFor(hash: string) {
  for (let i = 0; i < 80; i++) {
    const r = await retry("getTransaction", () => server.getTransaction(hash));
    if (r.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return r;
    await sleep(1500);
  }
  throw new Error(`transaction ${hash} did not appear in a ledger`);
}
async function send(tx: Transaction) {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${sent.errorResult?.toXDR("base64")}`);
  const done = await waitFor(sent.hash);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ${done.status}`);
  return { hash: sent.hash, done };
}
async function run(source: Keypair, ops: xdr.Operation[], soroban: boolean) {
  const account = await retry("getAccount", () => server.getAccount(source.publicKey()));
  let b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS });
  for (const op of ops) b = b.addOperation(op);
  let tx = b.setTimeout(180).build();
  if (soroban) tx = await retry("prepareTransaction", () => server.prepareTransaction(tx));
  tx.sign(source);
  return send(tx);
}

// --- Parties (throwaway, in memory only).
const external = process.env.HARNESS_USER_ADDRESS?.trim() || undefined;
if (external && !/^G[A-Z2-7]{55}$/.test(external)) throw new Error("HARNESS_USER_ADDRESS must be a public G... address");
const issuer = Keypair.random();
const user = external ? undefined : Keypair.random();
const userAddress = external ?? user!.publicKey();
const solver = Keypair.random();
const maker = Keypair.random();
const friendbot = (addr: string) => retry("friendbot", async () => {
  const r = await timedFetch(`https://friendbot.stellar.org?addr=${addr}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
});
for (const kp of [issuer, solver, maker]) await friendbot(kp.publicKey());
if (user) await friendbot(user.publicKey());
else await friendbot(userAddress).catch(() => console.log("friendbot did not fund your address (it may already be funded); continuing"));
const A = new Asset("SLFA", issuer.publicKey());
const C = new Asset("SLFC", issuer.publicKey());
if (user) await run(user, [Operation.changeTrust({ asset: A })], false); // the user trusts SLFA only: no SLFC trustline
await run(solver, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(maker, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(issuer, [
  ...(user ? [Operation.payment({ destination: user.publicKey(), asset: A, amount: "1000" })] : []),
  Operation.payment({ destination: solver.publicKey(), asset: C, amount: "1000" }),
  Operation.payment({ destination: maker.publicKey(), asset: C, amount: "1000" }),
], false);
await run(maker, [
  Operation.manageSellOffer({ selling: C, buying: A, amount: "60", price: "1.03" }),
  Operation.manageSellOffer({ selling: C, buying: A, amount: "200", price: "1.05" }),
], false);
for (const asset of [A, C]) await run(solver, [Operation.createStellarAssetContract({ asset })], true);
const wasm = readFileSync(WASM);
const wasmHash = createHash("sha256").update(wasm).digest();
await run(solver, [Operation.uploadContractWasm({ wasm })], true);
const deployed = await run(solver, [Operation.createCustomContract({ address: new Address(solver.publicKey()), wasmHash, salt: Keypair.random().rawPublicKey() })], true);
const settleId = Address.fromScVal(deployed.done.returnValue!).toString();

// --- The API, configured as a deployment would be (from an object, never from process.env or disk).
const setup = loadOrdersConfig({
  ORDERS_SETTLE_CONTRACT: settleId,
  ORDERS_RPC_URL: RPC,
  ORDERS_HORIZON_URL: HORIZON,
  ORDERS_NETWORK_PASSPHRASE: PASS,
  ORDERS_SOLVER_SECRET: solver.secret(),
  ORDERS_MAC_SECRET: createHash("sha256").update(Keypair.random().secret()).digest("hex"),
});
if (!setup.enabled) throw new Error(`orders config rejected: ${setup.reason}`);
const service = createOrdersService(setup.config, defaultOrdersDeps(setup.config, { server: apiServer, fetchImpl: retryingFetch }), { pollMs: 1500 });
const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: { enabled: true, service }, webDir: WEB_DIR });

// Real-wallet mode: the tester adds the SLFA trustline in their own wallet; then they are paid.
if (external) {
  console.log(`\nWAITING: in your wallet (on TESTNET) add the asset  SLFA  with issuer  ${issuer.publicKey()}\nThen this will pay you 1000 SLFA. (Freighter: Manage assets > Add an asset manually.)`);
  const holds = async () => {
    const r = await timedFetch(`${HORIZON}/accounts/${external}`);
    if (!r.ok) return false;
    const acc = (await r.json()) as { balances: { asset_code?: string; asset_issuer?: string }[] };
    return acc.balances.some((b) => b.asset_code === "SLFA" && b.asset_issuer === issuer.publicKey());
  };
  for (let i = 0; ; i++) {
    if (await holds().catch(() => false)) break;
    if (i > 180) throw new Error("gave up waiting for the SLFA trustline (15 minutes)");
    await sleep(5000);
  }
  await run(issuer, [Operation.payment({ destination: external, asset: A, amount: "1000" })], false);
  console.log("paid 1000 SLFA");
}

// --- The test wallet's two endpoints. They exist only in this harness.
let signatures = 0;
const handle = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/__test/wallet/") && !user) return new Response("no test wallet in real-wallet mode", { status: 404 });
  if (url.pathname === "/__test/wallet/address" && user) return Response.json({ address: user.publicKey() });
  if (url.pathname === "/__test/wallet/sign" && req.method === "POST" && user) {
    const { preimage } = (await req.json()) as { preimage?: string };
    if (typeof preimage !== "string") return new Response("bad request", { status: 400 });
    signatures++;
    const signature = user.sign(createHash("sha256").update(Buffer.from(preimage, "base64")).digest());
    console.log(`wallet signature #${signatures}`);
    return Response.json({ signedAuthEntry: signature.toString("base64"), signerAddress: user.publicKey() });
  }
  return app.fetch(req);
};
serve({ fetch: handle, port: PORT });

const fixture = {
  url: `http://localhost:${PORT}`,
  user: userAddress,
  mode: external ? "real wallet" : "test wallet shim",
  solver: solver.publicKey(),
  settle: settleId,
  assetIn: `SLFA:${issuer.publicKey()}`,
  assetOut: `SLFC:${issuer.publicKey()}`,
  book: "sells 60 SLFC at 1.03 SLFA and 200 SLFC at 1.05 SLFA (about 271.8 SLFA deep)",
};
if (process.env.HARNESS_FIXTURE) writeFileSync(process.env.HARNESS_FIXTURE, JSON.stringify(fixture, null, 2));
console.log(`READY ${JSON.stringify(fixture)}`);
