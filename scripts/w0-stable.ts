/** Live stablecoin signals and score for one or more assets. Usage: pnpm w0:stable CODE:ISSUER [...] */
import { fetchStablecoinSignals, preferIpv4, scoreStablecoin } from "../packages/core/src/index.js";
if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();
const assets = process.argv.slice(2);
if (!assets.length) assets.push("yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
for (const a of assets) {
  try {
    const s = await fetchStablecoinSignals(a);
    const sc = scoreStablecoin(s);
    console.log(a.split(":")[0], { peg: +s.pegPrice.toFixed(5), depthNearPeg: s.depthNearPeg, authRequired: s.authRequired, clawback: s.clawback }, "score", sc.score, "penaltyBps", sc.penaltyBps, sc.reasons);
  } catch (e) { console.log(a.split(":")[0], "ERROR", (e as Error).message); }
}
