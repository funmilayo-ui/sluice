import { lazy, Suspense, useEffect, useState } from "react";
import { EarnView } from "./components/EarnView";
import { useFlow } from "./components/FlowPanel";
import { Footer, Nav, PendingBanner, RiskNotice, type Tab } from "./components/Shell";
import { SwapView } from "./components/SwapView";
import { Bezel, Notice } from "./components/ui";
import { useAccount, useAssets, useOrdersConfig, useStablecoins } from "./lib/data";
import { useWallet, WalletProvider } from "./lib/wallet";

// Settlement orders (testnet prototype) load only when the tab is opened: nobody else pays for them.
const SettleView = lazy(() => import("./components/SettleView"));

const tabFromHash = (): Tab => (window.location.hash.startsWith("#/earn") ? "earn" : window.location.hash.startsWith("#/settle") ? "settle" : "swap");

function Screen() {
  const wallet = useWallet();
  const [wanted, setTab] = useState<Tab>(tabFromHash);
  const orders = useOrdersConfig();
  // The Settle tab exists only where the server says settlement orders are on. A link to it elsewhere lands on Swap.
  const tab: Tab = wanted === "settle" && orders.status === "disabled" ? "swap" : wanted;
  const assets = useAssets();

  // The Swap and Earn screens read the account on mainnet. Settle works on another network, where a mainnet
  // lookup of the same address is meaningless (and 404s for a testnet-only account), so it is skipped there.
  const account = useAccount(tab === "settle" ? undefined : wallet.address);
  const stable = useStablecoins();
  // Once opened, the Settle screen stays mounted (hidden) so an order in flight keeps its on-screen result when
  // the user looks at another tab, as the mainnet flow does.
  const [settleOpened, setSettleOpened] = useState(false);
  useEffect(() => { if (tab === "settle") setSettleOpened(true); }, [tab]);
  const flow = useFlow();

  // The hash is the router: two views, linkable, and the browser's back button works.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    document.title = tab === "earn" ? "Earn · Sluice" : tab === "settle" ? "Settle (testnet prototype) · Sluice" : "Sluice · One quote across Stellar Classic and Soroban";
  }, [tab]);

  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:ring-1 focus:ring-line">Skip to content</a>
      <Nav tab={tab} account={account} settle={orders.status === "enabled"} />
      <main id="main" className="mx-auto w-full max-w-6xl px-4 pt-28 sm:px-6 sm:pt-36">
        {wallet.testWallet && <Notice className="mb-6">Test build: the wallet here is a test stand-in that signs with a throwaway testnet key. It is not a real wallet.</Notice>}
        {/* The mainnet notices describe mainnet funds; the Settle screen carries its own testnet notice. */}
        {tab !== "settle" && <RiskNotice />}
        {tab !== "settle" && <PendingBanner flow={flow} onResume={() => { window.location.hash = "#/"; }} />}
        {wanted === "settle" && orders.status === "disabled" && <Notice tone="neutral" className="mb-6">Settlement orders are not available on this deployment.</Notice>}
        {tab === "swap" && <SwapView assets={assets} account={account} stable={stable} flow={flow} />}
        {tab === "earn" && <EarnView assets={assets} account={account} stable={stable} flow={flow} />}
        {tab === "settle" && orders.status !== "enabled" && <SettleLoading />}
        {orders.status === "enabled" && settleOpened && (
          <div hidden={tab !== "settle"}>
            <Suspense fallback={<SettleLoading />}>
              <SettleView orders={orders.config} flow={flow} />
            </Suspense>
          </div>
        )}
      </main>
      <Footer />
    </>
  );
}

function SettleLoading() {
  return (
    <Bezel core="p-7">
      <div className="skeleton h-40" aria-busy="true" aria-label="Loading settlement orders" />
    </Bezel>
  );
}

export function App() {
  return (
    <WalletProvider>
      <Screen />
    </WalletProvider>
  );
}
