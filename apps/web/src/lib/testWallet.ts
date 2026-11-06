/**
 * SLUICE_TEST_WALLET_SHIM. TEST ONLY. NOT A WALLET. NEVER ENABLED IN PRODUCTION.
 *
 * Browser automation has no wallet extension, so a test build can stand in for one. This module exists so the
 * Settle flow can be driven end to end against the testnet; it is the only way the app can "sign" without a
 * real wallet, and it is fenced three ways:
 *
 *  1. Build time. It is imported only behind `__SLUICE_TEST_WALLET__`, a constant that vite.config.ts sets to
 *     false unless the build was made with SLUICE_TEST_WALLET=1. In every other build the bundler removes the
 *     import, so this file is not in the output at all (checked by grepping the production bundle for the
 *     harness path "__test/wallet", which only this file contains).
 *  2. Run time. Even a test build does nothing unless the page is opened with `?testwallet=<module id>`.
 *  3. It holds no key. It forwards the preimage to a local test harness (`/__test/wallet/*`, served only by the
 *     test harness script, never by the Sluice API) which signs with a throwaway testnet key kept in that
 *     process's memory. The harness is the "wallet"; this file is the thin interface the kit would provide.
 *
 * `?testwallet=freighter`        signs, like Freighter.
 * `?testwallet=freighter&reject=1` the user rejects the request (kit error code -4).
 * `?testwallet=albedo`           an id the app already knows cannot sign orders (gating refuses before any call).
 * `?testwallet=wallet_connect`   an id the app cannot vouch for; the call fails with code -3, as a wallet that
 *                                lacks signAuthEntry does.
 * `?testwallet=freighter&slow=8` the wallet takes 8 seconds to answer (for the "waiting for your wallet" view).
 */
import type { SignAuthEntry } from "@sluice/sdk";

export interface TestWallet {
  moduleId: string;
  address: string;
  /** Resolves once the harness has told us the address. */
  ready: Promise<void>;
  signAuthEntry: SignAuthEntry;
}

export function testWalletFromLocation(loc: Pick<Location, "search">): TestWallet | undefined {
  const q = new URLSearchParams(loc.search);
  const moduleId = q.get("testwallet");
  if (!moduleId) return undefined;
  const reject = q.get("reject") === "1";
  const slow = Math.min(60, Math.max(0, Number(q.get("slow") ?? 0) || 0));

  const wallet: TestWallet = {
    moduleId,
    address: "",
    ready: Promise.resolve(),
    signAuthEntry: async (preimage) => {
      if (slow) await new Promise((r) => setTimeout(r, slow * 1000));
      if (reject) throw { code: -4, message: "The user rejected this request." };
      if (moduleId !== "freighter") throw { code: -3, message: `The test wallet "${moduleId}" does not support the "signAuthEntry" function` };
      const res = await fetch("/__test/wallet/sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preimage }) });
      if (!res.ok) throw { code: -1, message: `test harness refused: HTTP ${res.status}` };
      return (await res.json()) as { signedAuthEntry: string; signerAddress: string };
    },
  };
  wallet.ready = fetch("/__test/wallet/address")
    .then((r) => r.json() as Promise<{ address: string }>)
    .then(({ address }) => { wallet.address = address; });
  return wallet;
}
