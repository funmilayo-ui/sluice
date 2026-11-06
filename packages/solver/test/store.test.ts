import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyState, FileStore, MemoryStore, parse, stringify, ExposureLedger, type SolverState } from "../src/index.js";
import { A, C, mkOrder } from "./helpers.js";

const state = (): SolverState => ({
  version: 1,
  exposures: [],
  orders: [{
    id: "ab".repeat(32), kind: "auth-entry", order: mkOrder(), assetIn: A, assetOut: C, amountOut: 1_000_000_000n, nonceKey: "G:1", state: "pending",
    attempts: 0, cycles: 0, createdAtMs: 1, updatedAtMs: 2,
  }],
});
const tmp = () => mkdtemp(join(tmpdir(), "sluice-store-"));

describe("serialize", () => {
  it("round-trips bigints, nested, without confusing them with ordinary objects", () => {
    const v = { a: 1n, b: [2n, { c: 3n }], d: "4", e: { $bigint: 5 }, f: null, g: 1.5, h: true };
    expect(parse(stringify(v))).toEqual(v);
    expect(stringify({ x: 12345678901234567890n })).toBe('{"x":{"$bigint":"12345678901234567890"}}');
  });
});

describe("MemoryStore", () => {
  it("starts empty, and saves a copy: later changes to the object do not change what was saved", async () => {
    const s = new MemoryStore();
    expect(await s.load()).toEqual(emptyState());
    const st = state();
    await s.save(st);
    st.orders[0]!.state = "hedged";
    expect((await s.load()).orders[0]!.state).toBe("pending");
    expect((await s.load()).orders[0]!.amountOut).toBe(1_000_000_000n);
    expect(s.saves).toBe(1);
  });
  it("rejects a document that is not a solver state", async () => {
    const s = new MemoryStore();
    await s.save({ version: 2 } as never);
    await expect(s.load()).rejects.toThrow(/not a solver state/);
  });
});

describe("FileStore", () => {
  it("loads empty when there is no file yet, and round-trips the state with its bigints", async () => {
    const dir = await tmp();
    try {
      const s = new FileStore(join(dir, "nested", "dir"));
      expect(await s.load()).toEqual(emptyState());
      await s.save(state());
      const back = await new FileStore(join(dir, "nested", "dir")).load();
      expect(back).toEqual(state());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("writes atomically through a temporary file and leaves none behind; the file is private to its owner", async () => {
    const dir = await tmp();
    try {
      const s = new FileStore(dir);
      await s.save(state());
      await s.save({ ...state(), orders: [] });
      expect(await readdir(dir)).toEqual(["solver-state.json"]);
      expect((await stat(s.path)).mode & 0o777).toBe(0o600);
      expect((await readFile(s.path, "utf8")).startsWith("{")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("a crash between the temporary write and the rename leaves the previous document intact", async () => {
    const dir = await tmp();
    try {
      const s = new FileStore(dir);
      await s.save(state());
      // What a crash mid-save leaves behind: a half-written temporary file next to the real one.
      await writeFile(join(dir, "solver-state.json.123.456.tmp"), '{"version":1,"exposures":[{"trunc');
      expect(await s.load()).toEqual(state());
      // and the next save proceeds normally
      await s.save({ ...state(), orders: [] });
      expect((await s.load()).orders).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses to treat an unreadable file as an empty store, because that would forget open positions", async () => {
    const dir = await tmp();
    try {
      const s = new FileStore(dir);
      for (const junk of ["{ not json", "[]", '{"version":9}', ""]) {
        await writeFile(s.path, junk);
        await expect(s.load()).rejects.toThrow(/refusing to start empty/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("serialises concurrent saves: the last one wins and the file is never torn", async () => {
    const dir = await tmp();
    try {
      const s = new FileStore(dir);
      const docs = Array.from({ length: 8 }, (_v, i) => ({ ...state(), orders: state().orders.map((o) => ({ ...o, attempts: i })) }));
      await Promise.all(docs.map((d) => s.save(d)));
      const back = await s.load();
      expect(docs.map((d) => d.orders[0]!.attempts)).toContain(back.orders[0]!.attempts);
      expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ExposureLedger.restore", () => {
  it("loads persisted exposures without firing onChange, keeps their order and continues the sequence after them", () => {
    let changes = 0;
    const l = new ExposureLedger(() => void changes++);
    const base = { token: A, amount: 1n, markValueOut: 1n, markAsset: C, markStale: false, reason: "no_path" as const, detail: "", atMs: 1, updatedAtMs: 1, attempts: 0, pendingHashes: [], fill: {} as never };
    l.restore([{ ...base, id: "b", seq: 7 }, { ...base, id: "a", seq: 3 }]);
    expect(changes).toBe(0);
    expect(l.list().map((e) => e.id)).toEqual(["a", "b"]);
    expect(l.canFill(0n)).toMatchObject({ ok: false });
    const added = l.add({ ...base, id: "c" });
    expect(added.seq).toBe(8);
    expect(l.list().map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(changes).toBe(1);
  });
});
