import { CaretDown, Info } from "@phosphor-icons/react";
import { useState } from "react";
import type { Vault, VaultReserve } from "../lib/api";
import { usePositions, useQuote, useVaults, type AccountState, type Assets, type StableLookup } from "../lib/data";
import { assetCode, cx, fmt, fmtCompact, fromStroops, isAmount, pct, toStroops, venueName } from "../lib/format";
import { runDeposit, runWithdraw } from "../lib/flow";
import { useWallet } from "../lib/wallet";
import { AssetPicker } from "./AssetPicker";
import { FlowPanel, type Flow } from "./FlowPanel";
import { StableBadge } from "./StableBadge";
import { AssetIcon, Bezel, Eyebrow, LinkButton, Notice, PrimaryButton, QuietButton, Tag } from "./ui";

interface Props { assets: Assets; account: AccountState; stable: StableLookup; flow: Flow }
const FEE_HEADROOM = 5_000_000n;

/** What a pool status means for a supplier, per blend-contracts-v2 (`require_action_allowed`). */
function statusNote(v: Vault): string | null {
  if (v.status <= 1) return null;
  if (v.supplyOpen) return "The pool's backstop rules have paused new borrowing. Supplying and withdrawing stay open; existing loans keep paying interest.";
  return "The pool is frozen: deposits are paused. Withdrawals stay open.";
}

export function EarnView({ assets, account, stable, flow }: Props) {
  const wallet = useWallet();
  const vaults = useVaults();
  const positions = usePositions(wallet.address);
  const [open, setOpen] = useState<{ vault: string; asset: string; mode: "deposit" | "withdraw" } | null>(null);
  const settled = () => { account.reload(); positions.reload(); vaults.reload(); };

  return (
    <div>
      <div className="max-w-2xl">
        <Eyebrow>Blend lending pools · mainnet</Eyebrow>
        <h1 className="mt-4 text-4xl leading-[1.05] font-medium tracking-[-0.03em] sm:text-5xl">Put idle balances to work.</h1>
        <p className="mt-4 max-w-[52ch] text-muted">
          Supply an asset to a Blend pool and earn what borrowers pay. Pay with any asset: Sluice swaps it along the best single-transaction route, then deposits exactly what arrived.
        </p>
      </div>

      <div className="mt-10 space-y-6">
        {flow.active && <FlowPanel flow={flow} backLabel="Back to pools" />}

        {!flow.active && vaults.loading && <div className="skeleton h-72 rounded-[1.75rem]" aria-busy="true" aria-label="Loading pools" />}

        {!flow.active && !vaults.loading && vaults.error && !vaults.data && (
          <Bezel core="p-7">
            <h2 className="text-xl font-medium tracking-tight">Pools did not load</h2>
            <p className="mt-2 text-sm text-muted">{vaults.error}</p>
            <div className="mt-5"><LinkButton onClick={vaults.reload}>Try again</LinkButton></div>
          </Bezel>
        )}

        {!flow.active && vaults.data?.errors.map((e) => (
          <Notice key={e.vault} tone="bad">A pool could not be read from the network right now ({e.error}). It is hidden until it can be.</Notice>
        ))}

        {!flow.active && vaults.data?.vaults.map((v) => {
          const mine = positions.data?.vaults.find((p) => p.vault === v.id)?.positions ?? [];
          const note = statusNote(v);
          return (
            <Bezel key={v.id} className="animate-rise" core="p-5 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-medium tracking-tight">{v.name}</h2>
                  <p className="mt-1 text-sm text-muted">Blend v2 lending pool · rates are variable and move with every borrow and repayment</p>
                </div>
                <Tag tone={v.status <= 1 ? "accent" : v.supplyOpen ? "warn" : "bad"}>{v.statusLabel}</Tag>
              </div>
              {note && <Notice tone={v.supplyOpen ? "warn" : "bad"} className="mt-4">{note}</Notice>}

              <ul aria-label={`${v.name} assets`} className="mt-6 divide-y divide-line">
                {v.reserves.map((r) => {
                  const pos = mine.find((p) => p.asset === r.asset);
                  const supplied = pos && toStroops(pos.supplied) > 0n ? pos.supplied : undefined;
                  const collateral = pos && toStroops(pos.collateral) > 0n ? pos.collateral : undefined;
                  const here = open?.vault === v.id && open.asset === r.asset ? open.mode : null;
                  const toggle = (mode: "deposit" | "withdraw") => setOpen(here === mode ? null : { vault: v.id, asset: r.asset, mode });
                  return (
                    <li key={r.asset} className="py-5">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,1.4fr)_1fr_1fr_auto]">
                        <div className="flex items-center gap-3">
                          <AssetIcon asset={assets.describe(r.asset)} size={36} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 font-medium">{assetCode(r.asset)} <StableBadge scored={stable(r.asset)} /></div>
                            <div className="text-xs text-muted" title={`${fmt(r.supplied, 0)} ${assetCode(r.asset)} supplied by all lenders`}><span className="num">{fmtCompact(r.supplied)}</span> supplied</div>
                          </div>
                        </div>
                        <div className="justify-self-end text-right sm:justify-self-start sm:text-left">
                          <div className="num text-xl font-medium">{pct(r.supplyApr)}</div>
                          <div className="text-xs text-muted">supply APR now</div>
                        </div>
                        <div>
                          <div className="h-1.5 w-full max-w-36 overflow-hidden rounded-full bg-shell" role="img" aria-label={`${pct(r.utilization, 0)} of supplied funds are borrowed`}>
                            <div className="h-full origin-left rounded-full bg-accent transition-transform duration-700 ease-spring" style={{ transform: `scaleX(${r.utilization})` }} />
                          </div>
                          <div className="mt-1.5 text-xs text-muted"><span className="num">{pct(r.utilization, 1)}</span> borrowed</div>
                        </div>
                        <div className="flex gap-2 justify-self-end">
                          {supplied && <QuietButton aria-expanded={here === "withdraw"} onClick={() => toggle("withdraw")}>Withdraw</QuietButton>}
                          {v.supplyOpen && (
                            <QuietButton aria-expanded={here === "deposit"} onClick={() => toggle("deposit")}>
                              Deposit <CaretDown size={13} weight="light" className={cx("transition-transform duration-500 ease-spring", here === "deposit" && "rotate-180")} />
                            </QuietButton>
                          )}
                        </div>
                      </div>

                      {(supplied || collateral) && (
                        <p className="mt-3 rounded-2xl bg-accent-soft px-4 py-2.5 text-sm text-accent">
                          {supplied && <>You have <span className="font-medium"><span className="num">{fmt(supplied)}</span> {assetCode(r.asset)}</span> supplied here. </>}
                          {collateral && <span className="text-muted">{supplied ? "Another " : ""}<span className="num">{fmt(collateral)}</span> {assetCode(r.asset)} is posted as collateral through Blend itself; Sluice does not move collateral.</span>}
                        </p>
                      )}

                      {here === "deposit" && (
                        <DepositForm vault={v} reserve={r} assets={assets} account={account} stable={stable} onStart={(run) => { setOpen(null); flow.start(run, settled); }} />
                      )}
                      {here === "withdraw" && supplied && (
                        <WithdrawForm vault={v} reserve={r} supplied={supplied} onStart={(run) => { setOpen(null); flow.start(run, settled); }} />
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 flex gap-2 text-xs text-faint">
                <Info size={15} weight="light" className="mt-px shrink-0" />
                <span>Figures are read from the pool contract every 30 seconds. The rate is the pool's own curve at current utilisation, less the backstop's share, and is not a promise. Lending carries risk: borrowers can default and withdrawals wait when all funds are lent out.</span>
              </p>
            </Bezel>
          );
        })}

        {!flow.active && !wallet.address && vaults.data && (
          <p className="px-2 text-sm text-muted">Connect a wallet to deposit and to see what you have supplied.</p>
        )}
      </div>
    </div>
  );
}

type Start = (run: Parameters<Flow["start"]>[0]) => void;

function DepositForm({ vault, reserve, assets, account, stable, onStart }: { vault: Vault; reserve: VaultReserve; assets: Assets; account: AccountState; stable: StableLookup; onStart: Start }) {
  const wallet = useWallet();
  const [from, setFrom] = useState(reserve.asset);
  const [amount, setAmount] = useState("");
  const [picking, setPicking] = useState(false);
  const zap = from !== reserve.asset;
  const valid = isAmount(amount);
  // Only single-transaction routes: the deposit then follows as its own transaction.
  const quote = useQuote(zap && valid ? { assetIn: from, assetOut: reserve.asset, amount, slippageBps: 50, atomicOnly: true } : null, false);
  const route = quote.data?.best ?? undefined;

  const spendable = account.spendable(from);
  const short = valid && wallet.address && !account.loading && (spendable === undefined || toStroops(amount) > toStroops(spendable));
  const max = (() => {
    if (spendable === undefined) return undefined;
    const s = toStroops(spendable) - (from === "native" ? FEE_HEADROOM : 0n);
    return s > 0n ? fromStroops(s).replace(/\.?0+$/, "") : undefined;
  })();
  const overCap = valid && !zap && toStroops(amount) > toStroops(reserve.capRemaining);
  const args = { vault: vault.id, vaultName: vault.name, asset: reserve.asset, amount };

  let action: { label: string; onClick?: () => void; busy?: boolean };
  if (!wallet.address) action = { label: wallet.busy ? "Opening wallet…" : "Connect wallet", onClick: () => void wallet.connect(), busy: wallet.busy };
  else if (!amount) action = { label: "Enter an amount" };
  else if (!valid) action = { label: "Amount needs up to 7 decimals" };
  else if (short) action = { label: `Not enough ${assetCode(from)}` };
  else if (overCap) action = { label: "Above the pool's supply cap" };
  else if (zap && quote.loading) action = { label: "Quoting the swap…", busy: true };
  else if (zap && !route) action = { label: `No single-transaction route into ${assetCode(reserve.asset)}` };
  else if (zap) action = { label: `Review swap on ${venueName(route!.legs[0]!.venue)}, then deposit`, onClick: () => onStart((io) => runDeposit(io, args, { from, amount, slippageBps: 50, route: route! })) };
  else action = { label: `Review deposit of ${fmt(amount)} ${assetCode(reserve.asset)}`, onClick: () => onStart((io) => runDeposit(io, args)) };

  return (
    <div className="mt-4 animate-rise rounded-3xl bg-sunken p-4 ring-1 ring-line sm:p-5">
      <div className="flex items-center justify-between text-sm text-muted">
        <label htmlFor={`dep-${reserve.index}`}>Pay with</label>
        {wallet.address && spendable !== undefined && (
          <span className="flex items-center gap-2"><span><span className="num">{fmt(spendable)}</span> available</span>{max && <LinkButton onClick={() => setAmount(max)}>Max</LinkButton>}</span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          id={`dep-${reserve.index}`}
          name="deposit-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, ""))}
          aria-invalid={amount !== "" && !valid}
          className="num w-full min-w-0 bg-transparent text-2xl font-medium outline-none"
        />
        <button type="button" onClick={() => setPicking(true)} aria-label={`Pay with ${assetCode(from)}. Change asset.`} className="flex shrink-0 items-center gap-2 rounded-full bg-surface py-1.5 pr-3 pl-1.5 font-medium ring-1 ring-line transition-[transform,box-shadow] duration-500 ease-spring hover:shadow-float active:scale-[0.97]">
          <AssetIcon asset={assets.describe(from)} size={26} />
          {assetCode(from)}
          <CaretDown size={14} weight="light" className="text-muted" />
        </button>
      </div>
      <p className="mt-2 min-h-5 text-sm text-muted">
        {zap && valid && (quote.loading ? "Finding the best single-transaction route…" : route ? <>Swaps to about <span className="text-ink"><span className="num">{fmt(route.amountOut)}</span> {assetCode(reserve.asset)}</span> on {venueName(route.legs[0]!.venue)}, then deposits what actually arrives.</> : `No venue quotes this size into ${assetCode(reserve.asset)} in one transaction.`)}
        {!zap && valid && !overCap && <>Earning about <span className="num text-ink">{pct(reserve.supplyApr)}</span> a year at the current rate.</>}
        {overCap && <span className="text-bad">The pool accepts at most {fmt(reserve.capRemaining, 0)} more {assetCode(reserve.asset)}.</span>}
      </p>
      <div className="mt-3"><PrimaryButton onClick={action.onClick} disabled={!action.onClick} busy={action.busy}>{action.label}</PrimaryButton></div>
      <AssetPicker open={picking} title="Pay with" onClose={() => setPicking(false)} onPick={(id) => { setFrom(id); setAmount(""); }} assets={assets} account={account} stable={stable} only={wallet.address ? (id) => account.holds(id) : undefined} />
    </div>
  );
}

function WithdrawForm({ vault, reserve, supplied, onStart }: { vault: Vault; reserve: VaultReserve; supplied: string; onStart: Start }) {
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const valid = isAmount(amount);
  const over = valid && !all && toStroops(amount) > toStroops(supplied);
  const args = { vault: vault.id, vaultName: vault.name, asset: reserve.asset, amount };
  const action = !amount ? { label: "Enter an amount" } : !valid ? { label: "Amount needs up to 7 decimals" } : over ? { label: "More than you have supplied" }
    : { label: all ? `Review withdrawal of all ${assetCode(reserve.asset)}` : `Review withdrawal of ${fmt(amount)} ${assetCode(reserve.asset)}`, onClick: () => onStart((io) => runWithdraw(io, args, all)) };
  return (
    <div className="mt-4 animate-rise rounded-3xl bg-sunken p-4 ring-1 ring-line sm:p-5">
      <div className="flex items-center justify-between text-sm text-muted">
        <label htmlFor={`wd-${reserve.index}`}>Withdraw {assetCode(reserve.asset)}</label>
        <span className="flex items-center gap-2"><span><span className="num">{fmt(supplied)}</span> supplied</span><LinkButton onClick={() => { setAmount(supplied.replace(/\.?0+$/, "")); setAll(true); }}>All</LinkButton></span>
      </div>
      <input
        id={`wd-${reserve.index}`}
        name="withdraw-amount"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={amount}
        onChange={(e) => { setAmount(e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, "")); setAll(false); }}
        aria-invalid={amount !== "" && !valid}
        className="num mt-2 w-full min-w-0 bg-transparent text-2xl font-medium outline-none"
      />
      <p className="mt-2 min-h-5 text-sm text-muted">{all && "Withdraws the whole position, including interest earned since this page last read it."}</p>
      <div className="mt-3"><PrimaryButton onClick={"onClick" in action ? action.onClick : undefined} disabled={!("onClick" in action)}>{action.label}</PrimaryButton></div>
    </div>
  );
}
