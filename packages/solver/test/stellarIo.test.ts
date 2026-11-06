import { describe, expect, it } from "vitest";
import { Keypair, Networks, type rpc } from "@stellar/stellar-sdk";
import type { Leg } from "@sluice/core";
import { createStellarHedgeIo, describeFailure, proceedsFromResult } from "../src/index.js";

const issuer = Keypair.random().publicKey();
const leg: Leg = { venue: "horizon", layer: "classic", assetIn: `SLFA:${issuer}`, assetOut: `SLFC:${issuer}`, amountIn: 1_000_000_000n, amountOut: 960_000_000n, hops: [] };
const solver = Keypair.random();

/** A scripted RPC server: only the three calls the adapter makes. */
function server(o: { send?: () => Promise<unknown>; get?: (n: number) => Promise<unknown> }) {
  let n = 0;
  const calls = { send: 0, get: 0 };
  const s = {
    async getAccount() { return { sequenceNumber: () => "100", accountId: () => solver.publicKey(), incrementSequenceNumber() {} }; },
    async sendTransaction() { calls.send++; return o.send ? o.send() : { status: "PENDING" }; },
    async getTransaction() { calls.get++; return o.get ? o.get(n++) : { status: "NOT_FOUND" }; },
  };
  return { s: s as unknown as rpc.Server, calls };
}
const mk = (srv: rpc.Server, extra = {}) => {
  let t = 0;
  return createStellarHedgeIo({
    server: srv, passphrase: Networks.TESTNET, solver, quote: async () => null, heldIn: async () => 0n,
    now: () => t, sleep: async (ms) => void (t += ms), confirmTimeoutMs: 10_000, pollMs: 1_000, ...extra,
  });
};

describe("createStellarHedgeIo.submit classifies the three failure kinds", () => {
  it("network refuses the transaction -> rejected (not on any ledger)", async () => {
    const { s } = server({ send: async () => ({ status: "ERROR" }) });
    expect(await mk(s).submit(leg, 1n)).toMatchObject({ status: "rejected" });
  });
  it("try again later -> rejected", async () => {
    const { s } = server({ send: async () => ({ status: "TRY_AGAIN_LATER" }) });
    expect(await mk(s).submit(leg, 1n)).toMatchObject({ status: "rejected" });
  });
  it("the send call throws -> unknown, WITH the hash and expiry, because the node may have got it", async () => {
    const { s } = server({ send: async () => { throw new Error("socket hang up"); } });
    const r = await mk(s).submit(leg, 1n);
    expect(r).toMatchObject({ status: "unknown" });
    if (r.status === "unknown") {
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      // the transaction's own max time (SDK uses the wall clock): about timeoutSec from now
      expect(r.expiresAtMs).toBeGreaterThan(Date.now() + 100_000);
      expect(r.expiresAtMs).toBeLessThanOrEqual(Date.now() + 121_000);
    }
  });
  it("accepted but never shows up in a ledger in time -> unknown (not 'failed')", async () => {
    const { s, calls } = server({});
    const r = await mk(s).submit(leg, 1n);
    expect(r.status).toBe("unknown");
    expect(calls.get).toBeGreaterThan(1);
  });
  it("accepted, reads flake, then it is included and failed -> failed", async () => {
    const { s } = server({ get: async (n) => { if (n < 2) throw new Error("flaky"); return { status: "FAILED" }; } });
    const r = await mk(s).submit(leg, 1n);
    expect(r).toMatchObject({ status: "failed" });
  });
  it("accepted then included and successful -> success", async () => {
    const { s } = server({ get: async () => ({ status: "SUCCESS" }) });
    expect(await mk(s).submit(leg, 1n)).toMatchObject({ status: "success", proceedsOut: null });
  });
  it("cannot even read the sequence number -> rejected (nothing was sent)", async () => {
    const { s, calls } = server({});
    (s as unknown as { getAccount: () => Promise<never> }).getAccount = async () => { throw new Error("rpc down"); };
    const r = await mk(s, { sleep: async () => {} }).submit(leg, 1n);
    expect(r.status).toBe("rejected");
    expect(calls.send).toBe(0);
  });
  it("txStatus maps the RPC status", async () => {
    for (const [raw, want] of [["SUCCESS", "success"], ["FAILED", "failed"], ["NOT_FOUND", "not_found"]] as const) {
      const { s } = server({ get: async () => ({ status: raw }) });
      expect(await mk(s).txStatus("h")).toBe(want);
    }
  });
});

describe("result decoding is defensive", () => {
  it("unreadable results do not throw", () => {
    expect(describeFailure(undefined)).toMatch(/not decodable/);
    expect(proceedsFromResult(undefined)).toBeNull();
  });
});

describe("createStellarHedgeIo with a shared sequencer and a pre-send record", () => {
  it("records the transaction's hash BEFORE sending it, so a restart can find out what became of it", async () => {
    const order: string[] = [];
    const { s } = server({ send: async () => { order.push("send"); return { status: "PENDING" }; }, get: async () => ({ status: "SUCCESS" }) });
    const io = mk(s, { beforeSend: (hash: string, expiresAtMs: number) => void order.push(`record ${hash.length} ${expiresAtMs > Date.now()}`) });
    await io.submit(leg, 1n);
    expect(order).toEqual(["record 64 true", "send"]);
  });
  it("sends nothing when the record cannot be made", async () => {
    const { s, calls } = server({});
    const r = await mk(s, { beforeSend: () => { throw new Error("disk full"); } }).submit(leg, 1n);
    expect(r).toMatchObject({ status: "rejected" });
    expect((r as { error: string }).error).toMatch(/could not record/);
    expect(calls.send).toBe(0);
  });
  it("builds on the sequencer's number, not a fresh read, so a fill and a hedge from one key never collide", async () => {
    const { Sequencer } = await import("../src/index.js");
    const { Transaction } = await import("@stellar/stellar-sdk");
    const sent: string[] = [];
    const { s } = server({ send: async () => ({ status: "PENDING" }), get: async () => ({ status: "SUCCESS" }) });
    (s as unknown as { sendTransaction: (tx: InstanceType<typeof Transaction>) => Promise<unknown> }).sendTransaction = async (tx) => { sent.push(tx.sequence); return { status: "PENDING" }; };
    const sequencer = new Sequencer(async () => 100n);
    await sequencer.run(async (base) => ({ value: base, accepted: true })); // a fill took 101
    await mk(s, { sequencer }).submit(leg, 1n);
    expect(sent).toEqual(["102"]);
  });
  it("a txBadSeq answer makes the sequencer forget its count", async () => {
    const { Sequencer } = await import("../src/index.js");
    const { xdr } = await import("@stellar/stellar-sdk");
    const sequencer = new Sequencer(async () => 100n);
    const result = new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString("100"), result: xdr.TransactionResultResult.txBadSeq(), ext: new xdr.TransactionResultExt(0) });
    const { s } = server({ send: async () => ({ status: "ERROR", errorResult: result }) });
    await sequencer.run(async (b) => ({ value: b, accepted: true }));
    expect(await mk(s, { sequencer }).submit(leg, 1n)).toMatchObject({ status: "rejected" });
    const seen: bigint[] = [];
    await sequencer.run(async (b) => ({ value: seen.push(b), accepted: true }));
    expect(seen).toEqual([100n]);
  });
});
