/**
 * TESTNET ONLY. Settles real transactions through the exact core functions the API runs after a wallet has
 * signed: parseSignedTx, submitTx (Stellar RPC sendTransaction), getTxStatus, receivedAmount, explainCodes.
 * Mainnet execution needs a user's wallet; this proves the same code path against a real network without one.
 *
 * Keys are generated in memory, funded by friendbot and never written anywhere. Never run this against mainnet.
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w0:testnet-flow
 * Env (optional): SOROSWAP_ROUTER, SOROSWAP_TOKEN_OUT override the Soroswap testnet contracts.
 */
import {
  Account, Address, applyBps, Asset, BASE_FEE, buildChangeTrust, buildClassicSwap, buildSoroswapSwap, explainCodes, formatAmount, getTxStatus,
  horizonSource, Keypair, nativeToScVal, Networks, Operation, parseAmount, parseSignedTx, preferIpv4, prepare, receivedAmount, sacId,
  scValToNative, simulateView, submitTx, TransactionBuilder, xdr, type TxStatus,
} from "../packages/core/src/index.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const PASS = Networks.TESTNET;
if (PASS !== "Test SDF Network ; September 2015") throw new Error("testnet only");
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
// From soroswap/core public/testnet.contracts.json and tokens.json (read 2026-10-08).
const ROUTER = process.env.SOROSWAP_ROUTER ?? "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const TOKEN_CANDIDATES = (process.env.SOROSWAP_TOKEN_OUT ?? "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F,CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2,CDBCM2JWK2ERIE6EAVAZJJW3P25U5S3FLNHJDY72AVSVAVTU4E6NAQ43").split(",");

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}

const sequence = async (account: string) => ((await (await fetch(`${HORIZON}/accounts/${account}`)).json()) as { sequence: string }).sequence;
const balance = async (account: string, code: string) => {
  const a = (await (await fetch(`${HORIZON}/accounts/${account}`)).json()) as { balances: { asset_code?: string; asset_type: string; balance: string }[] };
  return a.balances.find((b) => (code === "XLM" ? b.asset_type === "native" : b.asset_code === code))?.balance ?? "0";
};

/** Sign with the throwaway key, then go through the same checks and calls as POST /v1/submit and GET /v1/tx. */
async function signAndSettle(unsignedXdr: string, kp: Keypair): Promise<{ status: TxStatus; submitCodes?: string[] }> {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, PASS);
  tx.sign(kp);
  const signed = tx.toXDR();
  parseSignedTx(signed, PASS); // what /v1/submit enforces before relaying
  const sent = await submitTx(RPC, signed, PASS);
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") return { status: { hash: sent.hash, status: "NOT_FOUND" }, submitCodes: sent.codes ?? [sent.status] };
  for (let i = 0; i < 40; i++) {
    const status = await getTxStatus(RPC, sent.hash);
    if (status.status !== "NOT_FOUND") return { status };
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`transaction ${sent.hash} did not appear in a ledger`);
}

// --- Setup: two throwaway accounts. `maker` issues a test asset and offers it for XLM; `trader` is the user.
const maker = Keypair.random();
const trader = Keypair.random();
for (const kp of [maker, trader]) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
}
console.log(`trader ${trader.publicKey()}\nmaker  ${maker.publicKey()}`);
const TEST = `SLTEST:${maker.publicKey()}`;

// 1. Trustline, built by the same builder /v1/build uses for the prerequisite step.
{
  const xdrIn = buildChangeTrust(TEST, { source: trader.publicKey(), sequence: await sequence(trader.publicKey()), passphrase: PASS, timeoutSec: 300 });
  const { status } = await signAndSettle(xdrIn, trader);
  check("trustline settles through submitTx/getTxStatus", status.status === "SUCCESS", `${status.status} ${status.hash}`);
  check("a trustline is not reported as a swap", receivedAmount(status) === null, "receivedAmount is null");
}

// 2. Liquidity: the issuer sells SLTEST for XLM at 2 XLM each. (Setup only; not a Sluice builder.)
{
  const tx = new TransactionBuilder(new Account(maker.publicKey(), await sequence(maker.publicKey())), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.manageSellOffer({ selling: new Asset("SLTEST", maker.publicKey()), buying: Asset.native(), amount: "1000", price: "2" }))
    .setTimeout(300)
    .build();
  const { status } = await signAndSettle(tx.toXDR(), maker);
  if (status.status !== "SUCCESS") throw new Error("could not place the test offer");
}

// 3. Classic swap: quote from Horizon paths, build a path payment, settle, read back what arrived.
const amountIn = parseAmount("10");
const classicLeg = await horizonSource(HORIZON).quote({ assetIn: "native", assetOut: TEST, amountIn });
if (!classicLeg) throw new Error("no classic path on testnet for the test asset");
{
  const minOut = applyBps(classicLeg.amountOut, 50);
  const before = await balance(trader.publicKey(), "SLTEST");
  const xdrIn = buildClassicSwap(classicLeg, { source: trader.publicKey(), sequence: await sequence(trader.publicKey()), minOut, passphrase: PASS, timeoutSec: 300 });
  const { status } = await signAndSettle(xdrIn, trader);
  const got = receivedAmount(status);
  const after = await balance(trader.publicKey(), "SLTEST");
  const delta = parseAmount(after) - parseAmount(before);
  check("classic swap settles", status.status === "SUCCESS", `${status.status} ledger ${status.ledger} ${status.hash}`);
  check("received amount read from the result equals the balance change", got?.kind === "classic" && got.amount === delta, `received ${got ? formatAmount(got.amount) : "null"}, balance moved ${formatAmount(delta)}`);
  check("received amount equals the quote", got?.amount === classicLeg.amountOut, `quote ${formatAmount(classicLeg.amountOut)}`);
}

// 4. A swap whose minimum cannot be met fails on chain, and the failure is explained.
{
  const xdrIn = buildClassicSwap(classicLeg, { source: trader.publicKey(), sequence: await sequence(trader.publicKey()), minOut: classicLeg.amountOut * 2n, passphrase: PASS, timeoutSec: 300 });
  const { status } = await signAndSettle(xdrIn, trader);
  const why = explainCodes(status.codes ?? []);
  check("under-minimum swap fails and is explained as slippage", status.status === "FAILED" && why.code === "SLIPPAGE", `${status.status} [${(status.codes ?? []).join(", ")}] -> ${why.code}`);
  check("a failed swap reports nothing received", receivedAmount(status) === null, "receivedAmount is null");
}

// 5. A transaction built on an old sequence number is rejected at submit, and explained.
{
  const stale = (BigInt(await sequence(trader.publicKey())) - 2n).toString();
  const xdrIn = buildClassicSwap(classicLeg, { source: trader.publicKey(), sequence: stale, minOut: 1n, passphrase: PASS, timeoutSec: 300 });
  const { submitCodes } = await signAndSettle(xdrIn, trader);
  const why = explainCodes(submitCodes ?? []);
  check("stale sequence is rejected at submit and explained", why.code === "STALE_SEQUENCE", `[${(submitCodes ?? []).join(", ")}] -> ${why.code}`);
}

// 6. Soroban swap on Soroswap testnet: simulate with prepare(), settle, decode the contract's return value.
{
  const xlm = sacId("native", PASS);
  const o = { passphrase: PASS };
  const soroIn = parseAmount("5");
  let path: string[] | undefined;
  let quoted = 0n;
  for (const token of TOKEN_CANDIDATES) {
    try {
      const amounts = (await simulateView(RPC, ROUTER, "router_get_amounts_out", [nativeToScVal(soroIn, { type: "i128" }), xdr.ScVal.scvVec([new Address(xlm).toScVal(), new Address(token).toScVal()])], o)) as bigint[];
      if ((amounts.at(-1) ?? 0n) > 0n) {
        path = [xlm, token];
        quoted = amounts.at(-1)!;
        break;
      }
    } catch {
      /* no pool for this token: try the next */
    }
  }
  if (!path) {
    check("soroban swap", false, "no Soroswap testnet pool with XLM found among the candidate tokens");
  } else {
    const tokenOut = path[1]!;
    const bal = async () => (await simulateView(RPC, tokenOut, "balance", [new Address(trader.publicKey()).toScVal()], o)) as bigint;
    const before = await bal();
    const built = buildSoroswapSwap({ source: trader.publicKey(), sequence: await sequence(trader.publicKey()), passphrase: PASS, router: ROUTER, path, amountIn: soroIn, minOut: applyBps(quoted, 100), timeoutSec: 300 });
    const prepared = await prepare(RPC, built, PASS);
    const simulated = (scValToNative(xdr.ScVal.fromXDR(prepared.returnValue!, "base64")) as bigint[]).at(-1);
    const { status } = await signAndSettle(prepared.xdr, trader);
    const got = receivedAmount(status);
    const delta = (await bal()) - before;
    check("soroban swap settles", status.status === "SUCCESS", `${status.status} ledger ${status.ledger} ${status.hash}`);
    check("received amount decoded from the contract return equals the token balance change", got?.kind === "swap_exact_tokens_for_tokens" && got.amount === delta, `received ${got?.amount}, balance moved ${delta}`);
    check("received amount equals the simulated output", got?.amount === simulated, `simulated ${simulated}, quoted ${quoted}`);
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
