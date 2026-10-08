import { ArrowUpRight, CircleNotch } from "@phosphor-icons/react";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { ListedAsset } from "../lib/api";
import { cx } from "../lib/format";

/**
 * A surface that sits in a tray: outer shell with a hairline, inner core with its own highlight and a
 * concentric radius. Used for the few panels that hold the page's main actions, not for every box.
 */
export function Bezel({ children, className, core }: { children: ReactNode; className?: string; core?: string }) {
  return (
    <div className={cx("rounded-[1.75rem] bg-shell p-1.5 ring-1 ring-line", className)}>
      <div className={cx("rounded-[calc(1.75rem-0.375rem)] bg-surface shadow-float ring-1 ring-line", core)}>{children}</div>
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean };

/** The one filled action on a panel: a pill with its arrow seated in its own circle. */
export function PrimaryButton({ children, busy, className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        "group flex w-full items-center justify-between gap-3 rounded-full bg-accent py-2 pr-2 pl-6 text-left text-[15px] font-medium text-accent-ink",
        "transition-[transform,opacity,filter] duration-500 ease-spring hover:brightness-110 active:scale-[0.985] disabled:opacity-45 disabled:hover:brightness-100 disabled:active:scale-100",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-black/12 transition-transform duration-500 ease-spring group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105 group-disabled:translate-x-0 group-disabled:translate-y-0 group-disabled:scale-100">
        {busy ? <CircleNotch size={18} weight="light" className="animate-spin" /> : <ArrowUpRight size={18} weight="light" />}
      </span>
    </button>
  );
}

export function QuietButton({ children, className, tone, ...rest }: ButtonProps & { tone?: "danger" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium ring-1 ring-line",
        "transition-[transform,background-color,color] duration-500 ease-spring hover:bg-shell active:scale-[0.98] disabled:opacity-45 disabled:hover:bg-transparent",
        tone === "danger" ? "text-bad" : "text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A small text action that is not a button-shaped button. */
export function LinkButton({ children, className, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} className={cx("-mx-2 -my-2.5 rounded-lg px-2 py-2.5 text-sm font-medium text-accent underline-offset-4 transition-opacity duration-300 ease-spring hover:underline disabled:opacity-45", className)}>
      {children}
    </button>
  );
}

export function Tag({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "bad"; className?: string }) {
  const tones = { neutral: "bg-shell text-muted", accent: "bg-accent-soft text-accent", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad" };
  return <span className={cx("inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

/** Eyebrow above a heading. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-[11px] font-medium tracking-[0.14em] text-accent uppercase">{children}</span>;
}

export function Notice({ children, tone = "warn", className }: { children: ReactNode; tone?: "warn" | "bad" | "neutral"; className?: string }) {
  const tones = { warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", neutral: "bg-shell text-muted" };
  return <p className={cx("rounded-2xl px-4 py-3 text-sm", tones[tone], className)}>{children}</p>;
}

/**
 * Asset icon from a public list. The code's first letters sit underneath and the image fades in over them
 * once it has loaded, so a slow or dead image host never leaves an empty box. XLM is on no list (it has no
 * issuer to publish one), so it uses the bundled mark.
 */
export function AssetIcon({ asset, size = 28 }: { asset: Pick<ListedAsset, "code" | "icon"> & { id?: string }; size?: number }) {
  const src = asset.icon ?? (asset.id === "native" ? "/xlm.svg" : undefined);
  const [state, setState] = useState<{ src?: string; ok: boolean }>({ ok: false });
  const loaded = state.src === src && state.ok;
  return (
    <span aria-hidden style={{ width: size, height: size, fontSize: size * 0.36 }} className="relative grid shrink-0 place-items-center overflow-hidden rounded-[30%] bg-accent-soft font-semibold tracking-tight text-accent ring-1 ring-line">
      {asset.code.slice(0, 2).toUpperCase()}
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setState({ src, ok: true })}
          onError={() => setState({ src, ok: false })}
          className={cx("absolute inset-0 size-full bg-surface object-cover transition-opacity duration-500 ease-spring", loaded ? "opacity-100" : "opacity-0")}
        />
      )}
    </span>
  );
}
