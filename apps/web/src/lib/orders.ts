import type { HedgeStatus, OrderStatusResponse, PreparedOrder, PreparedOrderTx, PrepareOrderResponse, PrepareOrderTxResponse, SigningTier, SubmitOrderResponse } from "@sluice/sdk";
import { toStroops } from "./format";
import { classifyWalletFailure, DEFAULT_TIERS, signingRoute, type SigningRoute } from "./orderWallet";

/**
 * The settlement-order ("Settle") flow as a state machine, with no React and no network in it.
 *
 *   idle -> preparing -> review -> signing -> submitting -> confirming -> filled
 *                  \-> declined        \-> rejected | unsupported | expired
 *                  \-> failed          \-> failed | expired | unconfirmed
 *
 * Every state says what is true about the user's funds and what they can do next. In particular the user is
 * never left looking at a spinner that has no end: a request that may or may not have reached the network
 * ends in `unconfirmed` with the way to check, not in a retry button that could double-send.
 *
 * `step` is the pure transition function (unit-tested); `createOrderController` runs the effects around it.
 */

/**
 * What the solver prepared. Tier 1 is an authorisation entry to sign; tier 2 (`tx` present) is a transaction from the user's own
 * account to sign. Everything after the wallet answers (submit, follow, filled) is the same for both.
 */
export type Prepared = PreparedOrder | PreparedOrderTx;
export const isTxPrepared = (p: Prepared): p is PreparedOrderTx => "tx" in p;

export interface OrderRequest {
  account: string;
  assetIn: string;
  assetOut: string;
  amount: string;
  slippageBps: number;
}

/** Something that went wrong, in words. `code` is the server's `explained.code` when there was one. */
export interface Failure {
  code: string;
  title: string;
  message: string;
  detail?: string;
}

export type OrderState =
  | { phase: "idle" }
  | { phase: "preparing"; req: OrderRequest }
  /** The solver agreed to fill. The user sees the app's own summary of exactly what they would sign. */
  | { phase: "review"; req: OrderRequest; prepared: Prepared }
  /** The wallet has the request. Nothing is signed yet. */
  | { phase: "signing"; req: OrderRequest; prepared: Prepared }
  /** Signed; handing it to the solver. */
  | { phase: "submitting"; req: OrderRequest; prepared: Prepared }
  /** Sent; waiting for the fill to land in a ledger. */
  | { phase: "confirming"; req: OrderRequest; prepared: Prepared; hash: string }
  | { phase: "filled"; req: OrderRequest; prepared: Prepared; hash: string; received: string | undefined; ledger: number | undefined; hedge: HedgeStatus | undefined }
  /** No solver will fill this now. Nothing was prepared and nothing can be signed. */
  | { phase: "declined"; req: OrderRequest; reasons: string[]; summary: { pay: string; classicQuote?: string; solverMaxPay?: string } }
  /** The deadline passed (or is too close). A new price means a new signature. */
  | { phase: "expired"; req: OrderRequest; during: "review" | "signing" | "submit" }
  /** The user said no in the wallet, or stopped waiting for it. Nothing was signed. */
  | { phase: "rejected"; req: OrderRequest; prepared: Prepared; stopped: boolean }
  /**
   * The wallet cannot sign this kind of request. `tried` is the route that was refused: "auth-entry" at the wallet's call (a
   * transaction may still work, if the server offers it), "transaction" (nothing is left to offer) or "none" (decided up front,
   * from the wallet's id and what the server offers, before anything was asked of the wallet).
   */
  | { phase: "unsupported"; req: OrderRequest; moduleId: string | undefined; at: "before" | "call"; tried: SigningRoute }
  | { phase: "failed"; req: OrderRequest; failure: Failure; hash?: string }
  /** We cannot tell whether the order reached the network. The user is told how to check. */
  | { phase: "unconfirmed"; req: OrderRequest; prepared?: Prepared; hash?: string; reason: "timeout" | "no-answer" };

export type Phase = OrderState["phase"];

export type OrderEvent =
  | { type: "PREPARE"; req: OrderRequest }
  | { type: "PREPARED"; res: PrepareOrderResponse | PrepareOrderTxResponse }
  | { type: "PREPARE_FAILED"; failure: Failure }
  | { type: "BLOCKED_BY_WALLET"; moduleId: string | undefined; req: OrderRequest }
  | { type: "SIGN_START" }
  | { type: "SIGNED" }
  | { type: "WALLET_REJECTED"; stopped: boolean }
  | { type: "WALLET_UNSUPPORTED"; moduleId: string | undefined }
  | { type: "FAILED"; failure: Failure }
  | { type: "SUBMITTED"; hash: string }
  | { type: "LANDED"; status: OrderStatusResponse }
  | { type: "UNCONFIRMED"; hash?: string; reason: "timeout" | "no-answer" }
  | { type: "EXPIRED" }
  | { type: "HEDGE"; hedge: HedgeStatus }
  | { type: "REVIEW_AGAIN" }
  | { type: "RESET" };

export const IDLE: OrderState = { phase: "idle" };

/** Phases from which the flow can be started over. */
const TERMINAL: Phase[] = ["declined", "expired", "rejected", "unsupported", "failed", "unconfirmed", "filled"];

/**
 * The only way the state changes. An event that makes no sense in the current state (a late wallet answer after
 * the user gave up, a second click) is ignored, never applied: that is how a stale async result is kept from
 * overwriting what the user is looking at.
 */
export function step(s: OrderState, ev: OrderEvent): OrderState {
  switch (ev.type) {
    case "RESET":
      return IDLE;
    case "PREPARE":
      return s.phase === "idle" || TERMINAL.includes(s.phase) || s.phase === "review" ? { phase: "preparing", req: ev.req } : s;
    case "BLOCKED_BY_WALLET":
      return s.phase === "idle" || s.phase === "review" || TERMINAL.includes(s.phase) ? { phase: "unsupported", req: ev.req, moduleId: ev.moduleId, at: "before", tried: "none" } : s;
    case "PREPARED":
      if (s.phase !== "preparing") return s;
      return ev.res.solverWillFill
        ? { phase: "review", req: s.req, prepared: ev.res }
        : { phase: "declined", req: s.req, reasons: ev.res.skipReasons, summary: ev.res.summary };
    case "PREPARE_FAILED":
      return s.phase === "preparing" ? { phase: "failed", req: s.req, failure: ev.failure } : s;
    case "SIGN_START":
      return s.phase === "review" ? { phase: "signing", req: s.req, prepared: s.prepared } : s;
    case "WALLET_REJECTED":
      return s.phase === "signing" ? { phase: "rejected", req: s.req, prepared: s.prepared, stopped: ev.stopped } : s;
    case "WALLET_UNSUPPORTED":
      return s.phase === "signing" ? { phase: "unsupported", req: s.req, moduleId: ev.moduleId, at: "call", tried: isTxPrepared(s.prepared) ? "transaction" : "auth-entry" } : s;
    case "SIGNED":
      return s.phase === "signing" ? { phase: "submitting", req: s.req, prepared: s.prepared } : s;
    case "SUBMITTED":
      return s.phase === "submitting" ? { phase: "confirming", req: s.req, prepared: s.prepared, hash: ev.hash } : s;
    case "FAILED":
      // Reachable while the wallet is signing, while submitting, and while waiting for the ledger.
      if (s.phase === "signing" || s.phase === "submitting") return { phase: "failed", req: s.req, failure: ev.failure };
      if (s.phase === "confirming") return { phase: "failed", req: s.req, failure: ev.failure, hash: s.hash };
      return s;
    case "UNCONFIRMED":
      if (s.phase === "submitting") return { phase: "unconfirmed", req: s.req, prepared: s.prepared, hash: ev.hash, reason: ev.reason };
      if (s.phase === "confirming") return { phase: "unconfirmed", req: s.req, prepared: s.prepared, hash: ev.hash ?? s.hash, reason: ev.reason };
      return s;
    case "LANDED": {
      if (s.phase !== "confirming") return s;
      if (ev.status.status === "SUCCESS") {
        return { phase: "filled", req: s.req, prepared: s.prepared, hash: s.hash, received: ev.status.received, ledger: ev.status.ledger, hedge: ev.status.hedge };
      }
      if (ev.status.status === "FAILED") {
        const x = ev.status.explained;
        const failure = failureFor(x?.code ?? "FILL_FAILED", x?.message, x?.detail, "The fill did not go through");
        // In tier 2 the user sent the transaction, so a fill that fails on the ledger can still have been charged its fee.
        if (isTxPrepared(s.prepared)) failure.message += " The transaction was sent from your account, so the network may still have charged its fee.";
        return { phase: "failed", req: s.req, hash: s.hash, failure };
      }
      return s;
    }
    case "EXPIRED":
      if (s.phase === "review" || s.phase === "rejected") return { phase: "expired", req: s.req, during: "review" };
      if (s.phase === "signing") return { phase: "expired", req: s.req, during: "signing" };
      if (s.phase === "submitting") return { phase: "expired", req: s.req, during: "submit" };
      return s;
    case "HEDGE":
      return s.phase === "filled" ? { ...s, hedge: ev.hedge } : s;
    case "REVIEW_AGAIN":
      return s.phase === "rejected" ? { phase: "review", req: s.req, prepared: s.prepared } : s;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Input

const ASSET_ID = /^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/;

/**
 * Turn what someone typed or pasted into an asset id the orders API takes: `native` or `CODE:ISSUER`. "xlm" and
 * "native" (any case) mean the network's own asset. Anything else must be a full CODE:ISSUER: a bare code is
 * ambiguous (anyone can issue "USDC"), so it is refused rather than guessed. No list is consulted, because the
 * orders network is not the one the app's asset lists describe.
 */
export function parseAssetInput(input: string): string | undefined {
  const t = input.trim();
  if (/^(xlm|native)$/i.test(t)) return "native";
  return ASSET_ID.test(t) ? t : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Time

/** The server refuses an order with less than this left before its deadline; the app stops offering it a moment earlier. */
export const EXPIRY_MARGIN_SEC = 15;

/** Unix seconds after which this order cannot be filled: the order's deadline, or for a transaction the moment the network stops accepting it, whichever is first. */
export function goodUntil(p: Pick<PreparedOrder, "order"> | PreparedOrderTx): number {
  return "tx" in p ? Math.min(p.order.deadline, p.tx.maxTime) : p.order.deadline;
}

/** Seconds left to sign and send this order, counted against the margin. `expired` once nothing useful is left. */
export function expiry(p: Pick<PreparedOrder, "order"> | PreparedOrderTx, nowMs: number): { expired: boolean; secondsLeft: number } {
  const secondsLeft = Math.floor(goodUntil(p) - nowMs / 1000 - EXPIRY_MARGIN_SEC);
  return { expired: secondsLeft <= 0, secondsLeft: Math.max(0, secondsLeft) };
}

/** "9 min 41 s", "41 s". */
export function countdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
}

// ---------------------------------------------------------------------------------------------------------------
// Words

/** Plain sentences for every reason the solver can give for not filling (the server's `skipReasons`). */
const REASON_TEXT: Record<string, string> = {
  invalid_order: "The order is not valid.",
  deadline_too_close: "There is too little time left on this order for the solver to fill and hedge it.",
  order_too_large: "This is larger than the solver will take on in one order.",
  inventory_too_low: "The solver does not hold enough of the asset you want to receive to pay this amount.",
  no_hedge_quote: "The Classic order book has no path deep enough for the solver to hedge this size.",
  hedge_too_thin: "The Classic order book is too thin for the solver to hedge this size.",
  hedge_quote_mismatch: "The solver's hedge quote did not match the order size.",
  hedge_quote_stale: "The solver's hedge quote was too old.",
  hedge_below_amount_out: "The Classic market pays less for this than the minimum the order would ask for.",
  below_min_profit: "After the solver's costs there is nothing left to pay out at this size.",
};
export const reasonText = (code: string): string => REASON_TEXT[code] ?? `The solver declined (${code.replace(/_/g, " ")}).`;

/**
 * One sentence per server `explained.code` a Settle request can end in. Codes the server may add later fall
 * back to its own `explained.message`, which is already written for users.
 */
const FAILURE_TEXT: Record<string, string> = {
  BAD_ORDER_ID: "The order no longer matches what the server prepared, so it was not sent. Prepare it again.",
  WRONG_SIGNER: "The order was signed by a different account than the one it is for. Switch your wallet back to the connected account and prepare the order again.",
  BAD_SIGNATURE: "The signature does not match this order, or it has expired. Prepare a new order and sign again. Nothing was sent.",
  ENTRY_MISMATCH: "What was signed does not match the order you reviewed. Nothing was sent. Prepare the order again.",
  UNSUPPORTED_CREDENTIALS: "This wallet or server uses a kind of authorisation this version of the app cannot handle yet. Nothing was sent.",
  SOLVER_WILL_NOT_FILL: "The solver no longer fills this order at the price it showed. Nothing was sent and your signature cannot be used. Prepare it again for a current price.",
  BELOW_MIN_OUT: "The solver's payment would have left you with less than the minimum you signed for, so the contract refused it. Nothing moved.",
  ALREADY_USED: "This signed order has already been used. If you submitted it a moment ago, look for its result in your account activity; otherwise prepare a new order.",
  BAD_AMOUNT: "The order has a zero or negative amount, or the solver offered less than your minimum. Nothing moved.",
  SAME_TOKEN: "The order sells and buys the same asset.",
  BAD_SOLVER: "The order cannot be filled by the account that tried to fill it. Prepare a new order.",
  NO_TRUSTLINE: "This account has no trustline for the asset you want to pay with, so it cannot hold any of it.",
  INSUFFICIENT_BALANCE: "This account does not hold enough of the asset you want to pay with.",
  LOW_RESERVE: "This account does not have enough spare XLM to add a trustline (each one raises the minimum balance by 0.5 XLM).",
  NETWORK: "The Stellar testnet did not answer in time. Try again.",
  SIMULATION_FAILED: "The testnet rejected this order in simulation, so nothing was sent.",
  ORDERS_DISABLED: "Settlement orders are not enabled on this deployment.",
  ORDERS_MAINNET_REFUSED: "Settlement orders are testnet-only and are refused on the public network until the contract is audited.",
  ORDERS_NETWORK_MISMATCH: "Settlement orders are misconfigured on this deployment. Nothing was sent.",
  NO_ACCOUNT: "This account does not exist on the testnet yet. Fund it with friendbot and try again.",
  FILL_FAILED: "The fill did not go through. Nothing moved.",
  // Tier 2 (the user signs a transaction). Every one of these is raised before anything is sent.
  BAD_SEQUENCE: "Your account sent another transaction after this one was prepared, so this one can no longer be sent. Nothing was sent. Prepare the order again.",
  UNSUPPORTED_ENVELOPE: "The signed transaction is not a kind the server accepts (a fee bump or a muxed account). Nothing was sent. Prepare the order again.",
  WRONG_SOURCE: "The transaction was not from your connected account. Switch your wallet to the account you prepared the order for and try again. Nothing was sent.",
  TX_MISMATCH: "What your wallet returned is not the transaction you reviewed, so it was not sent. Prepare the order again.",
  BAD_AUTH: "The transaction's authorisations are not exactly the ones this order needs, so it was not sent. Prepare the order again.",
  BAD_TIMEBOUNDS: "The transaction's time limit is not the one that was prepared, so it was not sent. Prepare the order again.",
  SOLVER_TX_MISMATCH: "The solver prepared something other than the order that was priced, so nothing was offered for you to sign. Try again.",
  SOLVER_UNAVAILABLE: "The solver is not available right now, so no order can be filled. Nothing was signed. Try again shortly.",
};

export function failureFor(code: string, message: string | undefined, detail: string | undefined, title: string): Failure {
  return { code, title, message: FAILURE_TEXT[code] ?? (message || "Something went wrong. Nothing was sent."), detail: detail || undefined };
}

type Stage = "prepare" | "submit";
export type Verdict =
  | { kind: "failed"; failure: Failure }
  | { kind: "expired" }
  | { kind: "unconfirmed"; reason: "timeout" | "no-answer"; hash?: string };

/** What an error from `prepareOrder` or `submitOrder` means for the user. Duck-typed on `SluiceError`. */
export function verdictFromError(e: unknown, stage: Stage): Verdict {
  const err = e as { status?: unknown; message?: unknown; explained?: { code?: string; message?: string; detail?: string }; body?: { hash?: unknown; status?: unknown } } | null;
  const status = typeof err?.status === "number" ? err.status : undefined;
  const code = err?.explained?.code;
  const message = typeof err?.message === "string" ? err.message : undefined;
  const title = stage === "prepare" ? "The order could not be prepared" : "The order was not sent";

  if (code === "EXPIRED") return { kind: "expired" };
  if (status === 408) return { kind: "unconfirmed", reason: "timeout" };
  if (stage === "submit") {
    // The network refused it but is busy: nothing was accepted, and the same signature may be sent again.
    if (status === 503 && err?.body?.status === "TRY_AGAIN_LATER") {
      return { kind: "failed", failure: { code: "NETWORK_BUSY", title: "The network is busy", message: "The testnet is busy and did not accept the order. Nothing was sent. Try again in a few seconds." } };
    }
    // No answer, or the server failed after it may have sent the fill: we cannot say it did not go out.
    if (status === undefined || (status >= 500 && !code)) return { kind: "unconfirmed", reason: "no-answer" };
  }
  if (status === undefined) {
    return { kind: "failed", failure: { code: "NO_ANSWER", title, message: "The server did not answer. Check your connection and try again." } };
  }
  if (code) return { kind: "failed", failure: failureFor(code, err?.explained?.message, err?.explained?.detail, title) };
  if (status === 404) return { kind: "failed", failure: failureFor("NO_ACCOUNT", message, undefined, title) };
  if (status >= 500) return { kind: "failed", failure: { code: "SERVER_ERROR", title, message: "The server could not reach the Stellar testnet just now. Try again in a moment.", detail: message } };
  return { kind: "failed", failure: { code: "BAD_REQUEST", title, message: message ?? "The server did not accept this order." } };
}

/**
 * What a failure of the transaction route means, in words. These are the messages `signOrderTx` throws: before the wallet is asked
 * ("...; refusing to ask the wallet to sign it") or after it answers. All of them mean nothing was sent.
 */
export function txSigningFailureText(message: string): string {
  if (/refusing to ask the wallet to sign it/.test(message)) {
    return "The transaction the server prepared is not exactly the order you reviewed, so your wallet was not asked to sign it. Nothing was signed or sent. Prepare the order again.";
  }
  if (/different transaction than the one it was given/.test(message)) {
    return "Your wallet returned a different transaction than the one it was shown. This happens when the wallet is set to another network: switch it to the network above and try again. Nothing was sent.";
  }
  if (/signed with .*not the order's account/.test(message)) {
    return "Your wallet signed with a different account than the one this order is for. Switch it back to the connected account and prepare the order again. Nothing was sent.";
  }
  if (/signature on the transaction does not verify/.test(message)) {
    return "The signature your wallet returned does not match this transaction, so it was not sent. Prepare the order again.";
  }
  return message;
}

/** What the solver's hedge is doing, for the filled screen. Best effort: the server keeps it in memory only. */
export function hedgeText(h: HedgeStatus | undefined): { label: string; tone: "ok" | "wait" | "warn" } {
  if (!h) return { label: "The server has no record of the solver's hedge (it is kept in memory only).", tone: "wait" };
  switch (h.status) {
    case "PENDING":
    case "HEDGING":
      return { label: "The solver is selling the asset you paid on the Classic order book.", tone: "wait" };
    case "HEDGED":
      return { label: "The solver sold the asset you paid on the Classic order book.", tone: "ok" };
    case "NOT_NEEDED":
      return { label: "No hedge was needed.", tone: "ok" };
    case "UNHEDGED":
      return { label: "The solver could not hedge this fill and holds the position itself. Your fill is unaffected.", tone: "warn" };
    case "RETRYING":
      return { label: "The solver could not sell the asset you paid yet and is retrying. Your fill is unaffected.", tone: "warn" };
    case "ABANDONED":
      return { label: "The solver could not hedge this fill and has stopped retrying on its own; it holds the position. Your fill is unaffected.", tone: "warn" };
    case "UNKNOWN":
      return { label: "The solver could not be asked about its hedge just now. Your fill is unaffected.", tone: "wait" };
  }
}
const HEDGE_DONE = new Set(["HEDGED", "UNHEDGED", "ABANDONED", "NOT_NEEDED"]);

/**
 * The values a wallet will show for this order: raw contract arguments in the asset's smallest unit (7
 * decimals), not amounts. Shown next to the readable summary so the two can be compared.
 */
export function rawValues(p: Pick<Prepared, "order">): { label: string; value: string }[] {
  const o = p.order;
  return [
    { label: "amount_in", value: toStroops(o.amountIn).toString() },
    { label: "min_out", value: toStroops(o.minOut).toString() },
    { label: "deadline (unix seconds)", value: String(o.deadline) },
    { label: "create_trustline", value: String(o.createTrustline) },
    { label: "token_in", value: o.tokenIn },
    { label: "token_out", value: o.tokenOut },
    { label: "user", value: o.user },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Effects

export interface OrderDeps {
  /**
   * How a wallet may authorise an order on this deployment (`config.signing.tiers`). Absent means a server that predates tiers:
   * the authorisation-entry route only.
   */
  tiers?: readonly SigningTier[];
  prepare(req: OrderRequest): Promise<PrepareOrderResponse>;
  /** Show the wallet the entry and return the signed entry (base64). Throws what the wallet threw. */
  sign(prepared: PreparedOrder): Promise<string>;
  submit(p: { orderId: string; order: PreparedOrder["order"]; signedAuthEntry: string }): Promise<SubmitOrderResponse>;
  /** Tier 2. Required when `tiers` includes "tx". */
  prepareTx?(req: OrderRequest): Promise<PrepareOrderTxResponse>;
  /** Tier 2: review the transaction, show it to the wallet and return it signed (base64 envelope). Throws what the wallet or the review threw. */
  signTx?(prepared: PreparedOrderTx): Promise<string>;
  submitTx?(p: { orderId: string; order: PreparedOrderTx["order"]; signedTx: string }): Promise<SubmitOrderResponse>;
  status(hash: string): Promise<OrderStatusResponse>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface OrderController {
  readonly state: OrderState;
  subscribe(fn: (s: OrderState) => void): () => void;
  /**
   * Ask the solver for a price. `moduleId` is the connected wallet's kit id: it decides which signing route is used (see
   * `signingRoute`), and a wallet with no route stops here. `route` overrides that choice, for a wallet that turned out not to
   * sign authorisation entries after all: only "transaction" is honoured, and only when the server offers it.
   */
  prepare(req: OrderRequest, moduleId: string | undefined, route?: "transaction"): Promise<void>;
  /** Ask the wallet to sign what is on the review screen, then send it and follow it to the ledger. */
  sign(moduleId: string | undefined): Promise<void>;
  /** Give up on a wallet that never answers. A signature that arrives later is dropped. */
  stopWaiting(): void;
  reviewAgain(): void;
  /** Call about once a second while an order is on screen: moves it to `expired` when its time is up. */
  tick(): void;
  reset(): void;
  dispose(): void;
}

export interface ControllerOpts {
  /** How long to follow a sent fill before giving up on an answer. */
  confirmTimeoutMs?: number;
  pollMs?: number;
  /** How long to keep asking about the solver's hedge after the fill lands. */
  hedgeTimeoutMs?: number;
}

export function createOrderController(deps: OrderDeps, opts: ControllerOpts = {}): OrderController {
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1500;
  const hedgeTimeoutMs = opts.hedgeTimeoutMs ?? 90_000;
  let state: OrderState = IDLE;
  let generation = 0;
  const listeners = new Set<(s: OrderState) => void>();
  /** `state` as of now: effects change it across awaits, which the compiler's narrowing cannot see. */
  const now = (): OrderState => state;
  const dispatch = (ev: OrderEvent) => {
    const next = step(state, ev);
    if (next === state) return;
    state = next;
    for (const l of listeners) l(state);
  };

  const tiers = deps.tiers ?? DEFAULT_TIERS;
  const offers = (t: SigningTier) => tiers.includes(t);
  /** The route for a wallet, with the transaction route honoured as an override only when the server offers it and the app can run it. */
  const routeFor = (moduleId: string | undefined, forced: "transaction" | undefined): SigningRoute => {
    const txReady = offers("tx") && !!deps.prepareTx && !!deps.signTx && !!deps.submitTx;
    if (forced === "transaction") return txReady ? "transaction" : "none";
    const r = signingRoute(moduleId, tiers);
    return r === "transaction" && !txReady ? "none" : r;
  };

  /** Follow one order to the ledger. Transient errors are retried; only silence for long ends it. */
  async function follow(gen: number, hash: string): Promise<OrderStatusResponse | "timeout"> {
    const until = deps.now() + confirmTimeoutMs;
    let misses = 0;
    for (;;) {
      if (gen !== generation) return "timeout";
      try {
        const st = await deps.status(hash);
        misses = 0;
        if (st.status !== "NOT_FOUND") return st;
      } catch (e) {
        // The order is known to be sent. A hiccup while asking about it is not a verdict on it.
        if (++misses >= 5 || (e as { status?: unknown })?.status === 400) return "timeout";
      }
      if (deps.now() >= until) return "timeout";
      await deps.sleep(pollMs);
    }
  }

  async function trackHedge(gen: number, hash: string, first: HedgeStatus | undefined) {
    let last = first;
    const until = deps.now() + hedgeTimeoutMs;
    while ((!last || !HEDGE_DONE.has(last.status)) && deps.now() < until) {
      await deps.sleep(pollMs + 500);
      if (gen !== generation || now().phase !== "filled") return;
      try {
        const st = await deps.status(hash);
        if (st.hedge && JSON.stringify(st.hedge) !== JSON.stringify(last)) {
          last = st.hedge;
          dispatch({ type: "HEDGE", hedge: st.hedge });
        }
      } catch {
        /* best effort: the fill is already final */
      }
    }
  }

  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },

    async prepare(req, moduleId, forced) {
      const gen = ++generation;
      const route = routeFor(moduleId, forced);
      if (route === "none") {
        dispatch({ type: "BLOCKED_BY_WALLET", moduleId, req });
        return;
      }
      dispatch({ type: "PREPARE", req });
      if (now().phase !== "preparing") return;
      try {
        const res = route === "transaction" ? await deps.prepareTx!(req) : await deps.prepare(req);
        if (gen !== generation) return;
        dispatch({ type: "PREPARED", res });
        // A price that arrives with the deadline already too close is not offered.
        const after = now();
        if (after.phase === "review" && expiry(after.prepared, deps.now()).expired) dispatch({ type: "EXPIRED" });
      } catch (e) {
        if (gen !== generation) return;
        const v = verdictFromError(e, "prepare");
        dispatch({ type: "PREPARE_FAILED", failure: v.kind === "failed" ? v.failure : failureFor("NO_ANSWER", undefined, undefined, "The order could not be prepared") });
      }
    },

    async sign(moduleId) {
      const gen = generation;
      const s = state;
      if (s.phase !== "review") return;
      // What was prepared decides how it is signed: a transaction for tier 2, an authorisation entry for tier 1. The wallet is
      // checked again here, in case it changed since the order was prepared.
      const prepared = s.prepared;
      const tx = isTxPrepared(prepared);
      if (tx ? !offers("tx") : signingRoute(moduleId, tiers) !== "auth-entry") {
        dispatch({ type: "BLOCKED_BY_WALLET", moduleId, req: s.req });
        return;
      }
      if (expiry(prepared, deps.now()).expired) {
        dispatch({ type: "EXPIRED" });
        return;
      }
      dispatch({ type: "SIGN_START" });

      let signed: string;
      try {
        signed = tx ? await deps.signTx!(prepared) : await deps.sign(prepared as PreparedOrder);
      } catch (e) {
        // The user may have stopped waiting already; that answer stands.
        if (gen !== generation || now().phase !== "signing") return;
        const f = classifyWalletFailure(e);
        if (f.kind === "unsupported") dispatch({ type: "WALLET_UNSUPPORTED", moduleId });
        else if (f.kind === "rejected") dispatch({ type: "WALLET_REJECTED", stopped: f.stopped });
        else dispatch({ type: "FAILED", failure: { code: "WALLET_FAILED", title: "Nothing was signed or sent", message: tx ? txSigningFailureText(f.message) : f.message } });
        return;
      }
      if (gen !== generation || now().phase !== "signing") return; // stopped waiting: drop the late signature
      dispatch({ type: "SIGNED" });

      let sent: SubmitOrderResponse;
      try {
        sent = tx
          ? await deps.submitTx!({ orderId: prepared.orderId, order: prepared.order, signedTx: signed })
          : await deps.submit({ orderId: prepared.orderId, order: prepared.order, signedAuthEntry: signed });
      } catch (e) {
        if (gen !== generation) return;
        const v = verdictFromError(e, "submit");
        if (v.kind === "expired") dispatch({ type: "EXPIRED" });
        else if (v.kind === "unconfirmed") dispatch({ type: "UNCONFIRMED", reason: v.reason, hash: v.hash });
        else dispatch({ type: "FAILED", failure: v.failure });
        return;
      }
      if (gen !== generation) return;
      dispatch({ type: "SUBMITTED", hash: sent.hash });

      const result = await follow(gen, sent.hash);
      if (gen !== generation) return;
      if (result === "timeout") {
        dispatch({ type: "UNCONFIRMED", reason: "timeout", hash: sent.hash });
        return;
      }
      dispatch({ type: "LANDED", status: result });
      if (now().phase === "filled") void trackHedge(gen, sent.hash, result.hedge);
    },

    stopWaiting() {
      if (state.phase === "signing") dispatch({ type: "WALLET_REJECTED", stopped: true });
    },
    reviewAgain() {
      dispatch({ type: "REVIEW_AGAIN" });
      const s = state;
      if (s.phase === "review" && expiry(s.prepared, deps.now()).expired) dispatch({ type: "EXPIRED" });
    },
    tick() {
      const s = state;
      if ((s.phase === "review" || s.phase === "rejected" || s.phase === "signing") && expiry(s.prepared, deps.now()).expired) dispatch({ type: "EXPIRED" });
    },
    reset() {
      generation++;
      dispatch({ type: "RESET" });
    },
    dispose() {
      generation++;
      listeners.clear();
    },
  };
}
