import { useEffect, useState } from "react";
import { EarnView } from "./components/EarnView";
import { useFlow } from "./components/FlowPanel";
import { Footer, Nav, PendingBanner, RiskNotice, type Tab } from "./components/Shell";
import { SwapView } from "./components/SwapView";
import { useAccount, useAssets, useStablecoins } from "./lib/data";
import { useWallet, WalletProvider } from "./lib/wallet";

const tabFromHash = (): Tab => (window.location.hash.startsWith("#/earn") ? "earn" : "swap");

function Screen() {
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const assets = useAssets();
  const account = useAccount(wallet.address);
  const stable = useStablecoins();
  const flow = useFlow();

  // The hash is the router: two views, linkable, and the browser's back button works.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    document.title = tab === "earn" ? "Earn · Sluice" : "Sluice · One quote across Stellar Classic and Soroban";
  }, [tab]);

  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:ring-1 focus:ring-line">Skip to content</a>
      <Nav tab={tab} account={account} />
      <main id="main" className="mx-auto w-full max-w-6xl px-4 pt-28 sm:px-6 sm:pt-36">
        <RiskNotice />
        <PendingBanner flow={flow} onResume={() => { window.location.hash = "#/"; }} />
        {tab === "swap" ? <SwapView assets={assets} account={account} stable={stable} flow={flow} /> : <EarnView assets={assets} account={account} stable={stable} flow={flow} />}
      </main>
      <Footer />
    </>
  );
}

export function App() {
  return (
    <WalletProvider>
      <Screen />
    </WalletProvider>
  );
}
