import { beforeEach, describe, expect, it, vi } from "vitest";

// The flow engine is exercised against a scripted API and a wallet that signs, declines or never answers.
// Nothing here touches the network: these tests pin the order of operations that moves real funds.
const api = vi.hoisted(() => ({
  build: vi.fn(), quote: vi.fn(), submit: vi.fn(), waitForTx: vi.fn(), deposit: vi.fn(), withdraw: vi.fn(),
}));
const saved = vi.hoisted(() => ({ pending: undefined as unknown }));
vi.mock("./api", () => ({
  api,
  SluiceError: class SluiceError extends Error {
    constructor(public status: number, message: string, public explained?: { code: string; message: string; detail: string }) { super(message); }
  },
}));
vi.mock("./wallet", () => ({ WalletError: class WalletError extends Error {} }));
vi.mock("./store", () => ({ savePending: (p: unknown) => { saved.pending = p; } }));

import { SluiceError } from "./api";
import { runDeposit, runLeg2, runSwap, runWithdraw, type Io, type Prompt, type StepView } from "./flow";
import { WalletError } from "./wallet";

const XLM = "native";
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const AQUA = "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";

const leg = (venue: string, layer: "classic" | "soroban", assetIn: string, assetOut: string, amountIn: string, amountOut: string, minOut: string) =>
  ({ venue, layer, assetIn, assetOut, amountIn, amountOut, minOut, hops: [] });
const route = (legs: ReturnType<typeof leg>[], atomicity: "ATOMIC_SOROBAN" | "CLASSIC_ONLY" | "TWO_STEP") => ({
  key: legs.map((l) => `${l.venue}:${l.assetIn}>${l.assetOut}`).join("|"), atomicity,
  assetIn: legs[0]!.assetIn, assetOut: legs.at(-1)!.assetOut, amountIn: legs[0]!.amountIn, amountOut: legs.at(-1)!.amountOut, effectiveOut: legs.at(-1)!.amountOut, risks: [], legs,
});
const tx = (r: ReturnType<typeof route>, xdr: string, legIndex = 0) => ({ kind: "transaction" as const, leg: legIndex, layer: r.legs[legIndex]!.layer, venue: r.legs[legIndex]!.venue, xdr, needsSimulation: true, minOut: r.legs[legIndex]!.minOut, resourceFee: "57504" });
const built = (r: ReturnType<typeof route>, steps: unknown[]) => ({ route: r, steps, unsigned: true, skipped: [] });

/** A scripted user: answers prompts in order and records everything shown to them. */
function user(answers: string[], sign: (xdr: string) => Promise<string> = async (x) => `signed:${x}`) {
  const prompts: Prompt[] = [];
  const steps = new Map<string, StepView>();
  const signedXdrs: string[] = [];
  const io: Io = {
    account: "GACCOUNT",
    sign: async (xdr) => { signedXdrs.push(xdr); return sign(xdr); },
    step: (v) => void steps.set(v.id, v),
    ask: async (p) => {
      prompts.push(p);
      const a = answers.shift();
      if (!a) throw new Error(`unexpected prompt: ${p.title}`);
      return a;
    },
  };
  return { io, prompts, steps, signedXdrs };
}

beforeEach(() => {
  vi.clearAllMocks();
  saved.pending = undefined;
  api.submit.mockImplementation(async (signed: string) => ({ hash: `hash-of-${signed}`, status: "PENDING" }));
  api.waitForTx.mockImplementation(async (hash: string) => ({ hash, status: "SUCCESS", received: "0.9500000" }));
});

describe("single-transaction swap", () => {
  const r = route([leg("aquarius", "soroban", XLM, USDC, "5.0000000", "0.9513582", "0.9466014")], "ATOMIC_SOROBAN");
  const args = { assetIn: XLM, assetOut: USDC, amount: "5", slippageBps: 50, routeKey: r.key };

  it("builds the named route, shows the built numbers, then signs, submits and waits", async () => {
    api.build.mockResolvedValue(built(r, [tx(r, "SWAP")]));
    const u = user(["go"]);
    const out = await runSwap(u.io, args, r);
    expect(api.build).toHaveBeenCalledWith({ ...args, account: "GACCOUNT" });
    expect(u.prompts[0]!.rows!.map((x) => x.value)).toEqual(["5 XLM", "0.9513582 USDC", "0.9466014 USDC", "Aquarius", "0.0057504 XLM"]);
    expect(u.signedXdrs).toEqual(["SWAP"]);
    expect(api.submit).toHaveBeenCalledWith("signed:SWAP");
    expect(out).toMatchObject({ kind: "done", summary: "Received 0.95 USDC.", hash: "hash-of-signed:SWAP" });
    expect(u.steps.get("leg1-swap")).toMatchObject({ status: "done" });
  });

  it("signs nothing when the user cancels at review", async () => {
    api.build.mockResolvedValue(built(r, [tx(r, "SWAP")]));
    const u = user(["cancel"]);
    expect(await runSwap(u.io, args, r)).toEqual({ kind: "cancelled" });
    expect(u.signedXdrs).toEqual([]);
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("submits nothing when the wallet declines", async () => {
    api.build.mockResolvedValue(built(r, [tx(r, "SWAP")]));
    const u = user(["go"], async () => { throw new WalletError("User rejected"); });
    expect(await runSwap(u.io, args, r)).toEqual({ kind: "cancelled" });
    expect(api.submit).not.toHaveBeenCalled();
    expect(u.steps.get("leg1-swap")).toMatchObject({ status: "failed", detail: "The transaction was not signed." });
  });

  it("says so in full when the wallet signed with a different account", async () => {
    api.build.mockResolvedValue(built(r, [tx(r, "SWAP")]));
    const said = "The wallet signed with a different account (GA5Z…KZVN). Switch the wallet back to GDZZ…ZAVT, or disconnect and connect the account you want to use.";
    const u = user(["go"], async () => { throw new WalletError(said); });
    await runSwap(u.io, args, r);
    expect(api.submit).not.toHaveBeenCalled();
    expect(u.steps.get("leg1-swap")).toMatchObject({ status: "failed", detail: said });
  });

  it("adds the trustline first, then rebuilds so the swap is simulated against the new account state", async () => {
    const trust = { kind: "prerequisite" as const, type: "changeTrust" as const, asset: USDC, xdr: "TRUST", reason: "no trustline" };
    api.build.mockResolvedValueOnce(built(r, [trust, { ...tx(r, "STALE-SWAP"), simulated: false }])).mockResolvedValueOnce(built(r, [tx(r, "FRESH-SWAP")]));
    const u = user(["go"]);
    const out = await runSwap(u.io, args, r);
    expect(u.prompts[0]!.caution).toMatch(/no trustline for USDC/);
    expect(u.signedXdrs).toEqual(["TRUST", "FRESH-SWAP"]);
    expect(api.build).toHaveBeenCalledTimes(2);
    expect(out.kind).toBe("done");
  });

  it("stops after the trustline if the price fell below the minimum the user accepted", async () => {
    const trust = { kind: "prerequisite" as const, type: "changeTrust" as const, asset: USDC, xdr: "TRUST", reason: "no trustline" };
    const worse = route([leg("aquarius", "soroban", XLM, USDC, "5.0000000", "0.9000000", "0.8955000")], "ATOMIC_SOROBAN");
    api.build.mockResolvedValueOnce(built(r, [trust, tx(r, "STALE")])).mockResolvedValueOnce(built(worse, [tx(worse, "WORSE")]));
    const u = user(["go"]);
    const out = await runSwap(u.io, args, r);
    expect(u.signedXdrs).toEqual(["TRUST"]);
    expect(out).toMatchObject({ kind: "failed", message: expect.stringMatching(/below the minimum you accepted/) });
  });

  it("reports why the network refused, in the server's words", async () => {
    api.build.mockResolvedValue(built(r, [tx(r, "SWAP")]));
    api.waitForTx.mockResolvedValue({ hash: "h", status: "FAILED", explained: { code: "SLIPPAGE", message: "The price moved past your slippage limit.", detail: "txFailed" } });
    const out = await runSwap(user(["go"]).io, args, r);
    expect(out).toMatchObject({ kind: "failed", message: "The price moved past your slippage limit.", detail: "txFailed" });
  });

  it("explains a failed simulation and a route that cannot be executed without asking for a signature", async () => {
    api.build.mockRejectedValueOnce(new SluiceError(422, "simulation failed", { code: "INSUFFICIENT_BALANCE", message: "Not enough.", detail: "Error(Contract, #10)" }));
    const a = user([]);
    expect(await runSwap(a.io, args, r)).toMatchObject({ kind: "failed", message: "Not enough.", detail: "Error(Contract, #10)" });
    api.build.mockResolvedValueOnce(built(r, [{ kind: "unsupported", leg: 0, venue: "aquarius", reason: "quote carried no swap_chain_xdr" }]));
    const b = user([]);
    expect(await runSwap(b.io, args, r)).toMatchObject({ kind: "failed", message: expect.stringMatching(/cannot be executed/) });
    expect([...a.signedXdrs, ...b.signedXdrs]).toEqual([]);
  });

  it("says a late confirmation may still settle instead of calling it failed", async () => {
    api.build.mockResolvedValue(built(r, [tx(r, "SWAP")]));
    api.waitForTx.mockRejectedValue(new SluiceError(408, "transaction not found in a ledger yet"));
    const out = await runSwap(user(["go"]).io, args, r);
    expect(out).toMatchObject({ kind: "failed", message: expect.stringMatching(/may still settle/) });
  });
});

describe("two-transaction route", () => {
  const twoStep = route([leg("classic-path", "classic", XLM, USDC, "40.0000000", "7.6000000", "7.5620000"), leg("aquarius", "soroban", USDC, AQUA, "7.6000000", "22800.0000000", "22686.0000000")], "TWO_STEP");
  const args = { assetIn: XLM, assetOut: AQUA, amount: "40", slippageBps: 50, routeKey: twoStep.key };
  const leg2 = (out: string, min: string) => route([leg("aquarius", "soroban", USDC, AQUA, "7.5900000", out, min)], "ATOMIC_SOROBAN");
  const leg1Build = built(twoStep, [{ ...tx(twoStep, "LEG1"), needsSimulation: false, resourceFee: undefined }, { kind: "deferred", leg: 1, layer: "soroban", venue: "aquarius", reason: "re-quote" }]);

  it("sizes leg 2 from what leg 1 actually delivered, not from the quote", async () => {
    const fresh = leg2("22790.0000000", "22676.0000000");
    api.build.mockResolvedValueOnce(leg1Build).mockResolvedValueOnce(built(fresh, [tx(fresh, "LEG2")]));
    api.waitForTx.mockResolvedValueOnce({ hash: "h1", status: "SUCCESS", received: "7.5900000" }).mockResolvedValueOnce({ hash: "h2", status: "SUCCESS", received: "22795.0000000" });
    api.quote.mockResolvedValue({ routes: [fresh], best: fresh, partial: false, errors: [] });
    const u = user(["go", "go"]);
    const out = await runSwap(u.io, args, twoStep);
    // The quote said 7.6; leg 1 delivered 7.59; leg 2 is quoted and built for 7.59.
    expect(api.quote).toHaveBeenCalledWith({ assetIn: USDC, assetOut: AQUA, amount: "7.5900000", slippageBps: 50, atomicOnly: true });
    expect(api.build).toHaveBeenLastCalledWith(expect.objectContaining({ assetIn: USDC, assetOut: AQUA, amount: "7.5900000", routeKey: fresh.key }));
    expect(u.signedXdrs).toEqual(["LEG1", "LEG2"]);
    expect(out).toMatchObject({ kind: "done", title: "Both legs settled", summary: "Received 22,795 AQUA." });
    expect(saved.pending).toBeNull();
  });

  it("records the half-finished route before leg 2, so a closed tab can resume", async () => {
    api.build.mockResolvedValueOnce(leg1Build);
    api.waitForTx.mockResolvedValueOnce({ hash: "h1", status: "SUCCESS", received: "7.5900000" });
    let recorded: unknown;
    api.quote.mockImplementation(async () => { recorded = saved.pending; return { routes: [], best: null, partial: false, errors: [] }; });
    const u = user(["go", "keep"]);
    const out = await runSwap(u.io, args, twoStep);
    expect(recorded).toMatchObject({ account: "GACCOUNT", from: XLM, to: AQUA, held: USDC, heldAmount: "7.5900000", acceptedMin: "22686.0000000", leg1Hash: "h1" });
    expect(u.prompts[1]).toMatchObject({ title: "Leg 2 did not go through", caution: expect.stringMatching(/No venue will take/) });
    expect(out).toMatchObject({ kind: "held", summary: expect.stringMatching(/kept 7.59 USDC/) });
    expect(saved.pending).toBeNull();
  });

  it("warns when the fresh leg 2 is below the minimum accepted at the start, and unwinds on request", async () => {
    const poor = leg2("20000.0000000", "19900.0000000");
    const back = route([leg("classic-path", "classic", USDC, XLM, "7.5900000", "39.7000000", "39.5015000")], "CLASSIC_ONLY");
    api.build.mockResolvedValueOnce(leg1Build).mockResolvedValueOnce(built(poor, [tx(poor, "LEG2")])).mockResolvedValueOnce(built(back, [tx(back, "UNWIND")]));
    api.waitForTx.mockResolvedValueOnce({ hash: "h1", status: "SUCCESS", received: "7.5900000" }).mockResolvedValueOnce({ hash: "h3", status: "SUCCESS", received: "39.6900000" });
    api.quote.mockResolvedValueOnce({ routes: [poor], best: poor, partial: false, errors: [] }).mockResolvedValueOnce({ routes: [back], best: back, partial: false, errors: [] });
    const u = user(["go", "unwind", "go"]);
    const out = await runSwap(u.io, args, twoStep);
    expect(u.prompts[1]!.caution).toMatch(/below the 22,686 AQUA minimum you accepted/);
    expect(api.quote).toHaveBeenLastCalledWith({ assetIn: USDC, assetOut: XLM, amount: "7.5900000", slippageBps: 50, atomicOnly: true });
    expect(u.signedXdrs).toEqual(["LEG1", "UNWIND"]);
    expect(out).toMatchObject({ kind: "done", title: "Unwound", summary: "Received 39.69 XLM." });
    expect(saved.pending).toBeNull();
  });

  it("offers retry, unwind or keep when leg 2 is declined, and never loses the record while the asset is held", async () => {
    const fresh = leg2("22790.0000000", "22676.0000000");
    api.quote.mockResolvedValue({ routes: [fresh], best: fresh, partial: false, errors: [] });
    api.build.mockResolvedValue(built(fresh, [tx(fresh, "LEG2")]));
    let attempts = 0;
    const u = user(["go", "retry", "go"], async (x) => { if (attempts++ === 0) throw new WalletError("declined"); return `signed:${x}`; });
    const pending = { account: "GACCOUNT", from: XLM, to: AQUA, held: USDC, heldAmount: "7.5900000", slippageBps: 50, acceptedMin: "22686.0000000", leg1Hash: "h1", at: 1 };
    api.waitForTx.mockResolvedValue({ hash: "h2", status: "SUCCESS", received: "22795.0000000" });
    const out = await runLeg2(u.io, pending);
    expect(u.prompts.map((p) => p.title)).toEqual(["Review leg 2 of 2", "Leg 2 did not go through", "Review leg 2 of 2"]);
    expect(u.prompts[1]!.caution).toBe("The transaction was not signed.");
    expect(out.kind).toBe("done");
  });

  it("keeps the record when an unwind fails, because the user still holds the asset", async () => {
    saved.pending = "untouched";
    api.quote.mockResolvedValueOnce({ routes: [], best: null, partial: false, errors: [] }).mockResolvedValueOnce({ routes: [], best: null, partial: false, errors: [] });
    const pending = { account: "GACCOUNT", from: XLM, to: AQUA, held: USDC, heldAmount: "7.5900000", slippageBps: 50, acceptedMin: "1", leg1Hash: "h1", at: 1 };
    const out = await runLeg2(user(["unwind"]).io, pending);
    expect(out).toMatchObject({ kind: "failed", title: "Unwind did not go through", message: expect.stringMatching(/You still hold 7.59 USDC/) });
    expect(saved.pending).toBe("untouched");
  });
});

describe("vault flows", () => {
  const vault = { vault: "CPOOL", vaultName: "Blend Fixed Pool V2", asset: USDC, amount: "2" };

  it("deposits the stated amount after review", async () => {
    api.deposit.mockResolvedValue({ kind: "transaction", venue: "blend", xdr: "DEP", resourceFee: "1", unsigned: true });
    const u = user(["go"]);
    const out = await runDeposit(u.io, vault);
    expect(api.deposit).toHaveBeenCalledWith({ account: "GACCOUNT", vault: "CPOOL", asset: USDC, amount: "2" });
    expect(u.signedXdrs).toEqual(["DEP"]);
    expect(out).toMatchObject({ kind: "done", title: "Deposit settled" });
  });

  it("zap deposits exactly what the swap delivered, not what was quoted", async () => {
    const r = route([leg("classic-path", "classic", XLM, USDC, "5.0000000", "0.9492212", "0.9444750")], "CLASSIC_ONLY");
    api.build.mockResolvedValue(built(r, [{ ...tx(r, "SWAP"), needsSimulation: false, resourceFee: undefined }]));
    api.waitForTx.mockResolvedValueOnce({ hash: "h1", status: "SUCCESS", received: "0.9480001" }).mockResolvedValueOnce({ hash: "h2", status: "SUCCESS" });
    api.deposit.mockResolvedValue({ kind: "transaction", venue: "blend", xdr: "DEP", resourceFee: "1", unsigned: true });
    const u = user(["go"]);
    const out = await runDeposit(u.io, { ...vault, amount: "5" }, { from: XLM, amount: "5", slippageBps: 50, route: r });
    expect(api.deposit).toHaveBeenCalledWith(expect.objectContaining({ amount: "0.9480001" }));
    expect(u.signedXdrs).toEqual(["SWAP", "DEP"]);
    expect(out.kind).toBe("done");
  });

  it("does not deposit when the swap half is declined or cancelled", async () => {
    const r = route([leg("classic-path", "classic", XLM, USDC, "5.0000000", "0.9492212", "0.9444750")], "CLASSIC_ONLY");
    api.build.mockResolvedValue(built(r, [tx(r, "SWAP")]));
    expect(await runDeposit(user(["cancel"]).io, vault, { from: XLM, amount: "5", slippageBps: 50, route: r })).toEqual({ kind: "cancelled" });
    expect(await runDeposit(user(["go"], async () => { throw new WalletError("no"); }).io, vault, { from: XLM, amount: "5", slippageBps: 50, route: r })).toEqual({ kind: "cancelled" });
    expect(api.deposit).not.toHaveBeenCalled();
  });

  it("withdraws the stated amount, or slightly over the reading to empty the position", async () => {
    api.withdraw.mockResolvedValue({ kind: "transaction", venue: "blend", xdr: "WD", resourceFee: "1", unsigned: true });
    await runWithdraw(user(["go"]).io, { ...vault, amount: "1.5" }, false);
    expect(api.withdraw).toHaveBeenLastCalledWith(expect.objectContaining({ amount: "1.5" }));
    await runWithdraw(user(["go"]).io, { ...vault, amount: "100.0000000" }, true);
    // 1% over plus one stroop: the pool caps a withdrawal at the position.
    expect(api.withdraw).toHaveBeenLastCalledWith(expect.objectContaining({ amount: "101.0000001" }));
    expect(await runWithdraw(user(["cancel"]).io, vault, false)).toEqual({ kind: "cancelled" });
  });
});
