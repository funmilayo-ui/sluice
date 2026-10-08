/**
 * TESTNET ONLY. A real end-to-end swap: Sluice router contract -> real Soroswap testnet pool, submitted and settled.
 * Uses a throwaway faucet-funded testnet key passed in SECRET. Never run this against mainnet.
 * Env: ROUTER, SECRET, ROUTER_VENUE (Soroswap testnet router), TOKEN_OUT (a token paired with XLM in that router).
 */
import {
  Address, buildSluiceRouterSwap, Keypair, rpc, TransactionBuilder, Networks, nativeToScVal, preferIpv4, prepare, sacId, simulateView, scValToNative, xdr,
} from "../packages/core/src/index.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const PASS = Networks.TESTNET;
if (PASS !== "Test SDF Network ; September 2015") throw new Error("testnet only");
const RPC = "https://soroban-testnet.stellar.org";
const { ROUTER, SECRET, ROUTER_VENUE, TOKEN_OUT } = process.env as Record<string, string>;
if (!ROUTER || !SECRET || !ROUTER_VENUE || !TOKEN_OUT) throw new Error("set ROUTER, SECRET, ROUTER_VENUE, TOKEN_OUT");

const kp = Keypair.fromSecret(SECRET);
const user = kp.publicKey();
const xlm = sacId("native", PASS);
const amountIn = 10_000_000n; // 1 XLM
const o = { passphrase: PASS };
const bal = async (t: string) => (await simulateView(RPC, t, "balance", [new Address(user).toScVal()], o)) as bigint;

const amounts = (await simulateView(RPC, ROUTER_VENUE, "router_get_amounts_out", [
  nativeToScVal(amountIn, { type: "i128" }), xdr.ScVal.scvVec([new Address(xlm).toScVal(), new Address(TOKEN_OUT).toScVal()]),
], o)) as bigint[];
const quote = amounts[amounts.length - 1]!;
const ROUNDTRIP = process.env.ROUNDTRIP === "1";
// Round trip: XLM -> token -> XLM in ONE invocation. Fees make it lose a little, so the final floor is 95% of input.
const minOut = ROUNDTRIP ? (amountIn * 9500n) / 10_000n : (quote * 9900n) / 10_000n;
console.log(`quote: 1 XLM -> ${quote} base units of token out; minOut ${minOut}`);

const before = await bal(TOKEN_OUT);
const seq = ((await (await fetch(`https://horizon-testnet.stellar.org/accounts/${user}`)).json()) as { sequence: string }).sequence;
const built = buildSluiceRouterSwap({
  source: user, sequence: seq, passphrase: PASS, routerContract: ROUTER,
  legs: ROUNDTRIP
    ? [{ kind: "Soroswap", venue: ROUTER_VENUE, path: [xlm, TOKEN_OUT] }, { kind: "Soroswap", venue: ROUTER_VENUE, path: [TOKEN_OUT, xlm] }]
    : [{ kind: "Soroswap", venue: ROUTER_VENUE, path: [xlm, TOKEN_OUT] }],
  amountIn, minOut, deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
});
const p = await prepare(RPC, built, PASS);
console.log("simulated return:", scValToNative(xdr.ScVal.fromXDR(p.returnValue!, "base64")), "resource fee", p.minResourceFee);

const tx = TransactionBuilder.fromXDR(p.xdr, PASS);
tx.sign(kp);
const server = new rpc.Server(RPC);
const sent = await server.sendTransaction(tx);
console.log("submitted:", sent.status, sent.hash);
let res = await server.getTransaction(sent.hash);
for (let i = 0; i < 20 && res.status === "NOT_FOUND"; i++) { await new Promise((r) => setTimeout(r, 2000)); res = await server.getTransaction(sent.hash); }
console.log("result:", res.status);
if (res.status !== "SUCCESS") { process.exitCode = 1; throw new Error("tx did not succeed"); }
const after = await bal(TOKEN_OUT);
console.log(`token out balance: ${before} -> ${after} (delta ${after - before}); quote was ${quote}${ROUNDTRIP ? " (round trip: delta should be 0, XLM net slightly lower)" : ""}`);
// The contract is non-custodial: check it holds neither token after the swap.
for (const t of [xlm, TOKEN_OUT]) {
  const held = (await simulateView(RPC, t, "balance", [new Address(ROUTER).toScVal()], o)) as bigint;
  console.log(`router contract balance of ${t.slice(0, 6)}: ${held}`);
  if (held !== 0n) process.exitCode = 1;
}
