import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, SluiceError, type AssetInfo, type ListedAsset } from "../lib/api";
import type { AccountState, Assets, StableLookup } from "../lib/data";
import { useDebounced } from "../lib/data";
import { cx, fmt, shortKey } from "../lib/format";
import { StableBadge } from "./StableBadge";
import { AssetIcon, Notice } from "./ui";

const PASTED = /^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/;

interface Props {
  open: boolean;
  title: string;
  onClose(): void;
  onPick(id: string): void;
  assets: Assets;
  account: AccountState;
  stable: StableLookup;
  /** Asset on the other side of the pair: shown, but picking it swaps the sides instead of making a same-asset pair. */
  other?: string;
  /** Restrict the list (for example to what a vault accepts or what the wallet holds). */
  only?: (id: string) => boolean;
}

/** Second line of a row: the asset's name when it adds something to the code, then who issues it. */
function subtitle(a: ListedAsset): string {
  const name = a.name && a.name.toLowerCase() !== a.code.toLowerCase() ? a.name : undefined;
  const who = a.domain ?? (a.issuer ? `Issuer ${shortKey(a.issuer, 6)}` : undefined);
  return [name, who].filter(Boolean).join(" · ");
}

function AssetRow({ a, balance, other, stable, onPick }: { a: ListedAsset; balance: string | undefined; other: boolean; stable: StableLookup; onPick(id: string): void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(a.id)}
        className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-300 ease-spring hover:bg-shell"
      >
        <AssetIcon asset={a} size={34} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-medium">{a.code}</span>
            <StableBadge scored={stable(a.id)} plain />
            {other && <span className="text-xs text-faint">other side</span>}
          </span>
          <span className="block truncate text-xs text-muted">{subtitle(a)}</span>
        </span>
        {balance !== undefined && <span className="num text-sm text-muted">{fmt(balance)}</span>}
      </button>
    </li>
  );
}

export function AssetPicker({ open, title, onClose, onPick, assets, account, stable, other, only }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      d.showModal();
      // A dialog focuses its first control (the close button); typing to search is what people came to do.
      search.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const q = query.trim();
  const rows = useMemo(() => {
    const needle = q.toLowerCase();
    const held = new Set((account.data?.balances ?? []).map((b) => b.asset));
    // Assets the wallet holds that no public list carries are still theirs to trade.
    const extra = [...held].filter((id) => !assets.assets.some((a) => a.id === id)).map((id) => assets.describe(id));
    const all = [...assets.assets, ...extra].filter((a) => !only || only(a.id));
    const match = (a: ListedAsset) =>
      !needle || a.code.toLowerCase().includes(needle) || a.name?.toLowerCase().includes(needle) || a.domain?.toLowerCase().includes(needle) || a.id.toLowerCase() === needle || a.issuer?.toLowerCase() === needle;
    const hit = all.filter(match);
    const amount = (a: ListedAsset) => Number(account.data?.balances.find((b) => b.asset === a.id)?.balance ?? 0);
    return {
      mine: hit.filter((a) => held.has(a.id) || (a.id === "native" && !!account.data)).sort((x, y) => amount(y) - amount(x)),
      rest: hit.filter((a) => !held.has(a.id) && !(a.id === "native" && !!account.data)),
    };
  }, [q, assets, account.data, only]);

  // A pasted CODE:ISSUER that no list carries: confirm it exists on mainnet before offering it.
  const pasted = PASTED.test(q) && !assets.assets.some((a) => a.id === q) ? q : null;
  const lookupKey = useDebounced(pasted, 300);
  const [lookup, setLookup] = useState<{ id: string; info?: AssetInfo; error?: string }>();
  useEffect(() => {
    if (!lookupKey) {
      setLookup(undefined);
      return;
    }
    let cancelled = false;
    setLookup({ id: lookupKey });
    api.asset(lookupKey)
      .then((info) => { if (!cancelled) setLookup({ id: lookupKey, info }); })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLookup({ id: lookupKey, error: e instanceof SluiceError && e.status === 404 ? "No asset with that code and issuer exists on Stellar mainnet." : "Could not check this asset right now. Try again." });
      });
    return () => { cancelled = true; };
  }, [lookupKey]);

  const pick = (id: string) => {
    onPick(id);
    onClose();
  };
  const balanceOf = (id: string) => account.data?.balances.find((b) => b.asset === id)?.balance;
  const addPasted = (info: AssetInfo) => {
    assets.addCustom({ id: info.id, code: info.code, issuer: info.issuer, contract: info.contract, lists: [] });
    pick(info.id);
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-label={title}
      className="m-auto w-[min(30rem,calc(100vw-1.5rem))] rounded-[1.75rem] bg-transparent p-0 open:animate-rise"
    >
      <div className="flex max-h-[min(40rem,calc(100dvh-3rem))] flex-col rounded-[1.75rem] bg-surface shadow-float ring-1 ring-line">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-lg font-medium tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 place-items-center rounded-full text-muted transition-colors duration-300 ease-spring hover:bg-shell hover:text-ink">
            <X size={18} weight="light" />
          </button>
        </div>
        <label className="mx-5 mt-4 flex items-center gap-2.5 rounded-2xl bg-sunken px-4 py-3 ring-1 ring-line focus-within:ring-accent">
          <MagnifyingGlass size={18} weight="light" className="text-faint" />
          <span className="sr-only">Search assets</span>
          <input
            ref={search}
            name="asset-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, or paste CODE:ISSUER"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent text-[15px] outline-none"
          />
        </label>

        <div className="scroll-thin mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {assets.partial.length > 0 && (
            <Notice tone="neutral" className="mx-3 mb-2">Some public asset lists did not answer ({assets.partial.map((p) => p.source).join(", ")}). You can still paste any CODE:ISSUER.</Notice>
          )}
          {pasted && (
            <div className="mx-3 mb-2 rounded-2xl bg-sunken p-4 text-sm ring-1 ring-line">
              {!lookup || (lookup.id === pasted && !lookup.info && !lookup.error) ? (
                <span className="text-muted">Checking this asset on mainnet…</span>
              ) : lookup.error ? (
                <span className="text-bad">{lookup.error}</span>
              ) : lookup.info ? (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <span className="font-medium">{lookup.info.code}</span>
                    <span className="block text-xs text-muted">
                      Issuer {shortKey(lookup.info.issuer ?? "", 6)} · {fmt(String(lookup.info.holders ?? 0), 0)} holders
                      {lookup.info.authRequired ? " · issuer must authorise holders" : ""}{lookup.info.clawback ? " · issuer can claw back" : ""}
                    </span>
                  </span>
                  <button type="button" onClick={() => addPasted(lookup.info!)} className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform duration-500 ease-spring active:scale-[0.97]">
                    Use this asset
                  </button>
                </div>
              ) : null}
            </div>
          )}
          {assets.loading && <div className="skeleton mx-3 h-40" />}
          {rows.mine.length > 0 && (
            <>
              <h3 className="px-4 pt-2 pb-1 text-xs font-medium text-faint">In your wallet</h3>
              <ul>{rows.mine.map((a) => <AssetRow key={a.id} a={a} balance={balanceOf(a.id)} other={a.id === other} stable={stable} onPick={pick} />)}</ul>
            </>
          )}
          {rows.rest.length > 0 && (
            <>
              <h3 className={cx("px-4 pb-1 text-xs font-medium text-faint", rows.mine.length ? "pt-4" : "pt-2")}>{rows.mine.length ? "Other assets" : "Assets"}</h3>
              <ul>{rows.rest.map((a) => <AssetRow key={a.id} a={a} balance={balanceOf(a.id)} other={a.id === other} stable={stable} onPick={pick} />)}</ul>
            </>
          )}
          {!assets.loading && !pasted && rows.mine.length + rows.rest.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">Nothing matches “{q}”. Paste a full CODE:ISSUER to use any asset on Stellar.</p>
          )}
        </div>
      </div>
    </dialog>
  );
}
