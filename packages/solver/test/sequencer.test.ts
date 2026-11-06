import { describe, expect, it } from "vitest";
import { Sequencer } from "../src/index.js";

describe("Sequencer", () => {
  it("hands out consecutive sequence numbers while the node still reports the old one", async () => {
    const seq = new Sequencer(async () => 41n);
    const used: bigint[] = [];
    for (let i = 0; i < 3; i++) await seq.run(async (base) => ({ value: used.push(base), accepted: true }));
    expect(used).toEqual([41n, 42n, 43n]);
  });
  it("does not advance for a transaction the network did not accept, and forgets its count after txBadSeq", async () => {
    const seq = new Sequencer(async () => 10n);
    const used: bigint[] = [];
    const run = (accepted: boolean, badSeq = false) => seq.run(async (base) => ({ value: used.push(base), accepted, badSeq }));
    await run(true);
    await run(false);
    await run(true, true);
    await run(true);
    expect(used).toEqual([10n, 11n, 11n, 10n]);
  });
  it("runs sends one at a time, in arrival order, even when an earlier one throws", async () => {
    const seq = new Sequencer(async () => 1n);
    const order: string[] = [];
    const slow = seq.run(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("slow"); throw new Error("boom"); });
    const fast = seq.run(async () => { order.push("fast"); return { value: 1, accepted: true }; });
    await expect(slow).rejects.toThrow("boom");
    await fast;
    expect(order).toEqual(["slow", "fast"]);
  });
  it("trusts the chain when it is ahead of what it has counted", async () => {
    let chain = 5n;
    const seq = new Sequencer(async () => chain);
    const used: bigint[] = [];
    await seq.run(async (b) => ({ value: used.push(b), accepted: true }));
    chain = 20n;
    await seq.run(async (b) => ({ value: used.push(b), accepted: true }));
    expect(used).toEqual([5n, 20n]);
  });
});
