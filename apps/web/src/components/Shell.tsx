import { ArrowSquareOut, Check, Copy, SignOut, Wallet, Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { AccountState } from "../lib/data";
import { assetCode, cx, explorerAccount, explorerTx, fmt, shortKey } from "../lib/format";
import { runLeg2 } from "../lib/flow";
import { load, loadPending, save, savePending } from "../lib/store";
import { useWallet } from "../lib/wallet";
import type { Flow } from "./FlowPanel";
import { PrimaryButton, QuietButton } from "./ui";

export type Tab = "swap" | "earn";

function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <rect width="32" height="32" rx="9" className="fill-accent" />
      <path d="M9 9.25h9.5a3.5 3.5 0 0 1 0 7H13.5a3.5 3.5 0 0 0 0 7H23" fill="none" strokeWidth="2.2" strokeLinecap="round" className="stroke-accent-ink" />
    </svg>
  );
}

function WalletButton({ account }: { account: AccountState }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (!wallet.address) {
    return (
      <button
        type="button"
        onClick={() => void wallet.connect()}
        disabled={wallet.busy}
        className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-[transform,filter,opacity] duration-500 ease-spring hover:brightness-110 active:scale-[0.97] disabled:opacity-60"
      >
        <Wallet size={17} weight="light" />
        <span className="hidden sm:inline">{wallet.busy ? "Wallet…" : "Connect wallet"}</span>
        <span className="sm:hidden">{wallet.busy ? "…" : "Connect"}</span>
      </button>
    );
  }
  const address = wallet.address;
  const xlm = account.data?.balances.find((b) => b.asset === "native")?.balance;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the address is visible in the menu to copy by hand */
    }
  };
  const item = "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition-colors duration-300 ease-spring hover:bg-shell";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-full bg-shell py-2 pr-4 pl-3 text-sm font-medium ring-1 ring-line transition-transform duration-500 ease-spring active:scale-[0.97]"
      >
        <span className="size-2 rounded-full bg-accent" aria-hidden />
        <span className="num">{shortKey(address)}</span>
        {xlm && <span className="hidden text-muted md:inline"><span className="num">{fmt(xlm, 2)}</span> XLM</span>}
      </button>
      <div
        role="menu"
        className={cx(
          "absolute right-0 z-30 mt-2 w-72 origin-top-right rounded-2xl bg-surface p-2 shadow-float ring-1 ring-line transition-[opacity,transform,visibility] duration-300 ease-spring",
          open ? "visible scale-100 opacity-100" : "pointer-events-none invisible scale-95 opacity-0",
        )}
      >
        <p className="num px-3 pt-2 pb-3 text-xs break-all text-muted">{address}</p>
        <button type="button" role="menuitem" tabIndex={open ? 0 : -1} onClick={() => void copy()} className={item}>
          {copied ? <Check size={16} weight="light" className="text-accent" /> : <Copy size={16} weight="light" />}
          {copied ? "Copied" : "Copy address"}
        </button>
        <a role="menuitem" tabIndex={open ? 0 : -1} href={explorerAccount(address)} target="_blank" rel="noreferrer" className={item}>
          <ArrowSquareOut size={16} weight="light" /> View account on StellarExpert
        </a>
        <button type="button" role="menuitem" tabIndex={open ? 0 : -1} onClick={() => { setOpen(false); void wallet.disconnect(); }} className={item}>
          <SignOut size={16} weight="light" /> Disconnect
        </button>
      </div>
    </div>
  );
}

/** Floating island: detached from the viewport edge, glass over the page (fixed, so the blur is cheap). */
export function Nav({ tab, account }: { tab: Tab; account: AccountState }) {
  const link = (t: Tab, label: string) => (
    <a
      href={t === "swap" ? "#/" : "#/earn"}
      aria-current={tab === t ? "page" : undefined}
      className={cx("rounded-full px-4 py-2 text-sm font-medium transition-colors duration-500 ease-spring", tab === t ? "bg-surface text-ink shadow-float ring-1 ring-line" : "text-muted hover:text-ink")}
    >
      {label}
    </a>
  );
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex justify-center px-3 pt-4 sm:pt-6">
      <nav aria-label="Main" className="pointer-events-auto flex w-full max-w-3xl items-center justify-between gap-2 rounded-full bg-(--overlay) p-1.5 ring-1 ring-line backdrop-blur-xl">
        <a href="#/" className="flex items-center gap-2.5 rounded-full py-1 pr-3 pl-1.5" aria-label="Sluice, go to swap">
          <Mark />
          <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">Sluice</span>
        </a>
        <div className="flex items-center gap-1 rounded-full bg-shell p-1">
          {link("swap", "Swap")}
          {link("earn", "Earn")}
        </div>
        <WalletButton account={account} />
      </nav>
    </header>
  );
}

const ACK = "sluice.riskAck";

/** Said once, plainly, before anyone moves money. Not a modal: it does not block reading the page. */
export function RiskNotice() {
  const [seen, setSeen] = useState(() => load(ACK, false));
  if (seen) return null;
  return (
    <aside className="mb-8 flex animate-rise flex-col gap-4 rounded-3xl bg-warn-soft p-5 text-warn sm:flex-row sm:items-center sm:justify-between">
      <p className="flex gap-3 text-sm">
        <Warning size={20} weight="light" className="mt-0.5 shrink-0" />
        <span className="max-w-[80ch]">
          This is Stellar mainnet: swaps and deposits move real funds and cannot be reversed. Sluice is open-source software that has not been independently audited. It never holds your keys or funds; you approve every transaction in your own wallet. Start with an amount you can afford to lose.
        </span>
      </p>
      <QuietButton className="shrink-0 self-start ring-warn/40 hover:bg-warn/10 sm:self-auto" onClick={() => { save(ACK, true); setSeen(true); }}>I understand</QuietButton>
    </aside>
  );
}

/** A two-transaction route left half way (tab closed, wallet prompt dismissed). Offers the way forward again. */
export function PendingBanner({ flow, onResume }: { flow: Flow; onResume(): void }) {
  const wallet = useWallet();
  const [, bump] = useState(0);
  const pending = loadPending(wallet.address);
  if (!pending || flow.active) return null;
  return (
    <aside className="mb-8 animate-rise rounded-3xl bg-surface p-5 shadow-float ring-1 ring-line">
      <h2 className="text-lg font-medium tracking-tight">You have an unfinished route</h2>
      <p className="mt-1 max-w-[70ch] text-sm text-muted">
        Leg 1 of a two-transaction swap from {assetCode(pending.from)} to {assetCode(pending.to)} settled and delivered{" "}
        <span className="text-ink"><span className="num">{fmt(pending.heldAmount)}</span> {assetCode(pending.held)}</span>, which is in your account.{" "}
        <a href={explorerTx(pending.leg1Hash)} target="_blank" rel="noreferrer" className="text-accent underline-offset-4 hover:underline">View leg 1</a>
      </p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <PrimaryButton className="sm:w-auto" onClick={() => { onResume(); flow.start((io) => runLeg2(io, pending)); }}>Continue: finish or unwind</PrimaryButton>
        <QuietButton onClick={() => { savePending(null); bump((n) => n + 1); }}>Keep {assetCode(pending.held)} and dismiss</QuietButton>
      </div>
    </aside>
  );
}

/** Where the source lives. A fork or a mirror builds with VITE_REPO_URL set to its own address. */
const REPO = (import.meta.env.VITE_REPO_URL as string | undefined) || "https://github.com/funmilayo-ui/sluice";

export function Footer() {
  return (
    <footer className="mx-auto mt-24 w-full max-w-6xl px-4 pb-12 text-sm text-muted sm:px-6">
      <div className="flex flex-col gap-4 border-t border-line pt-8 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-[60ch]">
          Sluice is an open-source router for Stellar liquidity. Quotes come live from the Stellar DEX, Aquarius, Soroswap, Phoenix and Comet; lending data from Blend. It runs no order book and takes no fee.
        </p>
        <ul className="flex shrink-0 flex-wrap gap-x-6 gap-y-2">
          <li><a href={REPO} target="_blank" rel="noreferrer" className="-my-2 inline-block py-2 underline-offset-4 hover:text-ink hover:underline">Source code</a></li>
          <li><a href="/health" className="-my-2 inline-block py-2 underline-offset-4 hover:text-ink hover:underline">API status</a></li>
          <li><a href="https://stellar.expert/explorer/public" target="_blank" rel="noreferrer" className="-my-2 inline-block py-2 underline-offset-4 hover:text-ink hover:underline">StellarExpert</a></li>
        </ul>
      </div>
    </footer>
  );
}
