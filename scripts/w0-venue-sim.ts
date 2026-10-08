/**
 * Read-only proof for the Phoenix and Comet adapters. For each venue it takes a live quote, builds the
 * transaction with the same code the API uses, and SIMULATES it on mainnet RPC as a public account that
 * holds the needed assets. Nothing is signed or submitted.
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w0:venue-sim
 */
import {
  buildCometSwap, buildPhoenixSwap, buildVaultDeposit, BLEND_FIXED_V2_POOL, buildSoroswapSwap, soroswapSource, type SoroswapRaw, cometSource, formatAmount, parseAmount, phoenixSource, prepare,
  preferIpv4, scValToNative, xdr, type CometRaw, type PhoenixRaw,
} from "../packages/core/src/index.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();
const RPC = process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
const H = "https://horizon.stellar.org";
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const BLND = "BLND:GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY";

type Acct = { id: string; sequence: string; balances: { asset_type: string; asset_code?: string; balance: string }[] };
async function holders(asset: string): Promise<Acct[]> {
  const r = (await (await fetch(`${H}/accounts?asset=${encodeURIComponent(asset)}&limit=200&order=desc`)).json()) as { _embedded: { records: Acct[] } };
  return r._embedded.records;
}
const bal = (a: Acct, code?: string) => Number(a.balances.find((b) => (code ? b.asset_code === code : b.asset_type === "native"))?.balance ?? 0);
const decode = (b64?: string) => (b64 ? (scValToNative(xdr.ScVal.fromXDR(b64, "base64")) as bigint) : undefined);

async function check(name: string, run: () => Promise<void>) {
  try { await run(); } catch (e) { console.log(`${name}: FAILED ${(e as Error).message.split("\n").filter((l) => /Error|topics:\[error|fn_call.*swap|trustline|balance/.test(l)).slice(0, 6).join(" || ").slice(0, 900)}`); process.exitCode = 1; }
}

await check("phoenix", async () => {
  const src = phoenixSource({ rpcUrl: RPC });
  const amount = parseAmount("10");
  const leg = await src.quote({ assetIn: "native", assetOut: USDC, amountIn: amount });
  if (!leg) throw new Error("no phoenix route for XLM->USDC");
  const raw = leg.raw as PhoenixRaw;
  const acct = (await holders(USDC)).find((a) => bal(a) > 300);
  if (!acct) throw new Error("no holder found");
  const minOut = (leg.amountOut * 9950n) / 10_000n;
  const tx = buildPhoenixSwap({ source: acct.id, sequence: acct.sequence, pool: raw.pool, offerAsset: raw.offerAsset, amountIn: amount, minOut });
  const p = await prepare(RPC, tx);
  console.log(`phoenix  pool ${raw.pool.slice(0, 8)}  quote ${formatAmount(leg.amountOut)} USDC  simulated ${formatAmount(decode(p.returnValue) ?? 0n)} USDC  resource fee ${p.minResourceFee}`);
});

await check("soroswap", async () => {
  const src = soroswapSource({ rpcUrl: RPC });
  const amount = parseAmount("10");
  const leg = await src.quote({ assetIn: "native", assetOut: USDC, amountIn: amount });
  if (!leg) throw new Error("no soroswap route for XLM->USDC");
  const raw = leg.raw as SoroswapRaw;
  const acct = (await holders(USDC)).find((a) => bal(a) > 300);
  if (!acct) throw new Error("no holder found");
  const minOut = (leg.amountOut * 9950n) / 10_000n;
  const tx = buildSoroswapSwap({ source: acct.id, sequence: acct.sequence, router: raw.router, path: raw.path, amountIn: amount, minOut });
  const p = await prepare(RPC, tx);
  const ret = p.returnValue ? (scValToNative(xdr.ScVal.fromXDR(p.returnValue, "base64")) as bigint[]) : [];
  console.log(`soroswap path ${raw.path.length} tokens  quote ${formatAmount(leg.amountOut)} USDC  simulated ${formatAmount(ret[ret.length - 1] ?? 0n)} USDC  resource fee ${p.minResourceFee}`);
});

await check("comet", async () => {
  const src = cometSource({ rpcUrl: RPC });
  const amount = parseAmount("5");
  const leg = await src.quote({ assetIn: USDC, assetOut: BLND, amountIn: amount });
  if (!leg) throw new Error("no comet route for USDC->BLND");
  const raw = leg.raw as CometRaw;
  const acct = (await holders(BLND)).find((a) => bal(a, "USDC") > 20);
  if (!acct) throw new Error("no holder with both USDC and a BLND trustline found");
  const minOut = (leg.amountOut * 9950n) / 10_000n;
  const tx = buildCometSwap({ source: acct.id, sequence: acct.sequence, pool: raw.pool, tokenIn: raw.tokenIn, tokenOut: raw.tokenOut, amountIn: amount, minOut });
  const p = await prepare(RPC, tx);
  const ret = p.returnValue ? (scValToNative(xdr.ScVal.fromXDR(p.returnValue, "base64")) as bigint[]) : [];
  console.log(`comet    pool ${raw.pool.slice(0, 8)}  quote ${formatAmount(leg.amountOut)} BLND  simulated ${formatAmount(ret[0] ?? 0n)} BLND  resource fee ${p.minResourceFee}`);
});

await check("blend", async () => {
  const acct = (await holders(USDC)).find((a) => bal(a, "USDC") > 20);
  if (!acct) throw new Error("no USDC holder found");
  const amount = parseAmount("5");
  const tx = buildVaultDeposit({ vault: BLEND_FIXED_V2_POOL, underlying: USDC, protocol: "blend" }, USDC, amount, { source: acct.id, sequence: acct.sequence });
  const p = await prepare(RPC, tx);
  console.log(`blend    supply ${formatAmount(amount)} USDC to FixedV2 simulated OK, resource fee ${p.minResourceFee}`);
});
