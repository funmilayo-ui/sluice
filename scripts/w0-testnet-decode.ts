/**
 * Encoding check against a REAL deployed Sluice router (testnet). The TS builder's arguments must decode in the
 * contract, and the contract must reach its own validation and venue dispatch. We simulate (never submit):
 *  1. a venue that is not allowlisted  -> expect Error(Contract, #3) VenueNotAllowed
 *  2. a bad amount                      -> expect Error(Contract, #6) BadAmount
 *  3. an allowlisted address of the wrong kind, for each VenueKind -> expect the failure to come from the VENUE call,
 *     which proves legs decoded and dispatch reached the right branch.
 * Usage: ROUTER=C... SOURCE=G... pnpm w0:testnet-decode
 */
import { buildSluiceRouterSwap, Networks, preferIpv4, prepare, sacId, type VenueKind } from "../packages/core/src/index.js";
if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const ROUTER = process.env.ROUTER!;
const SOURCE = process.env.SOURCE!;
const ALLOWED = process.env.ALLOWED; // an allowlisted contract id (wrong kind on purpose)
const RPC = "https://soroban-testnet.stellar.org";
const PASS = Networks.TESTNET;
if (!ROUTER || !SOURCE) throw new Error("set ROUTER and SOURCE");

const seq = ((await (await fetch(`https://horizon-testnet.stellar.org/accounts/${SOURCE}`)).json()) as { sequence: string }).sequence;
const xlm = sacId("native", PASS);
const stranger = sacId("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", PASS);

async function expectErr(label: string, kind: VenueKind, venue: string, amountIn: bigint, want: RegExp, outToken = stranger) {
  const tx = buildSluiceRouterSwap({
    source: SOURCE, sequence: seq, passphrase: PASS, routerContract: ROUTER,
    legs: [{ kind, venue, path: [xlm, outToken] }], amountIn, minOut: 1n, deadline: 4_000_000_000n,
  });
  try {
    await prepare(RPC, tx, PASS);
    console.log(`${label}: UNEXPECTED SUCCESS`);
    process.exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    const head = msg.split("\n")[0]!.slice(0, 160);
    const ok = want.test(msg);
    console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${head}`);
    if (!ok) process.exitCode = 1;
  }
}

await expectErr("unlisted venue", "Soroswap", stranger, 10n, /Error\(Contract, #3\)/);
await expectErr("bad amount", "Soroswap", stranger, 0n, /Error\(Contract, #6\)/);
if (ALLOWED) {
  // Passed the allowlist and decode; the failure must now originate in the call INTO the venue, not in the router.
  for (const kind of ["Soroswap", "Phoenix", "Comet"] as VenueKind[]) {
    // Output token is XLM so the router's own balance read succeeds (the account has no trustline for other assets).
    await expectErr(`dispatch ${kind}`, kind, ALLOWED, 10n, new RegExp(kind === "Soroswap" ? "swap_exact_tokens_for_tokens" : kind === "Phoenix" ? "fn_call.*\\bswap\\b|, swap\\]|\\[fn_call, " + ALLOWED + ", swap" : "swap_exact_amount_in"), xlm);
  }
}
