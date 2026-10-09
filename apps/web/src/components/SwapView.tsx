import { ArrowsClockwise, ArrowsDownUp, CaretDown, Lightning, ShieldCheck, Stack } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { USDC, type RouteQuote } from "../lib/api";
import { useQuote, type AccountState, type Assets, type StableLookup } from "../lib/data";
import { ago, assetCode, cx, fmt, fromStroops, isAmount, toStroops, venueName } from "../lib/format";
import { runSwap } from "../lib/flow";
import { load, save } from "../lib/store";
import { useWallet } from "../lib/wallet";
import { AssetPicker } from "./AssetPicker";
import { FlowPanel, type Flow } from "./FlowPanel";
import { RouteCard } from "./RouteCard";
import { StableBadge } from "./StableBadge";
import { AssetIcon, Bezel, Eyebrow, LinkButton, Notice, PrimaryButton } from "./ui";

const SLIPPAGE_CHOICES = [10, 50, 100];
/** XLM left behind by "Max" so the account can still pay network fees afterwards. */
const FEE_HEADROOM = 5_000_000n;

interface Props { assets: Assets; account: AccountState; stable: StableLookup; flow: Flow }

function AssetButton({ id, assets, stable, onClick, label }: { id: string; assets: Assets; stable: StableLookup; onClick(): void; label: string }) {
  const a = assets.describe(id);
  return (
    <span className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label}: ${a.code}. Change asset.`}
        className="flex items-center gap-2 rounded-full bg-surface py-1.5 pr-3 pl-1.5 font-medium ring-1 ring-line transition-[transform,box-shadow] duration-500 ease-spring hover:shadow-float active:scale-[0.97]"
      >
        <AssetIcon asset={a} size={28} />
        {a.code}
        <CaretDown size={14} weight="light" className="text-muted" />
      </button>
      <StableBadge scored={stable(id)} />
    </span>
  );
}

export function SwapView({ assets, account, stable, flow }: Props) {
  const wallet = useWallet();
  const [assetIn, setAssetIn] = useState(() => load("sluice.in", "native"));
  const [assetOut, setAssetOut] = useState(() => load("sluice.out", USDC));
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(() => load("sluice.slippage", 50));
  const [twoStep, setTwoStep] = useState(false);
  const [picking, setPicking] = useState<"in" | "out" | null>(null);
  const [chosenKey, setChosenKey] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => save("sluice.in", assetIn), [assetIn]);
  useEffect(() => save("sluice.out", assetOut), [assetOut]);
  useEffect(() => save("sluice.slippage", slippageBps), [slippageBps]);

  const valid = isAmount(amount);
  const quote = useQuote(valid ? { assetIn, assetOut, amount, slippageBps, atomicOnly: !twoStep } : null, flow.active);
  const routes = quote.data?.routes ?? [];
  const best = routes[0];
  // No routes because no venue answered (a cold connection, an outage) is not the same as no route existing:
  // the quote is being asked again, so keep showing that rather than telling the user there is no route.
  const silent = routes.length === 0 && quote.data?.partial === true;
  // The user's pick holds across refreshes while that route still exists; otherwise the best route is used.
  const selected: RouteQuote | undefined = routes.find((r) => r.key === chosenKey) ?? best;

  const flip = () => {
    setAssetIn(assetOut);
    setAssetOut(assetIn);
    setChosenKey(undefined);
  };
  const pick = (side: "in" | "out", id: string) => {
    setChosenKey(undefined);
    if (side === "in") {
      if (id === assetOut) return flip();
      setAssetIn(id);
    } else {
      if (id === assetIn) return flip();
      setAssetOut(id);
    }
  };

  const spendable = account.spendable(assetIn);
  const max = useMemo(() => {
    if (spendable === undefined) return undefined;
    const s = toStroops(spendable);
    const m = assetIn === "native" ? s - FEE_HEADROOM : s;
    return m > 0n ? fromStroops(m) : undefined;
  }, [spendable, assetIn]);
  const short = valid && wallet.address && !account.loading && (spendable === undefined || toStroops(amount) > toStroops(spendable));

  const start = () => {
    if (!selected) return;
    flow.start((io) => runSwap(io, { assetIn, assetOut, amount, slippageBps, routeKey: selected.key }, selected), () => account.reload());
  };

  let action: { label: string; onClick?: () => void; busy?: boolean };
  if (flow.active) action = { label: flow.running ? "Swap in progress" : "See the result on the right" };
  else if (!wallet.address) action = { label: wallet.busy ? "Opening wallet…" : "Connect wallet", onClick: () => void wallet.connect(), busy: wallet.busy };
  else if (account.unfunded) action = { label: "Fund this account with XLM first" };
  else if (!amount) action = { label: "Enter an amount" };
  else if (!valid) action = { label: "Amount needs up to 7 decimals" };
  else if (short) action = { label: `Not enough ${assetCode(assetIn)}` };
  else if (quote.loading || silent) action = { label: "Quoting every venue…", busy: true };
  else if (!selected) action = { label: "No route for this pair and size" };
  else action = { label: `Review swap on ${selected.legs.map((l) => venueName(l.venue)).join(" then ")}`, onClick: start };

  return (
    <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
      <section className="min-w-0 lg:col-span-5">
        <div className="lg:sticky lg:top-28">
          <Eyebrow>Stellar mainnet · non-custodial</Eyebrow>
          <h1 className="mt-4 text-4xl leading-[1.05] font-medium tracking-[-0.03em] sm:text-5xl">One quote across both layers.</h1>
          <p className="mt-4 max-w-[46ch] text-muted">
            The Stellar DEX and Soroban AMMs, ranked together. Every route says whether it settles in one transaction or two.
          </p>

          <fieldset disabled={flow.active} className={cx("m-0 min-w-0 border-0 p-0 transition-opacity duration-500 ease-spring", flow.active && "opacity-60")}>
          <Bezel className="mt-8" core="p-2">
            <div className="rounded-[1.1rem] bg-sunken p-4">
              <div className="flex items-center justify-between text-sm text-muted">
                <label htmlFor="amount">You pay</label>
                {wallet.address && spendable !== undefined && (
                  <span className="flex items-center gap-2">
                    <span><span className="num">{fmt(spendable)}</span> available</span>
                    {max && <LinkButton onClick={() => setAmount(max.replace(/\.?0+$/, ""))}>Max</LinkButton>}
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <input
                  id="amount"
                  name="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, ""))}
                  aria-invalid={amount !== "" && !valid}
                  aria-describedby="amount-help"
                  className="num w-full min-w-0 bg-transparent text-3xl font-medium outline-none"
                />
                <AssetButton id={assetIn} assets={assets} stable={stable} onClick={() => setPicking("in")} label="You pay" />
              </div>
              <p id="amount-help" className={cx("mt-1 min-h-5 text-xs", short || (amount !== "" && !valid) ? "text-bad" : "text-faint")}>
                {amount !== "" && !valid ? "Use digits and at most 7 decimal places." : short ? (spendable === undefined ? `This account holds no ${assetCode(assetIn)}.` : `Only ${fmt(spendable)} ${assetCode(assetIn)} can be spent${assetIn === "native" ? " (the rest is locked reserve)" : ""}.`) : ""}
              </p>
            </div>

            <div className="relative z-10 -my-3 flex justify-center">
              <button
                type="button"
                onClick={flip}
                aria-label="Swap the two assets"
                className="grid size-10 place-items-center rounded-full bg-surface text-muted shadow-float ring-1 ring-line transition-transform duration-500 ease-spring hover:rotate-180 hover:text-ink active:scale-95"
              >
                <ArrowsDownUp size={18} weight="light" />
              </button>
            </div>

            <div className="rounded-[1.1rem] bg-sunken p-4">
              <div className="text-sm text-muted">You receive</div>
              <div className="mt-2 flex items-center gap-3">
                <output aria-live="polite" className={cx("num w-full min-w-0 truncate text-3xl font-medium", !selected && "text-faint")}>
                  {quote.loading ? <span className="skeleton inline-block h-8 w-36 align-middle" /> : selected ? fmt(selected.amountOut) : "0"}
                </output>
                <AssetButton id={assetOut} assets={assets} stable={stable} onClick={() => setPicking("out")} label="You receive" />
              </div>
              <p className="mt-1 min-h-5 text-xs text-faint">
                {selected && valid && <>1 {assetCode(assetIn)} ≈ <span className="num">{fmt(String(Number(selected.amountOut) / Number(amount)), 7)}</span> {assetCode(assetOut)}</>}
              </p>
            </div>

            <div className="px-3 pt-3">
              <button
                type="button"
                aria-expanded={settingsOpen}
                aria-controls="swap-settings"
                onClick={() => setSettingsOpen((o) => !o)}
                className="flex w-full items-center justify-between gap-3 rounded-xl py-1.5 text-left text-sm text-muted transition-colors duration-300 ease-spring hover:text-ink"
              >
                <span>Slippage <span className="num text-ink">{slippageBps / 100}%</span>{twoStep && " · two-transaction routes shown"}</span>
                <CaretDown size={14} weight="light" className={cx("transition-transform duration-500 ease-spring", settingsOpen && "rotate-180")} />
              </button>
              {settingsOpen && (
                <div id="swap-settings" className="animate-rise space-y-4 pt-3 pb-1">
                  <fieldset>
                    <legend className="text-sm text-muted">The swap does not execute if the price moves against you by more than</legend>
                    <div className="mt-2 flex gap-2">
                      {SLIPPAGE_CHOICES.map((bps) => (
                        <button
                          key={bps}
                          type="button"
                          aria-pressed={slippageBps === bps}
                          onClick={() => setSlippageBps(bps)}
                          className={cx("num rounded-full px-4 py-1.5 text-sm ring-1 transition-colors duration-300 ease-spring", slippageBps === bps ? "bg-accent text-accent-ink ring-accent" : "ring-line hover:bg-shell")}
                        >
                          {bps / 100}%
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label className="flex cursor-pointer items-start gap-3 text-sm">
                    <input type="checkbox" name="twoStep" checked={twoStep} onChange={(e) => { setTwoStep(e.target.checked); setChosenKey(undefined); }} className="mt-0.5 size-4 accent-accent" />
                    <span>
                      Also show routes that need two transactions
                      <span className="block text-muted">A Classic leg and a Soroban leg cannot share a transaction. If the second fails you hold the intermediate asset and can unwind.</span>
                    </span>
                  </label>
                </div>
              )}
            </div>

            <div className="p-2 pt-3">
              <PrimaryButton onClick={action.onClick} disabled={!action.onClick} busy={action.busy}>{action.label}</PrimaryButton>
            </div>
          </Bezel>
          </fieldset>
          {wallet.error && <Notice tone="bad" className="mt-3">{wallet.error}</Notice>}
          {account.unfunded && <Notice className="mt-3">This account has never been funded on Stellar mainnet. Send it at least 1 XLM, then come back.</Notice>}
          <p className="mt-4 px-2 text-xs text-faint">Sluice never holds your funds or keys. Every transaction is simulated on mainnet, then signed by you in your own wallet.</p>
        </div>
      </section>

      <section className="min-w-0 lg:col-span-7" aria-label="Routes">
        {flow.active ? (
          <FlowPanel flow={flow} backLabel="Back to routes" />
        ) : !valid ? (
          <Explainer />
        ) : silent ? (
          <Bezel core="p-7" className="animate-rise">
            <h2 className="text-xl font-medium tracking-tight">The venues have not answered yet</h2>
            <p className="mt-2 max-w-[56ch] text-sm text-muted">
              None of {quote.data!.errors.map((e) => venueName(e.source)).join(", ")} replied in time. This usually clears in a few seconds; the quote is being asked again automatically.
            </p>
            <div className="mt-5"><LinkButton onClick={quote.reload} disabled={quote.refreshing}>{quote.refreshing ? "Asking again…" : "Ask again now"}</LinkButton></div>
          </Bezel>
        ) : quote.loading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading routes">
            <div className="skeleton h-36 rounded-3xl" />
            <div className="skeleton h-36 rounded-3xl" />
            <div className="skeleton h-36 rounded-3xl" />
          </div>
        ) : quote.error && routes.length === 0 ? (
          <Bezel core="p-7">
            <h2 className="text-xl font-medium tracking-tight">Quotes did not load</h2>
            <p className="mt-2 text-sm text-muted">{quote.error}</p>
            <div className="mt-5"><LinkButton onClick={quote.reload}>Try again</LinkButton></div>
          </Bezel>
        ) : routes.length === 0 ? (
          <Bezel core="p-7">
            <h2 className="text-xl font-medium tracking-tight">No route for this pair and size</h2>
            <p className="mt-2 max-w-[56ch] text-sm text-muted">
              No venue returned a quote for {fmt(amount)} {assetCode(assetIn)} to {assetCode(assetOut)}. Try a smaller amount{!twoStep && ", or allow two-transaction routes in the settings under the form"}.
            </p>
            {quote.data?.partial && <p className="mt-3 text-sm text-warn">Not every venue answered: {quote.data.errors.map((e) => venueName(e.source)).join(", ")}.</p>}
          </Bezel>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 px-1 text-sm text-muted">
              <span>
                {routes.length} route{routes.length === 1 ? "" : "s"}, best first · <Updated at={quote.at} />
              </span>
              <button type="button" onClick={quote.reload} disabled={quote.refreshing} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors duration-300 ease-spring hover:bg-shell hover:text-ink disabled:opacity-60">
                <ArrowsClockwise size={15} weight="light" className={cx(quote.refreshing && "animate-spin")} />
                Refresh
              </button>
            </div>
            {quote.data?.partial && (
              <Notice className="mb-3">Not every venue answered this time ({quote.data.errors.map((e) => venueName(e.source)).join(", ")}). The routes below are real but the list may be incomplete; it is being quoted again in a few seconds.</Notice>
            )}
            <div role="radiogroup" aria-label="Choose a route" className="space-y-3">
              {routes.map((r, i) => (
                <RouteCard key={r.key} route={r} best={best!} selected={selected?.key === r.key} onSelect={() => setChosenKey(r.key)} stable={stable} index={i} />
              ))}
            </div>
          </>
        )}
      </section>

      <AssetPicker open={picking !== null} title={picking === "in" ? "You pay" : "You receive"} onClose={() => setPicking(null)} onPick={(id) => pick(picking!, id)} assets={assets} account={account} stable={stable} other={picking === "in" ? assetOut : assetIn} />
    </div>
  );
}

/** Ticks once a second so "updated 6s ago" stays true between refreshes. */
function Updated({ at }: { at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span data-ticker className="tabular-nums">updated {ago(Date.now() - at)}</span>;
}

/** What the right-hand side says before there is anything to quote. */
function Explainer() {
  const points = [
    { icon: Lightning, title: "One transaction means all or nothing", body: "A path payment on the Stellar DEX, or a single contract call on a Soroban AMM, either settles completely or changes nothing." },
    { icon: Stack, title: "Crossing layers takes two", body: "Stellar does not let a Classic operation and a contract call share a transaction. Those routes are hidden until you ask for them, and each one says what happens if the second half fails." },
    { icon: ShieldCheck, title: "Simulated before you sign", body: "The exact transaction is run against mainnet first. A route that would fail never reaches your wallet." },
  ];
  return (
    <div className="grid gap-3 lg:pt-24">
      {points.map((p, i) => (
        <div key={p.title} style={{ animationDelay: `${i * 90}ms` }} className={cx("animate-rise rounded-3xl bg-surface p-6 ring-1 ring-line", i === 1 && "lg:ml-10", i === 2 && "lg:ml-20")}>
          <p.icon size={22} weight="light" className="text-accent" />
          <h2 className="mt-3 text-lg font-medium tracking-tight">{p.title}</h2>
          <p className="mt-1.5 max-w-[58ch] text-sm text-muted">{p.body}</p>
        </div>
      ))}
    </div>
  );
}
