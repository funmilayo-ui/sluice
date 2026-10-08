/**
 * W0-3 probe: hit every quoting source with the same pair and report status, latency and output.
 * Usage: pnpm w0:probe [amountXLM]
 */
import { preferIpv4, cometSource, phoenixSource, aquariusSource, formatAmount, horizonSource, parseAmount, soroswapSource, type QuoteSource } from "../packages/core/src/index.js";

const XLM = "native";
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const AQUA = "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const amount = parseAmount(process.argv[2] ?? "100");
const sources: QuoteSource[] = [horizonSource(), aquariusSource(), soroswapSource(), phoenixSource(), cometSource()];

const pairs: [string, string][] = [[XLM, USDC], [USDC, AQUA], [XLM, AQUA]];
for (const [a, b] of pairs) {
  console.log(`\n${a.split(":")[0]} -> ${b.split(":")[0]}  amountIn=${formatAmount(amount)}`);
  for (const s of sources) {
    const t = Date.now();
    try {
      const leg = await s.quote({ assetIn: a, assetOut: b, amountIn: amount });
      const ms = Date.now() - t;
      console.log(
        `  ${s.id.padEnd(14)} ${s.layer.padEnd(8)} ${String(ms).padStart(5)}ms  ` +
          (leg ? `out=${formatAmount(leg.amountOut)} hops=${leg.hops.length}` : "no route"),
      );
    } catch (e) {
      console.log(`  ${s.id.padEnd(14)} ${s.layer.padEnd(8)} ${String(Date.now() - t).padStart(5)}ms  ERROR ${(e as Error).message}`);
    }
  }
}
