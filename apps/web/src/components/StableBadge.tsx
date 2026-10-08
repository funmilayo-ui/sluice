import { ShieldCheck, ShieldWarning } from "@phosphor-icons/react";
import { useId, useRef, useState } from "react";
import type { ScoredStablecoin } from "../lib/api";
import { assetCode, cx, fmt, pct } from "../lib/format";

/**
 * Health of a scored stablecoin: a compact score that opens the live readings behind it. Rendered only for
 * assets this deployment actually scores; everything else shows no badge rather than a guess.
 */
const CARD_WIDTH = 256;
const EDGE = 12;

export function StableBadge({ scored, plain }: { scored: ScoredStablecoin | undefined; /** Score only, no details: for use inside another control. */ plain?: boolean }) {
  const [place, setPlace] = useState<{ left: number; width: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = place !== null;
  // The details card is only in the page while open, and is placed so it never leaves the viewport: a
  // hidden-but-laid-out card next to the right edge would otherwise make the whole page scroll sideways.
  const show = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2);
    const left = Math.min(Math.max(r.left, EDGE), window.innerWidth - EDGE - width);
    setPlace({ left: left - r.left, width });
  };
  const hide = () => setPlace(null);
  if (!scored || "error" in scored) return null;
  const { score, reasons, signals } = scored;
  const good = score >= 80;
  const Icon = good ? ShieldCheck : ShieldWarning;
  const code = assetCode(scored.asset);
  if (plain) {
    return (
      <span title={`${code} health score ${score} of 100`} className={cx("inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs font-medium", good ? "bg-accent-soft text-accent" : "bg-warn-soft text-warn")}>
        <Icon size={13} weight="light" />
        <span className="num">{score}</span>
      </span>
    );
  }
  return (
    <span ref={anchor} className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${code} health score ${score} of 100. Show details.`}
        onClick={(e) => { e.stopPropagation(); if (open) hide(); else show(); }}
        onBlur={hide}
        className={cx("relative inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs font-medium transition-colors duration-300 ease-spring after:absolute after:-inset-2.5", good ? "bg-accent-soft text-accent" : "bg-warn-soft text-warn")}
      >
        <Icon size={13} weight="light" />
        <span className="num">{score}</span>
      </button>
      {place && (
      <span
        id={id}
        role="tooltip"
        style={{ left: place.left, width: place.width }}
        className="absolute top-full z-20 mt-2 animate-rise rounded-2xl bg-surface p-4 text-left text-xs font-normal shadow-float ring-1 ring-line"
      >
        <span className="block text-sm font-medium text-ink">{code} health {score}/100</span>
        <span className="mt-2 grid gap-1.5 text-muted">
          {signals.reference ? (
            <span>This is the reference asset: other stablecoins are priced against it, so its own peg and depth are not measured here.</span>
          ) : (
            <>
              {signals.pegPrice !== undefined && <Row label="Executable price" value={`${signals.pegPrice.toFixed(4)} (${pct(signals.pegPrice - 1)} from peg)`} />}
              {signals.depthNearPeg !== undefined && <Row label="Depth within 0.5%" value={`${fmt(String(signals.depthNearPeg), 0)} units`} />}
            </>
          )}
          <Row label="Issuer can freeze" value={signals.authRequired ? "Yes (authorisation required)" : "No"} />
          <Row label="Issuer can claw back" value={signals.clawback ? "Yes" : "No"} />
        </span>
        {reasons.length > 0 && <span className="mt-3 block text-warn">Marked down for: {reasons.join("; ")}.</span>}
        <span className="mt-3 block text-faint">Read live from executable Stellar DEX quotes and issuer flags. Weights are a starting point, not a calibrated model.</span>
      </span>
      )}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex justify-between gap-3">
      <span>{label}</span>
      <span className="text-right text-ink">{value}</span>
    </span>
  );
}
