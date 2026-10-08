import { Lightning, Stack } from "@phosphor-icons/react";
import type { RouteQuote } from "../lib/api";
import type { StableLookup } from "../lib/data";
import { assetCode, cx, fmt, relDiff, venueName, versusBest } from "../lib/format";
import { StableBadge } from "./StableBadge";
import { Tag } from "./ui";

const ATOMICITY: Record<RouteQuote["atomicity"], { label: string; hint: string }> = {
  CLASSIC_ONLY: { label: "One transaction", hint: "A single path payment. It settles completely or not at all." },
  ATOMIC_SOROBAN: { label: "One transaction", hint: "A single contract call. It settles completely or not at all." },
  TWO_STEP: { label: "Two transactions", hint: "Classic and Soroban cannot share a transaction, so this route is two. Not atomic." },
};

interface Props {
  route: RouteQuote;
  best: RouteQuote;
  selected: boolean;
  onSelect(): void;
  stable: StableLookup;
  index: number;
}

export function RouteCard({ route, best, selected, onSelect, stable, index }: Props) {
  const isBest = route.key === best.key;
  const diff = relDiff(route.amountOut, best.amountOut);
  const twoStep = route.atomicity === "TWO_STEP";
  const out = assetCode(route.assetOut);

  return (
    <label
      style={{ animationDelay: `${Math.min(index, 6) * 60}ms` }}
      className={cx(
        "group relative block animate-rise cursor-pointer rounded-3xl bg-surface p-5 ring-1 transition-[box-shadow,transform] duration-500 ease-spring",
        selected ? "shadow-float ring-2 ring-accent" : "ring-line hover:-translate-y-0.5 hover:shadow-float",
      )}
    >
      <input type="radio" name="route" checked={selected} onChange={onSelect} className="peer sr-only" />
      <span className="pointer-events-none absolute inset-0 rounded-3xl peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent" />

      <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex items-baseline gap-2">
          <span className="num text-2xl font-medium">{fmt(route.amountOut)}</span>
          <span className="text-muted">{out}</span>
        </span>
        {isBest ? <Tag tone="accent">Best ranked</Tag> : <span className="text-sm text-muted">{versusBest(diff)}</span>}
      </span>

      <span className="mt-3 flex">
        <Tag tone={twoStep ? "warn" : "neutral"}>
          {twoStep ? <Stack size={13} weight="light" /> : <Lightning size={13} weight="light" />}
          <span title={ATOMICITY[route.atomicity].hint}>{ATOMICITY[route.atomicity].label}{twoStep ? ", not atomic" : ", atomic"}</span>
        </Tag>
      </span>

      {/* One line per leg: venue, then the path it takes. Long paths wrap instead of pushing the card wide. */}
      <span className="mt-3 grid gap-2">
        {route.legs.map((l, i) => (
          <span key={i} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            {twoStep && <span className="num grid size-5 shrink-0 place-items-center rounded-full bg-shell text-[11px] text-muted" aria-label={`Transaction ${i + 1}`}>{i + 1}</span>}
            <span className="font-medium">{venueName(l.venue)}</span>
            <span className="min-w-0 text-muted [overflow-wrap:anywhere]">
              {[l.assetIn, ...l.hops, l.assetOut].map(assetCode).join(" › ")}
            </span>
            {[...l.hops, ...(i < route.legs.length - 1 ? [l.assetOut] : [])].map((a) => <StableBadge key={a} scored={stable(a)} />)}
          </span>
        ))}
      </span>

      <span className="mt-3 block text-sm text-muted">
        Minimum <span className="num">{fmt(route.legs[route.legs.length - 1]!.minOut)}</span> {out}, or the swap does not execute.
        {route.effectiveOut !== route.amountOut && <> Ranked as <span className="num">{fmt(route.effectiveOut)}</span> {out} after a risk haircut.</>}
      </span>
      {route.risks.map((r) => (
        <span key={r.code} className="mt-3 block rounded-2xl bg-warn-soft px-3.5 py-2.5 text-sm text-warn">{r.message}</span>
      ))}
    </label>
  );
}
