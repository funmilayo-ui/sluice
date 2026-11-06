/**
 * TESTNET ONLY. Recovery across a crash, through the whole stack as it runs in production: the API in REMOTE solver mode talking
 * HTTP to the standalone solver service (a real child process running packages/solver/dist/bin.js with its own key and a state
 * directory). The API holds no solver secret.
 *
 *   1. fill an order through API + SDK (the user signs only a Soroban authorisation entry)
 *   2. FORCE the hedge to fail on the real chain: the maker cancels its resting SDEX offers while a Horizon proxy (fault injection in
 *      this harness, in the style of w3) keeps serving the old path quote, so the solver prices and sends the hedge into an empty book
 *   3. watch recovery: the fill stays SUCCESS for the user, the hedge goes RETRYING (bounded retries), the circuit breaker trips and a
 *      new order is refused up front with an explained reason
 *   4. KILL the solver service (SIGKILL) and drop the API instance. The API says "solver unavailable" cleanly and still reports the fill
 *   5. the maker restores the book; the solver service is started again on the SAME state directory: the open exposure and the tripped
 *      breaker come back from the store, the recovery loop resumes, the hedge lands, the exposure clears, the breaker closes
 *
 * Keys are generated in memory and funded by friendbot. The solver's secret is handed only to the child's environment. Never run
 * this against mainnet. Prerequisites: `pnpm build` (the solver child runs from dist) and the settle contract built:
 *   cd contracts && stellar contract build --manifest-path settle/Cargo.toml
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w5:recovery-restart-testnet
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { horizonSource, preferIpv4, Router, simulateView } from "../packages/core/src/index.js";
import { createApp } from "../packages/api/src/app.js";
import { loadOrdersConfig } from "../packages/api/src/orders/config.js";
import { defaultOrdersDeps } from "../packages/api/src/orders/deps.js";
import { createOrdersService } from "../packages/api/src/orders/service.js";
import { Sluice, SluiceError, signOrder, type OrderStatusResponse, type SignAuthEntry } from "../packages/sdk/src/index.js";
import { RemoteSolver } from "../packages/solver/dist/index.js";
import { Address, Keypair } from "../packages/api/node_modules/@stellar/stellar-sdk/lib/index.js";
import {
  apiServer, Book, BASE_TIERS, check, failureCount, fmt, HORIZON, retry, retryingFetch, setupMarket, sleep, S, solverGet, spawnSolver, startHorizonProxy, timedFetch, PASS, RPC,
  waitSolverUp, type Market, type SolverProc,
} from "./lib/testnet.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const t0 = Date.now();
const stamp = () => `+${Math.round((Date.now() - t0) / 1000)}s`;
const log = (m: string) => console.log(`  [${stamp()}] ${m}`);

const m: Market = await setupMarket();
const book = new Book(m);
const tokenA = m.A.contractId(PASS);
const tokenC = m.C.contractId(PASS);
/** Balances from Soroban RPC (the current ledger), not the lagging Horizon. */
const sacBal = async (token: string, g: string) => (await retry("balance", () => simulateView(RPC, token, "balance", [new Address(g).toScVal()], { passphrase: PASS }))) as bigint;
const heldA = () => sacBal(tokenA, m.solver.publicKey());
const stateDir = await mkdtemp(join(tmpdir(), "sluice-w5-"));
const SOLVER_PORT = 18902;
const token = randomBytes(32).toString("hex");
const proxy = await startHorizonProxy(18901);
const solverEnv = {
  SOLVER_MAX_RETRIES: "1", SOLVER_RETRY_TICK_MS: "2000", SOLVER_RETRY_BASE_MS: "4000", SOLVER_RETRY_MAX_MS: "8000", SOLVER_RETRY_MAX_CYCLES: "30",
};
let solver: SolverProc | undefined;
const startSolver = async () => {
  solver = spawnSolver({ port: SOLVER_PORT, token, secret: m.solver.secret(), settle: m.settleId, horizonUrl: proxy.url, stateDir, extraEnv: solverEnv });
  return waitSolverUp(solver);
};

/** The API, configured as a production deployment would be: REMOTE solver, public address and a token, NO solver secret. */
function startApi() {
  const env = {
    ORDERS_SETTLE_CONTRACT: m.settleId, ORDERS_RPC_URL: RPC, ORDERS_HORIZON_URL: proxy.url, ORDERS_NETWORK_PASSPHRASE: PASS,
    ORDERS_MAC_SECRET: createHash("sha256").update(m.issuer.secret()).digest("hex"),
    ORDERS_SOLVER_MODE: "remote", ORDERS_SOLVER_URL: `http://127.0.0.1:${SOLVER_PORT}`, ORDERS_SOLVER_TOKEN: token, ORDERS_SOLVER_ADDRESS: m.solver.publicKey(),
  };
  const setup = loadOrdersConfig(env);
  if (!setup.enabled) throw new Error(`orders config rejected: ${setup.reason}`);
  const noSecret = !JSON.stringify(setup.config, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes(m.solver.secret());
  const service = createOrdersService(setup.config, defaultOrdersDeps(setup.config, { server: apiServer, fetchImpl: retryingFetch }), new RemoteSolver({ url: env.ORDERS_SOLVER_URL, token, address: m.solver.publicKey(), writeTimeoutMs: 90_000 }));
  const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: { enabled: true, service } });
  return { sluice: new Sluice("http://sluice.test", async (input, init) => app.fetch(new Request(input, init))), noSecret };
}
const wallet: SignAuthEntry = async (preimageBase64) => ({ signedAuthEntry: m.user.sign(sha256(Buffer.from(preimageBase64, "base64"))).toString("base64"), signerAddress: m.user.publicKey() });
const fail = async (p: Promise<unknown>): Promise<SluiceError | undefined> => {
  try {
    await p;
  } catch (e) {
    return e as SluiceError;
  }
  return undefined;
};

try {
  await book.set(BASE_TIERS);
  log("maker posted 60 C @ 1.03 A and 200 C @ 1.05 A");
  const up1 = await startSolver();
  log(`solver service up: ${up1.address} accepting=${up1.accepting} state=${up1.store}`);
  check("the solver service owns the key; the API config holds none (remote mode)", up1.address === m.solver.publicKey() && startApi().noSecret, `solver ${up1.address}`);
  let { sluice } = startApi();
  const cfg = await sluice.ordersConfig();
  check("config advertises both signing tiers and the configured solver", cfg.enabled && cfg.signing.tiers?.join() === "auth-entry,tx" && cfg.solver === m.solver.publicKey(), JSON.stringify(cfg).slice(0, 160));

  // 1. Prepare while the real book is visible (this also fills the proxy's cache of path quotes).
  const user0 = await sacBal(tokenA, m.user.publicKey());
  let prepared: Awaited<ReturnType<Sluice["prepareOrder"]>> | undefined;
  for (let i = 0; i < 30 && !(prepared?.solverWillFill); i++) {
    prepared = await sluice.prepareOrder({ account: m.user.publicKey(), assetIn: m.idA, assetOut: m.idC, amount: "100" });
    if (!prepared.solverWillFill) {
      log(`book not visible yet (${prepared.skipReasons.join(", ")})`);
      await sleep(3000);
    }
  }
  if (!prepared?.solverWillFill) throw new Error("the solver never agreed to fill the order");
  log(`prepared: pay ${prepared.summary.pay} A, receive at least ${prepared.summary.receiveAtLeast} C, expected ${prepared.summary.expected} C`);
  const signed = await signOrder(prepared, wallet, { settleContract: m.settleId });

  // 2. Force the failure: freeze quotes, then cancel the book on chain.
  proxy.freeze();
  const cancelTx = await book.set([]);
  log(`FAULT: Horizon quotes frozen; maker cancelled every offer on chain: ${cancelTx}`);

  const sent = await sluice.submitOrder({ orderId: prepared.orderId, order: prepared.order, signedAuthEntry: signed });
  log(`fill submitted: ${sent.hash}`);
  const done = await sluice.waitForOrder(sent.hash, { timeoutMs: 180_000 });
  check("the fill settles for the user (the stale book fooled the pricing, as designed)", done.status === "SUCCESS" && done.received === prepared.summary.expected, `${done.status} ledger ${done.ledger} received ${done.received}`);

  // 3. Watch the hedge fail and the recovery take over.
  const seen: string[] = [];
  let st: OrderStatusResponse = done;
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    st = await sluice.order(sent.hash);
    const h = st.hedge;
    const line = h ? `${h.status}${"attempts" in h ? ` attempts=${h.attempts}` : ""}${"reason" in h && h.reason ? ` reason=${h.reason}` : ""}` : "none";
    if (seen.at(-1) !== line) {
      seen.push(line);
      log(`hedge: ${line}`);
    }
    if (st.hedge?.status === "RETRYING" && st.hedge.attempts >= 2) break;
    if (st.hedge?.status === "HEDGED") break;
    await sleep(2500);
  }
  check("the user's fill status is SUCCESS while the hedge is failing (a hedge failure never changes it)", st.status === "SUCCESS" && st.hedge?.status === "RETRYING", `${st.status} / ${JSON.stringify(st.hedge)}`);
  check("the hedge was retried per policy: attempts bounded, not dumped", st.hedge?.status === "RETRYING" && st.hedge.attempts >= 2 && st.hedge.attempts <= 4, `attempts ${st.hedge && "attempts" in st.hedge ? st.hedge.attempts : "?"}`);
  const stuckA = await heldA();
  check("the solver still holds the 100 A (nothing was dumped)", stuckA === 100n * S, `solver A ${fmt(stuckA)}`);

  const health1 = await solverGet({ url: `http://127.0.0.1:${SOLVER_PORT}`, token }, "/health");
  check("the circuit breaker is tripped on the solver", health1.accepting === false && health1.openExposures === 1, JSON.stringify({ accepting: health1.accepting, open: health1.openExposures }));
  const refused = await sluice.prepareOrder({ account: m.user.publicKey(), assetIn: m.idA, assetOut: m.idC, amount: "10" });
  check("a new order is refused up front with an explained circuit-breaker reason", !refused.solverWillFill && refused.skipReasons.includes("circuit_breaker") && refused.explained.code === "SOLVER_WILL_NOT_FILL", refused.solverWillFill ? "WRONGLY ACCEPTED" : `${refused.skipReasons.join(",")}: ${refused.explained.message.slice(0, 90)}`);
  const onDisk = JSON.parse(await readFile(join(stateDir, "solver-state.json"), "utf8"));
  check("the exposure is on disk, and the state file holds no secret key", onDisk.exposures.length === 1 && !JSON.stringify(onDisk).includes(m.solver.secret()), `state ${JSON.stringify(onDisk).length} bytes, exposures ${onDisk.exposures.length}, orders ${onDisk.orders.length}`);

  // 4. Kill the solver service, drop the API.
  await solver!.kill();
  log("KILLED the solver service (SIGKILL) and dropped the API instance");
  ({ sluice } = startApi());
  const down = await fail(sluice.prepareOrder({ account: m.user.publicKey(), assetIn: m.idA, assetOut: m.idC, amount: "10" }));
  check("with the solver down, prepare fails cleanly: 503 SOLVER_UNAVAILABLE, nothing leaked", down instanceof SluiceError && down.status === 503 && down.explained?.code === "SOLVER_UNAVAILABLE" && !JSON.stringify(down).includes("127.0.0.1"), down ? `${down.status} ${down.explained?.code}: ${down.message}` : "WRONGLY ACCEPTED");
  const orderDown = await sluice.order(sent.hash);
  check("the fill is still reported SUCCESS from the chain; the hedge is honestly UNKNOWN", orderDown.status === "SUCCESS" && orderDown.hedge?.status === "UNKNOWN", `${orderDown.status} / ${JSON.stringify(orderDown.hedge)}`);

  // 5. Restore the book, start the solver again on the same state directory.
  proxy.thaw();
  const restoreTx = await book.set(BASE_TIERS);
  log(`maker restored the book: ${restoreTx}`);
  const leg = horizonSource(HORIZON, timedFetch);
  for (let i = 0; i < 40; i++) {
    const q = await retry("quote", () => leg.quote({ assetIn: m.idA, assetOut: m.idC, amountIn: 100n * S })).catch(() => null);
    if (q && q.amountOut > 104n * S) {
      log(`Horizon shows the restored book: 100 A -> ${fmt(q.amountOut)} C`);
      break;
    }
    await sleep(3000);
  }
  const up2 = await startSolver();
  check("restarted on the same state: the open exposure and the tripped breaker came back from the store", up2.accepting === false && up2.openExposures === 1, JSON.stringify({ accepting: up2.accepting, open: up2.openExposures, store: up2.store }));
  ({ sluice } = startApi());
  const resumed = await sluice.order(sent.hash);
  // The retry that was due while the service was down may already have run by the time we look: HEDGED is as good an answer as RETRYING.
  check("the API reports the restored hedge honestly (RETRYING or already HEDGED; not PENDING, not lost)", resumed.hedge?.status === "RETRYING" || resumed.hedge?.status === "UNHEDGED" || resumed.hedge?.status === "HEDGED", JSON.stringify(resumed.hedge));

  let final: OrderStatusResponse = resumed;
  const until2 = Date.now() + 6 * 60_000;
  while (Date.now() < until2) {
    final = await sluice.order(sent.hash);
    const h = final.hedge;
    const line = h ? `${h.status}${"attempts" in h ? ` attempts=${h.attempts}` : ""}` : "none";
    if (seen.at(-1) !== line) {
      seen.push(line);
      log(`hedge: ${line}`);
    }
    if (h?.status === "HEDGED" || h?.status === "ABANDONED") break;
    await sleep(3000);
  }
  check("recovery resumed from the store after the restart and the hedge landed", final.hedge?.status === "HEDGED", JSON.stringify(final.hedge));
  const health2 = await solverGet({ url: `http://127.0.0.1:${SOLVER_PORT}`, token }, "/health");
  const exposures = await solverGet({ url: `http://127.0.0.1:${SOLVER_PORT}`, token }, "/exposures");
  check("the exposure is cleared and the circuit breaker is closed again", health2.accepting === true && health2.openExposures === 0 && exposures.exposures.length === 0, JSON.stringify({ accepting: health2.accepting, open: health2.openExposures }));
  const onDisk2 = JSON.parse(await readFile(join(stateDir, "solver-state.json"), "utf8"));
  check("the store agrees (no open exposures, the order recorded as hedged)", onDisk2.exposures.length === 0 && onDisk2.orders.some((o: any) => o.id === sent.hash && o.state === "hedged"), `exposures ${onDisk2.exposures.length}`);
  const leftA = await heldA();
  check("the solver holds no leftover A: the position was sold exactly once", leftA === 0n, `solver A ${fmt(leftA)}`);
  const reopened = await sluice.prepareOrder({ account: m.user.publicKey(), assetIn: m.idA, assetOut: m.idC, amount: "10" });
  check("new orders are accepted again", reopened.solverWillFill, reopened.solverWillFill ? `expected ${reopened.summary.expected}` : reopened.skipReasons.join(","));
  const userA = await sacBal(tokenA, m.user.publicKey());
  const userC = await sacBal(tokenC, m.user.publicKey());
  check("the user paid exactly 100 A and received the agreed C (trustline created in the fill)", user0 - userA === 100n * S && fmt(userC) === prepared.summary.expected, `user A ${fmt(userA)}, C ${fmt(userC)}`);

  // Evidence: every transaction the solver account sent, with its outcome.
  const txs = await retry("solver txs", async () => {
    const r = await timedFetch(`${HORIZON}/accounts/${m.solver.publicKey()}/transactions?order=asc&limit=50&include_failed=true`);
    if (!r.ok) throw new Error(`horizon ${r.status}`);
    return ((await r.json()) as { _embedded: { records: { hash: string; successful: boolean; operation_count: number }[] } })._embedded.records;
  });
  const tail = txs.slice(-8);
  console.log("\nsolver account transactions (last 8, oldest first; failed ones included):");
  for (const t of tail) console.log(`  ${t.hash} ${t.successful ? "success" : "FAILED"} ops=${t.operation_count}`);
  const failedHedges = txs.filter((t) => !t.successful).length;
  check("the hedge really did fail on chain before it was recovered (included in a ledger, operation failed), and was then sold once", failedHedges >= 1 && txs.at(-1)!.successful && txs.at(-1)!.hash === (final.hedge?.status === "HEDGED" ? final.hedge.hash : ""), `${failedHedges} failed hedge transaction(s), then ${txs.at(-1)!.hash.slice(0, 12)}…`);
  console.log(`\nfill     ${sent.hash}\nhedge    ${final.hedge?.status === "HEDGED" ? final.hedge.hash : "-"}\nfailed hedge transactions (on chain): ${failedHedges}\nHorizon proxy: ${proxy.served.stale} stale quotes served while frozen, ${proxy.served.live} live`);
  console.log(`hedge status timeline: ${seen.join("  ->  ")}`);
} finally {
  await solver?.kill().catch(() => undefined);
  await proxy.close();
  await rm(stateDir, { recursive: true, force: true });
}
console.log(failureCount() ? `\n${failureCount()} check(s) FAILED` : "\nall checks passed");
process.exit(failureCount() ? 1 : 0);
