import { describe, expect, it, vi } from "vitest";
import type { OrderStatusResponse, PreparedOrder, PrepareOrderResponse } from "@sluice/sdk";
import {
  countdown, createOrderController, EXPIRY_MARGIN_SEC, expiry, failureFor, hedgeText, parseAssetInput, rawValues, reasonText, step, verdictFromError,
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
