/**
 * Read-only proof that the Aquarius execution builder produces a transaction the mainnet RPC accepts.
 * It finds a public account that holds XLM and an AQUA trustline, builds a swap_chained call from the
 * live find-path response, and SIMULATES it. Nothing is signed or submitted.
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w0:aqua-sim [amountXLM]
 */
import {
  scValToNative, xdr, aquariusSource, buildAquariusSwap, formatAmount, parseAmount, prepare, preferIpv4, sacId,
} from "../packages/core/src/index.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const HORIZON = "https://horizon.stellar.org";
const RPC = process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
const AQUA = "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const amountIn = parseAmount(process.argv[2] ?? "10");

const list = await (await fetch(`${HORIZON}/accounts?asset=${encodeURIComponent(AQUA)}&limit=20&order=desc`)).json() as {
  _embedded: { records: { id: string; sequence: string; balances: { asset_type: string; balance: string }[] }[] };
};
const acct = list._embedded.records.find((a) => Number(a.balances.find((b) => b.asset_type === "native")?.balance ?? 0) > 200);
if (!acct) throw new Error("no suitable public account found");
console.log("simulating as", acct.id, "(never signed)");

const src = aquariusSource();
const leg = await src.quote({ assetIn: "native", assetOut: AQUA, amountIn });
if (!leg) throw new Error("aquarius returned no route");
const raw = leg.raw as { swap_chain_xdr: string };
console.log(`quote: ${formatAmount(amountIn)} XLM -> ${formatAmount(leg.amountOut)} AQUA via ${leg.hops.length} hops`);

const minOut = (leg.amountOut * 9950n) / 10_000n;
const tx = buildAquariusSwap({
  source: acct.id, sequence: acct.sequence, swapChainXdr: raw.swap_chain_xdr,
  tokenIn: sacId("native"), amountIn, minOut,
});

try {
  const p = await prepare(RPC, tx);
  const out = p.returnValue ? scValToNative(xdr.ScVal.fromXDR(p.returnValue, "base64")) : undefined;
  console.log("SIMULATION OK. min resource fee (stroops):", p.minResourceFee);
  console.log("simulated amount out:", out === undefined ? "n/a" : formatAmount(BigInt(out)), "AQUA");
} catch (e) {
  console.log("SIMULATION FAILED:", (e as Error).message.slice(0, 600));
  process.exitCode = 1;
}
