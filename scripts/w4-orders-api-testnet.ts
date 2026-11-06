/**
 * TESTNET ONLY. The settlement order flow end to end THROUGH THE API AND SDK, as the web app will drive it:
 *
 *   SDK.prepareOrder -> signOrder (a throwaway keypair acts as the wallet, via a callback shaped exactly like a
 *   wallet's signAuthEntry: it receives the base64 HashIdPreimage and returns a signature over sha256 of it)
 *   -> SDK.submitOrder -> SDK.waitForOrder -> balances.
 *
 * The API app runs in this process with the ORDERS_* configuration pointed at testnet; the SDK talks to it
 * through the app's own fetch handler (the same Hono routes a socket would reach, without the socket).
 * Setup matches scripts/w2-solver-testnet.ts: an issuer with assets A and C, a market maker with resting offers
 * that sell C for A (the Classic liquidity the solver hedges into), a user who holds A and has NO C trustline,
 * a solver, and a freshly deployed settle contract.
 *
 * Checks, in order: config; a prepared order the solver will fill; one it declines (too deep for the book);
 * tampered and wrongly-signed submissions refused by the server; the real fill (user sends no transaction);
 * the solver's hedge; a replay of the used signature refused; a second, smaller order that needs no trustline.
 *
 * Keys are generated in memory, funded by friendbot and never written anywhere. Never run this against mainnet.
 * Build the contract first:  cd contracts && stellar contract build --manifest-path settle/Cargo.toml
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w4:orders-api-testnet
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatAmount, parseAmount, preferIpv4, Router, simulateView } from "../packages/core/src/index.js";
import { createApp } from "../packages/api/src/app.js";
import { loadOrdersConfig } from "../packages/api/src/orders/config.js";
import { createOrdersService } from "../packages/api/src/orders/service.js";
import { defaultOrdersDeps } from "../packages/api/src/orders/deps.js";
import { Sluice, SluiceError, signOrder, type PreparedOrder, type SignAuthEntry } from "../packages/sdk/src/index.js";
import {
  Address, Asset, authorizeEntry, BASE_FEE, Keypair, Networks, Operation, rpc, Transaction, TransactionBuilder, xdr,
} from "../packages/api/node_modules/@stellar/stellar-sdk/lib/index.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const PASS = Networks.TESTNET;
if (PASS !== "Test SDF Network ; September 2015") throw new Error("testnet only");
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const WASM = fileURLToPath(new URL("../contracts/target/wasm32v1-none/release/sluice_settle.wasm", import.meta.url));
const S = 10_000_000n;

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (v: bigint) => formatAmount(v);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/** This machine's network is flaky: retry reads (never a transaction submit) with a pause. */
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
/** fetch for the API's own Horizon reads: retried, since a read is safe to repeat. */
const retryingFetch: typeof fetch = (input, init) => retry("horizon", async () => {
  const r = await timedFetch(input, init);
  if (r.status >= 500) throw new Error(`horizon ${r.status}`);
  return r;
});

const server = new rpc.Server(RPC);
/** The RPC client handed to the API: reads retried; sendTransaction passed straight through. */
const apiServer = new Proxy(server, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver);
    if (typeof v !== "function") return v;
    const readOnly = ["getLatestLedger", "getAccount", "simulateTransaction", "getTransaction", "getNetwork"].includes(String(prop));
    return readOnly ? (...a: unknown[]) => retry(String(prop), () => (v as (...x: unknown[]) => Promise<unknown>).apply(target, a)) : v.bind(target);
  },
});

async function waitFor(hash: string): Promise<rpc.Api.GetTransactionResponse> {
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

interface HorizonAccount { balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[] }
const bal = async (g: string, a: Asset | "native"): Promise<bigint | null> => {
  const acc = await retry("horizon account", async () => {
    const r = await timedFetch(`${HORIZON}/accounts/${g}`);
    if (!r.ok) throw new Error(`horizon ${r.status}`);
    return (await r.json()) as HorizonAccount;
  });
  const hit = acc.balances.find((x) => (a === "native" ? x.asset_type === "native" : x.asset_code === a.getCode() && x.asset_issuer === a.getIssuer()));
  return hit ? parseAmount(hit.balance) : null;
};

// --- Parties (throwaway, in memory).
const issuer = Keypair.random();
const user = Keypair.random();
const solver = Keypair.random();
const maker = Keypair.random();
for (const kp of [issuer, user, solver, maker]) {
  await retry("friendbot", async () => {
    const r = await timedFetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
    if (!r.ok) throw new Error(`friendbot ${r.status}`);
  });
}
console.log(`issuer ${issuer.publicKey()}\nuser   ${user.publicKey()}\nsolver ${solver.publicKey()}\nmaker  ${maker.publicKey()}`);

const A = new Asset("SLFA", issuer.publicKey());
const C = new Asset("SLFC", issuer.publicKey());
const idA = `SLFA:${issuer.publicKey()}`;
const idC = `SLFC:${issuer.publicKey()}`;

await run(user, [Operation.changeTrust({ asset: A })], false); // user trusts A only: NO trustline for C
await run(solver, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(maker, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(issuer, [
  Operation.payment({ destination: user.publicKey(), asset: A, amount: "1000" }),
  Operation.payment({ destination: solver.publicKey(), asset: C, amount: "1000" }),
  Operation.payment({ destination: maker.publicKey(), asset: C, amount: "1000" }),
], false);
await run(maker, [
  Operation.manageSellOffer({ selling: C, buying: A, amount: "60", price: "1.03" }),
  Operation.manageSellOffer({ selling: C, buying: A, amount: "200", price: "1.05" }),
], false);
console.log("maker offers: sell 60 C @ 1.03 A, sell 200 C @ 1.05 A  (depth 271.8 A)");
for (const asset of [A, C]) await run(solver, [Operation.createStellarAssetContract({ asset })], true);

const wasm = readFileSync(WASM);
const wasmHash = createHash("sha256").update(wasm).digest();
await run(solver, [Operation.uploadContractWasm({ wasm })], true);
const deployed = await run(solver, [Operation.createCustomContract({ address: new Address(solver.publicKey()), wasmHash, salt: Keypair.random().rawPublicKey() })], true);
const settleId = Address.fromScVal(deployed.done.returnValue!).toString();
console.log(`settle ${settleId}  (${wasm.length} bytes)`);

// --- The API, configured exactly as a deployment would be, from an environment object (never process.env, never on disk).
const env = {
  ORDERS_SETTLE_CONTRACT: settleId,
  ORDERS_RPC_URL: RPC,
  ORDERS_HORIZON_URL: HORIZON,
  ORDERS_NETWORK_PASSPHRASE: PASS,
  ORDERS_SOLVER_SECRET: solver.secret(),
  ORDERS_MAC_SECRET: createHash("sha256").update(Keypair.random().secret()).digest("hex"),
};
const setup = loadOrdersConfig(env);
if (!setup.enabled) throw new Error(`orders config rejected: ${setup.reason}`);
const service = createOrdersService(setup.config, defaultOrdersDeps(setup.config, { server: apiServer, fetchImpl: retryingFetch }), { pollMs: 1500 });
const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: { enabled: true, service } });
const sluice = new Sluice("http://sluice.test", (input, init) => app.fetch(new Request(input, init)));

// --- The wallet: a callback with the shape of signAuthEntry (SEP-43 / Stellar Wallets Kit). It sees only the base64
// preimage; it hashes it and signs. This is all a real wallet does, and it is the user's only action.
let walletCalls = 0;
const walletFor = (kp: Keypair): SignAuthEntry => async (preimageBase64) => {
  walletCalls++;
  const signature = kp.sign(sha256(Buffer.from(preimageBase64, "base64")));
  return { signedAuthEntry: signature.toString("base64"), signerAddress: kp.publicKey() };
};

const snapshot = async () => ({
  uA: (await bal(user.publicKey(), A)) ?? 0n,
  uC: await bal(user.publicKey(), C),
  sA: (await bal(solver.publicKey(), A)) ?? 0n,
  sC: (await bal(solver.publicKey(), C)) ?? 0n,
});
const before = await snapshot();
const userSeq0 = (await retry("getAccount", () => server.getAccount(user.publicKey()))).sequenceNumber();

// 1. Config.
const cfg = await sluice.ordersConfig();
check("config: enabled on testnet with this contract and solver", cfg.enabled === true && cfg.network === "testnet" && cfg.settleContract === settleId && cfg.solver === solver.publicKey() && cfg.signing.credentials === "address-legacy", JSON.stringify(cfg).slice(0, 200));
if (!cfg.enabled) process.exit(1);

// 2. A prepared order. Horizon ingests new offers a few ledgers late: keep asking until the book is visible.
let prepared: PreparedOrder | undefined;
for (let i = 0; i < 20 && !prepared; i++) {
  const r = await sluice.prepareOrder({ account: user.publicKey(), assetIn: idA, assetOut: idC, amount: "100" });
  if (r.solverWillFill) prepared = r;
  else {
    console.log(`  not visible yet (${r.skipReasons.join(", ")}); waiting`);
    await sleep(3000);
  }
}
if (!prepared) throw new Error("the solver never agreed to fill the order");
console.log(`prepared ${prepared.orderId.slice(0, 24)}…  pay ${prepared.summary.pay} A, receive at least ${prepared.summary.receiveAtLeast} C, expected ${prepared.summary.expected} C, valid until ledger ${prepared.authEntry.validUntilLedger}`);
check("prepare: order matches the request and asks to create the missing trustline", prepared.order.user === user.publicKey() && prepared.order.amountIn === "100.0000000" && prepared.order.createTrustline === true && prepared.order.assetOut === idC, JSON.stringify(prepared.order).slice(0, 160));
check("prepare: the user is promised at least the signed floor", parseAmount(prepared.summary.expected) >= parseAmount(prepared.summary.receiveAtLeast) && parseAmount(prepared.summary.receiveAtLeast) > 0n, `${prepared.summary.receiveAtLeast} <= ${prepared.summary.expected}`);

// 3. An order the solver declines: deeper than the whole book. The user is told why and nothing is prepared.
const deep = await sluice.prepareOrder({ account: user.publicKey(), assetIn: idA, assetOut: idC, amount: "500" });
check("prepare: an order deeper than the Classic book is declined with a reason", !deep.solverWillFill && deep.skipReasons.includes("no_hedge_quote") && !("orderId" in deep), deep.solverWillFill ? "WRONGLY ACCEPTED" : `${deep.skipReasons.join(", ")}: ${deep.explained.message}`);

// 4. Refusals by the server, on the real network.
const wallet = walletFor(user);
const signed = await signOrder(prepared, wallet, { settleContract: settleId });
const expectRefusal = async (name: string, body: Parameters<Sluice["submitOrder"]>[0], status: number, code: string) => {
  try {
    await sluice.submitOrder(body);
    check(name, false, "WRONGLY ACCEPTED");
  } catch (e) {
    const err = e as SluiceError;
    check(name, err instanceof SluiceError && err.status === status && err.explained?.code === code, `${err.status} ${err.explained?.code}: ${err.message}`);
  }
};
await expectRefusal("submit: a lowered min_out does not match the order id", { orderId: prepared.orderId, order: { ...prepared.order, minOut: "0.0000001" }, signedAuthEntry: signed }, 400, "BAD_ORDER_ID");
await expectRefusal("submit: a different order id is refused", { orderId: prepared.orderId.replace(/.$/, (c) => (c === "0" ? "1" : "0")), order: prepared.order, signedAuthEntry: signed }, 400, "BAD_ORDER_ID");
{
  // Signed by a key that is not the user's: build the entry by hand (signOrder would refuse to).
  const stranger = Keypair.random();
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(prepared.authEntry.xdr, "base64");
  const forged = await authorizeEntry(entry, stranger, prepared.authEntry.validUntilLedger, PASS);
  const forgedCreds = forged.credentials().address();
  check("setup of the wrong-signer case: entry still names the user", Address.fromScAddress(forgedCreds.address()).toString() === user.publicKey(), "ok");
  await expectRefusal("submit: an entry signed by another key is refused", { orderId: prepared.orderId, order: prepared.order, signedAuthEntry: forged.toXDR("base64") }, 400, "WRONG_SIGNER");
}
await expectRefusal("submit: an unsigned entry is refused", { orderId: prepared.orderId, order: prepared.order, signedAuthEntry: prepared.authEntry.xdr }, 400, "BAD_SIGNATURE");
check("none of the refusals reached the wallet or the chain", walletCalls === 1 && (await bal(user.publicKey(), A)) === before.uA, `wallet calls ${walletCalls}`);

// 5. The real fill.
const sent = await sluice.submitOrder({ orderId: prepared.orderId, order: prepared.order, signedAuthEntry: signed });
console.log(`\nsubmitted: ${sent.hash} (${sent.status})`);
const fillAt = Date.now();
const done = await sluice.waitForOrder(sent.hash, { timeoutMs: 120_000 });
check("fill settles", done.status === "SUCCESS", `${done.status} ledger ${done.ledger} ${sent.hash}`);
check("received equals the solver's agreed amount (read from the transaction)", done.received === prepared.summary.expected, `${done.received} vs ${prepared.summary.expected}`);
const expected = parseAmount(prepared.summary.expected);

// The hedge runs in the background after the fill lands. Poll the order until it reports.
let hedgeStatus = done.hedge;
for (let i = 0; i < 60 && hedgeStatus?.status !== "HEDGED" && hedgeStatus?.status !== "UNHEDGED"; i++) {
  await sleep(2000);
  hedgeStatus = (await sluice.order(sent.hash)).hedge;
}
console.log(`hedge: ${JSON.stringify(hedgeStatus)}  (${Math.round((Date.now() - fillAt) / 1000)}s after submit)`);
check("the solver hedged the position on the Classic DEX", hedgeStatus?.status === "HEDGED", JSON.stringify(hedgeStatus));

const after = await snapshot();
check("the user paid exactly amount_in of A", before.uA - after.uA === 100n * S, `user A ${fmt(after.uA)}`);
check("the user received the amount and the C trustline was created in the fill", after.uC === expected, `user C ${after.uC === null ? "none" : fmt(after.uC)}`);
check("the solver holds no extra A after the hedge", after.sA === before.sA, `solver A ${fmt(before.sA)} -> ${fmt(after.sA)}`);
const userSeq1 = (await retry("getAccount", () => server.getAccount(user.publicKey()))).sequenceNumber();
check("the user sent no transaction and paid no fee", userSeq0 === userSeq1, `sequence ${userSeq0} before and after`);
const [heldA, heldC] = await Promise.all([A, C].map(async (t) => (await retry("view", () => simulateView(RPC, t.contractId(PASS), "balance", [new Address(settleId).toScVal()], { passphrase: PASS }))) as bigint));
check("the settlement contract keeps nothing", heldA === 0n && heldC === 0n, `contract holds A ${heldA}, C ${heldC}`);

// 6. Replay: the same signed entry again must not move anything.
await (async () => {
  try {
    await sluice.submitOrder({ orderId: prepared!.orderId, order: prepared!.order, signedAuthEntry: signed });
    check("replay: the used signature is refused", false, "WRONGLY ACCEPTED");
  } catch (e) {
    const err = e as SluiceError;
    console.log(`  replay refused: ${err.status} ${err.explained?.code}: ${err.message}`);
    check("replay: the used signature is refused", err instanceof SluiceError && err.status >= 400 && err.status < 500, `${err.status} ${err.explained?.code}`);
  }
})();

// 7. A second, smaller order: the user now has the C trustline, so the order must not ask for one.
const second = await sluice.prepareOrder({ account: user.publicKey(), assetIn: idA, assetOut: idC, amount: "10" });
if (!second.solverWillFill) throw new Error(`second order declined: ${second.skipReasons.join(", ")}`);
check("second order: no trustline requested", second.order.createTrustline === false, `createTrustline ${second.order.createTrustline}`);
const sent2 = await sluice.submitOrder({ orderId: second.orderId, order: second.order, signedAuthEntry: await signOrder(second, wallet, { settleContract: settleId }) });
const done2 = await sluice.waitForOrder(sent2.hash, { timeoutMs: 120_000 });
check("second fill settles and delivers the agreed amount", done2.status === "SUCCESS" && done2.received === second.summary.expected, `${done2.status} ${done2.received} ${sent2.hash}`);
let hedge2 = done2.hedge;
for (let i = 0; i < 60 && hedge2?.status !== "HEDGED" && hedge2?.status !== "UNHEDGED"; i++) {
  await sleep(2000);
  hedge2 = (await sluice.order(sent2.hash)).hedge;
}
check("second hedge", hedge2?.status === "HEDGED", JSON.stringify(hedge2));
await service.idle();

console.log(`\nfill 1  ${sent.hash}\nhedge 1 ${hedgeStatus?.status === "HEDGED" ? hedgeStatus.hash : "-"}\nfill 2  ${sent2.hash}\nhedge 2 ${hedge2?.status === "HEDGED" ? hedge2.hash : "-"}`);
console.log(`wallet signatures requested: ${walletCalls}; user transactions sent after setup: 0`);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
