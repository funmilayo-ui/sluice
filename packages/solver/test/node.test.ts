import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { FileStore, MainnetRefused, MemoryStore, SolverNode, type FillRequest, type FillOutcome, type StateStore } from "../src/index.js";
import { A, C, PASS, S, SETTLE, failedOnChain, harness, mkOrder, ok, rejected, signedEntry, strangerKp, userKp } from "./helpers.js";

const AMOUNT_OUT = 100n * S;

async function fillReq(over: Partial<FillRequest> = {}, entryOver: Parameters<typeof signedEntry>[1] = {}): Promise<FillRequest> {
  const order = over.order ?? mkOrder();
  const entry = await signedEntry(order, entryOver);
  return { order, assetIn: A, assetOut: C, amountOut: AMOUNT_OUT, signedUserEntry: entry.toXDR("base64"), quoteOut: 105n * S, ...over };
}
const sent = (o: FillOutcome) => {
  expect(o.kind).toBe("sent");
  return (o as Extract<FillOutcome, { kind: "sent" }>).hash;
};
/** Fill, then let the chain include it, then wait for the hedge. */
async function filled(h = harness(), req?: FillRequest) {
  const hash = sent(await h.node.fill(req ?? (await fillReq())));
  return { h, hash };
}
const status = async (h: ReturnType<typeof harness>, hash: string) => h.node.orderStatus(hash);

describe("fill (tier 1)", () => {
  it("records the fill on disk BEFORE the network can see it, then hedges once it lands", async () => {
    const h = harness();
    const seen: Promise<unknown>[] = [];
    h.chain.onAfterRecord = () => void seen.push(h.store.load());
    h.chain.hedgeSteps.push(ok());
    const hash = sent(await h.node.fill(await fillReq()));
    const snap = (await seen[0]) as { orders: { id: string; state: string; fill?: unknown }[] };
    expect(snap.orders.map((o) => [o.id, o.state])).toEqual([[hash, "pending"]]);
    expect(snap.orders[0]!.fill).toBeDefined(); // everything needed to hedge it later was already saved
    expect(await status(h, hash)).toEqual({ status: "PENDING" });
    h.chain.land(hash);
    await h.node.idle();
    expect(await status(h, hash)).toMatchObject({ status: "HEDGED", received: "104.0000000" });
    expect(h.chain.hedgeSubmits).toHaveLength(1);
    expect(h.chain.held).toBe(0n);
  });
  it("re-checks everything itself: the API's say-so is not enough", async () => {
    const h = harness();
    // wrong signer
    expect(await h.node.fill(await fillReq({}, { key: strangerKp }))).toMatchObject({ kind: "invalid", code: "WRONG_SIGNER" });
    // unsigned
    const order = mkOrder();
    const unsigned = await fillReq({ order });
    const e = (await import("@stellar/stellar-sdk")).xdr.SorobanAuthorizationEntry.fromXDR(unsigned.signedUserEntry, "base64");
    e.credentials().address().signature((await import("@stellar/stellar-sdk")).xdr.ScVal.scvVec([]));
    expect(await h.node.fill({ ...unsigned, signedUserEntry: e.toXDR("base64") })).toMatchObject({ kind: "invalid", code: "BAD_SIGNATURE" });
    // an entry for a different order than the one named
    const req = await fillReq();
    expect(await h.node.fill({ ...req, order: { ...req.order, minOut: 1n } })).toMatchObject({ kind: "invalid", code: "ENTRY_MISMATCH" });
    // assets that are not the order's tokens
    expect(await h.node.fill({ ...req, assetOut: `SLFD:${(await import("./helpers.js")).issuerKp.publicKey()}` })).toMatchObject({ kind: "invalid", code: "BAD_REQUEST" });
    expect(await h.node.fill({ ...req, signedUserEntry: "not xdr" })).toMatchObject({ kind: "invalid", code: "BAD_REQUEST" });
    expect(h.chain.fillsSent).toHaveLength(0);
  });
  it("declines at its own price: the book moved, there is no path, or it cannot pay", async () => {
    const h = harness();
    h.chain.rate = (95n * S) / 100n;
    const r = await h.node.fill(await fillReq());
    expect(r).toMatchObject({ kind: "refused", code: "SOLVER_WILL_NOT_FILL" });
    expect((r as { reasons: string[] }).reasons.length).toBeGreaterThan(0);
    h.chain.rate = null;
    expect(await h.node.fill(await fillReq())).toMatchObject({ kind: "refused", reasons: expect.arrayContaining(["no_hedge_quote"]) });
    h.chain.rate = (105n * S) / 100n;
    h.chain.balanceOut = 10n * S;
    expect(await h.node.fill(await fillReq())).toMatchObject({ kind: "refused", reasons: expect.arrayContaining(["inventory_too_low"]) });
    expect(h.chain.fillsSent).toHaveLength(0);
  });
  it("answers a quote failure as an error, an expired entry or order as EXPIRED, and a refused simulation as sim_failed", async () => {
    const h = harness();
    h.chain.quoteThrows = true;
    expect(await h.node.fill(await fillReq())).toMatchObject({ kind: "error" });
    h.chain.quoteThrows = false;
    expect(await h.node.fill(await fillReq({}, { validUntil: 1001 }))).toMatchObject({ kind: "invalid", code: "EXPIRED" });
    const near = mkOrder({ deadline: Math.floor(h.chain.clock.now / 1000) + 5 });
    expect(await h.node.fill(await fillReq({ order: near }))).toMatchObject({ kind: "invalid", code: "EXPIRED" });
    h.chain.simError = "HostError: Error(Auth, ExistingValue)";
    expect(await h.node.fill(await fillReq())).toEqual({ kind: "sim_failed", message: "HostError: Error(Auth, ExistingValue)" });
  });
  it("answers a repeated signature with the first fill's hash and does not send it again", async () => {
    const h = harness();
    const req = await fillReq();
    const hash = sent(await h.node.fill(req));
    const again = await h.node.fill(req);
    expect(again).toEqual({ kind: "sent", hash, status: "DUPLICATE" });
    expect(h.chain.fillsSent).toHaveLength(1);
  });
  it("a network refusal leaves nothing to hedge, records why, and the same signature may be tried again", async () => {
    const h = harness();
    const req = await fillReq();
    h.chain.nextSendStatus = "ERROR";
    expect(await h.node.fill(req)).toMatchObject({ kind: "rejected", codes: ["txBadSeq"] });
    h.chain.nextSendStatus = "TRY_AGAIN_LATER";
    expect(await h.node.fill(req)).toMatchObject({ kind: "busy" });
    h.chain.nextSendStatus = "PENDING";
    expect(sent(await h.node.fill(req))).toMatch(/^[0-9a-f]{64}$/);
    const refused = h.node.state().orders.filter((o) => o.state === "not_needed");
    expect(refused).toHaveLength(2);
    expect(refused[0]!.reason).toMatch(/refused/);
  });
  it("a send that threw after the fill was recorded is reported PENDING with its hash (it may have landed) and tracked to the truth", async () => {
    const h = harness();
    h.chain.sendThrowsAfterRecord = true;
    const hash = sent(await h.node.fill(await fillReq()));
    h.chain.hedgeSteps.push(ok());
    h.chain.land(hash);
    await h.node.idle();
    expect(await status(h, hash)).toMatchObject({ status: "HEDGED" });
  });
  it("a failure before anything was recorded is an error and tracks nothing", async () => {
    const h = harness();
    h.chain.sendThrowsBeforeRecord = true;
    expect(await h.node.fill(await fillReq())).toMatchObject({ kind: "error" });
    expect(h.node.state().orders).toHaveLength(0);
  });
  it("does not send when the fill cannot be saved", async () => {
    const store: StateStore = { load: async () => ({ version: 1, exposures: [], orders: [] }), save: async () => { throw new Error("disk full"); }, describe: () => "broken" };
    const h = harness({ store });
    const r = await h.node.fill(await fillReq());
    expect(r).toMatchObject({ kind: "error" });
    expect(h.chain.fillsSent).toHaveLength(0);
    expect(h.node.state().orders).toHaveLength(0);
  });
  it("a fill that fails on chain is NOT_NEEDED, and one that never lands is NOT_NEEDED once its time bounds pass; neither is hedged", async () => {
    const a = await filled();
    a.h.chain.land(a.hash, "FAILED");
    await a.h.node.idle();
    expect(await status(a.h, a.hash)).toMatchObject({ status: "NOT_NEEDED", reason: expect.stringContaining("failed") });
    const b = await filled();
    b.h.chain.clock.now += 10 * 60_000;
    await b.h.node.idle();
    expect(await status(b.h, b.hash)).toMatchObject({ status: "NOT_NEEDED", reason: expect.stringContaining("never landed") });
    expect(a.h.chain.hedgeSubmits.length + b.h.chain.hedgeSubmits.length).toBe(0);
  });
  it("a fill that failed on chain rolled back its nonce, so the same signature may be sent again; one that landed may not", async () => {
    const h = harness();
    const req = await fillReq();
    const first = sent(await h.node.fill(req));
    h.chain.land(first, "FAILED");
    await h.node.idle();
    const second = sent(await h.node.fill(req));
    expect(second).not.toBe(first);
    h.chain.hedgeSteps.push(ok());
    h.chain.land(second);
    await h.node.idle();
    expect(await h.node.fill(req)).toEqual({ kind: "sent", hash: second, status: "DUPLICATE" });
  });
  it("keeps polling through flaky reads", async () => {
    const h = harness();
    h.chain.hedgeSteps.push(ok());
    const hash = sent(await h.node.fill(await fillReq()));
    h.chain.statusThrows = true;
    await new Promise((r) => setTimeout(r, 20));
    h.chain.statusThrows = false;
    h.chain.land(hash);
    await h.node.idle();
    expect(await status(h, hash)).toMatchObject({ status: "HEDGED" });
  });
  it("is refused up front while the circuit breaker is open: no quote, no simulation, no signature", async () => {
    const { h, hash } = await filled();
    h.chain.land(hash);
    h.chain.rate = (80n * S) / 100n; // the hedge will fail and the re-quote is outside the loss bound
    h.chain.hedgeSteps.push(failedOnChain());
    await h.node.idle();
    expect(await h.node.canFill()).toMatchObject({ ok: false });
    h.chain.quoteThrows = true; // any work at all would now throw
    h.chain.simError = "must not be reached";
    const r = await h.node.fill(await fillReq());
    expect(r).toMatchObject({ kind: "refused", code: "CIRCUIT_BREAKER", reasons: ["circuit_breaker"] });
    expect(h.chain.fillsSent).toHaveLength(1);
  });
});

describe("a failed hedge is recovered inside the policy", () => {
  /** Fill, land it, and make the first hedge fail with the book now far below the loss bound. */
  async function exposed(over: { start?: boolean } = {}) {
    const h = harness();
    const hash = sent(await h.node.fill(await fillReq()));
    if (over.start) h.node.start();
    h.chain.hedgeSteps.push(failedOnChain());
    h.chain.rate = (90n * S) / 100n;
    h.chain.land(hash);
    await h.node.idle();
    return { h, hash };
  }

  it("does not dump: the original hedge failed, the re-quote is outside the loss bound, so the position is left open and the breaker trips", async () => {
    const { h, hash } = await exposed();
    expect(h.chain.hedgeSubmits).toHaveLength(1); // only the original attempt was ever sent
    expect(h.chain.held).toBe(100n * S);
    expect(h.node.ledger.list()).toHaveLength(1);
    expect(h.node.ledger.list()[0]).toMatchObject({ id: hash, reason: "loss_bound_exceeded" });
    expect(await h.node.canFill()).toMatchObject({ ok: false });
    // The loop is not running: honest status is UNHEDGED, not "retrying".
    expect(await status(h, hash)).toMatchObject({ status: "UNHEDGED", reason: "loss_bound_exceeded", attempts: 1 });
    await h.node.stop();
  });
  it("reports RETRYING with the next attempt's time once the recovery loop is on", async () => {
    const { h, hash } = await exposed({ start: true });
    const s = (await status(h, hash)) as { status: string; nextRetryAt?: number; attempts: number };
    expect(s.status).toBe("RETRYING");
    expect(s.attempts).toBe(1);
    expect(s.nextRetryAt).toBe(Math.floor((h.chain.clock.now + 1000) / 1000)); // base delay 1000 ms
    await h.node.stop();
  });
  it("retries when due, never before, and hedges once the book recovers; the breaker clears by itself", async () => {
    const { h, hash } = await exposed({ start: true });
    await h.node.tick(); // not due yet
    expect(h.chain.hedgeSubmits).toHaveLength(1);
    h.chain.clock.now += 1500;
    h.chain.rate = (105n * S) / 100n; // the book is back
    h.chain.hedgeSteps.push(ok("late"));
    await h.node.tick();
    expect(await status(h, hash)).toMatchObject({ status: "HEDGED" });
    expect(h.chain.hedgeSubmits).toHaveLength(2);
    expect(h.node.ledger.list()).toHaveLength(0);
    expect(await h.node.canFill()).toEqual({ ok: true });
    expect(h.chain.held).toBe(0n);
    await h.node.stop();
  });
  it("is bounded: after maxCycles failed cycles the position is ABANDONED, stays open, the breaker stays tripped, and nothing was dumped", async () => {
    const { h, hash } = await exposed({ start: true });
    for (let i = 0; i < 6; i++) {
      h.chain.clock.now += 10_000;
      await h.node.tick(); // the book never recovers
    }
    const s = await status(h, hash);
    expect(s).toMatchObject({ status: "ABANDONED", reason: "loss_bound_exceeded" });
    expect(h.chain.hedgeSubmits).toHaveLength(1); // across all cycles: not one extra transaction at the bad price
    expect(h.node.ledger.list()).toHaveLength(1);
    expect(await h.node.canFill()).toMatchObject({ ok: false });
    const after = h.chain.hedgeSubmits.length;
    h.chain.clock.now += 100_000;
    await h.node.tick(); // abandoned positions are not retried automatically any more
    expect(h.chain.hedgeSubmits).toHaveLength(after);
    await h.node.stop();
  });
  it("an operator can retry an abandoned position, with an explicit looser bound to accept a known loss, or clear it", async () => {
    const { h, hash } = await exposed({ start: true });
    for (let i = 0; i < 6; i++) {
      h.chain.clock.now += 10_000;
      await h.node.tick();
    }
    expect(await status(h, hash)).toMatchObject({ status: "ABANDONED" });
    h.chain.hedgeSteps.push(ok("accepted-loss", 89n * S));
    const view = await h.node.retryNow(hash, { maxLossBps: 2000 });
    expect(view).toMatchObject({ status: "HEDGED" });
    expect(await h.node.canFill()).toEqual({ ok: true });

    const two = await exposed();
    expect(await two.h.node.clearExposure(two.hash)).toBe(true);
    expect(await two.h.node.canFill()).toEqual({ ok: true });
    expect(await two.h.node.clearExposure(two.hash)).toBe(false);
    await h.node.stop();
  });
  it("a hedge the network refused is retried with a fresh sequence, inside the same bounds", async () => {
    const h = harness();
    const hash = sent(await h.node.fill(await fillReq()));
    h.chain.hedgeSteps.push(rejected(), ok("second"));
    h.chain.land(hash);
    await h.node.idle();
    expect(await status(h, hash)).toMatchObject({ status: "HEDGED" });
    expect(h.chain.hedgeSubmits).toHaveLength(2);
  });
  it("an unknown outcome is resolved from the chain by hash, and the hedge is never sent twice", async () => {
    const h = harness();
    const hash = sent(await h.node.fill(await fillReq()));
    // The hedge lands, but the answer is lost.
    h.chain.hedgeSteps.push({ result: { status: "unknown", hash: "x", error: "response lost", expiresAtMs: h.chain.clock.now + 120_000 }, lands: true });
    h.chain.land(hash);
    await h.node.idle();
    expect(await status(h, hash)).toMatchObject({ status: "HEDGED" });
    expect(h.chain.hedgeSubmits).toHaveLength(1);
    expect(h.chain.held).toBe(0n);
  });
  it("an unknown outcome that cannot be settled leaves the position open WITHOUT resending; a later retry settles it", async () => {
    const h = harness();
    const hash = sent(await h.node.fill(await fillReq()));
    h.chain.hedgeSteps.push({ result: { status: "unknown", hash: "x", error: "response lost", expiresAtMs: h.chain.clock.now + 120_000 }, lands: true });
    h.chain.hedgeStatusThrows = true; // the node cannot tell what became of it
    h.chain.land(hash);
    await h.node.idle();
    expect(h.chain.hedgeSubmits).toHaveLength(1);
    expect(h.node.ledger.list()[0]).toMatchObject({ reason: "unknown_status" });
    expect(h.node.ledger.list()[0]!.pendingHashes).toHaveLength(1);
    expect(await status(h, hash)).toMatchObject({ status: "UNHEDGED", reason: "unknown_status" });
    h.chain.hedgeStatusThrows = false;
    const view = await h.node.retryNow(hash);
    expect(view).toMatchObject({ status: "HEDGED" });
    expect(h.chain.hedgeSubmits).toHaveLength(1); // still exactly one hedge transaction in the world
  });
  it("a balance that shows nothing left to sell is not hedged again", async () => {
    const { h, hash } = await exposed();
    h.chain.held = 0n; // somebody sold it by hand
    h.chain.rate = (105n * S) / 100n;
    expect(await h.node.retryNow(hash)).toMatchObject({ status: "HEDGED" });
    expect(h.chain.hedgeSubmits).toHaveLength(1);
  });
  it("does not let one position's retry disturb the balance guard of another that landed later", async () => {
    const h = harness();
    const h1 = sent(await h.node.fill(await fillReq()));
    h.chain.hedgeSteps.push(failedOnChain());
    h.chain.rate = (90n * S) / 100n;
    h.chain.land(h1);
    await h.node.idle(); // first position exposed
    h.chain.rate = (105n * S) / 100n;
    h.chain.hedgeSteps.length = 0;
    // The breaker is open, so a second fill is refused: close it by hedging the first, then fill again.
    h.chain.hedgeSteps.push(ok("h1"));
    await h.node.retryNow(h1);
    h.chain.hedgeSteps.push(ok("h2"));
    const h2 = sent(await h.node.fill(await fillReq()));
    h.chain.land(h2);
    await h.node.idle();
    expect(await status(h, h2)).toMatchObject({ status: "HEDGED" });
    expect(h.chain.held).toBe(0n);
  });
});

describe("a restart loses nothing", () => {
  it("brings an open position back with the breaker still tripped, resumes the retry from the store and clears the exposure", async () => {
    const h1 = harness();
    const hash = sent(await h1.node.fill(await fillReq()));
    h1.chain.hedgeSteps.push(failedOnChain());
    h1.chain.rate = (90n * S) / 100n;
    h1.chain.land(hash);
    await h1.node.idle();
    expect(h1.node.ledger.list()).toHaveLength(1);

    // "Kill" the process: a new node, a new ledger, nothing shared with the old one except what was written to the store.
    const h2 = harness({ chain: h1.chain, store: new MemoryStore(await h1.store.load()) });
    await h2.node.restore();
    expect(h2.node.ledger.list().map((e) => e.id)).toEqual([hash]);
    expect(await h2.node.canFill()).toMatchObject({ ok: false }); // the breaker is as tripped as it was
    expect(await status(h2, hash)).toMatchObject({ status: "UNHEDGED", reason: "loss_bound_exceeded" });
    expect(await h2.node.fill(await fillReq())).toMatchObject({ kind: "refused", code: "CIRCUIT_BREAKER" });

    h2.chain.rate = (105n * S) / 100n; // the book returns
    h2.chain.clock.now += 1500; // and the retry's backoff has passed
    h2.chain.hedgeSteps.push(ok("after-restart"));
    h2.node.start(); // the loop reconsiders an UNHEDGED position and retries it
    expect(await status(h2, hash)).toMatchObject({ status: "RETRYING" });
    await h2.node.tick();
    expect(await status(h2, hash)).toMatchObject({ status: "HEDGED" });
    expect(await h2.node.canFill()).toEqual({ ok: true });
    expect((await h2.store.load()).exposures).toHaveLength(0); // and the store says so too
    await h2.node.stop();
  });
  it("settles a hedge that was in flight when the process died by its hash, and sends nothing", async () => {
    const h1 = harness();
    const hash = sent(await h1.node.fill(await fillReq()));
    // The hedge is signed, its hash is recorded, it reaches the chain, and the process dies before it hears back.
    h1.chain.hedgeSteps.push({ result: { status: "success", hash: "x", proceedsOut: 104n * S }, lands: true, hang: true });
    h1.chain.land(hash);
    await vi.waitFor(() => expect(h1.chain.hedgeSubmits).toHaveLength(1));
    const crashed = await h1.store.load();
    const rec = crashed.orders.find((o) => o.id === hash)!;
    expect(rec.state).toBe("hedging");
    expect(rec.inflightHedge?.hash).toBe(h1.chain.hedgeSubmits[0]!.hash);

    const h2 = harness({ chain: h1.chain, store: new MemoryStore(crashed) });
    await h2.node.restore();
    expect(await status(h2, hash)).toMatchObject({ status: "UNHEDGED", reason: "unknown_status" });
    expect(await h2.node.canFill()).toMatchObject({ ok: false }); // while it is unresolved, no new fills
    await h2.node.tick();
    expect(await status(h2, hash)).toMatchObject({ status: "HEDGED" });
    expect(h1.chain.hedgeSubmits).toHaveLength(1); // exactly one hedge transaction ever
    expect(await h2.node.canFill()).toEqual({ ok: true });
    await h2.node.stop();
  });
  it("after a crash mid-hedge where the transaction did NOT land, it is retried (once the first has certainly expired), not forgotten", async () => {
    const h1 = harness();
    const hash = sent(await h1.node.fill(await fillReq()));
    h1.chain.hedgeSteps.push({ result: { status: "failed", hash: "x", error: "x" }, hang: true }); // never landed, never answered
    h1.chain.land(hash);
    await vi.waitFor(() => expect(h1.chain.hedgeSubmits).toHaveLength(1));
    const crashed = await h1.store.load();
    const h2 = harness({ chain: h1.chain, store: new MemoryStore(crashed) });
    await h2.node.restore();
    h2.chain.clock.now += 200_000; // past the first hedge's time bounds
    h2.chain.hedgeSteps.push(ok("second"));
    await h2.node.tick();
    expect(await status(h2, hash)).toMatchObject({ status: "HEDGED" });
    expect(h1.chain.hedgeSubmits).toHaveLength(2);
    await h2.node.stop();
  });
  it("tracks a fill that was sent but not yet seen landing, and hedges it", async () => {
    const h1 = harness();
    const hash = sent(await h1.node.fill(await fillReq()));
    await h1.node.close(); // the first process is gone (its tracker would otherwise race the second on the shared fake chain)
    const h2 = harness({ chain: h1.chain, store: new MemoryStore(await h1.store.load()) });
    await h2.node.restore();
    expect(await status(h2, hash)).toEqual({ status: "PENDING" });
    h2.chain.hedgeSteps.push(ok());
    h2.chain.land(hash);
    await h2.node.idle();
    expect(await status(h2, hash)).toMatchObject({ status: "HEDGED" });
  });
  it("a signature that was used stays used: the second submission is the first fill's hash", async () => {
    const h1 = harness();
    const req = await fillReq();
    const hash = sent(await h1.node.fill(req));
    await h1.node.close();
    const h2 = harness({ chain: h1.chain, store: new MemoryStore(await h1.store.load()) });
    expect(await h2.node.fill(req)).toEqual({ kind: "sent", hash, status: "DUPLICATE" });
    expect(h1.chain.fillsSent).toHaveLength(1);
  });
  it("survives a real restart through files: bigints, ledger and orders round-trip, and the temporary file is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sluice-node-"));
    try {
      const h1 = harness({ store: new FileStore(dir) });
      const hash = sent(await h1.node.fill(await fillReq()));
      h1.chain.hedgeSteps.push(failedOnChain());
      h1.chain.rate = (90n * S) / 100n;
      h1.chain.land(hash);
      await h1.node.idle();
      await h1.node.close();
      expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      const raw = await readFile(join(dir, "solver-state.json"), "utf8");
      expect(raw).not.toMatch(/S[A-Z2-7]{55}/); // no secret keys in the file
      const h2 = harness({ chain: h1.chain, store: new FileStore(dir) });
      await h2.node.restore();
      expect(h2.node.ledger.list()[0]).toMatchObject({ id: hash, amount: 100n * S, reason: "loss_bound_exceeded" });
      expect(await h2.node.canFill()).toMatchObject({ ok: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("will not start on a state file it cannot read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sluice-node-"));
    try {
      await writeFile(join(dir, "solver-state.json"), "{ not json");
      const h = harness({ store: new FileStore(dir) });
      await expect(h.node.restore()).rejects.toThrow(/refusing to start empty/);
      await expect(h.node.fill(await fillReq())).rejects.toThrow(/refusing to start empty/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reopens an exposure that the state says is open but the ledger lost", async () => {
    const h1 = harness();
    const hash = sent(await h1.node.fill(await fillReq()));
    h1.chain.hedgeSteps.push(failedOnChain());
    h1.chain.rate = (90n * S) / 100n;
    h1.chain.land(hash);
    await h1.node.idle();
    const torn = await h1.store.load();
    torn.exposures = []; // the two writes did not both happen
    const h2 = harness({ chain: h1.chain, store: new MemoryStore(torn) });
    await h2.node.restore();
    expect(h2.node.ledger.list()).toHaveLength(1);
    expect(await h2.node.canFill()).toMatchObject({ ok: false });
  });
});

describe("tier 2 (the user is the source)", () => {
  const prep = async (h = harness(), over: Partial<Parameters<SolverNode["prepareTx"]>[0]> = {}) => {
    const r = await h.node.prepareTx({ order: mkOrder(), assetIn: A, assetOut: C, amountOut: AMOUNT_OUT, validForSec: 600, quoteOut: 105n * S, ...over });
    return { h, r };
  };
  const sign = (xdrText: string, key = userKp) => {
    const tx = TransactionBuilder.fromXDR(xdrText, PASS) as Transaction;
    tx.sign(key);
    return tx.toXDR();
  };

  it("reserves the transaction it prepares, and hedges it once the user's signed copy lands", async () => {
    const { h, r } = await prep();
    expect(r.kind).toBe("prepared");
    if (r.kind !== "prepared") return;
    expect(await status(h, r.tx.hash)).toEqual({ status: "PENDING" });
    expect((await h.store.load()).orders[0]).toMatchObject({ id: r.tx.hash, kind: "tx", state: "reserved" }); // saved before the user ever sees it
    h.chain.hedgeSteps.push(ok());
    expect(await h.node.submitTx({ signedTx: sign(r.tx.xdr) })).toEqual({ kind: "sent", hash: r.tx.hash, status: "PENDING" });
    h.chain.land(r.tx.hash);
    await h.node.idle();
    expect(await status(h, r.tx.hash)).toMatchObject({ status: "HEDGED" });
    expect(h.chain.txSent).toEqual([r.tx.hash]);
    // a second submission of the same transaction is answered, not sent again
    expect(await h.node.submitTx({ signedTx: sign(r.tx.xdr) })).toEqual({ kind: "sent", hash: r.tx.hash, status: "DUPLICATE" });
    expect(h.chain.txSent).toHaveLength(1);
  });
  it("only submits transactions it prepared itself, signed by the user", async () => {
    const { h, r } = await prep();
    if (r.kind !== "prepared") throw new Error("not prepared");
    expect(await h.node.submitTx({ signedTx: r.tx.xdr })).toMatchObject({ kind: "invalid", code: "BAD_SIGNATURE" });
    expect(await h.node.submitTx({ signedTx: sign(r.tx.xdr, strangerKp) })).toMatchObject({ kind: "invalid", code: "BAD_SIGNATURE" });
    // a transaction it never prepared (same shape, different content)
    const other = new TransactionBuilder((TransactionBuilder.fromXDR(r.tx.xdr, PASS) as Transaction) && new (await import("@stellar/stellar-sdk")).Account(userKp.publicKey(), "7"), { fee: "100", networkPassphrase: PASS, timebounds: { minTime: 0, maxTime: 0 } })
      .addOperation((await import("@stellar/stellar-sdk")).Operation.bumpSequence({ bumpTo: "9" })).build();
    other.sign(userKp);
    expect(await h.node.submitTx({ signedTx: other.toXDR() })).toMatchObject({ kind: "invalid", code: "UNKNOWN_RESERVATION" });
    expect(await h.node.submitTx({ signedTx: "garbage" })).toMatchObject({ kind: "invalid", code: "BAD_REQUEST" });
    expect(h.chain.txSent).toHaveLength(0);
  });
  it("hedges a fill the user submitted themselves: the reservation is watched until it lands", async () => {
    const { h, r } = await prep();
    if (r.kind !== "prepared") throw new Error("not prepared");
    h.chain.hedgeSteps.push(ok());
    h.chain.land(r.tx.hash); // the user sent it straight to the network, not through us
    await h.node.tick();
    await h.node.idle();
    expect(await status(h, r.tx.hash)).toMatchObject({ status: "HEDGED" });
    expect(h.chain.txSent).toHaveLength(0);
  });
  it("lets a reservation that was never used expire, and a failed fill needs no hedge", async () => {
    const { h, r } = await prep();
    if (r.kind !== "prepared") throw new Error("not prepared");
    await h.node.tick();
    expect(await status(h, r.tx.hash)).toEqual({ status: "PENDING" });
    h.chain.clock.now += 3_600_000;
    await h.node.tick();
    expect(await status(h, r.tx.hash)).toMatchObject({ status: "NOT_NEEDED", reason: expect.stringContaining("expired") });
    const { h: h2, r: r2 } = await prep();
    if (r2.kind !== "prepared") throw new Error("not prepared");
    h2.chain.land(r2.tx.hash, "FAILED");
    await h2.node.tick();
    expect(await status(h2, r2.tx.hash)).toMatchObject({ status: "NOT_NEEDED" });
    expect(h.chain.hedgeSubmits.length + h2.chain.hedgeSubmits.length).toBe(0);
  });
  it("applies the same gates: breaker, its own pricing, assets, validity, and a cap on unsigned transactions it is holding", async () => {
    const a = await prep(); // one in the book
    if (a.r.kind !== "prepared") throw new Error("not prepared");
    a.h.chain.rate = (80n * S) / 100n;
    expect((await prep(a.h)).r).toMatchObject({ kind: "refused", code: "SOLVER_WILL_NOT_FILL" });
    a.h.chain.rate = (105n * S) / 100n;
    expect((await prep(a.h, { assetOut: `SLFD:${(await import("./helpers.js")).issuerKp.publicKey()}` })).r).toMatchObject({ kind: "invalid", code: "BAD_REQUEST" });
    expect((await prep(a.h, { validForSec: 5 })).r).toMatchObject({ kind: "invalid", code: "BAD_REQUEST" });
    a.h.chain.simError = "HostError: Error(Contract, #5)";
    expect((await prep(a.h)).r).toEqual({ kind: "sim_failed", message: "HostError: Error(Contract, #5)" });
    const capped = harness({ opts: { maxReservations: 2 } });
    await prep(capped);
    await prep(capped);
    expect((await prep(capped)).r).toMatchObject({ kind: "busy" });
  });
  it("is refused while the breaker is open, both when preparing and when submitting", async () => {
    const { h, r } = await prep();
    if (r.kind !== "prepared") throw new Error("not prepared");
    // open the breaker with an exposure
    const hash = sent(await h.node.fill(await fillReq()));
    h.chain.hedgeSteps.push(failedOnChain());
    h.chain.rate = (90n * S) / 100n;
    h.chain.land(hash);
    await h.node.idle();
    expect(await h.node.submitTx({ signedTx: sign(r.tx.xdr) })).toMatchObject({ kind: "refused", code: "CIRCUIT_BREAKER" });
    expect((await prep(h)).r).toMatchObject({ kind: "refused", code: "CIRCUIT_BREAKER" });
  });
  it("a network rejection at submit leaves the reservation usable", async () => {
    const { h, r } = await prep();
    if (r.kind !== "prepared") throw new Error("not prepared");
    h.chain.nextSendStatus = "ERROR";
    expect(await h.node.submitTx({ signedTx: sign(r.tx.xdr) })).toMatchObject({ kind: "rejected", codes: ["txBadSeq"] });
    h.chain.nextSendStatus = "PENDING";
    expect(await h.node.submitTx({ signedTx: sign(r.tx.xdr) })).toMatchObject({ kind: "sent", status: "PENDING" });
  });
});

describe("the node itself", () => {
  it("refuses the public network three ways: at construction, from its own RPC, and in the configuration of its state", async () => {
    expect(() => harness({ node: { passphrase: Networks.PUBLIC } })).toThrow(MainnetRefused);
    const h = harness();
    h.chain.passphrase = Networks.PUBLIC;
    expect(await h.node.fill(await fillReq())).toMatchObject({ kind: "invalid", code: "ORDERS_MAINNET_REFUSED" });
    expect(await h.node.prepareTx({ order: mkOrder(), assetIn: A, assetOut: C, amountOut: AMOUNT_OUT, validForSec: 600 })).toMatchObject({ kind: "invalid", code: "ORDERS_MAINNET_REFUSED" });
    h.chain.passphrase = Networks.FUTURENET;
    const h2 = harness({ chain: h.chain });
    expect(await h2.node.fill(await fillReq())).toMatchObject({ kind: "invalid", code: "ORDERS_NETWORK_MISMATCH" });
    expect(h.chain.fillsSent).toHaveLength(0);
  });
  it("runs a stoppable, unref'd recovery loop that does not keep the process alive", async () => {
    const h = harness({ node: { retry: { tickMs: 5, baseDelayMs: 0, maxDelayMs: 0, maxCycles: 3 } } });
    const hash = sent(await h.node.fill(await fillReq()));
    h.chain.hedgeSteps.push(failedOnChain());
    h.chain.rate = (90n * S) / 100n;
    h.chain.land(hash);
    await h.node.idle();
    h.node.start();
    const timer = (h.node as unknown as { timer?: { hasRef(): boolean } }).timer;
    expect(timer?.hasRef()).toBe(false);
    h.chain.rate = (105n * S) / 100n;
    h.chain.hedgeSteps.push(ok("by-the-loop"));
    await vi.waitFor(async () => expect(await status(h, hash)).toMatchObject({ status: "HEDGED" }), { timeout: 3000 });
    await h.node.stop();
    expect((h.node as unknown as { timer?: unknown }).timer).toBeUndefined();
    h.node.start();
    h.node.start(); // idempotent
    await h.node.close();
  });
  it("reports its health and refuses new work once closed", async () => {
    const h = harness();
    expect(await h.node.health()).toMatchObject({ ok: true, address: h.chain.address, accepting: true, openExposures: 0, recoveryLoop: false, settleContract: SETTLE });
    await h.node.close();
    expect(await h.node.fill(await fillReq())).toMatchObject({ kind: "busy" });
  });
  it("answers nothing for a hash it has never seen", async () => {
    expect(await status(harness(), "ab".repeat(32))).toBeUndefined();
  });
  it("prunes finished records but never an open one", async () => {
    const h = harness();
    const hash = sent(await h.node.fill(await fillReq()));
    h.chain.hedgeSteps.push(failedOnChain());
    h.chain.rate = (90n * S) / 100n;
    h.chain.land(hash);
    await h.node.idle();
    expect(h.node.state().orders.map((o) => o.id)).toContain(hash);
  });
});

