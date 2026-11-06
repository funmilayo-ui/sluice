/**
 * TESTNET ONLY. The reference solver end to end, with real Classic liquidity to hedge against.
 *
 * Parties (throwaway keys, generated in memory, funded by friendbot, never written anywhere):
 *   issuer  issues SLFA (A, what the user sells) and SLFC (C, what the user buys)
 *   maker   a market maker with resting SDEX offers that SELL C for A. This is the Classic liquidity the solver hedges into.
 *   user    holds A, has NO C trustline, and only ever signs a Soroban auth entry for `fill(order)`
 *   solver  evaluates each open order against a REAL Horizon path quote, fills the profitable one through the
 *           settle contract, then sells the A it received on the Classic DEX (path payment) and reports P&L
 *
 * Three orders are offered to the solver:
 *   1. profitable:    min_out well under what the hedge returns            -> fill, hedge, realised P&L
 *   2. unprofitable:  min_out above what the Classic book pays for the A    -> SKIP (a fill would lose money)
 *   3. too deep:      bigger than the market maker's resting depth          -> SKIP (no hedge path exists)
 * Only order 1 reaches the chain. Orders 2 and 3 never get a signature or a transaction.
 *
 * Fees are paid in XLM, which is neither A nor C. The decision converts them at an ASSUMED rate (there is no
 * XLM/C market on testnet), and the report keeps the measured XLM fee separate so nothing is hidden by the rate.
 *
 * Build the contract first:  cd contracts && stellar contract build --manifest-path settle/Cargo.toml
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w2:solver-testnet
 * Env (optional): IMPROVEMENT_BPS (default 5000), MIN_PROFIT_BPS (default 20), HEDGE_SLIPPAGE_BPS (default 50).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatAmount, parseAmount, preferIpv4, simulateView } from "../packages/core/src/index.js";
import {
  buildHedgeTx, encodeOrder, evaluateFill, feeToOut, quoteHedge, realisedPnl, resolveClassicAssets,
  type Decision, type Inventory, type Order, type QuotedHedge, type SolverParams,
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
const ASSUMED_C_PER_XLM = "0.1"; // no XLM/C market exists on testnet; the fee is tiny either way, and the XLM actually paid is reported separately

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (v: bigint) => formatAmount(v);

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

/** Build, (simulate for Soroban), sign with `signers`, send, wait. Throws if the transaction does not succeed. */
async function run(source: Keypair, ops: xdr.Operation[], soroban: boolean, signers: Keypair[] = [source]) {
  const account = await retry("getAccount", () => server.getAccount(source.publicKey()));
  let b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS });
  for (const op of ops) b = b.addOperation(op);
  let tx = b.setTimeout(180).build();
  if (soroban) tx = await retry("prepareTransaction", () => server.prepareTransaction(tx));
  for (const s of signers) tx.sign(s);
  return send(tx);
}

interface HorizonAccount { balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[] }
const account = (g: string) => retry("horizon account", async () => {
  const r = await timedFetch(`${HORIZON}/accounts/${g}`);
  if (!r.ok) throw new Error(`horizon ${r.status}`);
  return (await r.json()) as HorizonAccount;
});
const bal = async (g: string, a: Asset | "native"): Promise<bigint | null> => {
  const acc = await account(g);
  const hit = acc.balances.find((x) => (a === "native" ? x.asset_type === "native" : x.asset_code === a.getCode() && x.asset_issuer === a.getIssuer()));
  return hit ? parseAmount(hit.balance) : null;
};

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

await run(user, [Operation.changeTrust({ asset: A })], false); // user trusts A only: NO trustline for C
await run(solver, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(maker, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(issuer, [
  Operation.payment({ destination: user.publicKey(), asset: A, amount: "1000" }),
  Operation.payment({ destination: solver.publicKey(), asset: C, amount: "1000" }),
  Operation.payment({ destination: maker.publicKey(), asset: C, amount: "1000" }),
], false);

// The Classic liquidity. The maker SELLS C for A in two tiers (price = A per C), so a hedge walks a real book:
//   60 C at 1.03 A each, then up to 200 C at 1.05 A each. Total depth 271.8 A.
await run(maker, [
  Operation.manageSellOffer({ selling: C, buying: A, amount: "60", price: "1.03" }),
  Operation.manageSellOffer({ selling: C, buying: A, amount: "200", price: "1.05" }),
], false);
console.log("maker offers: sell 60 C @ 1.03 A, sell 200 C @ 1.05 A  (depth 271.8 A)");

for (const asset of [A, C]) await run(solver, [Operation.createStellarAssetContract({ asset })], true);
const sacA = A.contractId(PASS);
const sacC = C.contractId(PASS);

const wasm = readFileSync(WASM);
const wasmHash = createHash("sha256").update(wasm).digest();
await run(solver, [Operation.uploadContractWasm({ wasm })], true);
const deployed = await run(solver, [Operation.createCustomContract({ address: new Address(solver.publicKey()), wasmHash, salt: Keypair.random().rawPublicKey() })], true);
const settleId = Address.fromScVal(deployed.done.returnValue!).toString();
console.log(`settle ${settleId}  (${wasm.length} bytes)`);

// --- Solver inventory BEFORE anything is filled (setup and deployment fees are already paid).
const snapshot = async (): Promise<Inventory & { xlm: bigint }> => ({
  tokenIn: (await bal(solver.publicKey(), A)) ?? 0n,
  tokenOut: (await bal(solver.publicKey(), C)) ?? 0n,
  xlm: (await bal(solver.publicKey(), "native")) ?? 0n,
});
const before = await snapshot();
console.log(`solver inventory before: A ${fmt(before.tokenIn)}, C ${fmt(before.tokenOut)}, XLM ${fmt(before.xlm)}`);

// --- Solver policy.
const policy = {
  minDeadlineBufferSec: 120,
  maxOrderIn: 1000n * S,
  hedgeSlippageBps: Number(process.env.HEDGE_SLIPPAGE_BPS ?? 50),
  minProfitBps: Number(process.env.MIN_PROFIT_BPS ?? 20),
  improvementShareBps: Number(process.env.IMPROVEMENT_BPS ?? 5000),
};
console.log(`policy: ${JSON.stringify({ ...policy, maxOrderIn: fmt(policy.maxOrderIn) })}, fees converted at ${ASSUMED_C_PER_XLM} C per XLM (assumed)`);

const nowSec = Math.floor(Date.now() / 1000);
const mk = (amountIn: bigint, minOut: bigint): Order => ({
  user: user.publicKey(), tokenIn: sacA, amountIn, tokenOut: sacC, minOut, deadline: nowSec + 900, createTrustline: true,
});
const orders: { name: string; order: Order; expect: "fill" | "skip" }[] = [
  { name: "1 profitable (100 A, min_out 90 C)", order: mk(100n * S, 90n * S), expect: "fill" },
  { name: "2 unprofitable (100 A, min_out 99 C)", order: mk(100n * S, 99n * S), expect: "skip" },
  { name: "3 too deep (500 A, min_out 480 C)", order: mk(500n * S, 480n * S), expect: "skip" },
];

const fillOp = (o: Order, amountOut: bigint) =>
  Operation.invokeContractFunction({ contract: settleId, function: "fill", args: [encodeOrder(o), new Address(solver.publicKey()).toScVal(), nativeToScVal(amountOut, { type: "i128" })] });

async function solverTx(o: Order, amountOut: bigint, auth?: xdr.SorobanAuthorizationEntry[]): Promise<Transaction> {
  const acc = await retry("getAccount", () => server.getAccount(solver.publicKey()));
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASS }).addOperation(fillOp(o, amountOut)).setTimeout(300).build();
  if (!auth) return tx;
  const env = tx.toEnvelope();
  env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth(auth);
  return new Transaction(env, PASS);
}

interface Evaluated {
  name: string;
  order: Order;
  decision: Decision;
  quoted: QuotedHedge | null;
  feeOut: bigint;
}

async function evaluate(name: string, order: Order, firstQuote: boolean): Promise<Evaluated> {
  // The solver prices its own cost first: a recording simulation tells it the fill's resource fee. No user signature needed.
  const sim = await retry("simulate", () => solverTx(order, order.minOut).then((t) => server.simulateTransaction(t)));
  if (rpc.Api.isSimulationError(sim)) throw new Error(`recording simulation failed: ${sim.error}`);
  const feeStroops = BigInt(sim.minResourceFee) + BigInt(BASE_FEE) /* inclusion */ + BigInt(BASE_FEE) /* the hedge payment */;
  const feeOut = feeToOut(feeStroops, ASSUMED_C_PER_XLM);

  const pair = resolveClassicAssets(order, [idA, idC], PASS);
  let quoted: QuotedHedge | null = null;
  if (pair) {
    // Horizon ingests new offers a few ledgers late: for the first order keep asking until the book is visible.
    for (let i = 0; i < (firstQuote ? 15 : 2); i++) {
      quoted = await retry("horizon path", () => quoteHedge(order, pair, HORIZON, Date.now(), timedFetch));
      if (quoted) break;
      await sleep(3000);
    }
  }
  const p: SolverParams = { ...policy, nowMs: Date.now(), solverBalanceOut: (await bal(solver.publicKey(), C)) ?? 0n, networkFeeOut: feeOut, maxQuoteAgeSec: 60 };
  const decision = evaluateFill(order, quoted?.quote ?? null, p);

  console.log(`\norder ${name}`);
  console.log(`  hedge quote (Horizon strict-send, ${fmt(order.amountIn)} A -> C): ${quoted ? `${fmt(quoted.quote.amountOut)} C via ${quoted.leg.hops.length} hop(s)` : "none"}`);
  console.log(`  est. fees ${fmt(feeStroops)} XLM = ${fmt(feeOut)} C at the assumed rate`);
  if (decision.action === "fill") {
    console.log(`  DECISION fill: pay ${fmt(decision.amountOut)} C (min_out ${fmt(order.minOut)}, user improvement ${fmt(decision.userImprovement)} C)`);
    console.log(`    predicted profit ${fmt(decision.expectedProfitOut)} C (${decision.expectedProfitBps} bps), worst case with buffer ${fmt(decision.worstCaseProfitOut)} C, hedge destMin ${fmt(decision.hedgeMinOut)} C`);
  } else {
    console.log(`  DECISION skip: ${decision.reasons.join(", ")}${decision.maxPayableOut !== undefined ? `; most it could pay and still clear the profit floor: ${fmt(decision.maxPayableOut)} C` : ""}`);
    if (quoted && quoted.quote.amountOut < order.minOut) console.log(`    (filling anyway would have lost ${fmt(order.minOut - quoted.quote.amountOut)} C before fees)`);
  }
  return { name, order, decision, quoted, feeOut };
}

const results: Evaluated[] = [];
for (const [i, o] of orders.entries()) results.push(await evaluate(o.name, o.order, i === 0));

for (const [i, r] of results.entries()) {
  const want = orders[i]!.expect;
  check(`order ${r.name} -> ${want}`, r.decision.action === want, r.decision.action === "fill" ? "fill" : `skip [${r.decision.reasons.join(", ")}]`);
}
const skip2 = results[1]!.decision;
check("the unprofitable order is skipped because the hedge pays less than min_out", skip2.action === "skip" && skip2.reasons.includes("hedge_below_amount_out"), skip2.action === "skip" ? skip2.reasons.join(", ") : "filled");
const skip3 = results[2]!.decision;
check("the order deeper than the book is skipped for want of a hedge path", skip3.action === "skip" && skip3.reasons.includes("no_hedge_quote"), skip3.action === "skip" ? skip3.reasons.join(", ") : "filled");

// --- Fill order 1.
const chosen = results[0]!;
if (chosen.decision.action !== "fill" || !chosen.quoted) {
  console.log("\nnothing to fill; stopping");
  process.exit(1);
}
const { order, decision, quoted } = { order: chosen.order, decision: chosen.decision, quoted: chosen.quoted };

// Re-record at the real amount_out, then have the user sign the auth entry (signAuthEntry); no transaction from the user.
const rec = await retry("simulate", () => solverTx(order, decision.amountOut).then((t) => server.simulateTransaction(t)));
if (rpc.Api.isSimulationError(rec)) throw new Error(`recording simulation failed: ${rec.error}`);
const userEntry = rec.result!.auth.find((e) => e.credentials().switch().name === "sorobanCredentialsAddress");
if (!userEntry) throw new Error("simulation asked for no user authorization");
const latest = await retry("latest ledger", () => server.getLatestLedger());
const signedUser = await authorizeEntry(userEntry, user, latest.sequence + 100, PASS);
const userSeqBefore = (await retry("getAccount", () => server.getAccount(user.publicKey()))).sequenceNumber();
const signedAuth = rec.result!.auth.map((e) => (e === userEntry ? signedUser : e));

const enforced = await retry("simulate", () => solverTx(order, decision.amountOut, signedAuth).then((t) => server.simulateTransaction(t)));
check("enforcing simulation accepts the user's signature at the solver's amount_out", !rpc.Api.isSimulationError(enforced), rpc.Api.isSimulationError(enforced) ? enforced.error : "ok");
if (rpc.Api.isSimulationError(enforced)) process.exit(1);
const fillTx = rpc.assembleTransaction(await solverTx(order, decision.amountOut, signedAuth), enforced).build();
fillTx.sign(solver);
const fill = await send(fillTx);
console.log(`\nfill settled: ledger ${"ledger" in fill.done ? fill.done.ledger : "?"} ${fill.hash}`);
const returned = scValToNative(fill.done.returnValue!) as bigint;

const afterFill = await snapshot();
check("the user received amount_out (return value = measured balance change)", returned === decision.amountOut, `${fmt(returned)} C`);
console.log(`solver inventory after fill, before hedge: A ${fmt(afterFill.tokenIn)}, C ${fmt(afterFill.tokenOut)}  (exposed: it holds ${fmt(afterFill.tokenIn - before.tokenIn)} A it has not sold yet)`);

// --- The hedge: sell the A the solver just received on the Classic DEX, protected by the buffered minimum.
const acc = await retry("getAccount", () => server.getAccount(solver.publicKey()));
const hedgeXdr = buildHedgeTx(quoted.leg, { source: solver.publicKey(), sequence: acc.sequenceNumber(), minOut: decision.hedgeMinOut, passphrase: PASS });
const hedgeTx = TransactionBuilder.fromXDR(hedgeXdr, PASS) as Transaction;
hedgeTx.sign(solver);
const hedge = await send(hedgeTx);
console.log(`hedge settled: ledger ${"ledger" in hedge.done ? hedge.done.ledger : "?"} ${hedge.hash}`);

// --- What actually happened.
const after = await snapshot();
const userA = await bal(user.publicKey(), A);
const userC = await bal(user.publicKey(), C);
const feeXlmPaid = before.xlm - after.xlm;
const feesPaidOut = feeToOut(feeXlmPaid, ASSUMED_C_PER_XLM);
const hedgeProceeds = after.tokenOut - afterFill.tokenOut;
const mark = { num: quoted.quote.amountOut, den: quoted.quote.amountIn };
const pnl = realisedPnl(before, after, mark, feesPaidOut);
const predictedNet = decision.expectedProfitOut + decision.feesOut - feesPaidOut; // predicted profit, re-based on the fee actually paid

console.log("\n--- realised P&L ------------------------------------------------------------");
console.log(`             before            after fill        after hedge       change`);
const row = (label: string, b: bigint, f: bigint, a: bigint) => console.log(`${label.padEnd(5)} ${fmt(b).padStart(16)} ${fmt(f).padStart(17)} ${fmt(a).padStart(17)} ${fmt(a - b).padStart(14)}`);
row("A", before.tokenIn, afterFill.tokenIn, after.tokenIn);
row("C", before.tokenOut, afterFill.tokenOut, after.tokenOut);
row("XLM", before.xlm, afterFill.xlm, after.xlm);
console.log(`hedge sold ${fmt(order.amountIn)} A for ${fmt(hedgeProceeds)} C (quoted ${fmt(quoted.quote.amountOut)}, destMin ${fmt(decision.hedgeMinOut)})`);
console.log(`in C terms: inventory P&L ${fmt(pnl.inventoryPnlOut)} C (A change ${fmt(pnl.deltaIn)}, C change ${fmt(pnl.deltaOut)}), fees ${fmt(feeXlmPaid)} XLM = ${fmt(feesPaidOut)} C at the assumed rate, net ${fmt(pnl.netPnlOut)} C`);
console.log(`predicted by evaluateFill: ${fmt(decision.expectedProfitOut)} C after estimated fees ${fmt(decision.feesOut)} C (worst case ${fmt(decision.worstCaseProfitOut)} C); re-based on the fee actually paid: ${fmt(predictedNet)} C`);
console.log(`realised minus predicted: ${fmt(pnl.netPnlOut - predictedNet)} C; user improvement over min_out: ${fmt(decision.userImprovement)} C`);
console.log("-----------------------------------------------------------------------------");

check("the user paid exactly amount_in of A", userA === 900n * S, `user A ${userA === null ? "none" : fmt(userA)}`);
check("the user received amount_out and the C trustline was created in the fill", userC === decision.amountOut, `user C ${userC === null ? "none" : fmt(userC)}`);
check("the hedge cleared the whole position (solver holds no extra A)", pnl.deltaIn === 0n, `A change ${fmt(pnl.deltaIn)}`);
check("hedge proceeds equal the Horizon quote (nothing moved in between)", hedgeProceeds === quoted.quote.amountOut, `${fmt(hedgeProceeds)} vs ${fmt(quoted.quote.amountOut)} C`);
check("hedge proceeds respected the slippage buffer", hedgeProceeds >= decision.hedgeMinOut, `${fmt(hedgeProceeds)} >= ${fmt(decision.hedgeMinOut)}`);
check("realised profit is positive and at least the worst case", pnl.netPnlOut > 0n && pnl.netPnlOut >= decision.worstCaseProfitOut - (feesPaidOut > decision.feesOut ? feesPaidOut - decision.feesOut : 0n), `${fmt(pnl.netPnlOut)} C vs worst case ${fmt(decision.worstCaseProfitOut)} C`);
const gap = pnl.netPnlOut - predictedNet;
check("realised P&L matches the prediction up to fee-conversion rounding", (gap < 0n ? -gap : gap) <= 10n, `difference ${gap} stroops`);
const skipNotes = results.slice(1).every((r) => r.decision.action === "skip");
check("skipped orders touched nothing: only the one fill moved inventory", skipNotes && afterFill.tokenOut === before.tokenOut - decision.amountOut, `solver C after fill ${fmt(afterFill.tokenOut)} = ${fmt(before.tokenOut)} - ${fmt(decision.amountOut)}`);
const [heldA, heldC] = await Promise.all([sacA, sacC].map(async (t) => (await retry("view", () => simulateView(RPC, t, "balance", [new Address(settleId).toScVal()], { passphrase: PASS }))) as bigint));
check("the settlement contract keeps nothing", heldA === 0n && heldC === 0n, `contract holds A ${heldA}, C ${heldC}`);
const userSeqAfter = (await retry("getAccount", () => server.getAccount(user.publicKey()))).sequenceNumber();
check("the user sent no transaction and paid no fee", userSeqBefore === userSeqAfter, `sequence ${userSeqBefore} before and after`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
