/**
 * TESTNET ONLY. Proves the settlement design on a real network with throwaway keys:
 *   - the USER only ever signs a Soroban auth entry (what a wallet's signAuthEntry produces), never a transaction;
 *   - a separate SOLVER account builds, signs and pays for the transaction that fills the order;
 *   - the user's input and output are both Stellar Asset Contract movements of Classic assets, in one invocation;
 *   - the user has NO trustline for the output asset beforehand: `trust` (CAP-0073) creates it inside the fill.
 *
 * Keys are generated in memory, funded by friendbot and never written anywhere. Never run this against mainnet.
 * Build the contract first:  cd contracts && stellar contract build --manifest-path settle/Cargo.toml
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w1:settle-testnet
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { preferIpv4, simulateView } from "../packages/core/src/index.js";
import {
  Account, Address, Asset, authorizeEntry, BASE_FEE, Keypair, Networks, nativeToScVal, Operation, rpc, scValToNative, Transaction, TransactionBuilder, xdr,
} from "../packages/core/node_modules/@stellar/stellar-sdk/lib/index.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const PASS = Networks.TESTNET;
if (PASS !== "Test SDF Network ; September 2015") throw new Error("testnet only");
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const WASM = fileURLToPath(new URL("../contracts/target/wasm32v1-none/release/sluice_settle.wasm", import.meta.url));
const server = new rpc.Server(RPC);
const STROOPS = 10_000_000n;

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(hash: string): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < 60; i++) {
    const r = await server.getTransaction(hash);
    if (r.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return r;
    await sleep(1500);
  }
  throw new Error(`transaction ${hash} did not appear in a ledger`);
}

/** Build, (simulate for Soroban), sign with `signers`, send, wait. Throws if the transaction does not succeed. */
async function run(source: Keypair, ops: xdr.Operation[], soroban: boolean, signers: Keypair[] = [source]) {
  const account = await server.getAccount(source.publicKey());
  let b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS });
  for (const op of ops) b = b.addOperation(op);
  let tx = b.setTimeout(120).build();
  if (soroban) tx = await server.prepareTransaction(tx);
  for (const s of signers) tx.sign(s);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${sent.errorResult?.toXDR("base64")}`);
  const done = await waitFor(sent.hash);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ${done.status}`);
  return { hash: sent.hash, done };
}

const horizonBalance = async (g: string, a: Asset): Promise<string> => {
  const acc = (await (await fetch(`${HORIZON}/accounts/${g}`)).json()) as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
  return acc.balances.find((x) => x.asset_code === a.getCode() && x.asset_issuer === a.getIssuer())?.balance ?? "none";
};

// --- Parties. Three throwaway accounts; the user never sends a transaction after setup.
const issuer = Keypair.random();
const user = Keypair.random();
const solver = Keypair.random();
for (const kp of [issuer, user, solver]) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
}
console.log(`issuer ${issuer.publicKey()}\nuser   ${user.publicKey()}\nsolver ${solver.publicKey()}`);

// Two Classic assets. A is what the user sells, C is what the user buys.
const A = new Asset("SLFA", issuer.publicKey());
const C = new Asset("SLFC", issuer.publicKey());
await run(user, [Operation.changeTrust({ asset: A })], false); // the user trusts A only: NO trustline for C
await run(solver, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })], false);
await run(issuer, [
  Operation.payment({ destination: user.publicKey(), asset: A, amount: "1000" }),
  Operation.payment({ destination: solver.publicKey(), asset: C, amount: "1000" }),
], false);
for (const asset of [A, C]) await run(solver, [Operation.createStellarAssetContract({ asset })], true);
const sacA = A.contractId(PASS);
const sacC = C.contractId(PASS);
check("setup: user holds A and has no C trustline", (await horizonBalance(user.publicKey(), A)) === "1000.0000000" && (await horizonBalance(user.publicKey(), C)) === "none", `A ${await horizonBalance(user.publicKey(), A)}, C ${await horizonBalance(user.publicKey(), C)}`);

// --- Deploy the settlement contract.
const wasm = readFileSync(WASM);
const wasmHash = createHash("sha256").update(wasm).digest();
await run(solver, [Operation.uploadContractWasm({ wasm })], true);
const deployed = await run(solver, [Operation.createCustomContract({ address: new Address(solver.publicKey()), wasmHash, salt: Keypair.random().rawPublicKey() })], true);
const settleId = Address.fromScVal(deployed.done.returnValue!).toString();
console.log(`settle ${settleId}  (wasm ${wasmHash.toString("hex").slice(0, 16)}…, ${wasm.length} bytes)`);

// --- The order. A struct `Order` is a Soroban map with its symbol keys in sorted order.
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const orderScVal = (o: { amountIn: bigint; minOut: bigint; deadline: number; createTrustline: boolean }) =>
  xdr.ScVal.scvMap([
    entry("amount_in", i128(o.amountIn)),
    entry("create_trustline", xdr.ScVal.scvBool(o.createTrustline)),
    entry("deadline", nativeToScVal(BigInt(o.deadline), { type: "u64" })),
    entry("min_out", i128(o.minOut)),
    entry("token_in", new Address(sacA).toScVal()),
    entry("token_out", new Address(sacC).toScVal()),
    entry("user", new Address(user.publicKey()).toScVal()),
  ]);

const nowSec = Math.floor(Date.now() / 1000);
const order = { amountIn: 100n * STROOPS, minOut: 90n * STROOPS, deadline: nowSec + 900, createTrustline: true };
const fillOp = (o: typeof order, amountOut: bigint) =>
  Operation.invokeContractFunction({ contract: settleId, function: "fill", args: [orderScVal(o), new Address(solver.publicKey()).toScVal(), i128(amountOut)] });

const describe = (inv: xdr.SorobanAuthorizedInvocation, depth = 0): string[] => {
  const f = inv.function().contractFn();
  const lines = [`${"  ".repeat(depth)}${Address.fromScAddress(f.contractAddress()).toString().slice(0, 8)}…  ${f.functionName().toString()}`];
  for (const sub of inv.subInvocations()) lines.push(...describe(sub, depth + 1));
  return lines;
};

async function solverTx(o: typeof order, amountOut: bigint, auth?: xdr.SorobanAuthorizationEntry[]): Promise<Transaction> {
  const account = await server.getAccount(solver.publicKey());
  let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS }).addOperation(fillOp(o, amountOut)).setTimeout(300).build();
  if (!auth) return tx;
  const env = tx.toEnvelope();
  env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth(auth);
  return new Transaction(env, PASS);
}

// 1. The solver simulates the fill to learn what the user must authorize. The user has not been asked anything yet.
const recorded = await server.simulateTransaction(await solverTx(order, 95n * STROOPS));
if (rpc.Api.isSimulationError(recorded)) throw new Error(`recording simulation failed: ${recorded.error}`);
const userEntry = recorded.result!.auth.find((e) => e.credentials().switch().name === "sorobanCredentialsAddress");
if (!userEntry) throw new Error("simulation asked for no user authorization");
const tree = describe(userEntry.rootInvocation());
console.log("what the user is asked to sign:\n  " + tree.join("\n  "));
check("the user's signed tree is exactly: fill, then trust and the input transfer", tree.length === 3 && tree[0]!.endsWith("fill") && tree[1]!.endsWith("trust") && tree[2]!.endsWith("transfer"), tree.map((l) => l.trim().split("  ")[1]).join(" > "));

// 2. The user signs that entry offline. No transaction, no fee, no sequence number: this is signAuthEntry.
const latest = await server.getLatestLedger();
const signedUser = await authorizeEntry(userEntry, user, latest.sequence + 100, PASS);
const userSeqBefore = (await server.getAccount(user.publicKey())).sequenceNumber();

// 3. The solver attaches the signed entry, simulates again (enforcing, so the signature is really checked), and submits.
const signedAuth = recorded.result!.auth.map((e) => (e === userEntry ? signedUser : e));
const enforced = await server.simulateTransaction(await solverTx(order, 95n * STROOPS, signedAuth));
check("enforcing simulation accepts the user's signature", !rpc.Api.isSimulationError(enforced), rpc.Api.isSimulationError(enforced) ? enforced.error : "ok");

// 3a. Negative, on chain: the same signature must not authorize a different order (min_out lowered to 1).
{
  const weaker = { ...order, minOut: 1n };
  const sim = await server.simulateTransaction(await solverTx(weaker, 1n, signedAuth));
  check("the signature does not cover a different order (lower min_out)", rpc.Api.isSimulationError(sim), rpc.Api.isSimulationError(sim) ? sim.error.slice(0, 140) : "WRONGLY ACCEPTED");
}
// 3b. Negative: paying under min_out is refused by the contract itself.
{
  const sim = await server.simulateTransaction(await solverTx(order, 89n * STROOPS, signedAuth));
  check("paying under min_out is refused", rpc.Api.isSimulationError(sim), rpc.Api.isSimulationError(sim) ? sim.error.slice(0, 140) : "WRONGLY ACCEPTED");
}

if (rpc.Api.isSimulationError(enforced)) throw new Error("cannot continue: enforcing simulation failed");
const prepared = rpc.assembleTransaction(await solverTx(order, 95n * STROOPS, signedAuth), enforced).build();
prepared.sign(solver);
const sent = await server.sendTransaction(prepared);
if (sent.status === "ERROR") throw new Error(`send failed: ${sent.errorResult?.toXDR("base64")}`);
const done = await waitFor(sent.hash);
check("fill settles", done.status === rpc.Api.GetTransactionStatus.SUCCESS, `${done.status} ledger ${"ledger" in done ? done.ledger : "?"} ${sent.hash}`);
if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) process.exit(1);

// 4. What actually happened.
const returned = scValToNative(done.returnValue!) as bigint;
const [uA, uC, sA, sC] = await Promise.all([
  horizonBalance(user.publicKey(), A), horizonBalance(user.publicKey(), C), horizonBalance(solver.publicKey(), A), horizonBalance(solver.publicKey(), C),
]);
check("user paid exactly amount_in of A", uA === "900.0000000", `user A ${uA}`);
check("user received the output and the trustline was created in the same transaction", uC === "95.0000000", `user C ${uC} (had no C trustline before)`);
check("the return value equals the measured balance change", returned === 95n * STROOPS, `${returned} stroops`);
check("the solver took the input and paid the output", sA === "100.0000000" && sC === "905.0000000", `solver A ${sA}, C ${sC}`);
const [heldA, heldC] = await Promise.all(
  [sacA, sacC].map(async (t) => (await simulateView(RPC, t, "balance", [new Address(settleId).toScVal()], { passphrase: PASS })) as bigint),
);
check("the settlement contract keeps nothing", heldA === 0n && heldC === 0n, `contract holds A ${heldA}, C ${heldC}`);
const userSeqAfter = (await server.getAccount(user.publicKey())).sequenceNumber();
check("the user sent no transaction and paid no fee", userSeqBefore === userSeqAfter, `sequence ${userSeqBefore} before and after`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
