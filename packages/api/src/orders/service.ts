import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import {
  explainCodes, explainFill, explainSettleCode, formatAmount, parseAmount, sacId, type Explained, type SubmitResult, type TxStatus,
} from "@sluice/core";
import {
  evaluateFill, feeToOut, type ClassicPair, type Decision, type Order, type QuotedHedge, type SkipReason, type SolverParams,
} from "@sluice/solver";
import { ACCOUNT_NOT_FOUND } from "../deps.js";
import { buildPreimage, checkSignature, isAddressEntry, reviewEntry, withExpiration } from "./auth.js";
import { assertNotMainnet, isPublicNetwork, networkName, type OrdersConfig } from "./config.js";
import { makeOrderId, verifyOrderId } from "./mac.js";

const ACCOUNT = /^G[A-Z2-7]{55}$/;
const ASSET = /^(native|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$/;
const TX_HASH = /^[0-9a-f]{64}$/;
const BASE_FEE_STROOPS = 100n;
/** Seconds per ledger, used only to turn a validity window into an expiration ledger. */
const LEDGER_SEC = 5;

export const DEFAULT_VALID_FOR_SEC = 600;
export const MIN_VALID_FOR_SEC = 120;
export const MAX_VALID_FOR_SEC = 3600;

/** The order as a client sees it: human assets and decimal amounts next to the contract's token ids. */
export interface OrderFields {
  user: string;
  assetIn: string;
  tokenIn: string;
  amountIn: string;
  assetOut: string;
  tokenOut: string;
  minOut: string;
  /** Ledger close time, unix seconds. */
  deadline: number;
  createTrustline: boolean;
}

export type HedgeStatus =
  | { status: "PENDING" }
  | { status: "HEDGING" }
  | { status: "HEDGED"; hash: string; received?: string }
  | { status: "UNHEDGED"; error: string; hash?: string }
  | { status: "NOT_NEEDED"; reason: string };

export interface HedgeOutcome { hash?: string; received?: bigint; error?: string }

/** A transaction as `GET /v1/orders/:hash` needs it: the usual status, plus the settle contract's error number when the fill failed with one. */
export interface OrderTx extends TxStatus { contractError?: number }

/** A recorded or enforced simulation of `fill`. `send` signs as the solver and submits exactly what was simulated. */
export interface FillSimulation {
  /** The user's authorisation entry: unsigned when recorded, as given when `signedUser` was passed. */
  userEntry: xdr.SorobanAuthorizationEntry;
  minResourceFee: bigint;
  send(): Promise<SubmitResult>;
}

/** Thrown by `simulateFill` when the network refuses the simulation. `message` is the raw RPC error (all lines). */
export class FillSimulationError extends Error {}

/** Everything the service reads from or sends to the network. Injectable, so tests never leave the process. */
export interface OrdersDeps {
  now(): number;
  /** The network passphrase the RPC endpoint itself reports. */
  networkPassphrase(): Promise<string>;
  latestLedger(): Promise<number>;
  /** Assets the account holds a trustline for (plus "native"). Throws `Error(ACCOUNT_NOT_FOUND)` for an unfunded account. */
  trustlines(account: string): Promise<Set<string>>;
  /** The solver's balance of `asset`, in stroops. */
  solverBalance(asset: string): Promise<bigint>;
  hedgeQuote(order: Order, pair: ClassicPair): Promise<QuotedHedge | null>;
  simulateFill(order: Order, amountOut: bigint, signedUser?: xdr.SorobanAuthorizationEntry): Promise<FillSimulation>;
  getTx(hash: string): Promise<OrderTx>;
  /** Sell the filled input on the Classic DEX. Throws on failure. */
  hedge(order: Order, pair: ClassicPair, amountOut: bigint): Promise<HedgeOutcome>;
}

/**
 * SEAM(recovery): called when a fill settled but the hedge did not, which leaves the solver holding the user's
 * `token_in` unhedged. A recovery module (retry, unwind, alert) plugs in here. Nothing is wired today: the
 * outcome is recorded as `UNHEDGED` in memory and nothing else happens.
 */
export interface OrdersHooks {
  onUnhedged?(ctx: { fillHash: string; order: Order; amountOut: bigint; error: string }): Promise<void> | void;
}

export interface ServiceResult { status: number; body: Record<string, unknown> }
const ok = (body: Record<string, unknown>): ServiceResult => ({ status: 200, body });
const fail = (status: number, error: string, explained?: Explained, extra: Record<string, unknown> = {}): ServiceResult => ({
  status,
  body: { error, ...(explained ? { explained } : {}), ...extra },
});
const explain = (code: string, message: string, detail = ""): Explained => ({ code, message, detail });
const firstLine = (s: string) => (s.split("\n")[0] ?? s).slice(0, 300);

const SKIP_TEXT: Record<SkipReason, string> = {
  invalid_order: "The order is not valid.",
  deadline_too_close: "There is too little time left on this order for the solver to fill and hedge it.",
  order_too_large: "This is larger than the solver will take on in one order.",
  inventory_too_low: "The solver does not hold enough of the asset you want to pay out this amount.",
  no_hedge_quote: "The Classic order book has no path deep enough to hedge this size, so the solver cannot fill it.",
  hedge_too_thin: "The Classic order book is too thin to hedge this size.",
  hedge_quote_mismatch: "The hedge quote did not match the order size.",
  hedge_quote_stale: "The hedge quote is too old.",
  hedge_below_amount_out: "The Classic market pays less for this than the minimum the order would ask for.",
  below_min_profit: "After the solver's costs and its profit floor there is nothing left to pay out at this size.",
};
const skipExplained = (reasons: SkipReason[]): Explained =>
  explain("SOLVER_WILL_NOT_FILL", `No solver will fill this order now. ${reasons.map((r) => SKIP_TEXT[r]).join(" ")} Nothing was signed.`, reasons.join(", "));

export function orderFields(o: Order, assetIn: string, assetOut: string): OrderFields {
  return {
    user: o.user, assetIn, tokenIn: o.tokenIn, amountIn: formatAmount(o.amountIn), assetOut, tokenOut: o.tokenOut,
    minOut: formatAmount(o.minOut), deadline: o.deadline, createTrustline: o.createTrustline,
  };
}

/** Validate a client-sent order and derive its contract form. Returns a message when it is malformed. */
export function parseOrderFields(v: unknown, passphrase: string): { order: Order; assetIn: string; assetOut: string } | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "order must be an object";
  const b = v as Record<string, unknown>;
  const user = String(b.user ?? "");
  const assetIn = String(b.assetIn ?? "");
  const assetOut = String(b.assetOut ?? "");
  if (!ACCOUNT.test(user)) return "order.user must be a G... address";
  if (!ASSET.test(assetIn) || !ASSET.test(assetOut) || assetIn === assetOut) return "order.assetIn and order.assetOut must be different 'native' or 'CODE:ISSUER' assets";
  let amountIn: bigint;
  let minOut: bigint;
  try {
    amountIn = parseAmount(String(b.amountIn ?? ""));
    minOut = parseAmount(String(b.minOut ?? ""));
  } catch {
    return "order.amountIn and order.minOut must be decimals with at most 7 places";
  }
  if (amountIn <= 0n || minOut <= 0n) return "order.amountIn and order.minOut must be positive";
  if (typeof b.deadline !== "number" || !Number.isSafeInteger(b.deadline) || b.deadline <= 0) return "order.deadline must be a unix timestamp in seconds";
  if (typeof b.createTrustline !== "boolean") return "order.createTrustline must be a boolean";
  let tokenIn: string;
  let tokenOut: string;
  try {
    tokenIn = sacId(assetIn, passphrase);
    tokenOut = sacId(assetOut, passphrase);
  } catch {
    return "order has an invalid asset issuer";
  }
  // tokenIn / tokenOut are echoed by prepare for convenience; if a client sends them they must be the derived ones.
  if ((b.tokenIn !== undefined && b.tokenIn !== tokenIn) || (b.tokenOut !== undefined && b.tokenOut !== tokenOut)) return "order.tokenIn / order.tokenOut do not match the assets";
  return { order: { user, tokenIn, amountIn, tokenOut, minOut, deadline: b.deadline, createTrustline: b.createTrustline }, assetIn, assetOut };
}

export interface OrdersServiceOpts {
  hooks?: OrdersHooks;
  /** How often the post-fill tracker polls for the fill to land. */
  pollMs?: number;
  /** Give up waiting for the fill after this long. */
  fillWaitMs?: number;
}

export function createOrdersService(config: OrdersConfig, deps: OrdersDeps, opts: OrdersServiceOpts = {}) {
  // Defence in depth: even a config object built by hand cannot start a service on the public network.
  assertNotMainnet(config.networkPassphrase);
  const solver = Keypair.fromSecret(config.solverSecret).publicKey();
  const pass = config.networkPassphrase;
  const pollMs = opts.pollMs ?? 1500;
  const fillWaitMs = opts.fillWaitMs ?? 180_000;

  /** Best-effort, in this process only. Bounded; the oldest entries go first. */
  const hedges = new Map<string, HedgeStatus>();
  const setHedge = (hash: string, s: HedgeStatus) => {
    hedges.delete(hash);
    hedges.set(hash, s);
    while (hedges.size > 500) hedges.delete(hedges.keys().next().value as string);
  };
  const pending = new Set<Promise<void>>();

  let networkOk = false;
  /** The RPC endpoint must really serve the configured, non-public network. Cached once it has. */
  async function ensureNetwork(): Promise<ServiceResult | null> {
    if (networkOk) return null;
    let reported: string;
    try {
      reported = await deps.networkPassphrase();
    } catch (e) {
      return fail(502, `could not reach the settlement network: ${firstLine((e as Error).message)}`);
    }
    if (isPublicNetwork(reported)) {
      return fail(503, "settlement orders are testnet-only: the configured RPC serves the public network", explain("ORDERS_MAINNET_REFUSED", "Settlement orders are refused on the public network until the contract is audited.", "rpc reports the public network"));
    }
    if (reported !== pass) {
      return fail(503, "the configured RPC serves a different network than ORDERS_NETWORK_PASSPHRASE", explain("ORDERS_NETWORK_MISMATCH", "Settlement orders are misconfigured on this deployment.", "rpc passphrase differs from configuration"));
    }
    networkOk = true;
    return null;
  }

  const params = (nowMs: number, solverBalanceOut: bigint, networkFeeOut: bigint, improvementShareBps: number): SolverParams => ({
    nowMs,
    minDeadlineBufferSec: config.policy.minDeadlineBufferSec,
    maxOrderIn: config.policy.maxOrderIn,
    solverBalanceOut,
    hedgeSlippageBps: config.policy.hedgeSlippageBps,
    minProfitBps: config.policy.minProfitBps,
    improvementShareBps,
    networkFeeOut,
    maxQuoteAgeSec: 60,
  });
  const feeOut = (assetOut: string, resourceFee: bigint) => {
    const stroops = resourceFee + 2n * BASE_FEE_STROOPS; // inclusion fee for the fill, and for the hedge payment
    return assetOut === "native" ? stroops : feeToOut(stroops, config.feeOutPerXlm);
  };

  function publicConfig() {
    return {
      enabled: true,
      network: networkName(pass),
      networkPassphrase: pass,
      settleContract: config.settleContract,
      solver,
      signing: { credentials: "address-legacy" as const },
      limits: { maxOrderIn: formatAmount(config.policy.maxOrderIn), validForSec: { min: MIN_VALID_FOR_SEC, max: MAX_VALID_FOR_SEC, default: DEFAULT_VALID_FOR_SEC } },
    };
  }

  async function prepare(b: Record<string, unknown>): Promise<ServiceResult> {
    const account = String(b.account ?? "");
    const assetIn = String(b.assetIn ?? "");
    const assetOut = String(b.assetOut ?? "");
    const slippageBps = Number(b.slippageBps ?? 50);
    const validFor = Number(b.validForSec ?? DEFAULT_VALID_FOR_SEC);
    if (!ACCOUNT.test(account)) return fail(400, "account must be a G... address");
    if (!ASSET.test(assetIn) || !ASSET.test(assetOut)) return fail(400, "assetIn and assetOut must be 'native' or 'CODE:ISSUER'");
    if (assetIn === assetOut) return fail(400, "assetIn and assetOut are identical");
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) return fail(400, "slippageBps must be an integer in 0..5000");
    if (!Number.isInteger(validFor) || validFor < MIN_VALID_FOR_SEC || validFor > MAX_VALID_FOR_SEC) return fail(400, `validForSec must be an integer in ${MIN_VALID_FOR_SEC}..${MAX_VALID_FOR_SEC}`);
    let amountIn: bigint;
    try {
      amountIn = parseAmount(String(b.amount ?? ""));
    } catch {
      return fail(400, "amount must be a decimal with at most 7 places");
    }
    if (amountIn <= 0n) return fail(400, "amount must be positive");
    let tokenIn: string;
    let tokenOut: string;
    try {
      tokenIn = sacId(assetIn, pass);
      tokenOut = sacId(assetOut, pass);
    } catch {
      return fail(400, "an asset issuer is not a valid account address");
    }

    const refused = await ensureNetwork();
    if (refused) return refused;

    let trusted: Set<string>;
    try {
      trusted = await deps.trustlines(account);
    } catch (e) {
      const m = (e as Error).message;
      return fail(m === ACCOUNT_NOT_FOUND ? 404 : 502, m === ACCOUNT_NOT_FOUND ? "account not found on the settlement network" : firstLine(m));
    }
    if (assetIn !== "native" && !trusted.has(assetIn)) {
      return fail(422, "this account holds none of the asset it wants to pay with", explain("NO_TRUSTLINE", "This account has no trustline for the asset being sold, so it cannot hold any of it. Nothing was signed.", assetIn));
    }

    const nowMs = deps.now();
    const deadline = Math.floor(nowMs / 1000) + validFor;
    const base: Order = { user: account, tokenIn, amountIn, tokenOut, minOut: 1n, deadline, createTrustline: assetOut !== "native" && !trusted.has(assetOut) };
    const pair: ClassicPair = { tokenIn: assetIn, tokenOut: assetOut };

    let hedge: QuotedHedge | null;
    let balance: bigint;
    try {
      [hedge, balance] = await Promise.all([deps.hedgeQuote(base, pair), deps.solverBalance(assetOut)]);
    } catch (e) {
      return fail(502, firstLine((e as Error).message));
    }
    const declined = (reasons: SkipReason[], extra: Record<string, unknown> = {}): ServiceResult =>
      ok({
        solverWillFill: false,
        skipReasons: reasons,
        explained: skipExplained(reasons),
        summary: { pay: formatAmount(amountIn), classicQuote: hedge ? formatAmount(hedge.quote.amountOut) : undefined, ...extra },
      });

    // Price the solver's own costs with a recording simulation at a placeholder order (the fee barely depends on the amounts).
    // Not possible without a hedge to pay for or inventory to pay out of: the evaluation below then says why it declines.
    let fee = 0n;
    if (hedge && balance > 0n) {
      try {
        fee = feeOut(assetOut, (await deps.simulateFill(base, 1n)).minResourceFee);
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        return fail(422, firstLine(e.message), explainFill(e.message, config.settleContract));
      }
    }

    // Pass 1: the most the solver could pay at all. min_out = 1 and a 100% improvement share make `amountOut` that maximum.
    const best = evaluateFill(base, hedge?.quote ?? null, params(nowMs, balance, fee, 10_000));
    if (best.action === "skip") return declined(best.reasons, best.maxPayableOut !== undefined && best.maxPayableOut > 0n ? { solverMaxPay: formatAmount(best.maxPayableOut) } : {});
    // What the user signs for: that maximum less their slippage tolerance. The solver then pays more than this by policy.
    const minOut = (best.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (minOut <= 0n) return declined(["below_min_profit"]);
    const order: Order = { ...base, minOut };
    const decision: Decision = evaluateFill(order, hedge!.quote, params(nowMs, balance, fee, config.policy.improvementShareBps));
    if (decision.action === "skip") return declined(decision.reasons);

    let sim: FillSimulation;
    try {
      sim = await deps.simulateFill(order, decision.amountOut);
    } catch (e) {
      return fail(422, firstLine((e as Error).message), explainFill((e as Error).message, config.settleContract));
    }
    if (!isAddressEntry(sim.userEntry)) {
      return fail(502, "the network asked for authorisation in a form this version does not support", explain("UNSUPPORTED_CREDENTIALS", "The settlement network returned a kind of authorisation entry this server cannot issue yet. Nothing was signed.", sim.userEntry.credentials().switch().name));
    }
    let latest: number;
    try {
      latest = await deps.latestLedger();
    } catch (e) {
      return fail(502, firstLine((e as Error).message));
    }
    const validUntilLedger = latest + Math.ceil(validFor / LEDGER_SEC);
    const entry = withExpiration(sim.userEntry, validUntilLedger);
    const nonce = entry.credentials().address().nonce().toString();
    const orderId = makeOrderId(config.macSecret, { passphrase: pass, settleContract: config.settleContract, solver, order, amountOut: decision.amountOut, nonce, validUntilLedger });
    return ok({
      solverWillFill: true,
      orderId,
      order: orderFields(order, assetIn, assetOut),
      summary: { pay: formatAmount(amountIn), receiveAtLeast: formatAmount(minOut), expected: formatAmount(decision.amountOut) },
      authEntry: {
        xdr: entry.toXDR("base64"),
        preimage: buildPreimage(entry, validUntilLedger, pass).toXDR("base64"),
        validUntilLedger,
        credentials: "address-legacy",
        networkPassphrase: pass,
      },
    });
  }

  async function submit(b: Record<string, unknown>): Promise<ServiceResult> {
    const orderId = String(b.orderId ?? "");
    const signedXdr = String(b.signedAuthEntry ?? "");
    const parsed = parseOrderFields(b.order, pass);
    if (typeof parsed === "string") return fail(400, parsed);
    if (!orderId) return fail(400, "orderId is required");
    if (!signedXdr) return fail(400, "signedAuthEntry is required");
    const { order, assetIn, assetOut } = parsed;

    let entry: xdr.SorobanAuthorizationEntry;
    try {
      entry = xdr.SorobanAuthorizationEntry.fromXDR(signedXdr, "base64");
    } catch {
      return fail(400, "signedAuthEntry is not a SorobanAuthorizationEntry in base64 XDR");
    }
    const bad = (code: string, message: string, status = 400) => fail(status, message, explain(code, `${message} Nothing was sent.`, code));
    if (!isAddressEntry(entry)) return bad("UNSUPPORTED_CREDENTIALS", "The authorisation entry must use address credentials (SOROBAN_CREDENTIALS_ADDRESS).");
    const creds = entry.credentials().address();
    const validUntilLedger = creds.signatureExpirationLedger();

    // The id binds the order, what the solver agreed to pay, the entry's nonce and expiry, and this server's settings.
    const amountOut = verifyOrderId(config.macSecret, orderId, { passphrase: pass, settleContract: config.settleContract, solver, order, nonce: creds.nonce().toString(), validUntilLedger });
    if (amountOut === null) return bad("BAD_ORDER_ID", "orderId does not match this order and entry: it was not prepared by this server, or something in it was changed. Prepare a new order.");

    const refused = await ensureNetwork();
    if (refused) return refused;
    let latest: number;
    try {
      latest = await deps.latestLedger();
    } catch (e) {
      return fail(502, firstLine((e as Error).message));
    }
    const nowSec = Math.floor(deps.now() / 1000);
    if (validUntilLedger <= latest + 2 || order.deadline <= nowSec + 15) return bad("EXPIRED", "This order has expired. Prepare a new one.", 410);

    const problem = reviewEntry(entry, order, config.settleContract) ?? checkSignature(entry, order, pass);
    if (problem) return bad(problem.code, problem.message);

    // Enforcing simulation: the network itself checks the signature, the nonce and the contract's rules.
    let sim: FillSimulation;
    try {
      sim = await deps.simulateFill(order, amountOut, entry);
    } catch (e) {
      const raw = (e as Error).message;
      return fail(422, firstLine(raw), explainFill(raw, config.settleContract));
    }

    // The price may have moved since prepare. The id proves the solver once agreed to pay `amountOut`; it does not oblige it to lose money now.
    const pair: ClassicPair = { tokenIn: assetIn, tokenOut: assetOut };
    let hedge: QuotedHedge | null;
    let balance: bigint;
    try {
      [hedge, balance] = await Promise.all([deps.hedgeQuote(order, pair), deps.solverBalance(assetOut)]);
    } catch (e) {
      return fail(502, firstLine((e as Error).message));
    }
    const recheck = evaluateFill({ ...order, minOut: amountOut }, hedge?.quote ?? null, params(deps.now(), balance, feeOut(assetOut, sim.minResourceFee), 0));
    if (recheck.action === "skip") {
      if (recheck.reasons.includes("deadline_too_close")) return bad("EXPIRED", "There is too little time left on this order. Prepare a new one.", 410);
      return fail(409, "the solver no longer fills this order at the prepared price", skipExplained(recheck.reasons), { skipReasons: recheck.reasons });
    }

    let sent: SubmitResult;
    try {
      sent = await sim.send();
    } catch (e) {
      return fail(502, firstLine((e as Error).message));
    }
    if (sent.status === "ERROR") {
      return fail(422, "the network rejected this transaction", explainCodes(sent.codes ?? []), { hash: sent.hash, status: sent.status });
    }
    if (sent.status === "TRY_AGAIN_LATER") return fail(503, "the network is busy, submit again in a few seconds", undefined, { hash: sent.hash, status: sent.status });
    track(sent.hash, order, pair, amountOut);
    return ok({ hash: sent.hash, status: sent.status });
  }

  /** After the fill is sent: wait for it to land, then hedge. Runs in this process only; its state is not durable. */
  function track(hash: string, order: Order, pair: ClassicPair, amountOut: bigint): void {
    setHedge(hash, { status: "PENDING" });
    const run = (async () => {
      const deadline = Date.now() + fillWaitMs;
      let tx: OrderTx | undefined;
      while (Date.now() < deadline) {
        try {
          tx = await deps.getTx(hash);
          if (tx.status !== "NOT_FOUND") break;
        } catch { /* keep polling */ }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (!tx || tx.status !== "SUCCESS") {
        setHedge(hash, { status: "NOT_NEEDED", reason: tx?.status === "FAILED" ? "the fill failed, so the solver took nothing" : "the fill was not seen in a ledger" });
        return;
      }
      setHedge(hash, { status: "HEDGING" });
      try {
        const r = await deps.hedge(order, pair, amountOut);
        if (r.error) throw new Error(r.error);
        setHedge(hash, { status: "HEDGED", hash: r.hash!, received: r.received === undefined ? undefined : formatAmount(r.received) });
      } catch (e) {
        const error = firstLine((e as Error).message);
        setHedge(hash, { status: "UNHEDGED", error });
        // SEAM(recovery): hand the unhedged position to the recovery module here.
        try {
          await opts.hooks?.onUnhedged?.({ fillHash: hash, order, amountOut, error });
        } catch { /* a failing hook must not hide the UNHEDGED status */ }
      }
    })();
    pending.add(run);
    void run.finally(() => pending.delete(run));
  }

  async function status(hash: string): Promise<ServiceResult> {
    if (!TX_HASH.test(hash)) return fail(400, "hash must be 64 hex characters");
    const refused = await ensureNetwork();
    if (refused) return refused;
    let t: OrderTx;
    try {
      t = await deps.getTx(hash);
    } catch (e) {
      return fail(502, firstLine((e as Error).message));
    }
    const hedge = hedges.get(hash);
    if (t.status === "NOT_FOUND") return ok({ hash, status: "NOT_FOUND", ...(hedge ? { hedge } : {}) });
    const fill = readFill(t, config.settleContract);
    if (!fill) return fail(404, "that transaction is not a fill of this settlement contract");
    if (t.status === "SUCCESS") {
      return ok({ hash, status: "SUCCESS", ledger: t.ledger, createdAt: t.createdAt, received: fill.received === undefined ? undefined : formatAmount(fill.received), ...(hedge ? { hedge } : {}) });
    }
    const explained = (t.contractError !== undefined ? explainSettleCode(t.contractError) : null) ?? explainCodes(t.codes ?? []);
    return ok({ hash, status: "FAILED", ledger: t.ledger, createdAt: t.createdAt, explained, ...(hedge ? { hedge } : {}) });
  }

  return {
    solver,
    publicConfig,
    prepare,
    submit,
    status,
    /** Test hook: resolves when every post-fill tracker has finished. */
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
    hedgeOf: (hash: string) => hedges.get(hash),
  };
}

export type OrdersService = ReturnType<typeof createOrdersService>;

/** Is this transaction a call to `settleContract.fill`, and if it succeeded, what did it return (the amount the user received)? */
export function readFill(tx: Pick<TxStatus, "envelopeXdr" | "returnValue">, settleContract: string): { received?: bigint } | null {
  if (!tx.envelopeXdr) return null;
  try {
    const env = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64");
    if (env.switch().name !== "envelopeTypeTx") return null;
    const op = env.v1().tx().operations()[0]?.body();
    if (!op || op.switch().name !== "invokeHostFunction") return null;
    const fn = op.invokeHostFunctionOp().hostFunction();
    if (fn.switch().name !== "hostFunctionTypeInvokeContract") return null;
    const inv = fn.invokeContract();
    if (inv.functionName().toString() !== "fill" || Address.fromScAddress(inv.contractAddress()).toString() !== settleContract) return null;
    if (!tx.returnValue) return {};
    const v = xdr.ScVal.fromXDR(tx.returnValue, "base64");
    // Result<i128, Error>: an Ok arrives as the bare i128.
    if (v.switch().name !== "scvI128") return {};
    const parts = v.i128();
    return { received: (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString()) };
  } catch {
    return null;
  }
}
