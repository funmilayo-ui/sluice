import { ArrowSquareOut, Check, CircleNotch, Clock, Flask, Info, PenNib, Receipt, ShieldCheck, Warning } from "@phosphor-icons/react";
import { signOrder, signOrderTx } from "@sluice/sdk";
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { OrdersAvailability } from "../lib/data";
import { assetCode, cx, fmt, isAmount, orderExplorerAccount, orderExplorerTx, shortKey, toStroops } from "../lib/format";
import {
  countdown, createOrderController, expiry, goodUntil, hedgeText, isTxPrepared, parseAssetInput, rawValues, reasonText,
  type OrderController, type OrderDeps, type OrderState,
} from "../lib/orders";
import { signingRoute, signingSupport, UNKNOWN_WALLET_NOTE, UNSUPPORTED_WALLET_MESSAGE, UNSUPPORTED_WALLET_TITLE, type SigningRoute } from "../lib/orderWallet";
import { load, save } from "../lib/store";
import { useWallet } from "../lib/wallet";
import type { Flow } from "./FlowPanel";
import { StepRow } from "./FlowPanel";
import { AssetIcon, Bezel, Eyebrow, Notice, PrimaryButton, QuietButton, Tag } from "./ui";

type Enabled = Extract<OrdersAvailability, { status: "enabled" }>["config"];

const SLIPPAGE_CHOICES = [10, 50, 100];
const PAIR = "sluice.orders.pair";
const RECENT = "sluice.orders.recent";

/** `#/settle?in=CODE:ISSUER&out=CODE:ISSUER` fills the form; handy for a test pass and for sharing a pair. */
function pairFromHash(): { in?: string; out?: string } {
  const q = window.location.hash.split("?")[1];
  if (!q) return {};
  const p = new URLSearchParams(q);
  return { in: p.get("in") ?? undefined, out: p.get("out") ?? undefined };
}

/** Re-render once a second while `on`, so deadlines count down. */
function useSecond(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

function AssetField({ id, label, value, onChange, recents }: { id: string; label: string; value: string; onChange(v: string): void; recents: string[] }) {
  const parsed = parseAssetInput(value);
  const invalid = value.trim() !== "" && !parsed;
  return (
    <div className="mt-3">
      <label htmlFor={id} className="text-xs text-muted">{label}</label>
      <div className={cx("mt-1 flex items-center gap-2.5 rounded-xl bg-surface px-3 py-2 ring-1 focus-within:ring-2 focus-within:ring-accent", invalid ? "ring-bad" : "ring-line")}>
        {parsed && <AssetIcon asset={{ code: assetCode(parsed), id: parsed }} size={24} />}
        <input
          id={id}
          name={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="XLM, or paste CODE:ISSUER"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          aria-describedby={`${id}-help`}
          className="num min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      <p id={`${id}-help`} className={cx("mt-1 min-h-4 text-xs [overflow-wrap:anywhere]", invalid ? "text-bad" : "text-faint")}>
        {invalid ? "Paste the full CODE:ISSUER of a testnet asset, or type XLM." : parsed ? (parsed === "native" ? "XLM · the network's own asset" : `${assetCode(parsed)} · issuer ${shortKey(parsed.split(":")[1]!, 6)}`) : ""}
      </p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {recents.map((r) => (
          <button
            key={r}
            type="button"
            title={r}
            aria-label={`Use ${assetCode(r)} for ${label.toLowerCase()}`}
            onClick={() => onChange(r)}
            className={cx("num rounded-full px-3 py-2 text-xs ring-1 transition-colors duration-300 ease-spring hover:bg-shell sm:py-1", value.trim() === r ? "bg-accent-soft text-accent ring-accent" : "text-muted ring-line")}
          >
            {assetCode(r)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Rows({ rows }: { rows: { label: string; value: ReactNode; strong?: boolean; text?: boolean }[] }) {
  return (
    <dl className="divide-y divide-line rounded-2xl bg-sunken px-4 ring-1 ring-line">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-4 py-3">
          <dt className="text-sm text-muted">{r.label}</dt>
          <dd className={cx("min-w-0 text-right [overflow-wrap:anywhere]", r.text ? "" : "num", r.strong ? "text-base font-medium" : "text-sm")}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PanelHead({ title, tone, children }: { title: string; tone?: "bad"; children?: ReactNode }) {
  return (
    <div>
      <h2 className={cx("text-xl font-medium tracking-tight", tone === "bad" && "text-bad")}>{title}</h2>
      {children && <p className="mt-2 max-w-[60ch] text-sm text-muted">{children}</p>}
    </div>
  );
}

function TxLink({ network, hash }: { network: string; hash: string }) {
  const href = orderExplorerTx(network, hash);
  return (
    <span className="mt-3 flex flex-col gap-1 text-sm">
      {href && (
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline-offset-4 hover:underline">
          View on StellarExpert (testnet) <ArrowSquareOut size={14} weight="light" />
        </a>
      )}
      <code className="num text-xs break-all text-faint">{hash}</code>
    </span>
  );
}

interface Props { orders: Enabled; flow: Flow }

export default function SettleView({ orders, flow }: Props) {
  const wallet = useWallet();
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  const initial = useMemo(() => {
    const h = pairFromHash();
    const saved = load<{ in?: string; out?: string }>(PAIR, {});
    return { in: h.in ?? saved.in ?? "", out: h.out ?? saved.out ?? "" };
  }, []);
  const [assetIn, setAssetIn] = useState(initial.in);
  const [assetOut, setAssetOut] = useState(initial.out);
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(() => load("sluice.orders.slippage", 50));
  const [recents, setRecents] = useState<string[]>(() => load<string[]>(RECENT, []));
  useEffect(() => save("sluice.orders.slippage", slippageBps), [slippageBps]);

  // One controller for the life of this screen. Its dependencies read the current wallet through a ref.
  const tiersKey = (orders.signing.tiers ?? []).join(",");
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const controller = useMemo<OrderController>(() => {
    const deps: OrderDeps = {
      tiers: orders.signing.tiers,
      prepare: (req) => api.prepareOrder({ account: req.account, assetIn: req.assetIn, assetOut: req.assetOut, amount: req.amount, slippageBps: req.slippageBps }),
      // signOrder checks the entry against the order shown, asks the wallet, and verifies the signature locally.
      sign: (prepared) => signOrder(prepared, (preimage, o) => walletRef.current.signAuthEntry(preimage, o), { settleContract: orders.settleContract }),
      submit: (p) => api.submitOrder(p),
      // Tier 2: for wallets that sign a transaction, not an entry. signOrderTx reviews the whole transaction before the wallet is asked.
      prepareTx: (req) => api.prepareOrderTx({ account: req.account, assetIn: req.assetIn, assetOut: req.assetOut, amount: req.amount, slippageBps: req.slippageBps }),
      signTx: (prepared) => signOrderTx(prepared, (xdr, o) => walletRef.current.signOrderTransaction(xdr, o), { settleContract: orders.settleContract, solver: orders.solver }),
      submitTx: (p) => api.submitOrderTx(p),
      status: (h) => api.order(h),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
    };
    return createOrderController(deps);
  }, [orders.settleContract, orders.solver, tiersKey]);
  useEffect(() => {
    const off = controller.subscribe(() => rerender());
    return () => { off(); controller.dispose(); };
  }, [controller]);

  const state: OrderState = controller.state;
  // On a narrow screen the order panel sits below the form: bring it into view when the flow starts or changes.
  const panelRef = useRef<HTMLElement>(null);
  const phase = state.phase;
  useEffect(() => {
    if (phase === "idle" || phase === "signing" || phase === "submitting" || phase === "confirming") return;
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [phase]);
  const busy = state.phase !== "idle";
  const ticking = state.phase === "review" || state.phase === "signing" || state.phase === "rejected";
  const now = useSecond(ticking);
  useEffect(() => { if (ticking) controller.tick(); }, [now, ticking, controller]);

  // Leaving while an order is between signature and ledger loses the on-screen result, so ask first.
  const inFlight = state.phase === "signing" || state.phase === "submitting" || state.phase === "confirming";
  useEffect(() => {
    if (!inFlight) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [inFlight]);

  // An order belongs to the account it was prepared for.
  const reqAccount = "req" in state ? state.req.account : undefined;
  useEffect(() => {
    if (reqAccount && wallet.address !== reqAccount && (state.phase === "review" || state.phase === "rejected" || state.phase === "preparing")) controller.reset();
    if (reqAccount && wallet.address !== reqAccount && state.phase === "signing") controller.stopWaiting();
  }, [wallet.address, reqAccount, state.phase, controller]);

  const inId = parseAssetInput(assetIn);
  const outId = parseAssetInput(assetOut);
  const valid = isAmount(amount);
  const support = signingSupport(wallet.moduleId);
  const route = signingRoute(wallet.moduleId, orders.signing.tiers);
  const txOffered = (orders.signing.tiers ?? []).includes("tx");
  const max = orders.limits.maxOrderIn;
  const tooBig = valid && toStroops(amount) > toStroops(max);

  const start = () => {
    if (!wallet.address || !inId || !outId || !valid) return;
    save(PAIR, { in: inId, out: outId });
    const next = [inId, outId, ...recents].filter((v, i, a) => v !== "native" && a.indexOf(v) === i).slice(0, 6);
    setRecents(next);
    save(RECENT, next);
    void controller.prepare({ account: wallet.address, assetIn: inId, assetOut: outId, amount, slippageBps }, wallet.moduleId);
  };
  const again = () => {
    if ("req" in state) void controller.prepare(state.req, wallet.moduleId);
  };

  let action: { label: string; onClick?: () => void };
  if (flow.running) action = { label: "A swap is in progress" };
  else if (!wallet.address) action = { label: wallet.busy ? "Opening wallet…" : "Connect wallet", onClick: () => void wallet.connect() };
  else if (route === "none") action = { label: "Your wallet cannot sign orders" };
  else if (!inId) action = { label: "Choose the asset you pay" };
  else if (!outId) action = { label: "Choose the asset you receive" };
  else if (inId === outId) action = { label: "Pick two different assets" };
  else if (!amount) action = { label: "Enter an amount" };
  else if (!valid) action = { label: "Amount needs up to 7 decimals" };
  else if (tooBig) action = { label: `Largest order is ${fmt(max)}` };
  else action = { label: "Ask the solver for a price", onClick: start };

  const network = orders.network;
  const quoteRecents = ["native", ...recents.filter((r) => r !== "native")];

  return (
    <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
      <section className="min-w-0 lg:col-span-5">
        <div className="lg:sticky lg:top-28">
          <Eyebrow>Settle · Stellar {network}</Eyebrow>
          <h1 className="mt-4 text-4xl leading-[1.05] font-medium tracking-[-0.03em] sm:text-5xl">One signature. One atomic fill.</h1>
          <p className="mt-4 max-w-[46ch] text-muted">
            A solver fills your order and hedges the trade on the Stellar DEX. A contract refuses the fill if you would receive less than the minimum you signed. Most wallets sign a single authorisation and the solver pays the network fee. A wallet that cannot sign one signs a transaction instead, and you pay its fee.
          </p>

          <p role="note" className="mt-5 flex gap-3 rounded-2xl bg-warn-soft px-4 py-3 text-sm text-warn">
            <Flask size={20} weight="light" className="mt-0.5 shrink-0" />
            <span>
              <strong className="font-semibold">Testnet prototype, unaudited.</strong> This runs on the Stellar {network}, not mainnet, with test assets that have no value. The settlement contract has not been audited. Your wallet must be switched to {network}.
            </span>
          </p>

          <fieldset disabled={busy} className={cx("m-0 min-w-0 border-0 p-0 transition-opacity duration-500 ease-spring", busy && "opacity-60")}>
            <Bezel className="mt-6" core="p-2">
              <div className="rounded-[1.1rem] bg-sunken p-4">
                <label htmlFor="order-amount" className="text-sm text-muted">You pay</label>
                <input
                  id="order-amount"
                  name="order-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, ""))}
                  aria-invalid={amount !== "" && !valid}
                  aria-describedby="order-amount-help"
                  className="num mt-2 w-full min-w-0 bg-transparent text-3xl font-medium outline-none"
                />
                <p id="order-amount-help" className={cx("mt-1 min-h-5 text-xs", (amount !== "" && !valid) || tooBig ? "text-bad" : "text-faint")}>
                  {amount !== "" && !valid ? "Use digits and at most 7 decimal places." : tooBig ? `The solver takes orders up to ${fmt(max)} at a time.` : `Up to ${fmt(max)} per order.`}
                </p>
                <AssetField id="order-asset-in" label="Asset you pay" value={assetIn} onChange={setAssetIn} recents={quoteRecents} />
              </div>

              <div className="mt-2 rounded-[1.1rem] bg-sunken p-4">
                <div className="text-sm text-muted">You receive</div>
                <p className="mt-2 text-lg text-faint">Priced by the solver when you ask</p>
                <AssetField id="order-asset-out" label="Asset you receive" value={assetOut} onChange={setAssetOut} recents={quoteRecents} />
              </div>

              <fieldset className="mx-3 mt-4 border-0 p-0">
                <legend className="text-sm text-muted">Your minimum, below the solver&apos;s price by at most</legend>
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

              <div className="p-2 pt-4">
                <PrimaryButton onClick={action.onClick} disabled={!action.onClick} busy={wallet.busy && !wallet.address}>{action.label}</PrimaryButton>
              </div>
            </Bezel>
          </fieldset>

          {wallet.address && route === "none" && state.phase === "idle" && <UnsupportedNotice className="mt-3" />}
          {wallet.address && route === "transaction" && state.phase === "idle" && <TransactionRouteNotice className="mt-3" />}
          {wallet.address && support === "unknown" && state.phase === "idle" && <Notice tone="neutral" className="mt-3">{UNKNOWN_WALLET_NOTE}</Notice>}
          {wallet.error && <Notice tone="bad" className="mt-3">{wallet.error}</Notice>}
          <p className="mt-4 px-2 text-xs text-faint">
            Sluice never holds your keys. You approve the order in your own wallet; the solver {shortKey(orders.solver, 5)} fills it.
          </p>
        </div>
      </section>

      <section ref={panelRef} className="min-w-0 scroll-mt-24 lg:col-span-7" aria-label="Order">
        <Panel
          state={state}
          controller={controller}
          orders={orders}
          now={now}
          wallet={wallet}
          support={support}
          route={route}
          txOffered={txOffered}
          again={again}
        />
      </section>
    </div>
  );
}

function UnsupportedNotice({ className }: { className?: string }) {
  return (
    <div className={cx("rounded-2xl bg-warn-soft px-4 py-3 text-sm text-warn", className)}>
      <p>{UNSUPPORTED_WALLET_MESSAGE}</p>
      <a href="#/" className="mt-2 inline-block font-medium underline underline-offset-4">Use the standard swap</a>
    </div>
  );
}

/** Shown to a wallet that cannot sign an authorisation: it will sign a transaction instead. Says what changes and what does not. */
function TransactionRouteNotice({ className }: { className?: string }) {
  return (
    <div role="note" className={cx("flex gap-2.5 rounded-2xl bg-shell px-4 py-3 text-sm text-muted", className)}>
      <Info size={18} weight="light" className="mt-0.5 shrink-0" />
      <p>
        Your wallet cannot sign an authorisation, so this order is signed as a transaction from your account instead. It is still one atomic fill, and the contract still refuses it if you would receive less than your minimum. What changes: you send the transaction, so <strong className="font-medium text-ink">you pay its network fee in XLM</strong>. The fee is shown before you sign.
      </p>
    </div>
  );
}

function Panel({ state, controller, orders, now, wallet, support, route, txOffered, again }: {
  state: OrderState;
  controller: OrderController;
  orders: Enabled;
  now: number;
  wallet: ReturnType<typeof useWallet>;
  support: ReturnType<typeof signingSupport>;
  /** How this wallet would sign a new order on this deployment. */
  route: SigningRoute;
  /** The server offers tier 2 (the user signs a transaction). */
  txOffered: boolean;
  again(): void;
}) {
  const net = orders.network;
  const edit = <QuietButton onClick={controller.reset}>Edit the order</QuietButton>;

  switch (state.phase) {
    case "idle":
      return <Explainer />;

    case "preparing":
      return (
        <Bezel className="animate-rise" core="p-5 sm:p-7">
          <div aria-live="polite" aria-busy="true">
            <div className="flex items-center gap-3 text-muted">
              <CircleNotch size={18} weight="light" className="animate-spin" />
              <span>Asking the solver for a price on the {net}…</span>
            </div>
            <div className="skeleton mt-5 h-40" />
          </div>
        </Bezel>
      );

    case "review":
    case "signing":
    case "rejected":
      return <Review state={state} controller={controller} orders={orders} now={now} support={support} moduleId={wallet.moduleId} />;

    case "submitting":
    case "confirming": {
      const tx = isTxPrepared(state.prepared);
      return (
        <Bezel className="animate-rise" core="p-5 sm:p-7">
          <ol className="divide-y divide-line" aria-live="polite">
            <StepRow s={{ id: "signed", title: "Signed in your wallet", status: "done", detail: tx ? "You signed one transaction from your account. It has not been sent yet." : "Only the authorisation was signed. No transaction was made from your account." }} />
            <StepRow
              s={{
                id: "sent",
                title: "Sent to the solver",
                status: state.phase === "submitting" ? "active" : "done",
                detail: state.phase === "submitting"
                  ? (tx ? "The server is checking the whole transaction and simulating the fill." : "The solver is checking the signature and simulating the fill.")
                  : (tx ? "The transaction was sent. The network fee is charged to your account." : "The solver submitted the fill and pays its fee."),
                hash: undefined,
              }}
            />
            <StepRow s={{ id: "ledger", title: "Waiting for the fill to settle", status: "active", detail: state.phase === "confirming" ? "Usually a few seconds." : undefined }} />
          </ol>
          {state.phase === "confirming" && <TxLink network={net} hash={state.hash} />}
        </Bezel>
      );
    }

    case "filled": {
      const p = state.prepared;
      const out = assetCode(p.order.assetOut);
      const hedge = hedgeText(state.hedge);
      const feeRow = isTxPrepared(p)
        ? { label: "Network fee you paid, at most", value: `${fmt(p.summary.networkFee, 7)} XLM (charged to your account)`, text: true }
        : { label: "Fee you paid", value: "None (the solver paid it)", text: true };
      return (
        <Bezel className="animate-rise" core="p-5 sm:p-7">
          <div aria-live="polite">
            <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent"><Check size={20} weight="light" /></span>
            <h2 className="mt-4 text-xl font-medium tracking-tight">Order filled</h2>
            <p className="num mt-2 text-3xl font-medium">
              {state.received !== undefined ? <>{fmt(state.received)} <span className="text-lg text-muted">{out}</span></> : <span className="text-lg text-muted">Amount not readable</span>}
            </p>
            <p className="mt-1 text-sm text-muted">
              {state.received !== undefined ? "Received, read from the fill on the ledger." : "The fill settled, but the amount could not be read. Check your balance."}
            </p>
            <div className="mt-5">
              <Rows
                rows={[
                  { label: "You paid", value: `${fmt(p.order.amountIn)} ${assetCode(p.order.assetIn)}`, strong: true },
                  { label: "Your minimum was", value: `${fmt(p.order.minOut)} ${out}` },
                  feeRow,
                  ...(state.ledger ? [{ label: "Ledger", value: String(state.ledger) }] : []),
                ]}
              />
            </div>
            <p className={cx("mt-4 flex gap-2.5 rounded-2xl px-4 py-3 text-sm", hedge.tone === "warn" ? "bg-warn-soft text-warn" : "bg-shell text-muted")}>
              {hedge.tone === "wait" ? <CircleNotch size={18} weight="light" className="mt-0.5 shrink-0 animate-spin" /> : hedge.tone === "ok" ? <Check size={18} weight="light" className="mt-0.5 shrink-0" /> : <Warning size={18} weight="light" className="mt-0.5 shrink-0" />}
              <span>{hedge.label}</span>
            </p>
            <TxLink network={net} hash={state.hash} />
            <div className="mt-6"><QuietButton onClick={controller.reset}>New order</QuietButton></div>
          </div>
        </Bezel>
      );
    }

    case "declined":
      return (
        <Bezel className="animate-rise" core="p-5 sm:p-7">
          <div aria-live="polite">
            <PanelHead title="No solver will fill this order right now">
              Nothing was prepared, so there is nothing to sign and nothing was sent. Try a smaller amount or another pair.
            </PanelHead>
            <ul className="mt-4 space-y-2 text-sm">
              {state.reasons.map((r) => (
                <li key={r} className="flex gap-2.5 rounded-2xl bg-sunken px-4 py-3 ring-1 ring-line">
                  <Info size={18} weight="light" className="mt-0.5 shrink-0 text-muted" />
                  <span>{reasonText(r)}</span>
                </li>
              ))}
            </ul>
            {(state.summary.classicQuote || state.summary.solverMaxPay) && (
              <div className="mt-4">
                <Rows
                  rows={[
                    { label: "You asked to pay", value: `${fmt(state.summary.pay)} ${assetCode(state.req.assetIn)}` },
                    ...(state.summary.classicQuote ? [{ label: "Classic order book alone would pay", value: `${fmt(state.summary.classicQuote)} ${assetCode(state.req.assetOut)}` }] : []),
                    ...(state.summary.solverMaxPay ? [{ label: "Most the solver could pay at this size", value: `${fmt(state.summary.solverMaxPay)} ${assetCode(state.req.assetOut)}` }] : []),
                  ]}
                />
              </div>
            )}
            <div className="mt-6 flex flex-wrap gap-2">{edit}<QuietButton onClick={again}>Ask again</QuietButton></div>
          </div>
        </Bezel>
      );

    case "expired":
      return (
        <Bezel className="animate-rise" core="p-5 sm:p-7">
          <div aria-live="polite">
            <PanelHead title="This order expired">
              {state.during === "review"
                ? "The price was only good for a few minutes and its time ran out before you signed. Nothing was signed or sent."
                : state.during === "signing"
                  ? "The order ran out of time while your wallet was open. Anything the wallet signed now is of no use, and nothing was sent."
                  : "The order ran out of time before the solver could send it. Nothing was sent."}
            </PanelHead>
            <p className="mt-3 max-w-[60ch] text-sm text-muted">A new price needs a new signature, so you will be asked to sign again.</p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <PrimaryButton className="sm:w-auto" onClick={again}>Get a new price</PrimaryButton>
              {edit}
            </div>
          </div>
        </Bezel>
      );

    case "unsupported": {
      // The wallet refused to sign an authorisation entry, and the server offers the transaction route: offer it. (A wallet already
      // known not to sign entries goes to that route before this point and never lands here.)
      const canSwitch = txOffered && state.tried === "auth-entry";
      const tried = state.tried === "transaction";
      return (
        <Bezel className="animate-rise" core="p-5 sm:p-7">
          <div aria-live="polite">
            <PanelHead title={tried ? "Your wallet could not sign this order" : UNSUPPORTED_WALLET_TITLE}>
              {canSwitch
                ? "Nothing was signed or sent. Your wallet reported that it does not sign authorisations, but it can sign a transaction instead."
                : tried
                  ? "Your wallet reported that it does not support signing a transaction either. Nothing was signed or sent. Use the standard swap, or connect a different wallet."
                  : <>Use Freighter (listed as Varial in newer wallet pickers), or the standard swap. Nothing was signed or sent.{" "}
                    {state.at === "call" ? "The wallet reported that it does not support signing this kind of request." : "This is decided from which wallet is connected, before anything is asked of it."}</>}
            </PanelHead>
            {canSwitch ? (
              <p className="mt-3 max-w-[60ch] text-sm text-muted">
                It is the same atomic fill and the contract still enforces your minimum. The difference is that you send the transaction, so you pay its network fee in XLM. You will see the fee before you sign.
              </p>
            ) : (
              <p className="mt-3 max-w-[60ch] text-sm text-muted">
                Settlement orders are signed as a Soroban authorisation, which only some wallets support so far. Freighter does. The standard swap still works with every wallet.
              </p>
            )}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              {canSwitch ? (
                <PrimaryButton className="sm:w-auto" onClick={() => void controller.prepare(state.req, wallet.moduleId, "transaction")}>Sign it as a transaction instead</PrimaryButton>
              ) : (
                <a href="#/" className="inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-accent-ink transition-[transform,filter] duration-500 ease-spring hover:brightness-110 active:scale-[0.985]">Use the standard swap</a>
              )}
              <QuietButton onClick={() => void wallet.disconnect().then(() => wallet.connect())}>Connect a different wallet</QuietButton>
              {edit}
            </div>
          </div>
        </Bezel>
      );
    }

    case "failed":
      return (
        <Bezel className="animate-rise" core="p-5 sm:p-7">
          <div aria-live="polite">
            <PanelHead title={state.failure.title} tone="bad">{state.failure.message}</PanelHead>
            {state.failure.detail && (
              <details className="mt-3 text-sm text-faint">
                <summary className="cursor-pointer select-none">Technical detail</summary>
                <code className="num mt-2 block rounded-xl bg-sunken p-3 text-xs break-all">{state.failure.code}: {state.failure.detail}</code>
              </details>
            )}
            {state.hash && <TxLink network={net} hash={state.hash} />}
            <div className="mt-6 flex flex-wrap gap-2"><QuietButton onClick={again}>Prepare again</QuietButton>{edit}</div>
          </div>
        </Bezel>
      );

    case "unconfirmed": {
      const acct = orderExplorerAccount(net, state.req.account);
      return (
        <Bezel className="animate-rise" core="p-5 sm:p-7">
          <div aria-live="polite">
            <PanelHead title="We could not confirm this order">
              {state.reason === "timeout"
                ? "The order was sent but has not shown up in a ledger yet. It may still fill."
                : "The server did not answer after you signed, so we cannot say whether the order was sent."}{" "}
              Check before you try again: your account&apos;s activity will show a fill if there was one.
            </PanelHead>
            {state.hash && <TxLink network={net} hash={state.hash} />}
            {acct && (
              <a href={acct} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-accent underline-offset-4 hover:underline">
                Open your account on StellarExpert (testnet) <ArrowSquareOut size={14} weight="light" />
              </a>
            )}
            <p className="mt-3 max-w-[60ch] text-sm text-muted">A signed order can be used once, so a new order will not repeat an old one.</p>
            <div className="mt-6"><QuietButton onClick={controller.reset}>Start over</QuietButton></div>
          </div>
        </Bezel>
      );
    }
  }
}

function Review({ state, controller, orders, now, support, moduleId }: {
  state: Extract<OrderState, { phase: "review" | "signing" | "rejected" }>;
  controller: OrderController;
  orders: Enabled;
  now: number;
  support: ReturnType<typeof signingSupport>;
  moduleId: string | undefined;
}) {
  const p = state.prepared;
  const tx = isTxPrepared(p);
  const o = p.order;
  const left = expiry(p, now);
  const signing = state.phase === "signing";
  const rejected = state.phase === "rejected";
  const outCode = assetCode(o.assetOut);
  const until = new Date(goodUntil(p) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <Bezel className="animate-rise" core="p-5 sm:p-7">
      <div aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-medium tracking-tight">Review the order</h2>
          <Tag tone="warn"><Flask size={13} weight="light" />Testnet · unaudited</Tag>
        </div>
        <p className="mt-2 max-w-[60ch] text-sm text-muted">
          {tx
            ? "The solver will fill this if you sign and send it. This is what the transaction does, worked out here from the transaction itself, not copied from your wallet."
            : "The solver will fill this if you sign it. This is what you would be authorising, worked out here from the order itself, not copied from your wallet."}
        </p>
        {tx && (
          <p className="mt-3 flex gap-2.5 rounded-2xl bg-shell px-4 py-3 text-sm text-muted">
            <Info size={18} weight="light" className="mt-0.5 shrink-0" />
            <span>Signed as a transaction from your account, because your wallet cannot sign an authorisation. It is still one atomic fill that the contract enforces. <strong className="font-medium text-ink">You pay the network fee.</strong></span>
          </p>
        )}

        {rejected && (
          <p className="mt-4 flex gap-2.5 rounded-2xl bg-shell px-4 py-3 text-sm">
            <Info size={18} weight="light" className="mt-0.5 shrink-0 text-muted" />
            <span>{state.stopped ? "You stopped waiting for the wallet." : "You declined the request in your wallet."} Nothing was signed or sent. The order below is still good until it expires.</span>
          </p>
        )}

        <div className={cx("mt-5 transition-opacity duration-500 ease-spring", signing && "opacity-60")}>
          <Rows
            rows={[
              { label: "You pay", value: `${fmt(o.amountIn)} ${assetCode(o.assetIn)}`, strong: true },
              { label: "You receive at least", value: `${fmt(o.minOut)} ${outCode}`, strong: true },
              { label: "The solver expects to pay", value: `${fmt(p.summary.expected)} ${outCode}` },
              { label: "Good until", value: `${until} · ${left.expired ? "expired" : countdown(left.secondsLeft) + " left"}`, text: true },
              tx
                ? { label: "Network fee you pay, at most", value: `${fmt(p.summary.networkFee, 7)} XLM`, text: true, strong: true }
                : { label: "Network fee to you", value: "None. The solver pays it.", text: true },
              { label: "Network", value: `Stellar ${orders.network}`, text: true },
              { label: "Your account", value: shortKey(o.user, 6) },
            ]}
          />
        </div>
        <p className="mt-3 text-xs text-faint">The contract refuses the fill if your balance of {outCode} would grow by less than the minimum above. You can receive more, never less.</p>

        {o.createTrustline && (
          <p className="mt-4 flex gap-2.5 rounded-2xl bg-warn-soft px-4 py-3 text-sm text-warn">
            <Warning size={18} weight="light" className="mt-0.5 shrink-0" />
            <span>Your account has no trustline for {outCode}. Signing this also adds it. That raises your account&apos;s minimum XLM balance by 0.5 XLM (a reserve you can get back by removing the trustline, not a fee).</span>
          </p>
        )}

        <div className="mt-4 rounded-2xl bg-sunken p-4 text-sm ring-1 ring-line">
          <p className="flex items-center gap-2 font-medium"><PenNib size={18} weight="light" className="text-accent" />What your wallet will show</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
            {tx ? (
              <>
                <li>It will ask you to sign a <strong className="font-medium text-ink">transaction</strong> from your account: one contract call to the settlement contract. The fee above comes out of your account in XLM.</li>
                <li>It shows the contract call as raw values, not as a swap, and some wallets warn that they cannot read it (a Ledger needs blind signing turned on). Amounts are in units of 0.0000001, so {fmt(o.amountIn)} appears as {toStroops(o.amountIn).toString()}.</li>
                <li>Compare them with the figures above. If they differ, decline. Your wallet must be on the {orders.network} network.</li>
              </>
            ) : (
              <>
                <li>It will ask you to <strong className="font-medium text-ink">“Confirm Authorizations”</strong>, not to confirm a transaction. You send no transaction and pay no fee.</li>
                <li>It shows the contract call as raw values, not as a swap. Amounts are in units of 0.0000001, so {fmt(o.amountIn)} appears as {toStroops(o.amountIn).toString()}.</li>
                <li>Compare them with the figures above. If they differ, decline.</li>
              </>
            )}
          </ul>
          <details className="mt-3">
            <summary className="cursor-pointer select-none text-muted">Raw values to compare</summary>
            <dl className="mt-2 space-y-1.5">
              {rawValues(p).map((r) => (
                <div key={r.label} className="grid gap-x-3 sm:grid-cols-[11rem_1fr]">
                  <dt className="text-xs text-faint">{r.label}</dt>
                  <dd className="num text-xs break-all">{r.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>

        {!tx && support === "unknown" && !signing && <Notice tone="neutral" className="mt-4">{UNKNOWN_WALLET_NOTE}</Notice>}

        {signing ? (
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl bg-sunken px-4 py-3 text-sm text-muted ring-1 ring-line">
            <CircleNotch size={18} weight="light" className="shrink-0 animate-spin" />
            <span className="min-w-0 flex-1">Approve it in your wallet. Closed the wallet window, or nothing opened? Stop here: nothing is sent unless you approve.</span>
            <QuietButton onClick={controller.stopWaiting}>Stop waiting</QuietButton>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-3">
            {left.expired ? (
              <Notice tone="warn">This order has run out of time.</Notice>
            ) : (
              <PrimaryButton onClick={() => { if (rejected) controller.reviewAgain(); void controller.sign(moduleId); }}>
                {rejected ? "Ask my wallet again" : tx ? "Sign transaction in wallet" : "Sign in wallet"}
              </PrimaryButton>
            )}
            <div className="flex flex-wrap gap-2">
              <QuietButton onClick={controller.reset}>Cancel</QuietButton>
              <span className="inline-flex items-center gap-1.5 px-1 text-xs text-faint"><Clock size={14} weight="light" />A new price needs a new signature.</span>
            </div>
          </div>
        )}
      </div>
    </Bezel>
  );
}

function Explainer() {
  const points = [
    { icon: PenNib, title: "You sign an authorisation", body: "Not a transaction. Your account sends nothing and pays no fee. The signature covers one order: this amount, this minimum, this deadline." },
    { icon: Receipt, title: "A solver fills it and hedges", body: "The solver submits the fill, receives what you pay, pays you from its own balance and sells the position on the Stellar DEX. If it cannot, you are told before you sign." },
    { icon: ShieldCheck, title: "The contract enforces your minimum", body: "If the solver would pay you less than you signed for, the contract refuses the fill and nothing moves. The signature is single-use and expires." },
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
