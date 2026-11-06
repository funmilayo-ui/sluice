/**
 * TESTNET ONLY. The failed-hedge path, exercised on a real network, with the recovery in packages/solver.
 *
 * Same parties as w2 (throwaway keys in memory, friendbot-funded, never written anywhere): issuer (SLFA/SLFC),
 * maker (resting SDEX offers that SELL C for A: the Classic liquidity the solver hedges into), user (signs only a
 * Soroban auth entry), solver. The solver fills through the settle contract in ONE Soroban transaction, THEN hedges
 * in a separate Classic path-payment transaction. This script moves the real order book between those two steps:
 * after the fill has settled and before the hedge is sent, the market maker re-prices or cancels its real SDEX
 * offers with a real transaction, so the quote the fill was priced on is stale. Nothing is mocked.
 *
 * Scenarios (one settle deployment, one book, run in this order):
 *   a  book moves a little, INSIDE the slippage buffer      -> the original hedge still lands
 *   b  book moves past the buffer, re-quote inside the loss bound
 *                                                           -> original hedge FAILS on chain (destMin), retry lands
 *   c  book moves past the loss bound                       -> recovery refuses to dump, records the exposure, the
 *      breaker trips and the next order is refused; the book then disappears completely (no path); then the maker
 *      restores liquidity and retryExposure() hedges it and clears the breaker
 *   d  the hedge LANDS but its response is dropped (fault injected in this client, the chain is real)
 *                                                           -> status UNKNOWN: resolved from the chain, never re-sent
 *
 * Fees are paid in XLM; they are converted to C at an ASSUMED rate (no XLM/C market on testnet) and the measured
 * XLM is reported separately. Balances are read from Soroban RPC (current ledger), not from the lagging Horizon.
 *
 * Build the contract first:  cd contracts && stellar contract build --manifest-path settle/Cargo.toml
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w3:hedge-failure-testnet
 * Env (optional): MIN_PROFIT_BPS (20), HEDGE_SLIPPAGE_BPS (50), LOSS_BPS (100 = max loss bound, bps of the quoted hedge proceeds)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatAmount, parseAmount, preferIpv4, simulateView } from "../packages/core/src/index.js";
import {
  createStellarHedgeIo, decideHedgeRetry, encodeOrder, evaluateFill, feeToOut, fillRecordFrom, guardedEvaluate, HedgeExecutor, quoteHedge, realisedPnl,
  resolveClassicAssets, type Decision, type HedgeIo, type HedgeResult, type Inventory, type Order, type QuotedHedge, type SolverParams,
} from "../packages/solver/src/index.js";
import {
  Address, Asset, authorizeEntry, BASE_FEE, Keypair, nativeToScVal, Networks, Operation, rpc, scValToNative, Transaction, TransactionBuilder, xdr,
} from "../packages/solver/node_modules/@stellar/stellar-sdk/lib/index.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const PASS = Networks.TESTNET;
if (PASS !== "Test SDF Network ; September 2015") throw new Error("testnet only");
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const WASM = fileURLToPath(new URL("../contracts/target/wasm32v1-none/release/sluice_settle.wasm", import.meta.url));
const server = new rpc.Server(RPC);
const S = 10_000_000n;
const ASSUMED_C_PER_XLM = "0.1";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (v: bigint) => formatAmount(v);
const signed = (v: bigint) => (v < 0n ? "-" : "+") + fmt(v < 0n ? -v : v);
const short = (h: string) => h.slice(0, 8);

/** Flaky network: retry READS (never a transaction submit) with a pause. */
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
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(75_000) });

async function waitFor(hash: string): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < 80; i++) {
    const r = await retry("getTransaction", () => server.getTransaction(hash));
    if (r.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return r;
    await sleep(1500);
  }
  throw new Error(`transaction ${hash} did not appear in a ledger`);
}
async function send(tx: Transaction) {
  console.log(`  . sending ${tx.hash().toString("hex").slice(0, 8)} ${new Date().toISOString().slice(11, 19)}`);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${sent.errorResult?.toXDR("base64")}`);
  const done = await waitFor(sent.hash);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ${done.status}`);
  return { hash: sent.hash, done: done as rpc.Api.GetSuccessfulTransactionResponse };
}
async function run(source: Keypair, ops: xdr.Operation[], soroban: boolean, signers: Keypair[] = [source]) {
  const account = await retry("getAccount", () => server.getAccount(source.publicKey()));
  let b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS });
  for (const op of ops) b = b.addOperation(op);
  let tx = b.setTimeout(180).build();
  if (soroban) tx = await retry("prepareTransaction", () => server.prepareTransaction(tx));
  for (const s of signers) tx.sign(s);
  return send(tx);
}

// --- Parties.
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

await run(user, [Operation.changeTrust({ asset: A })], false);
await run(solver, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(maker, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(issuer, [
  Operation.payment({ destination: user.publicKey(), asset: A, amount: "1000" }),
  Operation.payment({ destination: solver.publicKey(), asset: C, amount: "1000" }),
  Operation.payment({ destination: maker.publicKey(), asset: C, amount: "2000" }),
], false);

for (const asset of [A, C]) await run(solver, [Operation.createStellarAssetContract({ asset })], true);
const sacA = A.contractId(PASS);
const sacC = C.contractId(PASS);
const sacX = Asset.native().contractId(PASS);
const wasm = readFileSync(WASM);
const wasmHash = createHash("sha256").update(wasm).digest();
await run(solver, [Operation.uploadContractWasm({ wasm })], true);
const deployed = await run(solver, [Operation.createCustomContract({ address: new Address(solver.publicKey()), wasmHash, salt: Keypair.random().rawPublicKey() })], true);
const settleId = Address.fromScVal(deployed.done.returnValue!).toString();
console.log(`settle ${settleId}  (${wasm.length} bytes)`);

// --- Balances from Soroban RPC (the current ledger), not Horizon.
const sacBal = async (token: string, g: string): Promise<bigint> =>
  (await retry("balance", () => simulateView(RPC, token, "balance", [new Address(g).toScVal()], { passphrase: PASS }))) as bigint;
type Snap = Inventory & { xlm: bigint };
const snapshot = async (): Promise<Snap> => ({ tokenIn: await sacBal(sacA, solver.publicKey()), tokenOut: await sacBal(sacC, solver.publicKey()), xlm: await sacBal(sacX, solver.publicKey()) });

// --- The market maker's book. Two tiers selling C for A; price = A per C. The first tier is fixed (60 C @ 1.03 A);
// the second tier's price is what the scenarios move.
const TIER1_C = 60n * S;
// Prices are integers in units of 1e-7 A per C.
const px = (n: bigint) => `${n / S}.${(n % S).toString().padStart(7, "0")}`;
const P1 = 10_300_000n; // 1.03
interface Tier { amountC: bigint; price: bigint }
const bookOf = (price2: bigint): Tier[] => [{ amountC: TIER1_C, price: P1 }, { amountC: 200n * S, price: price2 }];
/** C a strict-send of `amountA` returns from `tiers` (cheapest first). */
function expectOut(tiers: Tier[], amountA: bigint): bigint {
  let rem = amountA, out = 0n;
  for (const t of [...tiers].sort((a, b) => Number(a.price - b.price))) {
    if (rem <= 0n) break;
    const cap = (t.amountC * t.price) / S;
    const take = rem < cap ? rem : cap;
    out += (take * S) / t.price;
    rem -= take;
  }
  return rem > 0n ? -1n : out; // -1: the order is deeper than the book
}
/** Second-tier price that makes a 100 A sale return about `target` C. */
function price2For(target: bigint): bigint {
  const remA = 100n * S - (TIER1_C * P1) / S;
  const remC = target - TIER1_C;
  return (remA * S + remC - 1n) / remC;
}
const INITIAL = bookOf(10_500_000n); // 1.05
let offerIds: string[] = [];

async function offerExists(id: string): Promise<boolean> {
  const key = xdr.LedgerKey.offer(new xdr.LedgerKeyOffer({ sellerId: maker.xdrAccountId(), offerId: xdr.Int64.fromString(id) }));
  const r = await retry("getLedgerEntries", () => server.getLedgerEntries(key));
  return r.entries.length > 0;
}
/** One real maker transaction: cancel what is left of the previous offers and post `tiers` (none = the book disappears). */
async function setBook(tiers: Tier[]): Promise<string> {
  const ops: xdr.Operation[] = [];
  for (const id of offerIds) if (await offerExists(id)) ops.push(Operation.manageSellOffer({ selling: C, buying: A, amount: "0", price: "1", offerId: id }));
  for (const t of tiers) ops.push(Operation.manageSellOffer({ selling: C, buying: A, amount: fmt(t.amountC), price: px(t.price) }));
  const { hash, done } = await run(maker, ops, false);
  const results = done.resultXdr.result().results();
  offerIds = [];
  for (let i = ops.length - tiers.length; i < ops.length; i++) {
    const r = results[i]!.tr().manageSellOfferResult().success().offer();
    offerIds.push(r.offer().offerId().toString());
  }
  return hash;
}

const pairOf = (o: Order) => resolveClassicAssets(o, [idA, idC], PASS)!;
const horizonQuote = (o: Order, amountIn: bigint = o.amountIn) => quoteHedge({ ...o, amountIn }, pairOf(o), HORIZON, Date.now(), timedFetch);
/** Horizon ingests new offers a few ledgers late: wait until its path quote reflects the book we know is on chain. */
async function waitHorizon(o: Order, tiers: Tier[]): Promise<QuotedHedge | null> {
  const want = expectOut(tiers, o.amountIn);
  for (let i = 0; i < 40; i++) {
    let q: QuotedHedge | null | undefined;
    try {
      q = await horizonQuote(o);
    } catch {
      q = undefined;
    }
    if (q !== undefined) {
      if (want < 0n ? q === null : q !== null && (q.quote.amountOut > want ? q.quote.amountOut - want : want - q.quote.amountOut) <= 200n) return q;
    }
    await sleep(3000);
  }
  throw new Error(`Horizon never showed the book (wanted ${want < 0n ? "no path" : fmt(want)} C for ${fmt(o.amountIn)} A)`);
}

// --- Solver policy and the recovery config.
const policy = {
  minDeadlineBufferSec: 120,
  maxOrderIn: 1000n * S,
  hedgeSlippageBps: Number(process.env.HEDGE_SLIPPAGE_BPS ?? 50),
  minProfitBps: Number(process.env.MIN_PROFIT_BPS ?? 20),
  improvementShareBps: 10_000, // hand the user everything above the profit floor, so the solver's margin is the buffer (realistic and thin)
};
const LOSS_BPS = Number(process.env.LOSS_BPS ?? 100);
const attemptFeeOut = feeToOut(BigInt(BASE_FEE), ASSUMED_C_PER_XLM);
console.log(`policy: ${JSON.stringify({ ...policy, maxOrderIn: fmt(policy.maxOrderIn) })}, recovery: maxRetries 3, max loss ${LOSS_BPS} bps of the quoted hedge proceeds, breaker cap 0; fees at ${ASSUMED_C_PER_XLM} C per XLM (assumed)`);

const wasmCall = (o: Order, amountOut: bigint) =>
  Operation.invokeContractFunction({ contract: settleId, function: "fill", args: [encodeOrder(o), new Address(solver.publicKey()).toScVal(), nativeToScVal(amountOut, { type: "i128" })] });
async function solverTx(o: Order, amountOut: bigint, auth?: xdr.SorobanAuthorizationEntry[]): Promise<Transaction> {
  const acc = await retry("getAccount", () => server.getAccount(solver.publicKey()));
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS }).addOperation(wasmCall(o, amountOut)).setTimeout(300).build();
  if (!auth) return tx;
  const env = tx.toEnvelope();
  env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth(auth);
  return new Transaction(env, PASS);
}
const mkOrder = (amountIn: bigint, minOut: bigint): Order => ({
  user: user.publicKey(), tokenIn: sacA, amountIn, tokenOut: sacC, minOut, deadline: Math.floor(Date.now() / 1000) + 900, createTrustline: true,
});

/** Price the order against a real Horizon quote, as w2 does. */
async function evaluate(order: Order): Promise<{ decision: Decision; quoted: QuotedHedge | null; feeOut: bigint }> {
  const sim = await retry("simulate", () => solverTx(order, order.minOut).then((t) => server.simulateTransaction(t)));
  if (rpc.Api.isSimulationError(sim)) throw new Error(`recording simulation failed: ${sim.error}`);
  const feeStroops = BigInt(sim.minResourceFee) + BigInt(BASE_FEE) * 2n;
  const feeOut = feeToOut(feeStroops, ASSUMED_C_PER_XLM);
  const quoted = await retry("horizon path", () => horizonQuote(order));
  const p: SolverParams = { ...policy, nowMs: Date.now(), solverBalanceOut: await sacBal(sacC, solver.publicKey()), networkFeeOut: feeOut, maxQuoteAgeSec: 120 };
  return { decision: evaluateFill(order, quoted?.quote ?? null, p), quoted, feeOut };
}

async function fillOrder(order: Order, decision: Extract<Decision, { action: "fill" }>) {
  const rec = await retry("simulate", () => solverTx(order, decision.amountOut).then((t) => server.simulateTransaction(t)));
  if (rpc.Api.isSimulationError(rec)) throw new Error(`recording simulation failed: ${rec.error}`);
  const userEntry = rec.result!.auth.find((e) => e.credentials().switch().name === "sorobanCredentialsAddress");
  if (!userEntry) throw new Error("simulation asked for no user authorization");
  const latest = await retry("latest ledger", () => server.getLatestLedger());
  const signedUser = await authorizeEntry(userEntry, user, latest.sequence + 100, PASS);
  const signedAuth = rec.result!.auth.map((e) => (e === userEntry ? signedUser : e));
  const enforced = await retry("simulate", () => solverTx(order, decision.amountOut, signedAuth).then((t) => server.simulateTransaction(t)));
  if (rpc.Api.isSimulationError(enforced)) throw new Error(`enforcing simulation failed: ${enforced.error}`);
  const fillTx = rpc.assembleTransaction(await solverTx(order, decision.amountOut, signedAuth), enforced).build();
  fillTx.sign(solver);
  const fill = await send(fillTx);
  const returned = scValToNative(fill.done.returnValue!) as bigint;
  return { hash: fill.hash, returned };
}

// --- The hedge executor, wired to the real chain.
let currentOrder: Order;
const realIo = createStellarHedgeIo({
  server, passphrase: PASS, solver,
  quote: (amountIn) => retry("horizon path", () => horizonQuote(currentOrder, amountIn), 3),
  heldIn: () => sacBal(sacA, solver.publicKey()),
  timeoutSec: 120, confirmTimeoutMs: 60_000, pollMs: 1500,
});
let submitCount = 0;
let dropNextResponse = false;
const io: HedgeIo = {
  ...realIo,
  async submit(leg, minOut) {
    submitCount++;
    const r = await realIo.submit(leg, minOut);
    if (dropNextResponse && (r.status === "success" || r.status === "failed")) {
      dropNextResponse = false;
      // FAULT INJECTION in this client: the transaction really went through, the answer is lost on the way back.
      return { status: "unknown", hash: r.hash, error: "response dropped by the test harness (transaction was really sent)", expiresAtMs: Date.now() + 120_000 };
    }
    return r;
  },
};
const exec = new HedgeExecutor(io, { maxRetries: 3, maxLossBps: LOSS_BPS, hedgeSlippageBps: policy.hedgeSlippageBps, maxUnhedgedExposureOut: 0n, attemptFeeOut, unknownPollMs: 2000, unknownResolveTimeoutMs: 150_000 });

interface Row {
  name: string; fillTx: string; moveTx: string[]; attempts: string[]; before: Snap; after: Snap; expected: bigint; realised: bigint; bound: string; result: string;
}
const rows: Row[] = [];

function describeResult(r: HedgeResult): string[] {
  const lines = r.attempts.map((a) => {
    const s = a.result;
    const tail = s.status === "success" ? `landed ${s.hash}${s.proceedsOut !== null ? `, received ${fmt(s.proceedsOut)} C` : ""}` : s.status === "failed" ? `FAILED ON CHAIN ${s.hash}: ${s.error}` : s.status === "rejected" ? `rejected: ${s.error}` : `UNKNOWN ${s.hash}: ${s.error}`;
    return `attempt ${a.n} (${a.kind}) quote ${fmt(a.quoteOut)} C, destMin ${fmt(a.minOut)} C -> ${tail}`;
  });
  lines.push(r.status === "hedged" ? `=> HEDGED: ${r.detail}` : `=> EXPOSED (${r.reason}): ${r.detail}`);
  return lines;
}
const printResult = (r: HedgeResult) => describeResult(r).forEach((l) => console.log(`    ${l}`));
function printInv(label: string, b: Snap, a: Snap) {
  console.log(`    ${label.padEnd(26)} A ${fmt(b.tokenIn)} -> ${fmt(a.tokenIn)} (${signed(a.tokenIn - b.tokenIn)})   C ${fmt(b.tokenOut)} -> ${fmt(a.tokenOut)} (${signed(a.tokenOut - b.tokenOut)})   XLM ${fmt(b.xlm)} -> ${fmt(a.xlm)} (${signed(a.xlm - b.xlm)})`);
}

/** Common start: reset the book, wait for Horizon, price and fill one order, return what the hedge needs. */
async function startScenario(name: string) {
  console.log(`\n================ scenario ${name} ================`);
  const moveTx: string[] = [];
  moveTx.push(await setBook(INITIAL));
  console.log(`  maker posts the base book (60 C @ 1.03 A, 200 C @ 1.05 A): ${moveTx[0]}`);
  const order = mkOrder(100n * S, 90n * S);
  currentOrder = order;
  await waitHorizon(order, INITIAL);
  const g = exec.canFill();
  if (!g.ok) throw new Error(`breaker unexpectedly tripped: ${g.reason}`);
  const { decision, quoted, feeOut } = await evaluate(order);
  if (decision.action !== "fill" || !quoted) throw new Error(`scenario ${name}: the base order should be fillable, got ${JSON.stringify(decision, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  console.log(`  quote ${fmt(quoted.quote.amountOut)} C for 100 A; fill pays ${fmt(decision.amountOut)} C (min_out 90); expected profit ${fmt(decision.expectedProfitOut)} C, worst case in buffer ${fmt(decision.worstCaseProfitOut)} C, hedge destMin ${fmt(decision.hedgeMinOut)} C`);
  const before = await snapshot();
  const fill = await fillOrder(order, decision);
  console.log(`  fill settled ${fill.hash}; user received ${fmt(fill.returned)} C`);
  const afterFill = await snapshot();
  printInv("solver after fill", before, afterFill);
  const record = fillRecordFrom(decision, { id: `${name}:${short(fill.hash)}`, tokenIn: idA, tokenOut: idC, amountIn: order.amountIn, quoted, baselineIn: before.tokenIn });
  return { order, decision, quoted, feeOut, before, fill, record, moveTx };
}

/** Loss window for a re-quote to be accepted: a quote T is accepted iff floor(T) >= cost + fees - bound. */
function acceptWindow(rec: ReturnType<typeof fillRecordFrom>) {
  // smallest quote the retry check accepts (found by the same pure function the executor uses)
  let lo = 0n, hi = rec.quoted.quote.amountOut;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const d = decideHedgeRetry(rec, { amountIn: rec.amountIn, amountOut: mid }, rec.amountIn, attemptFeeOut, { maxLossBps: LOSS_BPS, hedgeSlippageBps: policy.hedgeSlippageBps });
    if (d.action === "hedge") hi = mid; else lo = mid + 1n;
  }
  return { minAcceptedQuote: lo, originalFloor: rec.hedgeMinOut, originalQuote: rec.quoted.quote.amountOut };
}

async function finish(name: string, s: Awaited<ReturnType<typeof startScenario>>, r: HedgeResult, attemptsText: string[], bound: bigint, result: string) {
  const after = await snapshot();
  printInv(`${name} total (before fill -> after)`, s.before, after);
  const xlmPaid = s.before.xlm - after.xlm;
  const feesOut = feeToOut(xlmPaid, ASSUMED_C_PER_XLM);
  const mark = { num: s.quoted.quote.amountOut, den: s.quoted.quote.amountIn };
  const pnl = realisedPnl(s.before, after, mark, feesOut);
  console.log(`    expected P&L ${signed(s.decision.expectedProfitOut)} C; realised ${signed(pnl.netPnlOut)} C (inventory ${signed(pnl.inventoryPnlOut)} C, fees ${fmt(xlmPaid)} XLM = ${fmt(feesOut)} C assumed); max acceptable loss ${fmt(bound)} C; A left over ${fmt(pnl.deltaIn)}`);
  rows.push({ name, fillTx: s.fill.hash, moveTx: s.moveTx, attempts: attemptsText, before: s.before, after, expected: s.decision.expectedProfitOut, realised: pnl.netPnlOut, bound: fmt(bound), result });
  void r;
  return { after, pnl };
}
const attemptsOf = (r: HedgeResult) => r.attempts.map((a) => `${a.result.status === "success" ? "ok" : a.result.status}${"hash" in a.result ? ":" + short(a.result.hash) : ""}`);

// =====================================================================================================================
// a: a small move, inside the buffer.
{
  const s = await startScenario("a (move inside the buffer)");
  const T = s.quoted.quote.amountOut - (s.quoted.quote.amountOut - s.decision.hedgeMinOut) / 2n; // midway between the quote and the on-chain floor
  const book = bookOf(price2For(T));
  s.moveTx.push(await setBook(book));
  console.log(`  maker re-prices tier 2 to ${px(book[1]!.price)} A/C: a 100 A sale now returns ~${fmt(expectOut(book, 100n * S))} C (quote was ${fmt(s.quoted.quote.amountOut)}, destMin ${fmt(s.decision.hedgeMinOut)}): ${s.moveTx[1]}`);
  await waitHorizon(s.order, book);
  const r = await exec.hedgeFill(s.record);
  printResult(r);
  const { pnl } = await finish("a", s, r, attemptsOf(r), (BigInt(LOSS_BPS) * s.quoted.quote.amountOut) / 10_000n, "hedged on the 1st try");
  check("a: the original hedge landed on the first attempt despite the move", r.status === "hedged" && r.attempts.length === 1 && r.attempts[0]!.result.status === "success", attemptsOf(r).join(" "));
  const got = r.status === "hedged" ? r.attempts[0]!.result : undefined;
  check("a: proceeds fell below the quote but stayed above destMin", got?.status === "success" && got.proceedsOut !== null && got.proceedsOut < s.quoted.quote.amountOut && got.proceedsOut >= s.decision.hedgeMinOut, got?.status === "success" ? `${got.proceedsOut === null ? "?" : fmt(got.proceedsOut)} C in [${fmt(s.decision.hedgeMinOut)}, ${fmt(s.quoted.quote.amountOut)})` : "n/a");
  check("a: no A left over, no exposure, breaker clear", pnl.deltaIn === 0n && exec.exposures.length === 0 && exec.canFill().ok, `A change ${fmt(pnl.deltaIn)}`);
  check("a: realised profit is positive and no better than expected (the move cost something)", pnl.netPnlOut > 0n && pnl.netPnlOut < s.decision.expectedProfitOut, `${signed(pnl.netPnlOut)} vs expected ${signed(s.decision.expectedProfitOut)}`);
}

// b: past the buffer, re-quote inside the loss bound.
{
  const s = await startScenario("b (move past the buffer, inside the loss bound)");
  const w = acceptWindow(s.record);
  console.log(`  window: a re-quote is accepted from ${fmt(w.minAcceptedQuote)} C; the original destMin is ${fmt(w.originalFloor)} C; the original quote was ${fmt(w.originalQuote)} C`);
  if (!(w.minAcceptedQuote < w.originalFloor - 20n)) {
    console.log("  CANNOT PRODUCE scenario b as designed: the acceptable-quote window is empty with these parameters");
    check("b: scenario could be produced", false, "window empty");
  } else {
    const T = w.minAcceptedQuote + (w.originalFloor - w.minAcceptedQuote) / 2n;
    const book = bookOf(price2For(T));
    s.moveTx.push(await setBook(book));
    console.log(`  maker re-prices tier 2 to ${px(book[1]!.price)} A/C: a 100 A sale now returns ~${fmt(expectOut(book, 100n * S))} C: ${s.moveTx[1]}`);
    await waitHorizon(s.order, book);
    const r = await exec.hedgeFill(s.record);
    printResult(r);
    const bound = (BigInt(LOSS_BPS) * s.quoted.quote.amountOut) / 10_000n;
    const { pnl } = await finish("b", s, r, attemptsOf(r), bound, "1st hedge failed on chain, retry landed");
    const [a1, a2] = r.attempts;
    check("b: the first hedge failed ON CHAIN (included, op failed under destMin)", a1?.result.status === "failed" && /UnderDestmin/i.test(a1.result.error), a1?.result.status === "failed" ? a1.result.error : String(a1?.result.status));
    check("b: the retry used a fresh quote and a lower floor, and landed", r.status === "hedged" && a2?.kind === "requote" && a2.result.status === "success" && a2.minOut < s.decision.hedgeMinOut, a2 ? `destMin ${fmt(a2.minOut)} C (was ${fmt(s.decision.hedgeMinOut)}), ${a2.result.status}` : "no retry");
    check("b: realised loss is inside the bound", pnl.netPnlOut >= -bound, `realised ${signed(pnl.netPnlOut)} C, bound -${fmt(bound)} C`);
    check("b: realised P&L is a loss or thin vs the expected profit (honest: the move cost money)", pnl.netPnlOut < s.decision.expectedProfitOut, `${signed(pnl.netPnlOut)} vs expected ${signed(s.decision.expectedProfitOut)}`);
    check("b: no A left over, no exposure", pnl.deltaIn === 0n && exec.exposures.length === 0, `A change ${fmt(pnl.deltaIn)}`);
  }
}

// c: past the loss bound -> exposure, breaker, refuse the next order; book gone; restore; retryExposure.
{
  const s = await startScenario("c (move past the loss bound)");
  const w = acceptWindow(s.record);
  const T = (w.minAcceptedQuote * 97n) / 100n; // 3% under the cheapest acceptable quote: liquidity still exists, but dumping into it would break the bound
  const book = bookOf(price2For(T));
  s.moveTx.push(await setBook(book));
  console.log(`  a re-quote is accepted from ${fmt(w.minAcceptedQuote)} C. Maker re-prices tier 2 to ${px(book[1]!.price)} A/C: a 100 A sale now returns ~${fmt(expectOut(book, 100n * S))} C: ${s.moveTx[1]}`);
  await waitHorizon(s.order, book);
  const bound = (BigInt(LOSS_BPS) * s.quoted.quote.amountOut) / 10_000n;
  const r = await exec.hedgeFill(s.record);
  printResult(r);
  const exposed = await snapshot();
  printInv("solver while EXPOSED", s.before, exposed);
  check("c: the first hedge failed on chain, the re-quote was refused as outside the loss bound, nothing was dumped", r.status === "exposed" && r.reason === "loss_bound_exceeded" && r.attempts.length === 1 && r.attempts[0]!.result.status === "failed", r.status === "exposed" ? `${r.reason}, ${r.attempts.length} hedge tx` : "hedged?!");
  check("c: the 100 A is still on the solver (unhedged)", exposed.tokenIn - s.before.tokenIn === 100n * S, `A change ${fmt(exposed.tokenIn - s.before.tokenIn)}`);
  const ex = exec.exposures[0];
  console.log(`    exposure ledger: ${ex ? `${ex.id} token ${ex.token.slice(0, 12)}... amount ${fmt(ex.amount)} mark ${fmt(ex.markValueOut)} C (stale ${ex.markStale}) reason ${ex.reason} at ${new Date(ex.atMs).toISOString()} attempts ${ex.attempts}` : "EMPTY"}`);
  check("c: exposure recorded (token, amount, mark, reason, timestamp)", !!ex && ex.amount === 100n * S && ex.markValueOut > 0n && ex.reason === "loss_bound_exceeded" && ex.atMs > 0, ex ? "recorded" : "missing");

  // The breaker: a following, otherwise profitable order is refused with the breaker reason, before any quote, simulation or signature.
  const seqBefore = (await retry("getAccount", () => server.getAccount(solver.publicKey()))).sequenceNumber();
  const g = guardedEvaluate(exec, () => ({ action: "skip", reasons: [] }));
  console.log(`    next order (100 A for min 90 C): ${g.action === "refuse" ? `REFUSED: ${g.detail}` : `not refused: ${JSON.stringify(g)}`}`);
  const seqAfter = (await retry("getAccount", () => server.getAccount(solver.publicKey()))).sequenceNumber();
  check("c: breaker tripped and the next order was refused with the breaker reason, no transaction sent", g.action === "refuse" && g.reason === "circuit_breaker" && seqBefore === seqAfter, `solver sequence ${seqBefore} -> ${seqAfter}`);

  // Still bad: a retry does not dump.
  const again = await exec.retryExposure();
  console.log(`    retryExposure while the book is still bad: ${again?.status === "exposed" ? `EXPOSED (${again.reason}): ${again.detail}` : JSON.stringify(again?.status)}`);
  check("c: retryExposure while the market is still bad refuses again and sends nothing", again?.status === "exposed" && again.attempts.length === 0 && !exec.canFill().ok, again?.status === "exposed" ? again.reason : "hedged?!");

  // The book disappears entirely.
  s.moveTx.push(await setBook([]));
  console.log(`  maker cancels every offer (book gone): ${s.moveTx[2]}`);
  await waitHorizon(s.order, []);
  const gone = await exec.retryExposure();
  console.log(`    retryExposure with no book: ${gone?.status === "exposed" ? `EXPOSED (${gone.reason}), mark stale ${exec.exposures[0]?.markStale}` : JSON.stringify(gone?.status)}`);
  check("c: with no book at all there is no path, still no dump, mark flagged stale", gone?.status === "exposed" && gone.reason === "no_path" && exec.exposures[0]?.markStale === true, gone?.status === "exposed" ? gone.reason : "hedged?!");

  // The maker restores liquidity.
  s.moveTx.push(await setBook(INITIAL));
  console.log(`  maker restores the base book: ${s.moveTx[3]}`);
  await waitHorizon(s.order, INITIAL);
  const healed = await exec.retryExposure();
  if (healed) printResult(healed);
  check("c: after liquidity returns, retryExposure hedged the position and cleared the exposure and the breaker", healed?.status === "hedged" && exec.exposures.length === 0 && exec.canFill().ok, healed?.status ?? "none");
  const { pnl } = await finish("c", s, healed ?? r, [...attemptsOf(r), "retry:" + (healed ? attemptsOf(healed).join(",") : "-")], bound, "exposed, breaker tripped, later recovered via retryExposure");
  check("c: no A left over after the recovery", pnl.deltaIn === 0n, `A change ${fmt(pnl.deltaIn)}`);
  console.log("    NOTE: the recovery here was lucky in that the maker restored the SAME price; the exposure sat unhedged and exposed to the market for the whole interval.");
}

// d: the hedge lands but its response is lost -> unknown -> settled from the chain, never re-sent.
{
  const s = await startScenario("d (hedge lands, response lost: UNKNOWN status)");
  const submitsBefore = submitCount;
  dropNextResponse = true;
  const r = await exec.hedgeFill(s.record);
  printResult(r);
  const { pnl } = await finish("d", s, r, attemptsOf(r), (BigInt(LOSS_BPS) * s.quoted.quote.amountOut) / 10_000n, "unknown -> found on chain, not re-sent");
  check("d: the executor saw UNKNOWN and settled it by tx hash: hedged, exactly ONE hedge transaction was submitted", r.status === "hedged" && r.attempts.length === 1 && r.attempts[0]!.result.status === "unknown" && submitCount - submitsBefore === 1, `submissions ${submitCount - submitsBefore}`);
  check("d: no A left over (the one hedge did sell it), no exposure", pnl.deltaIn === 0n && exec.exposures.length === 0, `A change ${fmt(pnl.deltaIn)}`);
  console.log("    NOTE: the lost response is injected in this client; the transaction and the chain are real. A genuinely hung RPC was not reproduced.");
}

// --- The table.
console.log("\n==================================== summary ====================================");
for (const r of rows) {
  console.log(`\n${r.name}`);
  console.log(`  result      : ${r.result}`);
  console.log(`  fill tx     : ${r.fillTx}`);
  console.log(`  book moves  : ${r.moveTx.map(short).join(", ")}   hedge attempts: ${r.attempts.join(" ") || "-"}`);
  console.log(`  A  before/after : ${fmt(r.before.tokenIn)} / ${fmt(r.after.tokenIn)}   C: ${fmt(r.before.tokenOut)} / ${fmt(r.after.tokenOut)}   XLM: ${fmt(r.before.xlm)} / ${fmt(r.after.xlm)}`);
  console.log(`  P&L expected ${signed(r.expected)} C  realised ${signed(r.realised)} C  (max acceptable loss ${r.bound} C)`);
}
console.log("\n scenario                                    | fill     | hedge attempts          | expected C | realised C | loss bound | result");
for (const r of rows) console.log(` ${r.name.slice(0, 44).padEnd(44)}| ${short(r.fillTx).padEnd(9)}| ${r.attempts.join(" ").slice(0, 24).padEnd(24)}| ${signed(r.expected).padStart(10)} | ${signed(r.realised).padStart(10)} | ${r.bound.padStart(10)} | ${r.result}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
