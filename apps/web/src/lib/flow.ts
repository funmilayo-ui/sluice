import { api, SluiceError, type BuildResponse, type BuildStep, type Explained, type RouteQuote, type TxResponse } from "./api";
import { assetCode, fmt, toStroops, venueName } from "./format";
import { savePending, type PendingRoute } from "./store";
import { WalletError } from "./wallet";

/**
 * Everything that moves funds goes through here: build (the API simulates), show the user the real
 * numbers, have their wallet sign, relay, wait for the ledger. The UI supplies `Io`; this module holds no
 * React state so the sequence reads top to bottom.
 */

export type StepStatus = "active" | "done" | "failed";
export interface StepView {
  id: string;
  title: string;
  status: StepStatus;
  /** What is happening now, or the outcome. */
  detail?: string;
  hash?: string;
}

export interface Choice { id: string; label: string; tone?: "primary" | "quiet" | "danger" }
export interface Prompt {
  title: string;
  body?: string;
  rows?: { label: string; value: string; strong?: boolean; /** Words, not a figure. */ text?: boolean }[];
  /** Shown with warning styling above the choices. */
  caution?: string;
  choices: Choice[];
}

export interface Io {
  account: string;
  sign(xdr: string): Promise<string>;
  step(view: StepView): void;
  ask(prompt: Prompt): Promise<string>;
}

export type Outcome =
  | { kind: "done"; title: string; summary: string; hash?: string }
  | { kind: "cancelled" }
  | { kind: "failed"; title: string; message: string; detail?: string }
  /** Leg 1 settled and the user chose to keep the intermediate asset rather than finish or unwind. */
  | { kind: "held"; summary: string };

class FlowError extends Error {
  constructor(message: string, public detail?: string, public declined = false) {
    super(message);
  }
}

function explain(e: unknown): FlowError {
  if (e instanceof FlowError) return e;
  if (e instanceof WalletError) {
    // A mismatch between the signing and the connected account needs saying in full; anything else is the
    // wallet declining, and its own wording goes in the detail.
    const mismatch = e.message.startsWith("The wallet signed with a different account");
    return new FlowError(mismatch ? e.message : "The transaction was not signed.", mismatch ? undefined : e.message, true);
  }
  if (e instanceof SluiceError) {
    if (e.status === 408) return new FlowError("The network has not confirmed this yet. It may still settle: check your wallet's history before trying again.");
    const x: Explained | undefined = e.explained;
    return new FlowError(x?.message ?? e.message, x?.detail);
  }
  return new FlowError(e instanceof Error ? e.message : "Something went wrong.");
}

/** Sign one transaction, relay it and wait for the ledger. Throws FlowError; the step row shows why. */
async function send(io: Io, id: string, title: string, xdr: string): Promise<TxResponse> {
  try {
    io.step({ id, title, status: "active", detail: "Waiting for your signature in the wallet" });
    const signed = await io.sign(xdr);
    io.step({ id, title, status: "active", detail: "Sending to the network" });
    const sent = await api.submit(signed);
    io.step({ id, title, status: "active", detail: "Waiting for the ledger to close", hash: sent.hash });
    const tx = await api.waitForTx(sent.hash);
    if (tx.status !== "SUCCESS") {
      throw new FlowError(tx.explained?.message ?? "The network did not apply this transaction.", tx.explained?.detail);
    }
    io.step({ id, title, status: "done", detail: tx.received ? `Settled. Received ${fmt(tx.received)}.` : "Settled.", hash: sent.hash });
    return tx;
  } catch (e) {
    const err = explain(e);
    io.step({ id, title, status: "failed", detail: err.message });
    throw err;
  }
}

interface SwapArgs { assetIn: string; assetOut: string; amount: string; slippageBps: number; routeKey: string }

const firstTx = (b: BuildResponse) => b.steps.find((s): s is Extract<BuildStep, { kind: "transaction" }> => s.kind === "transaction");
const prerequisites = (b: BuildResponse) => b.steps.filter((s): s is Extract<BuildStep, { kind: "prerequisite" }> => s.kind === "prerequisite");
const unsupported = (b: BuildResponse) => b.steps.find((s): s is Extract<BuildStep, { kind: "unsupported" }> => s.kind === "unsupported");

function swapTitle(route: RouteQuote, leg: number): string {
  const l = route.legs[leg]!;
  return `Swap ${assetCode(l.assetIn)} to ${assetCode(l.assetOut)} on ${venueName(l.venue)}`;
}

/** Rows for the review prompt, from the freshly built route (not the quote the user clicked a moment ago). */
function reviewRows(b: BuildResponse, leg: number): Prompt["rows"] {
  const l = b.route.legs[leg]!;
  const tx = firstTx(b);
  const rows: NonNullable<Prompt["rows"]> = [
    { label: "You pay", value: `${fmt(l.amountIn)} ${assetCode(l.assetIn)}`, strong: true },
    { label: "Expected", value: `${fmt(l.amountOut)} ${assetCode(l.assetOut)}`, strong: true },
    { label: "Minimum, or it does not execute", value: `${fmt(l.minOut)} ${assetCode(l.assetOut)}` },
    { label: "Venue", value: venueName(l.venue) + (l.hops.length ? ` via ${l.hops.map(assetCode).join(", ")}` : ""), text: true },
  ];
  if (tx?.resourceFee) rows.push({ label: "Network fee (simulated)", value: `${fmt(String(Number(tx.resourceFee) / 1e7))} XLM` });
  else if (tx && !tx.needsSimulation) rows.push({ label: "Network fee", value: "0.00001 XLM" });
  return rows;
}

/**
 * Build one route, add any missing trustline, and settle its first transaction.
 * `review` decides whether to pause on the numbers; it receives the build and returns false to cancel.
 * Returns the settled transaction, or null when the user cancelled at review.
 */
async function settle(io: Io, a: SwapArgs, idPrefix: string, review: (b: BuildResponse) => Promise<boolean>): Promise<{ tx: TxResponse; build: BuildResponse } | null> {
  const request = () => api.build({ assetIn: a.assetIn, assetOut: a.assetOut, amount: a.amount, account: io.account, slippageBps: a.slippageBps, routeKey: a.routeKey });
  let build: BuildResponse;
  try {
    build = await request();
  } catch (e) {
    throw explain(e);
  }
  const blocked = unsupported(build);
  if (blocked) throw new FlowError(`This route cannot be executed: ${blocked.reason}`);
  if (!(await review(build))) return null;
  const builtAt = Date.now();

  const missing = prerequisites(build);
  for (const [n, p] of missing.entries()) {
    await send(io, `${idPrefix}-trust-${n}`, `Add a trustline for ${assetCode(p.asset)}`, p.xdr);
  }
  // After a trustline the sequence number has moved and the swap can now be simulated; a build that sat in
  // review for minutes is also refreshed, so the wallet is never handed an expiring transaction.
  if (missing.length > 0 || Date.now() - builtAt > 120_000) {
    try {
      const fresh = await request();
      const accepted = toStroops(build.route.legs[0]!.minOut);
      if (toStroops(fresh.route.legs[0]!.amountOut) < accepted) {
        throw new FlowError("The price moved below the minimum you accepted while the trustline was being added. Nothing was swapped. Quote again.");
      }
      build = fresh;
    } catch (e) {
      throw explain(e);
    }
  }
  const step = firstTx(build);
  if (!step) throw new FlowError("The route did not produce a transaction to sign.");
  const tx = await send(io, `${idPrefix}-swap`, swapTitle(build.route, step.leg), step.xdr);
  return { tx, build };
}

/** Swap along one route. Single-transaction routes end after one signature; cross-layer routes continue into leg 2. */
export async function runSwap(io: Io, a: SwapArgs, route: RouteQuote): Promise<Outcome> {
  const twoStep = route.atomicity === "TWO_STEP";
  try {
    const first = await settle(io, a, "leg1", async (b) => {
      const answer = await io.ask({
        title: twoStep ? "Review leg 1 of 2" : "Review swap",
        body: twoStep
          ? "This route crosses from one Stellar layer to the other, so it is two transactions. You will sign each one. If the second does not go through you keep the intermediate asset and can unwind."
          : "The network simulated this exact transaction a moment ago. Your wallet will ask you to sign it.",
        rows: reviewRows(b, 0),
        caution: prerequisites(b).length ? `Your account has no trustline for ${prerequisites(b).map((p) => assetCode(p.asset)).join(", ")}. You will sign that first; it locks 0.5 XLM of reserve per asset.` : undefined,
        choices: [{ id: "go", label: "Sign in wallet", tone: "primary" }, { id: "cancel", label: "Cancel", tone: "quiet" }],
      });
      return answer === "go";
    });
    if (!first) return { kind: "cancelled" };

    if (!twoStep) {
      const out = first.tx.received ?? first.build.route.amountOut;
      return { kind: "done", title: "Swap settled", summary: `Received ${fmt(out)} ${assetCode(a.assetOut)}.`, hash: first.tx.hash };
    }

    const leg1 = first.build.route.legs[0]!;
    if (!first.tx.received) {
      throw new FlowError(`Leg 1 settled but the amount of ${assetCode(leg1.assetOut)} it delivered could not be read. Check your balance and swap it onward from the Swap tab.`);
    }
    const pending: PendingRoute = {
      account: io.account, from: a.assetIn, to: a.assetOut, held: leg1.assetOut, heldAmount: first.tx.received,
      slippageBps: a.slippageBps, acceptedMin: route.legs[1]!.minOut, leg1Hash: first.tx.hash, at: Date.now(),
    };
    savePending(pending);
    return await runLeg2(io, pending);
  } catch (e) {
    const err = explain(e);
    if (err.declined) return { kind: "cancelled" };
    return { kind: "failed", title: "Swap did not go through", message: err.message, detail: err.detail };
  }
}

/**
 * Second leg of a cross-layer route, sized from what leg 1 actually delivered. Also the entry point when a
 * user returns to a route they left half way. Ends in done, held (user keeps the asset) or an unwind.
 */
export async function runLeg2(io: Io, p: PendingRoute): Promise<Outcome> {
  const held = `${fmt(p.heldAmount)} ${assetCode(p.held)}`;
  for (;;) {
    let problem: string | undefined;
    try {
      const q = await api.quote({ assetIn: p.held, assetOut: p.to, amount: p.heldAmount, slippageBps: p.slippageBps, atomicOnly: true });
      const best = q.best;
      if (!best) {
        problem = `No venue will take ${held} for ${assetCode(p.to)} right now.`;
      } else {
        const below = toStroops(best.amountOut) < toStroops(p.acceptedMin);
        const done = await settle(io, { assetIn: p.held, assetOut: p.to, amount: p.heldAmount, slippageBps: p.slippageBps, routeKey: best.key }, "leg2", async (b) => {
          const answer = await io.ask({
            title: "Review leg 2 of 2",
            body: `Leg 1 delivered ${held}. This is a fresh quote for exactly that amount.`,
            rows: reviewRows(b, 0),
            caution: below ? `This is below the ${fmt(p.acceptedMin)} ${assetCode(p.to)} minimum you accepted when you started. You can continue, unwind back to ${assetCode(p.from)}, or keep the ${assetCode(p.held)}.` : undefined,
            choices: [
              { id: "go", label: "Sign in wallet", tone: "primary" },
              { id: "unwind", label: `Unwind to ${assetCode(p.from)}`, tone: "quiet" },
              { id: "keep", label: `Keep ${assetCode(p.held)}`, tone: "quiet" },
            ],
          });
          if (answer === "unwind") throw new Redirect("unwind");
          if (answer === "keep") throw new Redirect("keep");
          return true;
        });
        if (done) {
          savePending(null);
          return { kind: "done", title: "Both legs settled", summary: `Received ${fmt(done.tx.received ?? done.build.route.amountOut)} ${assetCode(p.to)}.`, hash: done.tx.hash };
        }
      }
    } catch (e) {
      if (e instanceof Redirect) {
        if (e.to === "keep") return keep(p);
        return unwind(io, p);
      }
      problem = explain(e).message;
    }
    const answer = await io.ask({
      title: "Leg 2 did not go through",
      body: `You hold ${held} from leg 1. Nothing else has moved.`,
      caution: problem,
      choices: [
        { id: "retry", label: "Quote leg 2 again", tone: "primary" },
        { id: "unwind", label: `Unwind to ${assetCode(p.from)}`, tone: "quiet" },
        { id: "keep", label: `Keep ${assetCode(p.held)}`, tone: "quiet" },
      ],
    });
    if (answer === "keep") return keep(p);
    if (answer === "unwind") return unwind(io, p);
  }
}

class Redirect extends Error {
  constructor(public to: "unwind" | "keep") {
    super(to);
  }
}

function keep(p: PendingRoute): Outcome {
  savePending(null);
  return { kind: "held", summary: `You kept ${fmt(p.heldAmount)} ${assetCode(p.held)}. It is in your account and you can swap it any time.` };
}

/** Swap the intermediate asset back to what the user started with, along the best single-transaction route. */
async function unwind(io: Io, p: PendingRoute): Promise<Outcome> {
  try {
    const q = await api.quote({ assetIn: p.held, assetOut: p.from, amount: p.heldAmount, slippageBps: p.slippageBps, atomicOnly: true });
    if (!q.best) throw new FlowError(`No venue will take ${fmt(p.heldAmount)} ${assetCode(p.held)} back to ${assetCode(p.from)} right now. It stays in your account.`);
    const done = await settle(io, { assetIn: p.held, assetOut: p.from, amount: p.heldAmount, slippageBps: p.slippageBps, routeKey: q.best.key }, "unwind", async (b) => {
      const answer = await io.ask({
        title: "Review unwind",
        body: `This swaps the ${assetCode(p.held)} from leg 1 back to ${assetCode(p.from)}. Two swaps each pay venue fees, so you get back a little less than you started with.`,
        rows: reviewRows(b, 0),
        choices: [{ id: "go", label: "Sign in wallet", tone: "primary" }, { id: "cancel", label: `Keep ${assetCode(p.held)} instead`, tone: "quiet" }],
      });
      return answer === "go";
    });
    if (!done) return keep(p);
    savePending(null);
    return { kind: "done", title: "Unwound", summary: `Received ${fmt(done.tx.received ?? done.build.route.amountOut)} ${assetCode(p.from)}.`, hash: done.tx.hash };
  } catch (e) {
    const err = explain(e);
    // The asset is still theirs and the pending record stays, so the banner offers the choice again.
    return { kind: "failed", title: "Unwind did not go through", message: `${err.message} You still hold ${fmt(p.heldAmount)} ${assetCode(p.held)}.`, detail: err.detail };
  }
}

export interface VaultArgs { vault: string; vaultName: string; asset: string; amount: string }

/** Supply to a Blend pool. When `from` differs from the pool's asset, swap first and supply what arrived. */
export async function runDeposit(io: Io, v: VaultArgs, zap?: { from: string; amount: string; slippageBps: number; route: RouteQuote }): Promise<Outcome> {
  try {
    let amount = v.amount;
    if (zap) {
      const swapped = await settle(io, { assetIn: zap.from, assetOut: v.asset, amount: zap.amount, slippageBps: zap.slippageBps, routeKey: zap.route.key }, "zap", async (b) => {
        const answer = await io.ask({
          title: "Review swap, then deposit",
          body: `Two signatures: first the swap into ${assetCode(v.asset)}, then the deposit of exactly what the swap delivered. If the deposit does not go through you simply hold the ${assetCode(v.asset)}.`,
          rows: reviewRows(b, 0),
          caution: prerequisites(b).length ? `Your account has no trustline for ${prerequisites(b).map((p) => assetCode(p.asset)).join(", ")}. You will sign that first; it locks 0.5 XLM of reserve per asset.` : undefined,
          choices: [{ id: "go", label: "Sign in wallet", tone: "primary" }, { id: "cancel", label: "Cancel", tone: "quiet" }],
        });
        return answer === "go";
      });
      if (!swapped) return { kind: "cancelled" };
      if (!swapped.tx.received) throw new FlowError(`The swap settled but the amount it delivered could not be read. Deposit your ${assetCode(v.asset)} from the Earn tab.`);
      amount = swapped.tx.received;
    } else {
      const answer = await io.ask({
        title: "Review deposit",
        body: "Supplied funds earn the pool's variable rate and can be withdrawn while the pool has idle liquidity. They are not posted as collateral.",
        rows: [
          { label: "You supply", value: `${fmt(amount)} ${assetCode(v.asset)}`, strong: true },
          { label: "Pool", value: v.vaultName, text: true },
        ],
        choices: [{ id: "go", label: "Sign in wallet", tone: "primary" }, { id: "cancel", label: "Cancel", tone: "quiet" }],
      });
      if (answer !== "go") return { kind: "cancelled" };
    }
    const built = await api.deposit({ account: io.account, vault: v.vault, asset: v.asset, amount });
    const tx = await send(io, "deposit", `Supply ${fmt(amount)} ${assetCode(v.asset)} to ${v.vaultName}`, built.xdr);
    return { kind: "done", title: "Deposit settled", summary: `${fmt(amount)} ${assetCode(v.asset)} is now supplied to ${v.vaultName}.`, hash: tx.hash };
  } catch (e) {
    const err = explain(e);
    if (err.declined) return { kind: "cancelled" };
    return { kind: "failed", title: "Deposit did not go through", message: err.message, detail: err.detail };
  }
}

export async function runWithdraw(io: Io, v: VaultArgs, all: boolean): Promise<Outcome> {
  try {
    const answer = await io.ask({
      title: "Review withdrawal",
      rows: [
        { label: "You withdraw", value: all ? `All supplied ${assetCode(v.asset)} (about ${fmt(v.amount)})` : `${fmt(v.amount)} ${assetCode(v.asset)}`, strong: true, text: all },
        { label: "Pool", value: v.vaultName, text: true },
      ],
      choices: [{ id: "go", label: "Sign in wallet", tone: "primary" }, { id: "cancel", label: "Cancel", tone: "quiet" }],
    });
    if (answer !== "go") return { kind: "cancelled" };
    // Interest accrues every ledger, so "all" asks for slightly more than the last reading; the pool caps a
    // withdrawal at the position, which empties it exactly.
    const amount = all ? padUp(v.amount) : v.amount;
    const built = await api.withdraw({ account: io.account, vault: v.vault, asset: v.asset, amount });
    const tx = await send(io, "withdraw", `Withdraw ${assetCode(v.asset)} from ${v.vaultName}`, built.xdr);
    return { kind: "done", title: "Withdrawal settled", summary: `${assetCode(v.asset)} is back in your account.`, hash: tx.hash };
  } catch (e) {
    const err = explain(e);
    if (err.declined) return { kind: "cancelled" };
    return { kind: "failed", title: "Withdrawal did not go through", message: err.message, detail: err.detail };
  }
}

/** 1% above, in exact stroop arithmetic. */
function padUp(amount: string): string {
  const v = (toStroops(amount) * 101n) / 100n + 1n;
  return `${v / 10_000_000n}.${(v % 10_000_000n).toString().padStart(7, "0")}`;
}
