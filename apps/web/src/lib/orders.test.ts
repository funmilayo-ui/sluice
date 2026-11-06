import { describe, expect, it, vi } from "vitest";
import type { OrderStatusResponse, PreparedOrder, PreparedOrderTx, PrepareOrderResponse, PrepareOrderTxResponse } from "@sluice/sdk";
import {
  countdown, createOrderController, EXPIRY_MARGIN_SEC, expiry, failureFor, goodUntil, hedgeText, isTxPrepared, parseAssetInput, rawValues, reasonText, step, txSigningFailureText, verdictFromError,
  type OrderDeps, type OrderRequest, type OrderState,
} from "./orders";
import { SigningAborted } from "./orderWallet";

const USER = "GDZZR6UBK5TWJ5AXFX74N442RLEAEERYUSP7JHMXAHUAMGEGZSC3ZAVT";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const A = `SLFA:${ISSUER}`;
const C = `SLFC:${ISSUER}`;
const NOW = 1_800_000_000_000;

const req: OrderRequest = { account: USER, assetIn: A, assetOut: C, amount: "100", slippageBps: 50 };
const prepared = (over: Partial<PreparedOrder["order"]> = {}): PreparedOrder => ({
  solverWillFill: true,
  orderId: "id-1",
  order: { user: USER, assetIn: A, tokenIn: "CAAA", amountIn: "100.0000000", assetOut: C, tokenOut: "CBBB", minOut: "103.5000000", deadline: NOW / 1000 + 600, createTrustline: false, ...over },
  summary: { pay: "100.0000000", receiveAtLeast: "103.5000000", expected: "104.1000000" },
  authEntry: { xdr: "xdr", preimage: "pre", validUntilLedger: 999, credentials: "address-legacy", networkPassphrase: "Test SDF Network ; September 2015" },
});
const preparedTx = (over: { maxTime?: number; networkFee?: string } = {}): PreparedOrderTx => ({
  solverWillFill: true,
  orderId: "id-tx",
  order: prepared().order,
  summary: { pay: "100.0000000", receiveAtLeast: "103.5000000", expected: "104.1000000", networkFee: over.networkFee ?? "0.0140000" },
  tx: { xdr: "txxdr", hash: "ab".repeat(32), source: USER, validUntilLedger: 999, maxTime: over.maxTime ?? NOW / 1000 + 300, networkPassphrase: "Test SDF Network ; September 2015" },
});
const declinedRes: PrepareOrderResponse = {
  solverWillFill: false,
  skipReasons: ["no_hedge_quote"],
  explained: { code: "SOLVER_WILL_NOT_FILL", message: "No solver will fill this order now.", detail: "no_hedge_quote" },
  summary: { pay: "500.0000000", classicQuote: "510", solverMaxPay: "271.8" },
};
const err = (status: number, message: string, explained?: { code: string; message: string; detail?: string }, body?: Record<string, unknown>) =>
  Object.assign(new Error(message), { status, explained: explained && { detail: "", ...explained }, body });

describe("step: the transitions", () => {
  const idle: OrderState = { phase: "idle" };
  const preparing = step(idle, { type: "PREPARE", req });
  const review = step(preparing, { type: "PREPARED", res: prepared() });

  it("idle -> preparing -> review when the solver will fill", () => {
    expect(preparing).toEqual({ phase: "preparing", req });
    expect(review).toMatchObject({ phase: "review", req, prepared: { orderId: "id-1" } });
  });
  it("preparing -> declined with the reasons and what the book alone would pay", () => {
    expect(step(preparing, { type: "PREPARED", res: declinedRes })).toMatchObject({ phase: "declined", reasons: ["no_hedge_quote"], summary: { classicQuote: "510", solverMaxPay: "271.8" } });
  });
  it("preparing -> failed on a prepare error", () => {
    const failure = failureFor("NO_ACCOUNT", undefined, undefined, "t");
    expect(step(preparing, { type: "PREPARE_FAILED", failure })).toEqual({ phase: "failed", req, failure });
  });
  it("review -> signing -> submitting -> confirming -> filled, carrying what was shown", () => {
    const signing = step(review, { type: "SIGN_START" });
    const submitting = step(signing, { type: "SIGNED" });
    const confirming = step(submitting, { type: "SUBMITTED", hash: "h" });
    const filled = step(confirming, { type: "LANDED", status: { hash: "h", status: "SUCCESS", ledger: 7, received: "104.1000000", hedge: { status: "PENDING" } } });
    expect([signing.phase, submitting.phase, confirming.phase, filled.phase]).toEqual(["signing", "submitting", "confirming", "filled"]);
    expect(filled).toMatchObject({ received: "104.1000000", hash: "h", ledger: 7, hedge: { status: "PENDING" }, prepared: { orderId: "id-1" } });
  });
  it("a fill that failed on chain becomes failed, with the contract's explanation and the hash", () => {
    const confirming = step(step(step(review, { type: "SIGN_START" }), { type: "SIGNED" }), { type: "SUBMITTED", hash: "h" });
    const s = step(confirming, { type: "LANDED", status: { hash: "h", status: "FAILED", explained: { code: "BELOW_MIN_OUT", message: "m", detail: "settle contract error #5" } } });
    expect(s).toMatchObject({ phase: "failed", hash: "h", failure: { code: "BELOW_MIN_OUT", detail: "settle contract error #5" } });
    expect((s as { failure: { message: string } }).failure.message).toMatch(/less than the minimum you signed for/);
  });
  it("signing -> rejected -> review again; rejected remembers the order", () => {
    const rejected = step(step(review, { type: "SIGN_START" }), { type: "WALLET_REJECTED", stopped: false });
    expect(rejected).toMatchObject({ phase: "rejected", stopped: false, prepared: { orderId: "id-1" } });
    expect(step(rejected, { type: "REVIEW_AGAIN" })).toMatchObject({ phase: "review", prepared: { orderId: "id-1" } });
  });
  it("signing -> unsupported when the wallet says it cannot", () => {
    expect(step(step(review, { type: "SIGN_START" }), { type: "WALLET_UNSUPPORTED", moduleId: "walletconnect" })).toMatchObject({ phase: "unsupported", at: "call" });
  });
  it("EXPIRED reaches review, rejected, signing and submitting, and says where", () => {
    const signing = step(review, { type: "SIGN_START" });
    expect(step(review, { type: "EXPIRED" })).toMatchObject({ phase: "expired", during: "review" });
    expect(step(step(signing, { type: "WALLET_REJECTED", stopped: true }), { type: "EXPIRED" })).toMatchObject({ phase: "expired", during: "review" });
    expect(step(signing, { type: "EXPIRED" })).toMatchObject({ phase: "expired", during: "signing" });
    expect(step(step(signing, { type: "SIGNED" }), { type: "EXPIRED" })).toMatchObject({ phase: "expired", during: "submit" });
  });
  it("UNCONFIRMED from submitting or confirming keeps the hash when there is one", () => {
    const submitting = step(step(review, { type: "SIGN_START" }), { type: "SIGNED" });
    expect(step(submitting, { type: "UNCONFIRMED", reason: "no-answer" })).toMatchObject({ phase: "unconfirmed", reason: "no-answer", hash: undefined });
    const confirming = step(submitting, { type: "SUBMITTED", hash: "h" });
    expect(step(confirming, { type: "UNCONFIRMED", reason: "timeout" })).toMatchObject({ phase: "unconfirmed", reason: "timeout", hash: "h" });
  });
  it("HEDGE updates a filled order and nothing else", () => {
    const filled = step(step(step(step(review, { type: "SIGN_START" }), { type: "SIGNED" }), { type: "SUBMITTED", hash: "h" }), { type: "LANDED", status: { hash: "h", status: "SUCCESS", received: "1" } });
    expect(step(filled, { type: "HEDGE", hedge: { status: "HEDGED", hash: "x" } })).toMatchObject({ phase: "filled", hedge: { status: "HEDGED" } });
    expect(step(review, { type: "HEDGE", hedge: { status: "PENDING" } })).toBe(review);
  });
  it("a wallet with no support is stopped before anything is prepared", () => {
    expect(step(idle, { type: "BLOCKED_BY_WALLET", moduleId: "albedo", req })).toMatchObject({ phase: "unsupported", moduleId: "albedo", at: "before" });
  });
  it("RESET returns to idle from anywhere; PREPARE can restart from any end state", () => {
    expect(step(review, { type: "RESET" })).toEqual(idle);
    for (const ev of [{ type: "EXPIRED" as const }]) expect(step(step(review, ev), { type: "PREPARE", req }).phase).toBe("preparing");
    expect(step(step(preparing, { type: "PREPARED", res: declinedRes }), { type: "PREPARE", req }).phase).toBe("preparing");
  });
  it("ignores events that do not fit the current state, so a late result cannot overwrite the screen", () => {
    expect(step(idle, { type: "SIGNED" })).toBe(idle);
    expect(step(review, { type: "SIGNED" })).toBe(review); // cannot skip the wallet
    expect(step(review, { type: "SUBMITTED", hash: "h" })).toBe(review);
    expect(step(review, { type: "LANDED", status: { hash: "h", status: "SUCCESS" } })).toBe(review);
    expect(step(preparing, { type: "SIGN_START" })).toBe(preparing);
    const rejected = step(step(review, { type: "SIGN_START" }), { type: "WALLET_REJECTED", stopped: true });
    expect(step(rejected, { type: "SIGNED" })).toBe(rejected); // a signature that arrives after giving up
    expect(step(rejected, { type: "WALLET_UNSUPPORTED", moduleId: "x" })).toBe(rejected);
    const filled = step(step(step(step(review, { type: "SIGN_START" }), { type: "SIGNED" }), { type: "SUBMITTED", hash: "h" }), { type: "LANDED", status: { hash: "h", status: "SUCCESS" } });
    expect(step(filled, { type: "EXPIRED" })).toBe(filled);
    expect(step(filled, { type: "FAILED", failure: failureFor("X", "m", undefined, "t") })).toBe(filled);
  });
  it("a state is never mutated", () => {
    const frozen = Object.freeze({ ...review });
    expect(() => step(frozen, { type: "SIGN_START" })).not.toThrow();
    expect(review.phase).toBe("review");
  });
});

describe("expiry", () => {
  it("counts down to the deadline minus the margin the server uses, and never goes negative", () => {
    const p = prepared({ deadline: NOW / 1000 + 100 });
    expect(expiry(p, NOW)).toEqual({ expired: false, secondsLeft: 100 - EXPIRY_MARGIN_SEC });
    expect(expiry(p, NOW + (100 - EXPIRY_MARGIN_SEC) * 1000).expired).toBe(true);
    expect(expiry(p, NOW + 500_000)).toEqual({ expired: true, secondsLeft: 0 });
  });
  it("formats the countdown", () => {
    expect(countdown(581)).toBe("9 min 41 s");
    expect(countdown(60)).toBe("1 min 00 s");
    expect(countdown(41)).toBe("41 s");
    expect(countdown(-3)).toBe("0 s");
  });
});

describe("failure mapping: every code the server can end a Settle request with", () => {
  const cases: [code: string, status: number, expectText: RegExp][] = [
    ["BAD_ORDER_ID", 400, /no longer matches what the server prepared.*Prepare it again/],
    ["WRONG_SIGNER", 400, /different account.*Switch your wallet back/],
    ["BAD_SIGNATURE", 400, /does not match this order, or it has expired.*Nothing was sent/],
    ["ENTRY_MISMATCH", 400, /does not match the order you reviewed.*Nothing was sent/],
    ["UNSUPPORTED_CREDENTIALS", 400, /kind of authorisation this version/],
    ["SOLVER_WILL_NOT_FILL", 409, /no longer fills this order at the price it showed.*cannot be used/],
    ["BELOW_MIN_OUT", 422, /less than the minimum you signed for.*Nothing moved/],
    ["ALREADY_USED", 422, /already been used/],
    ["BAD_AMOUNT", 422, /zero or negative amount/],
    ["SAME_TOKEN", 422, /same asset/],
    ["BAD_SOLVER", 422, /cannot be filled by the account/],
    ["NO_TRUSTLINE", 422, /no trustline for the asset you want to pay with/],
    ["INSUFFICIENT_BALANCE", 422, /does not hold enough/],
    ["LOW_RESERVE", 422, /trustline/],
    ["NETWORK", 422, /did not answer in time/],
    ["SIMULATION_FAILED", 422, /rejected this order in simulation/],
    ["ORDERS_DISABLED", 501, /not enabled on this deployment/],
    ["ORDERS_MAINNET_REFUSED", 501, /testnet-only/],
    ["ORDERS_NETWORK_MISMATCH", 503, /misconfigured/],
  ];
  it.each(cases)("%s (HTTP %i) -> a sentence that says what happened and what is true about the funds", (code, status, text) => {
    for (const stage of ["prepare", "submit"] as const) {
      const v = verdictFromError(err(status, "raw server text", { code, message: "the server's own words" }), stage);
      expect(v.kind, `${stage} ${code}`).toBe("failed");
      if (v.kind === "failed") {
        expect(v.failure.code).toBe(code);
        expect(v.failure.message).toMatch(text);
        expect(v.failure.message).not.toMatch(/!/);
      }
    }
  });
  it("EXPIRED is not a failure: it sends the user to a new price", () => {
    expect(verdictFromError(err(410, "expired", { code: "EXPIRED", message: "x" }), "submit")).toEqual({ kind: "expired" });
  });
  it("an unknown code falls back to the server's own message rather than hiding it", () => {
    const v = verdictFromError(err(422, "raw", { code: "SOMETHING_NEW", message: "The server explains it." }), "submit");
    expect(v).toMatchObject({ kind: "failed", failure: { code: "SOMETHING_NEW", message: "The server explains it." } });
  });
  it("prepare: an unknown account is explained, validation errors keep their text, server trouble is plain", () => {
    expect(verdictFromError(err(404, "account not found on the settlement network"), "prepare")).toMatchObject({ failure: { code: "NO_ACCOUNT", message: expect.stringMatching(/friendbot/) } });
    expect(verdictFromError(err(400, "amount must be positive"), "prepare")).toMatchObject({ failure: { code: "BAD_REQUEST", message: "amount must be positive" } });
    expect(verdictFromError(err(502, "boom"), "prepare")).toMatchObject({ failure: { code: "SERVER_ERROR", message: expect.stringMatching(/Try again in a moment/) } });
    expect(verdictFromError(new TypeError("Failed to fetch"), "prepare")).toMatchObject({ failure: { code: "NO_ANSWER" } });
  });
  it("submit: no answer, or a server error with no explanation, is 'unconfirmed', never 'failed', because the fill may have gone out", () => {
    expect(verdictFromError(new TypeError("Failed to fetch"), "submit")).toEqual({ kind: "unconfirmed", reason: "no-answer" });
    expect(verdictFromError(err(502, "boom"), "submit")).toEqual({ kind: "unconfirmed", reason: "no-answer" });
    expect(verdictFromError(err(408, "order not found in a ledger yet"), "submit")).toEqual({ kind: "unconfirmed", reason: "timeout" });
  });
  it("submit: the network being busy is a clean failure the user can retry", () => {
    const v = verdictFromError(err(503, "busy", undefined, { status: "TRY_AGAIN_LATER", hash: "h" }), "submit");
    expect(v).toMatchObject({ kind: "failed", failure: { code: "NETWORK_BUSY" } });
  });
});

describe("small pure helpers", () => {
  it("parseAssetInput accepts XLM and full CODE:ISSUER only", () => {
    expect(parseAssetInput(" xlm ")).toBe("native");
    expect(parseAssetInput("NATIVE")).toBe("native");
    expect(parseAssetInput(A)).toBe(A);
    expect(parseAssetInput("USDC")).toBeUndefined();
    expect(parseAssetInput("USDC:short")).toBeUndefined();
    expect(parseAssetInput("")).toBeUndefined();
    expect(parseAssetInput(`TOOLONGCODE123:${ISSUER}`)).toBeUndefined();
  });
  it("rawValues shows what the wallet shows: stroops, not decimals", () => {
    const v = Object.fromEntries(rawValues(prepared({ createTrustline: true })).map((r) => [r.label, r.value]));
    expect(v.amount_in).toBe("1000000000");
    expect(v.min_out).toBe("1035000000");
    expect(v.create_trustline).toBe("true");
    expect(v.user).toBe(USER);
  });
  it("reasonText has a sentence for every reason the solver gives, and a safe fallback", () => {
    for (const r of ["invalid_order", "deadline_too_close", "order_too_large", "inventory_too_low", "no_hedge_quote", "hedge_too_thin", "hedge_quote_mismatch", "hedge_quote_stale", "hedge_below_amount_out", "below_min_profit"]) {
      expect(reasonText(r)).toMatch(/\.$/);
      expect(reasonText(r)).not.toContain("_");
    }
    expect(reasonText("brand_new_reason")).toBe("The solver declined (brand new reason).");
  });
  it("hedgeText never claims success it was not told", () => {
    expect(hedgeText(undefined).tone).toBe("wait");
    expect(hedgeText({ status: "HEDGING" }).tone).toBe("wait");
    expect(hedgeText({ status: "HEDGED", hash: "h" }).tone).toBe("ok");
    expect(hedgeText({ status: "UNHEDGED", error: "e" })).toMatchObject({ tone: "warn", label: expect.stringMatching(/Your fill is unaffected/) });
    expect(hedgeText({ status: "NOT_NEEDED", reason: "r" }).tone).toBe("ok");
  });
});

/** Scripted dependencies. Time is virtual: `sleep` advances the clock. */
function harness(over: Partial<OrderDeps> = {}) {
  let t = NOW;
  const deps: OrderDeps = {
    prepare: vi.fn(async () => prepared()),
    sign: vi.fn(async () => "signed-entry"),
    submit: vi.fn(async () => ({ hash: "h", status: "PENDING" as const })),
    status: vi.fn(async (): Promise<OrderStatusResponse> => ({ hash: "h", status: "SUCCESS", ledger: 9, received: "104.1000000", hedge: { status: "HEDGED", hash: "hh" } })),
    now: () => t,
    sleep: async (ms) => { t += ms; },
    ...over,
  };
  const c = createOrderController(deps, { confirmTimeoutMs: 10_000, pollMs: 1000, hedgeTimeoutMs: 20_000 });
  const seen: string[] = [];
  c.subscribe((s) => seen.push(s.phase));
  return { c, deps, seen, advance: (ms: number) => { t += ms; } };
}

describe("the controller: whole flows", () => {
  it("happy path: prepare, review, sign, submit, follow to the ledger, filled, hedge reported", async () => {
    const { c, deps, seen } = harness({
      status: vi.fn()
        .mockResolvedValueOnce({ hash: "h", status: "NOT_FOUND" })
        .mockResolvedValueOnce({ hash: "h", status: "SUCCESS", ledger: 9, received: "104.1000000", hedge: { status: "PENDING" } })
        .mockResolvedValue({ hash: "h", status: "SUCCESS", ledger: 9, received: "104.1000000", hedge: { status: "HEDGED", hash: "hh" } }),
    });
    await c.prepare(req, "freighter");
    expect(c.state.phase).toBe("review");
    await c.sign("freighter");
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ orderId: "id-1" }));
    expect(deps.submit).toHaveBeenCalledWith({ orderId: "id-1", order: prepared().order, signedAuthEntry: "signed-entry" });
    expect(c.state).toMatchObject({ phase: "filled", received: "104.1000000", hash: "h" });
    // The hedge is reported afterwards, best effort.
    await vi.waitFor(() => expect(c.state).toMatchObject({ phase: "filled", hedge: { status: "HEDGED" } }));
    expect(seen).toEqual(["preparing", "review", "signing", "submitting", "confirming", "filled", "filled"]);
  });

  it("declined: nothing is prepared, nothing can be signed", async () => {
    const { c, deps } = harness({ prepare: vi.fn(async () => declinedRes) });
    await c.prepare(req, "freighter");
    expect(c.state).toMatchObject({ phase: "declined", reasons: ["no_hedge_quote"] });
    await c.sign("freighter");
    expect(deps.sign).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("a wallet known not to sign orders is stopped before the server is even asked", async () => {
    const { c, deps } = harness();
    await c.prepare(req, "albedo");
    expect(c.state).toMatchObject({ phase: "unsupported", moduleId: "albedo", at: "before" });
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.sign).not.toHaveBeenCalled();
  });

  it("the kit 2.8.0 id for Freighter ('varial') is allowed through, like 'freighter'", async () => {
    const { c, deps } = harness();
    await c.prepare(req, "varial");
    expect(c.state.phase).toBe("review");
    await c.sign("varial");
    expect(deps.sign).toHaveBeenCalled();
  });

  it("a wallet that is merely unknown is allowed to try", async () => {
    const { c } = harness();
    await c.prepare(req, "wallet_connect");
    expect(c.state.phase).toBe("review");
  });

  it("a wallet that answers code -3 ends in unsupported, with nothing submitted", async () => {
    const { c, deps } = harness({ sign: vi.fn(async () => { throw { code: -3, message: 'Hana does not support the "signAuthEntry" function' }; }) });
    await c.prepare(req, "hana");
    await c.sign("hana");
    expect(c.state).toMatchObject({ phase: "unsupported", at: "call" });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("a user who declines (code -4) lands on rejected and can sign again while the order is good", async () => {
    let first = true;
    const { c, deps } = harness({ sign: vi.fn(async () => { if (first) { first = false; throw { code: -4, message: "The user rejected this request." }; } return "signed-entry"; }) });
    await c.prepare(req, "freighter");
    await c.sign("freighter");
    expect(c.state).toMatchObject({ phase: "rejected", stopped: false });
    expect(deps.submit).not.toHaveBeenCalled();
    c.reviewAgain();
    expect(c.state.phase).toBe("review");
    await c.sign("freighter");
    expect(c.state.phase).toBe("filled");
  });

  it("stopping the wait drops a signature that arrives later: nothing is sent", async () => {
    let release!: (v: string) => void;
    const { c, deps } = harness({ sign: vi.fn(() => new Promise<string>((r) => { release = r; })) });
    await c.prepare(req, "freighter");
    const signing = c.sign("freighter");
    expect(c.state.phase).toBe("signing");
    c.stopWaiting();
    expect(c.state).toMatchObject({ phase: "rejected", stopped: true });
    release("late-signature");
    await signing;
    expect(deps.submit).not.toHaveBeenCalled();
    expect(c.state.phase).toBe("rejected");
  });

  it("a wallet that fails in some other way (or a signature the app's own check refuses) is a failure with nothing sent", async () => {
    const { c, deps } = harness({ sign: vi.fn(async () => { throw new Error("the wallet's signature does not verify against the order's preimage"); }) });
    await c.prepare(req, "freighter");
    await c.sign("freighter");
    expect(c.state).toMatchObject({ phase: "failed", failure: { code: "WALLET_FAILED", title: "Nothing was signed or sent", message: expect.stringMatching(/does not verify/) } });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("an order whose time runs out in review becomes expired on the next tick, and cannot be signed", async () => {
    const fresh = prepared({ deadline: (NOW + 590_000) / 1000 + 600 });
    const { c, deps, advance } = harness({ prepare: vi.fn().mockResolvedValueOnce(prepared()).mockResolvedValue(fresh) });
    await c.prepare(req, "freighter");
    advance(590_000);
    c.tick();
    expect(c.state).toMatchObject({ phase: "expired", during: "review" });
    await c.sign("freighter");
    expect(deps.sign).not.toHaveBeenCalled();
    // Re-quoting is the way out, and asks for a fresh signature.
    await c.prepare(req, "freighter");
    expect(c.state.phase).toBe("review");
    expect(deps.prepare).toHaveBeenCalledTimes(2);
  });

  it("an order that expires while the wallet is open is expired, and the late signature is dropped", async () => {
    let release!: (v: string) => void;
    const { c, deps, advance } = harness({ sign: vi.fn(() => new Promise<string>((r) => { release = r; })) });
    await c.prepare(req, "freighter");
    const signing = c.sign("freighter");
    advance(590_000);
    c.tick();
    expect(c.state).toMatchObject({ phase: "expired", during: "signing" });
    release("signed-entry");
    await signing;
    expect(deps.submit).not.toHaveBeenCalled();
    expect(c.state.phase).toBe("expired");
  });

  it("the server saying EXPIRED at submit is expired", async () => {
    const { c } = harness({ submit: vi.fn(async () => { throw err(410, "expired", { code: "EXPIRED", message: "This order has expired. Prepare a new one. Nothing was sent." }); }) });
    await c.prepare(req, "freighter");
    await c.sign("freighter");
    expect(c.state).toMatchObject({ phase: "expired", during: "submit" });
  });

  it("ALREADY_USED, SOLVER_WILL_NOT_FILL and BAD_SIGNATURE at submit are failures with their sentences", async () => {
    for (const [code, re] of [["ALREADY_USED", /already been used/], ["SOLVER_WILL_NOT_FILL", /no longer fills/], ["BAD_SIGNATURE", /does not match this order/]] as const) {
      const { c } = harness({ submit: vi.fn(async () => { throw err(422, "raw", { code, message: "m" }); }) });
      await c.prepare(req, "freighter");
      await c.sign("freighter");
      expect(c.state, code).toMatchObject({ phase: "failed", failure: { code, message: expect.stringMatching(re) } });
    }
  });

  it("no answer to the submit is 'unconfirmed', not 'failed': the order may have gone out", async () => {
    const { c } = harness({ submit: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    await c.prepare(req, "freighter");
    await c.sign("freighter");
    expect(c.state).toMatchObject({ phase: "unconfirmed", reason: "no-answer", hash: undefined });
  });

  it("a fill that never appears in a ledger ends in unconfirmed with its hash", async () => {
    const { c } = harness({ status: vi.fn(async () => ({ hash: "h", status: "NOT_FOUND" as const })) });
    await c.prepare(req, "freighter");
    await c.sign("freighter");
    expect(c.state).toMatchObject({ phase: "unconfirmed", reason: "timeout", hash: "h" });
  });

  it("a few hiccups while following a sent order are tolerated; many are not a verdict either, just 'unconfirmed'", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(err(502, "x")).mockRejectedValueOnce(err(502, "x")).mockResolvedValue({ hash: "h", status: "SUCCESS", received: "104.1", hedge: { status: "NOT_NEEDED", reason: "r" } });
    const a = harness({ status: flaky });
    await a.c.prepare(req, "freighter");
    await a.c.sign("freighter");
    expect(a.c.state.phase).toBe("filled");
    const b = harness({ status: vi.fn(async () => { throw err(502, "x"); }) });
    await b.c.prepare(req, "freighter");
    await b.c.sign("freighter");
    expect(b.c.state).toMatchObject({ phase: "unconfirmed", hash: "h" });
  });

  it("a fill that fails on chain is a failure carrying the hash", async () => {
    const { c } = harness({ status: vi.fn(async () => ({ hash: "h", status: "FAILED" as const, explained: { code: "BELOW_MIN_OUT", message: "m", detail: "settle contract error #5" } })) });
    await c.prepare(req, "freighter");
    await c.sign("freighter");
    expect(c.state).toMatchObject({ phase: "failed", hash: "h", failure: { code: "BELOW_MIN_OUT" } });
  });

  it("filled without a readable amount still says filled, with the amount unknown", async () => {
    const { c } = harness({ status: vi.fn(async () => ({ hash: "h", status: "SUCCESS" as const, ledger: 3 })) });
    await c.prepare(req, "freighter");
    await c.sign("freighter");
    expect(c.state).toMatchObject({ phase: "filled", received: undefined });
  });

  it("a prepare error is a failure with its sentence; preparing again recovers", async () => {
    const p = vi.fn().mockRejectedValueOnce(err(404, "account not found on the settlement network")).mockResolvedValue(prepared());
    const { c } = harness({ prepare: p });
    await c.prepare(req, "freighter");
    expect(c.state).toMatchObject({ phase: "failed", failure: { code: "NO_ACCOUNT" } });
    await c.prepare(req, "freighter");
    expect(c.state.phase).toBe("review");
  });

  it("an answer that arrives after the user reset is ignored", async () => {
    let release!: (v: PrepareOrderResponse) => void;
    const { c } = harness({ prepare: vi.fn(() => new Promise<PrepareOrderResponse>((r) => { release = r; })) });
    const p = c.prepare(req, "freighter");
    expect(c.state.phase).toBe("preparing");
    c.reset();
    release(prepared());
    await p;
    expect(c.state.phase).toBe("idle");
  });

  it("a SigningAborted from the wallet layer counts as stopping, not failing", async () => {
    const { c } = harness({ sign: vi.fn(async () => { throw new SigningAborted(); }) });
    await c.prepare(req, "freighter");
    await c.sign("freighter");
    expect(c.state).toMatchObject({ phase: "rejected", stopped: true });
  });
});

describe("tier 2: the user signs a transaction", () => {
  const BOTH = ["auth-entry", "tx"] as const;
  const txDeps = (over: Partial<OrderDeps> = {}) => ({
    tiers: BOTH,
    prepareTx: vi.fn(async (): Promise<PrepareOrderTxResponse> => preparedTx()),
    signTx: vi.fn(async () => "signed-tx"),
    submitTx: vi.fn(async () => ({ hash: "h", status: "PENDING" as const })),
    ...over,
  });

  it("a wallet that cannot sign entries is routed to the transaction path: prepareTx, signTx, submitTx, then the same polling", async () => {
    const { c, deps, seen } = harness(txDeps());
    await c.prepare(req, "albedo");
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.prepareTx).toHaveBeenCalledWith(req);
    expect(c.state).toMatchObject({ phase: "review", prepared: { orderId: "id-tx", summary: { networkFee: "0.0140000" } } });
    await c.sign("albedo");
    expect(deps.signTx).toHaveBeenCalledWith(expect.objectContaining({ orderId: "id-tx" }));
    expect(deps.sign).not.toHaveBeenCalled();
    expect(deps.submitTx).toHaveBeenCalledWith({ orderId: "id-tx", order: preparedTx().order, signedTx: "signed-tx" });
    expect(deps.submit).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ phase: "filled", hash: "h", received: "104.1000000" });
    expect(seen.slice(0, 6)).toEqual(["preparing", "review", "signing", "submitting", "confirming", "filled"]);
  });

  it("a wallet that can sign entries keeps the free path even when the server offers both", async () => {
    const { c, deps } = harness(txDeps());
    await c.prepare(req, "varial");
    await c.sign("varial");
    expect(deps.prepare).toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalled();
    expect(deps.prepareTx).not.toHaveBeenCalled();
    expect(deps.submitTx).not.toHaveBeenCalled();
  });

  it("is off when the server does not offer it: the wallet is stopped up front, nothing is requested", async () => {
    for (const tiers of [undefined, ["auth-entry"] as const]) {
      const { c, deps } = harness({ ...txDeps(), tiers });
      await c.prepare(req, "xbull");
      expect(c.state).toMatchObject({ phase: "unsupported", at: "before", tried: "none" });
      expect(deps.prepareTx).not.toHaveBeenCalled();
      expect(deps.prepare).not.toHaveBeenCalled();
    }
  });

  it("is off when the app cannot run it, even if the server offers it", async () => {
    const { c, deps } = harness({ tiers: BOTH });
    await c.prepare(req, "ledger");
    expect(c.state).toMatchObject({ phase: "unsupported", tried: "none" });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it("a declined tier-2 order reads like a declined one: reasons, nothing to sign", async () => {
    const { c, deps } = harness(txDeps({ prepareTx: vi.fn(async () => declinedRes) }));
    await c.prepare(req, "rabet");
    expect(c.state).toMatchObject({ phase: "declined", reasons: ["no_hedge_quote"] });
    await c.sign("rabet");
    expect(deps.signTx).not.toHaveBeenCalled();
  });

  it("a wallet that turns out not to sign entries (an 'unknown' one) can switch to the transaction path", async () => {
    const { c, deps } = harness(txDeps({ sign: vi.fn(async () => { throw { code: -3, message: 'Hana does not support the "signAuthEntry" function' }; }) }));
    await c.prepare(req, "hana");
    await c.sign("hana");
    expect(c.state).toMatchObject({ phase: "unsupported", at: "call", tried: "auth-entry" });
    await c.prepare(req, "hana", "transaction");
    expect(deps.prepareTx).toHaveBeenCalledTimes(1);
    expect(c.state).toMatchObject({ phase: "review", prepared: { orderId: "id-tx" } });
    await c.sign("hana");
    expect(c.state.phase).toBe("filled");
  });

  it("the override is refused when the server does not offer transactions", async () => {
    const { c, deps } = harness({ ...txDeps(), tiers: ["auth-entry"] });
    await c.prepare(req, "hana", "transaction");
    expect(c.state).toMatchObject({ phase: "unsupported", tried: "none" });
    expect(deps.prepareTx).not.toHaveBeenCalled();
  });

  it("a transaction wallet that cannot sign transactions either says so, and offers nothing further", async () => {
    const { c } = harness(txDeps({ signTx: vi.fn(async () => { throw { code: -3, message: 'X does not support the "signTransaction" function' }; }) }));
    await c.prepare(req, "xbull");
    await c.sign("xbull");
    expect(c.state).toMatchObject({ phase: "unsupported", at: "call", tried: "transaction" });
  });

  it("declining in the wallet is a refusal, not a failure; nothing was sent", async () => {
    const { c, deps } = harness(txDeps({ signTx: vi.fn(async () => { throw { code: -4, message: "The user rejected this request." }; }) }));
    await c.prepare(req, "albedo");
    await c.sign("albedo");
    expect(c.state).toMatchObject({ phase: "rejected", stopped: false });
    expect(deps.submitTx).not.toHaveBeenCalled();
  });

  it("the SDK's own review refusals and wallet mix-ups become plain sentences, and nothing is sent", async () => {
    const cases: [string, RegExp][] = [
      ["the transaction does not match the hash the server reported; refusing to ask the wallet to sign it", /not exactly the order you reviewed.*not asked to sign it/],
      ["the wallet returned a different transaction than the one it was given", /another network/],
      ["the wallet signed with GABC, not the order's account GDEF", /different account/],
      ["the wallet's signature on the transaction does not verify for the order's account", /does not match this transaction/],
    ];
    for (const [message, text] of cases) {
      const { c, deps } = harness(txDeps({ signTx: vi.fn(async () => { throw new Error(message); }) }));
      await c.prepare(req, "lobstr");
      await c.sign("lobstr");
      expect(c.state, message).toMatchObject({ phase: "failed", failure: { code: "WALLET_FAILED", title: "Nothing was signed or sent" } });
      expect((c.state as { failure: { message: string } }).failure.message).toMatch(text);
      expect(deps.submitTx).not.toHaveBeenCalled();
    }
    expect(txSigningFailureText("Extension is locked")).toBe("Extension is locked");
  });

  it("maps the tier-2 server codes to human messages", () => {
    const codes: [string, RegExp][] = [
      ["BAD_SEQUENCE", /another transaction after this one was prepared/],
      ["WRONG_SOURCE", /not from your connected account/],
      ["TX_MISMATCH", /not the transaction you reviewed/],
      ["BAD_AUTH", /authorisations are not exactly/],
      ["BAD_TIMEBOUNDS", /time limit/],
      ["UNSUPPORTED_ENVELOPE", /fee bump or a muxed account/],
      ["SOLVER_TX_MISMATCH", /solver prepared something other/],
      ["BAD_ORDER_ID", /no longer matches/],
      ["EXPIRED", /./],
    ];
    for (const [code, text] of codes) {
      const v = verdictFromError(err(code === "BAD_SEQUENCE" ? 409 : 400, "m", { code, message: "server words" }), "submit");
      if (code === "EXPIRED") { expect(v.kind).toBe("expired"); continue; }
      expect(v, code).toMatchObject({ kind: "failed" });
      expect((v as { failure: { message: string } }).failure.message, code).toMatch(text);
      expect((v as { failure: { message: string } }).failure.message, code).toMatch(/Nothing was sent|not sent|Prepare|Try again|Switch/);
    }
  });

  it("a submit refusal ends in failed with the server's code, and does not claim anything was sent", async () => {
    const { c } = harness(txDeps({ submitTx: vi.fn(async () => { throw err(409, "seq", { code: "BAD_SEQUENCE", message: "m" }); }) }));
    await c.prepare(req, "albedo");
    await c.sign("albedo");
    expect(c.state).toMatchObject({ phase: "failed", failure: { code: "BAD_SEQUENCE" } });
  });

  it("an unanswered submit is 'unconfirmed', never a retry that could send the transaction twice", async () => {
    const { c } = harness(txDeps({ submitTx: vi.fn(async () => { throw Object.assign(new Error("fetch failed"), {}); }) }));
    await c.prepare(req, "albedo");
    await c.sign("albedo");
    expect(c.state).toMatchObject({ phase: "unconfirmed", reason: "no-answer" });
  });

  it("a fill that fails on the ledger warns that the fee may still have been charged (and only for tier 2)", () => {
    const failed = (prep: PreparedOrder | PreparedOrderTx) => {
      let s: OrderState = { phase: "review", req, prepared: prep };
      for (const ev of [{ type: "SIGN_START" }, { type: "SIGNED" }, { type: "SUBMITTED", hash: "h" }] as const) s = step(s, ev);
      return step(s, { type: "LANDED", status: { hash: "h", status: "FAILED", explained: { code: "BELOW_MIN_OUT", message: "m", detail: "" } } }) as Extract<OrderState, { phase: "failed" }>;
    };
    expect(failed(preparedTx()).failure.message).toMatch(/may still have charged its fee/);
    expect(failed(prepared()).failure.message).not.toMatch(/fee/);
  });

  it("the order's time limit is the earlier of its deadline and the transaction's expiry", () => {
    const p = preparedTx({ maxTime: NOW / 1000 + 100 });
    expect(isTxPrepared(p)).toBe(true);
    expect(isTxPrepared(prepared())).toBe(false);
    expect(goodUntil(p)).toBe(NOW / 1000 + 100);
    expect(goodUntil(prepared())).toBe(NOW / 1000 + 600);
    expect(expiry(p, NOW).secondsLeft).toBe(100 - EXPIRY_MARGIN_SEC);
    expect(expiry(preparedTx({ maxTime: NOW / 1000 + 5000 }), NOW).secondsLeft).toBe(600 - EXPIRY_MARGIN_SEC);
  });

  it("an order that expires before the wallet is asked is not signed or sent", async () => {
    const { c, deps, advance } = harness(txDeps({ signTx: vi.fn(async () => "signed-tx") }));
    await c.prepare(req, "albedo");
    advance(400_000);
    await c.sign("albedo");
    expect(c.state.phase).toBe("expired");
    expect(deps.submitTx).not.toHaveBeenCalled();
  });
});
