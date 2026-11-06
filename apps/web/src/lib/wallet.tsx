import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SignAuthEntry } from "@sluice/sdk";
import type { TestWallet } from "./testWallet";

const PUBLIC = "Public Global Stellar Network ; September 2015";
type Kit = typeof import("@creit.tech/stellar-wallets-kit/sdk").StellarWalletsKit;

/**
 * WalletConnect (mobile wallets such as LOBSTR) needs a Reown project id, which belongs to whoever deploys
 * the app. Set VITE_WALLETCONNECT_PROJECT_ID at build time to offer it; without it the option is not shown.
 */
const WALLETCONNECT_PROJECT_ID = (import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) || undefined;
/**
 * Settlement orders (testnet prototype) are signed on the testnet chain, which a WalletConnect session must have
 * been approved for up front. Off by default so mainnet pairing is exactly what it was; set
 * VITE_WALLETCONNECT_TESTNET=1 at build time, together with the project id, to test orders over WalletConnect.
 */
const WALLETCONNECT_TESTNET = import.meta.env?.VITE_WALLETCONNECT_TESTNET === "1";

let kitPromise: Promise<Kit> | undefined;

/**
 * The wallet kit and its wallet modules are loaded on demand: they are the largest dependency and nothing on
 * first paint needs them. Extension and web wallets only; WalletConnect needs a project id this app does not have.
 */
function loadKit(): Promise<Kit> {
  kitPromise ??= (async () => {
    const [{ StellarWalletsKit }, types, freighter, xbull, albedo, lobstr, rabet, hana] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit/sdk"),
      import("@creit.tech/stellar-wallets-kit/types"),
      import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      import("@creit.tech/stellar-wallets-kit/modules/xbull"),
      import("@creit.tech/stellar-wallets-kit/modules/albedo"),
      import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
      import("@creit.tech/stellar-wallets-kit/modules/rabet"),
      import("@creit.tech/stellar-wallets-kit/modules/hana"),
    ]);
    const modules = [
      new freighter.FreighterModule(), new xbull.xBullModule(), new albedo.AlbedoModule(),
      new lobstr.LobstrModule(), new rabet.RabetModule(), new hana.HanaModule(),
    ];
    if (WALLETCONNECT_PROJECT_ID) {
      // Loaded only when configured: it is by far the largest wallet module.
      const wc = await import("@creit.tech/stellar-wallets-kit/modules/wallet-connect");
      modules.push(new wc.WalletConnectModule({
        projectId: WALLETCONNECT_PROJECT_ID,
        metadata: {
          name: "Sluice",
          description: "Route Stellar liquidity across Classic and Soroban, signed in your own wallet.",
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.svg`],
        },
        allowedChains: WALLETCONNECT_TESTNET ? [wc.WalletConnectTargetChain.PUBLIC, wc.WalletConnectTargetChain.TESTNET] : [wc.WalletConnectTargetChain.PUBLIC],
      }));
    }
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim();
    StellarWalletsKit.init({
      modules,
      network: types.Networks.PUBLIC,
      theme: {
        ...(dark ? types.SwkAppDarkTheme : types.SwkAppLightTheme),
        background: token("--surface"),
        "background-secondary": token("--sunken"),
        "foreground-strong": token("--ink"),
        foreground: token("--ink"),
        "foreground-secondary": token("--muted"),
        primary: token("--accent"),
        "primary-foreground": token("--accent-ink"),
        "border-radius": "1rem",
        "font-family": '"Geist Variable", system-ui, sans-serif',
      },
      authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
    });
    return StellarWalletsKit;
  })();
  return kitPromise;
}

/**
 * Refuse a signature made by a different account than the one connected. This happens when the user switches
 * accounts inside the wallet after connecting: the transaction was built for the connected account's sequence
 * number, so the network would reject it anyway, with a less helpful message.
 */
export function assertSigner(connected: string | undefined, signer: string | undefined): void {
  if (connected && signer && signer !== connected) {
    const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
    throw new WalletError(`The wallet signed with a different account (${short(signer)}). Switch the wallet back to ${short(connected)}, or disconnect and connect the account you want to use.`);
  }
}

/** The kit's id for the wallet it is using, or undefined when none is selected (the kit throws then). */
function selectedModuleId(kit: Kit): string | undefined {
  try {
    return kit.selectedModule.productId;
  } catch {
    return undefined;
  }
}

/** A wallet error in words. Wallets report rejection differently; the message is theirs, the framing ours. */
export class WalletError extends Error {}
function walletMessage(e: unknown): string {
  const m = (e as { message?: string; error?: { message?: string } })?.error?.message ?? (e as { message?: string })?.message;
  return typeof m === "string" && m ? m : "The wallet did not respond.";
}

interface WalletState {
  address: string | undefined;
  /** True while a stored session is being restored or the wallet picker is open. */
  busy: boolean;
  error: string | undefined;
  connect(): Promise<string | undefined>;
  disconnect(): Promise<void>;
  /** Ask the wallet to sign. Rejects with WalletError when the user declines or the wallet fails. */
  sign(xdr: string): Promise<string>;
  /** The kit's id for the connected wallet module ("freighter", "albedo", ...), when one is connected. */
  moduleId: string | undefined;
  /**
   * Ask the wallet to sign a Soroban authorisation entry (SEP-43 `signAuthEntry`), for settlement orders.
   * Rejects with the wallet's own error object untouched ({ code, message }): `classifyWalletFailure` tells
   * "this wallet cannot do it" (-3) from "the user said no" (-4).
   */
  signAuthEntry: SignAuthEntry;
  /** True only in a test build running the test wallet. Always false in production builds. */
  testWallet: boolean;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [moduleId, setModuleId] = useState<string>();
  const [shim, setShim] = useState<TestWallet>();

  // TEST-ONLY. `__SLUICE_TEST_WALLET__` is a build-time constant that is false unless the build was made with
  // SLUICE_TEST_WALLET=1, so in a production build this block and the module it imports are removed entirely.
  // (Keep the constant in the `if` itself: bundlers fold it there, but not through a helper function.)
  useEffect(() => {
    if (__SLUICE_TEST_WALLET__ && /[?&]testwallet=/.test(window.location.search)) {
      void import("./testWallet").then(({ testWalletFromLocation }) => {
        const t = testWalletFromLocation(window.location);
        if (!t) return;
        t.ready.then(() => { setShim(t); setAddress(t.address); setModuleId(t.moduleId); }).catch(() => undefined).finally(() => setBusy(false));
      });
    }
  }, []);

  // Restore a previous session (the kit remembers the wallet and address) once the page is idle.
  useEffect(() => {
    if (__SLUICE_TEST_WALLET__ && /[?&]testwallet=/.test(window.location.search)) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    const start = () => {
      loadKit()
        .then(async (kit) => {
          if (cancelled) return;
          const { KitEventType } = await import("@creit.tech/stellar-wallets-kit/types");
          off = kit.on(KitEventType.STATE_UPDATED, (ev) => { setAddress(ev.payload.address || undefined); setModuleId(selectedModuleId(kit)); });
          const offDisconnect = kit.on(KitEventType.DISCONNECT, () => { setAddress(undefined); setModuleId(undefined); });
          const prev = off;
          off = () => { prev(); offDisconnect(); };
        })
        .catch(() => undefined)
        .finally(() => { if (!cancelled) setBusy(false); });
    };
    const idle = window.requestIdleCallback ? window.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 300);
    return () => {
      cancelled = true;
      off?.();
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, []);

  const connect = useCallback(async () => {
    setError(undefined);
    setBusy(true);
    try {
      const kit = await loadKit();
      const { address: a } = await kit.authModal();
      setAddress(a);
      setModuleId(selectedModuleId(kit));
      return a;
    } catch (e) {
      // Closing the picker is not an error worth showing.
      if ((e as { code?: number })?.code !== -1) setError(walletMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (shim) return;
    const kit = await loadKit();
    await kit.disconnect();
    setAddress(undefined);
    setModuleId(undefined);
  }, [shim]);

  const sign = useCallback(async (xdr: string) => {
    if (shim) throw new WalletError("The test wallet only signs settlement orders.");
    const kit = await loadKit();
    try {
      const { signedTxXdr, signerAddress } = await kit.signTransaction(xdr, { networkPassphrase: PUBLIC, address });
      assertSigner(address, signerAddress);
      return signedTxXdr;
    } catch (e) {
      throw e instanceof WalletError ? e : new WalletError(walletMessage(e));
    }
  }, [address, shim]);

  const signAuthEntry = useCallback<SignAuthEntry>(async (preimage, opts) => {
    if (shim) return shim.signAuthEntry(preimage, opts);
    const kit = await loadKit();
    return kit.signAuthEntry(preimage, { address: opts.address, networkPassphrase: opts.networkPassphrase });
  }, [shim]);

  const value = useMemo(
    () => ({ address, busy, error, connect, disconnect, sign, moduleId, signAuthEntry, testWallet: shim !== undefined }),
    [address, busy, error, connect, disconnect, sign, moduleId, signAuthEntry, shim],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
