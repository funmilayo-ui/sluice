import { ArrowSquareOut, Check, CircleNotch, Warning, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cx, explorerTx } from "../lib/format";
import type { Io, Outcome, Prompt, StepView } from "../lib/flow";
import { useWallet, WalletError } from "../lib/wallet";
import { Bezel, PrimaryButton, QuietButton } from "./ui";

export interface Flow {
  /** A flow is on screen: running, waiting on a choice, or showing its outcome. */
  active: boolean;
  running: boolean;
  /** The wallet has been asked to sign and has not answered yet. */
  signing: boolean;
  steps: StepView[];
  prompt: Prompt | null;
  outcome: Outcome | null;
  start(run: (io: Io) => Promise<Outcome>, onSettled?: () => void): void;
  choose(id: string): void;
  /** Give up on a signature request the wallet never answered (a closed popup often reports nothing). */
  stopWaiting(): void;
  close(): void;
}

/** One flow at a time, owned by the app shell so it survives moving between tabs. */
export function useFlow(): Flow {
  const wallet = useWallet();
  const [steps, setSteps] = useState<StepView[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);
  const [signing, setSigning] = useState(false);
  const resolver = useRef<((id: string) => void) | null>(null);
  const abortSign = useRef<(() => void) | null>(null);

  // Leaving while a transaction is between signature and ledger loses the on-screen result, so ask first.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const close = useCallback(() => {
    setSteps([]);
    setPrompt(null);
    setOutcome(null);
  }, []);

  // A flow belongs to the account it started for. If the wallet disconnects or connects another account
  // while a signature is awaited, stop waiting: a signature from someone else is of no use.
  const startedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (running && startedFor.current && wallet.address !== startedFor.current) {
      setSigning(false);
      abortSign.current?.();
      abortSign.current = null;
    }
  }, [running, wallet.address]);

  const start = useCallback<Flow["start"]>((run, onSettled) => {
    if (!wallet.address) return;
    startedFor.current = wallet.address;
    setSteps([]);
    setOutcome(null);
    setRunning(true);
    const io: Io = {
      account: wallet.address,
      // Raced against the user giving up: some wallets never settle the request when their window is closed.
      // A signature that arrives after that is dropped, and an unsent transaction simply expires.
      sign: (xdr) =>
        new Promise<string>((resolve, reject) => {
          abortSign.current = () => reject(new WalletError("You stopped waiting for the wallet."));
          setSigning(true);
          wallet.sign(xdr).then(resolve, reject).finally(() => { setSigning(false); abortSign.current = null; });
        }),
      step: (view) => setSteps((prev) => (prev.some((s) => s.id === view.id) ? prev.map((s) => (s.id === view.id ? view : s)) : [...prev, view])),
      ask: (p) => new Promise<string>((resolve) => { resolver.current = resolve; setPrompt(p); }),
    };
    run(io)
      .then(setOutcome)
      .catch((e: unknown) => setOutcome({ kind: "failed", title: "Something went wrong", message: e instanceof Error ? e.message : "Unexpected error" }))
      .finally(() => { setRunning(false); setPrompt(null); onSettled?.(); });
  }, [wallet.address, wallet.sign]);

  const stopWaiting = useCallback(() => {
    setSigning(false);
    abortSign.current?.();
    abortSign.current = null;
  }, []);

  const choose = useCallback((id: string) => {
    setPrompt(null);
    resolver.current?.(id);
    resolver.current = null;
  }, []);

  // Cancelling before anything was signed leaves nothing to report: go straight back.
  useEffect(() => {
    if (outcome?.kind === "cancelled" && steps.length === 0) close();
  }, [outcome, steps.length, close]);

  return { active: running || outcome !== null, running, signing, steps, prompt, outcome, start, choose, stopWaiting, close };
}

function StepRow({ s }: { s: StepView }) {
  return (
    <li className="flex gap-3.5 py-3.5">
      <span className={cx("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", s.status === "done" ? "bg-accent-soft text-accent" : s.status === "failed" ? "bg-bad-soft text-bad" : "bg-shell text-muted")}>
        {s.status === "done" ? <Check size={15} weight="light" /> : s.status === "failed" ? <X size={15} weight="light" /> : <CircleNotch size={15} weight="light" className="animate-spin" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{s.title}</span>
        {s.detail && <span className={cx("block text-sm", s.status === "failed" ? "text-bad" : "text-muted")}>{s.detail}</span>}
        {s.hash && (
          <a href={explorerTx(s.hash)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-accent underline-offset-4 hover:underline">
            View transaction <ArrowSquareOut size={14} weight="light" />
          </a>
        )}
      </span>
    </li>
  );
}

export function FlowPanel({ flow, backLabel = "Back" }: { flow: Flow; backLabel?: string }) {
  const { steps, prompt, outcome } = flow;
  const primary = prompt?.choices.find((c) => c.tone === "primary");
  const others = prompt?.choices.filter((c) => c !== primary) ?? [];
  const finished = outcome !== null && !flow.running;

  return (
    <Bezel className="animate-rise" core="p-5 sm:p-7">
      <div aria-live="polite">
        {steps.length > 0 && <ol className="divide-y divide-line">{steps.map((s) => <StepRow key={s.id} s={s} />)}</ol>}

        {prompt && (
          <div className={cx(steps.length > 0 && "mt-4 border-t border-line pt-6")}>
            <h2 className="text-xl font-medium tracking-tight">{prompt.title}</h2>
            {prompt.body && <p className="mt-2 max-w-[60ch] text-sm text-muted">{prompt.body}</p>}
            {prompt.rows && (
              <dl className="mt-5 divide-y divide-line rounded-2xl bg-sunken px-4 ring-1 ring-line">
                {prompt.rows.map((r) => (
                  <div key={r.label} className="flex items-baseline justify-between gap-4 py-3">
                    <dt className="text-sm text-muted">{r.label}</dt>
                    <dd className={cx("text-right", r.text ? "" : "num", r.strong ? "text-base font-medium" : "text-sm")}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {prompt.caution && (
              <p className="mt-4 flex gap-2.5 rounded-2xl bg-warn-soft px-4 py-3 text-sm text-warn">
                <Warning size={18} weight="light" className="mt-0.5 shrink-0" />
                <span>{prompt.caution}</span>
              </p>
            )}
            <div className="mt-6 flex flex-col gap-3">
              {primary && <PrimaryButton onClick={() => flow.choose(primary.id)}>{primary.label}</PrimaryButton>}
              {others.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {others.map((c) => <QuietButton key={c.id} tone={c.tone === "danger" ? "danger" : undefined} onClick={() => flow.choose(c.id)}>{c.label}</QuietButton>)}
                </div>
              )}
            </div>
          </div>
        )}

        {flow.signing && (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-2xl bg-sunken px-4 py-3 text-sm text-muted ring-1 ring-line">
            <span className="min-w-0 flex-1">Approve it in your wallet. Closed the wallet window, or nothing opened? Stop here: nothing is sent unless you approve.</span>
            <QuietButton onClick={flow.stopWaiting}>Stop waiting</QuietButton>
          </div>
        )}

        {!prompt && flow.running && steps.length === 0 && (
          <div className="flex items-center gap-3 py-2 text-muted">
            <CircleNotch size={18} weight="light" className="animate-spin" />
            <span>Building and simulating on mainnet…</span>
          </div>
        )}

        {finished && outcome.kind !== "cancelled" && (
          <div className={cx(steps.length > 0 && "mt-4 border-t border-line pt-6")}>
            <h2 className={cx("text-xl font-medium tracking-tight", outcome.kind === "failed" && "text-bad")}>
              {outcome.kind === "done" ? outcome.title : outcome.kind === "failed" ? outcome.title : "Route stopped after leg 1"}
            </h2>
            <p className="mt-2 max-w-[60ch] text-sm text-muted">{outcome.kind === "failed" ? outcome.message : outcome.summary}</p>
            {outcome.kind === "failed" && outcome.detail && (
              <details className="mt-3 text-sm text-faint">
                <summary className="cursor-pointer select-none">Technical detail</summary>
                <code className="num mt-2 block rounded-xl bg-sunken p-3 text-xs break-all">{outcome.detail}</code>
              </details>
            )}
            {outcome.kind === "done" && outcome.hash && (
              <a href={explorerTx(outcome.hash)} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-accent underline-offset-4 hover:underline">
                View on StellarExpert <ArrowSquareOut size={14} weight="light" />
              </a>
            )}
          </div>
        )}

        {finished && (
          <div className="mt-6">
            <QuietButton onClick={flow.close}>{backLabel}</QuietButton>
          </div>
        )}
      </div>
    </Bezel>
  );
}
