/**
 * TESTNET ONLY. The tier-2 signing path end to end: a wallet that CANNOT sign a Soroban authorisation entry but CAN sign a
 * transaction. The user is the transaction source (and pays its fee); the one operation is settle.fill(order, solver, amount_out);
 * the user's authorisation is the transaction signature itself (source-account credentials); the SOLVER's authorisation entry was
 * signed by the solver service when it prepared the transaction.
 *
 *   SDK.prepareOrderTx -> signOrderTx (a throwaway key acts as the wallet, through a callback shaped like signTransaction)
 *   -> SDK.submitOrderTx -> SDK.waitForOrder -> balances, fee, hedge.
 *
 * Stack as in production: the API in REMOTE solver mode (no solver secret) calling the standalone solver service, a real child
 * process (packages/solver/dist/bin.js) that owns the key and a state directory.
 *
 * Negatives against the live API: unsigned, signed by someone else, wrong source, tampered amount_out, tampered order, wrong order id,
 * a replayed transaction, a stale sequence number, an expired transaction. And the SDK's own refusal to ask a wallet to sign a
 * transaction that is not the order it was shown.
 *
 * Keys are generated in memory and funded by friendbot. Never run this against mainnet. Prerequisites: `pnpm build` and the contract:
 *   cd contracts && stellar contract build --manifest-path settle/Cargo.toml
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w6:tx-tier-testnet
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preferIpv4, Router, simulateView } from "../packages/core/src/index.js";
import { createApp } from "../packages/api/src/app.js";
import { loadOrdersConfig } from "../packages/api/src/orders/config.js";
import { defaultOrdersDeps } from "../packages/api/src/orders/deps.js";
import { createOrdersService } from "../packages/api/src/orders/service.js";
import { Sluice, SluiceError, signOrderTx, type PreparedOrderTx, type SignTransaction } from "../packages/sdk/src/index.js";
import { RemoteSolver } from "../packages/solver/dist/index.js";
import { Address, Asset, nativeToScVal, StrKey, Transaction, TransactionBuilder, xdr, Keypair } from "../packages/api/node_modules/@stellar/stellar-sdk/lib/index.js";
import {
  apiServer, Book, BASE_TIERS, check, failureCount, fmt, HORIZON, PASS, retry, retryingFetch, RPC, S, server, setupMarket, sleep, solverGet, spawnSolver, waitFor, waitSolverUp,
  type Market, type SolverProc,
} from "./lib/testnet.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();
const t0 = Date.now();
const log = (msg: string) => console.log(`  [+${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);

const m: Market = await setupMarket();
const book = new Book(m);
const sacBal = async (token: string, g: string) => (await retry("balance", () => simulateView(RPC, token, "balance", [new Address(g).toScVal()], { passphrase: PASS }))) as bigint;
const tokenA = m.A.contractId(PASS), tokenC = m.C.contractId(PASS), tokenX = Asset.native().contractId(PASS);
const stateDir = await mkdtemp(join(tmpdir(), "sluice-w6-"));
const SOLVER_PORT = 18912;
const token = randomBytes(32).toString("hex");
const solver: SolverProc = spawnSolver({ port: SOLVER_PORT, token, secret: m.solver.secret(), settle: m.settleId, horizonUrl: HORIZON, stateDir, extraEnv: { SOLVER_RETRY_TICK_MS: "3000" } });

try {
  await book.set(BASE_TIERS);
  log("maker posted 60 C @ 1.03 A and 200 C @ 1.05 A");
  const up = await waitSolverUp(solver);
  log(`solver service up: ${up.address}`);

  const env = {
    ORDERS_SETTLE_CONTRACT: m.settleId, ORDERS_RPC_URL: RPC, ORDERS_HORIZON_URL: HORIZON, ORDERS_NETWORK_PASSPHRASE: PASS,
    ORDERS_MAC_SECRET: createHash("sha256").update(m.issuer.secret()).digest("hex"),
    ORDERS_SOLVER_MODE: "remote", ORDERS_SOLVER_URL: `http://127.0.0.1:${SOLVER_PORT}`, ORDERS_SOLVER_TOKEN: token, ORDERS_SOLVER_ADDRESS: m.solver.publicKey(),
  };
  const setup = loadOrdersConfig(env);
  if (!setup.enabled) throw new Error(`orders config rejected: ${setup.reason}`);
  const service = createOrdersService(setup.config, defaultOrdersDeps(setup.config, { server: apiServer, fetchImpl: retryingFetch }), new RemoteSolver({ url: env.ORDERS_SOLVER_URL, token, address: m.solver.publicKey(), writeTimeoutMs: 90_000 }));
  const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: { enabled: true, service } });
  const sluice = new Sluice("http://sluice.test", async (input, init) => app.fetch(new Request(input, init)));

  const cfg = await sluice.ordersConfig();
  if (!cfg.enabled) throw new Error(`orders disabled: ${cfg.reason}`);
  check("config: the tx tier is advertised next to the auth-entry tier, and the documented fields are unchanged", cfg.signing.credentials === "address-legacy" && cfg.signing.tiers?.join() === "auth-entry,tx" && cfg.solver === m.solver.publicKey() && cfg.settleContract === m.settleId, JSON.stringify(cfg.signing));
  const opts = { settleContract: cfg.settleContract, solver: cfg.solver };

  // The wallet: it can sign a transaction and nothing else (no signAuthEntry).
  let walletCalls = 0;
  const walletFor = (kp: Keypair): SignTransaction => async (txXdr, o) => {
    walletCalls++;
    const tx = TransactionBuilder.fromXDR(txXdr, o.networkPassphrase) as Transaction;
    tx.sign(kp);
    return { signedTxXdr: tx.toXDR(), signerAddress: kp.publicKey() };
  };
  const wallet = walletFor(m.user);
  const prep = async (amount: string, validForSec?: number): Promise<PreparedOrderTx | undefined> => {
    for (let i = 0; i < 30; i++) {
      const r = await sluice.prepareOrderTx({ account: m.user.publicKey(), assetIn: m.idA, assetOut: m.idC, amount, ...(validForSec ? { validForSec } : {}) });
      if (r.solverWillFill) return r;
      log(`book not visible yet (${r.skipReasons.join(", ")})`);
      await sleep(3000);
    }
    return undefined;
  };

  // Prepare three transactions up front: P2 will be left to expire, P3 to go stale, P1 is the real one.
  const P2 = await prep("10", 120);
  if (!P2) throw new Error("the solver never agreed to fill the order");
  const P3 = (await prep("10"))!;
  const P1 = (await prep("100"))!;
  log(`P1 ${P1.tx.hash}: pay ${P1.summary.pay} A, receive at least ${P1.summary.receiveAtLeast} C, expected ${P1.summary.expected} C, network fee shown ${P1.summary.networkFee} XLM (paid by the user)`);
  const t1 = TransactionBuilder.fromXDR(P1.tx.xdr, PASS) as Transaction;
  check("prepare-tx: the transaction's source is the USER, one operation, the solver's entry already signed, no user signature yet", t1.source === m.user.publicKey() && t1.operations.length === 1 && t1.signatures.length === 0 && P1.tx.source === m.user.publicKey(), `source ${t1.source.slice(0, 8)}…, ops ${t1.operations.length}, signatures ${t1.signatures.length}`);
  check("prepare-tx: the order asks for the missing trustline, and the user is promised at least the signed floor", P1.order.createTrustline === true && Number(P1.summary.expected) >= Number(P1.summary.receiveAtLeast), `${P1.summary.receiveAtLeast} <= ${P1.summary.expected}`);
  const auth = t1.toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth();
  check("prepare-tx: the real network produced the entries we expect (source-account credentials for the user, address credentials for the solver)", auth.length === 2 && auth.some((e) => e.credentials().switch().name === "sorobanCredentialsSourceAccount") && auth.some((e) => e.credentials().switch().name === "sorobanCredentialsAddress"), auth.map((e) => e.credentials().switch().name).join(", "));

  // The SDK refuses to put a wrong transaction in front of the wallet.
  const before = walletCalls;
  const lie = await signOrderTx({ ...P1, summary: { ...P1.summary, expected: "99.0000000" } }, wallet, opts).then(() => undefined, (e: Error) => e);
  const lie2 = await signOrderTx({ ...P1, order: { ...P1.order, minOut: "1.0000000" } }, wallet, opts).then(() => undefined, (e: Error) => e);
  const lie3 = await signOrderTx(P1, wallet, { ...opts, solver: m.stranger.publicKey() }).then(() => undefined, (e: Error) => e);
  check("signOrderTx refuses, before the wallet is asked, a summary that promises more, an order that was changed, and a different solver", !!lie && !!lie2 && !!lie3 && walletCalls === before, [lie, lie2, lie3].map((e) => e?.message.slice(0, 55)).join(" | "));

  const signed1 = await signOrderTx(P1, wallet, opts);
  check("signOrderTx: the wallet signed the transaction it was shown (same hash) and the signature verifies", walletCalls === before + 1 && (TransactionBuilder.fromXDR(signed1, PASS) as Transaction).hash().toString("hex") === P1.tx.hash, `wallet calls ${walletCalls}`);

  // Negatives against the live API. None of them may reach the chain.
  const mutate = (x: string, f: (t: xdr.Transaction) => void): string => {
    const e = xdr.TransactionEnvelope.fromXDR(x, "base64");
    f(e.v1().tx());
    return new Transaction(e, PASS).toXDR();
  };
  const sign = (x: string, kp: Keypair) => {
    const t = TransactionBuilder.fromXDR(x, PASS) as Transaction;
    t.sign(kp);
    return t.toXDR();
  };
  const userSeq0 = (await retry("getAccount", () => server.getAccount(m.user.publicKey()))).sequenceNumber();
  const aBefore = await sacBal(tokenA, m.user.publicKey());
  const refuse = async (name: string, body: { orderId?: string; order?: PreparedOrderTx["order"]; signedTx: string }, status: number, code: string, p: PreparedOrderTx = P1) => {
    const e = await sluice.submitOrderTx({ orderId: body.orderId ?? p.orderId, order: body.order ?? p.order, signedTx: body.signedTx }).then(() => undefined, (x: SluiceError) => x);
    check(`submit-tx refuses ${name}`, e instanceof SluiceError && e.status === status && e.explained?.code === code, e ? `${e.status} ${e.explained?.code}: ${e.message.slice(0, 80)}` : "WRONGLY ACCEPTED");
  };
  const callOf = (t: xdr.Transaction) => t.operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract();
  await refuse("a transaction the user did not sign", { signedTx: P1.tx.xdr }, 400, "BAD_SIGNATURE");
  await refuse("a transaction signed by someone else", { signedTx: sign(P1.tx.xdr, m.stranger) }, 400, "BAD_SIGNATURE");
  await refuse("a wrong source account", { signedTx: sign(sign(mutate(P1.tx.xdr, (t) => t.sourceAccount(xdr.MuxedAccount.keyTypeEd25519(m.stranger.rawPublicKey()))), m.stranger), m.user) }, 400, "WRONG_SOURCE");
  await refuse("a tampered amount_out (the solver's signature no longer covers it)", { signedTx: sign(mutate(P1.tx.xdr, (t) => {
    const c = callOf(t);
    c.args([c.args()[0]!, c.args()[1]!, nativeToScVal(BigInt(P1.summary.expected.replace(".", "")) + 1n, { type: "i128" })]);
  }), m.user) }, 400, "BAD_AUTH");
  await refuse("a tampered order (min_out lowered)", { signedTx: sign(mutate(P1.tx.xdr, (t) => {
    const c = callOf(t);
    const o = c.args()[0]!;
    const mo = o.map()!.find((e) => e.key().sym().toString() === "min_out")!;
    mo.val(nativeToScVal(1n, { type: "i128" }));
    c.args([o, c.args()[1]!, c.args()[2]!]);
  }), m.user) }, 400, "TX_MISMATCH");
  await refuse("a wrong order id", { orderId: P1.orderId.replace(/.$/, (c) => (c === "0" ? "1" : "0")), signedTx: signed1 }, 400, "BAD_ORDER_ID");
  check("none of the refusals reached the chain: the user's balance and sequence are unchanged", (await sacBal(tokenA, m.user.publicKey())) === aBefore && (await retry("getAccount", () => server.getAccount(m.user.publicKey()))).sequenceNumber() === userSeq0, `sequence ${userSeq0}`);

  // The real fill.
  const xlmBefore = await sacBal(tokenX, m.user.publicKey());
  const sent = await sluice.submitOrderTx({ orderId: P1.orderId, order: P1.order, signedTx: signed1 });
  log(`submitted ${sent.hash} (${sent.status})`);
  check("submit-tx returns the hash the transaction always had", sent.hash === P1.tx.hash, sent.hash);
  const done = await sluice.waitForOrder(sent.hash, { timeoutMs: 180_000 });
  check("the fill settles", done.status === "SUCCESS", `${done.status} ledger ${done.ledger}`);
  check("received equals the amount the solver agreed to (read from the transaction)", done.received === P1.summary.expected, `${done.received} vs ${P1.summary.expected}`);
  const onChain = await waitFor(sent.hash);
  const env1 = (onChain as { envelopeXdr: xdr.TransactionEnvelope }).envelopeXdr.v1().tx();
  const feeCharged = BigInt((onChain as { resultXdr: xdr.TransactionResult }).resultXdr.feeCharged().toString());
  const xlmAfter = await sacBal(tokenX, m.user.publicKey());
  check("the transaction on chain is sourced from the USER; the user paid the fee and the solver sent no fill transaction", StrKey.encodeEd25519PublicKey(env1.sourceAccount().ed25519()) === m.user.publicKey() && xlmBefore - xlmAfter > 0n && xlmBefore - xlmAfter <= BigInt(t1.fee), `user XLM -${fmt(xlmBefore - xlmAfter)} (fee charged ${fmt(feeCharged)}, max shown ${P1.summary.networkFee})`);
  const aAfter = await sacBal(tokenA, m.user.publicKey());
  const cAfter = await sacBal(tokenC, m.user.publicKey());
  check("the user paid exactly amount_in of A and received the amount, with the C trustline created inside the fill", aBefore - aAfter === 100n * S && fmt(cAfter) === P1.summary.expected, `user A ${fmt(aAfter)}, C ${fmt(cAfter)}`);

  // The solver hedged it (reserved at prepare time, tracked, hedged after it landed).
  let hedge = done.hedge;
  for (let i = 0; i < 80 && hedge?.status !== "HEDGED" && hedge?.status !== "ABANDONED" && hedge?.status !== "UNHEDGED"; i++) {
    await sleep(3000);
    hedge = (await sluice.order(sent.hash)).hedge;
  }
  check("GET /v1/orders/:hash reports the solver's hedge for a user-sourced fill: HEDGED", hedge?.status === "HEDGED", JSON.stringify(hedge));
  const heldA = await sacBal(tokenA, m.solver.publicKey());
  check("the solver holds no leftover A after the hedge", heldA === 0n, `solver A ${fmt(heldA)}`);

  // More negatives, now that the account has moved on.
  await refuse("a replay of the transaction that was just filled", { signedTx: signed1 }, 409, "BAD_SEQUENCE");
  const signed3 = await signOrderTx(P3, wallet, opts);
  await refuse("a transaction prepared before another one was sent from the account (stale sequence)", { signedTx: signed3 }, 409, "BAD_SEQUENCE", P3);

  // The expired one: wait out P2's validity.
  const waitMs = P2.tx.maxTime * 1000 + 8000 - Date.now();
  if (waitMs > 0) {
    log(`waiting ${Math.ceil(waitMs / 1000)}s for P2 to expire`);
    await sleep(waitMs);
  }
  const lateSdk = await signOrderTx(P2, wallet, opts).then(() => undefined, (e: Error) => e);
  check("signOrderTx refuses an expired transaction without asking the wallet", !!lateSdk && /expired/.test(lateSdk.message), lateSdk?.message.slice(0, 80) ?? "WRONGLY ACCEPTED");
  await refuse("an expired transaction", { signedTx: sign(P2.tx.xdr, m.user) }, 410, "EXPIRED", P2);
  let p2view: any;
  for (let i = 0; i < 30; i++) {
    p2view = await solverGet({ url: `http://127.0.0.1:${SOLVER_PORT}`, token }, `/status/${P2.tx.hash}`);
    if (p2view.hedge?.status === "NOT_NEEDED") break;
    await sleep(3000);
  }
  check("the solver lets the unused reservation expire (no hedge owed, nothing held)", p2view?.hedge?.status === "NOT_NEEDED", JSON.stringify(p2view?.hedge));
  const finalHealth = await solverGet({ url: `http://127.0.0.1:${SOLVER_PORT}`, token }, "/health");
  check("the solver is healthy and accepting, with no open exposures", finalHealth.accepting === true && finalHealth.openExposures === 0, JSON.stringify({ accepting: finalHealth.accepting, open: finalHealth.openExposures }));

  console.log(`\ntier-2 fill ${sent.hash}\nhedge       ${hedge?.status === "HEDGED" ? hedge.hash : "-"}\nwallet signTransaction calls: ${walletCalls} (signAuthEntry was never used)`);
} finally {
  await solver.kill().catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
}
console.log(failureCount() ? `\n${failureCount()} check(s) FAILED` : "\nall checks passed");
process.exit(failureCount() ? 1 : 0);
