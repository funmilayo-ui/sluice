/**
 * Shared plumbing for the testnet scripts that drive the whole stack (w5, w6): throwaway funded keys, a deployed settle contract,
 * a Classic order book to hedge against, a standalone solver service as a child process, and a Horizon proxy that can be frozen.
 * TESTNET ONLY: nothing here accepts another network. Keys live in memory (and in the child's environment) and are never written to disk.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { formatAmount, parseAmount } from "../../packages/core/src/index.js";
import {
  Address, Asset, BASE_FEE, Keypair, Networks, Operation, rpc, Transaction, TransactionBuilder, xdr,
} from "../../packages/api/node_modules/@stellar/stellar-sdk/lib/index.js";

export const PASS = Networks.TESTNET;
if (PASS !== "Test SDF Network ; September 2015") throw new Error("testnet only");
export const RPC = "https://soroban-testnet.stellar.org";
export const HORIZON = "https://horizon-testnet.stellar.org";
export const WASM = fileURLToPath(new URL("../../contracts/target/wasm32v1-none/release/sluice_settle.wasm", import.meta.url));
export const SOLVER_BIN = fileURLToPath(new URL("../../packages/solver/dist/bin.js", import.meta.url));
export const S = 10_000_000n;
export const server = new rpc.Server(RPC);
export const fmt = (v: bigint) => formatAmount(v);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
export function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}
export const failureCount = () => failures;

/** This machine's network is flaky: retry reads (never a transaction submit) with a pause. */
export async function retry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${label}: ${(last as Error)?.message ?? last}`);
}
export const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
/** fetch for reads that are safe to repeat. */
export const retryingFetch: typeof fetch = (input, init) => retry("horizon", async () => {
  const r = await timedFetch(input, init);
  if (r.status >= 500) throw new Error(`horizon ${r.status}`);
  return r;
});

/** The RPC client handed to in-process code: reads retried, sendTransaction passed straight through. */
export const apiServer = new Proxy(server, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver);
    if (typeof v !== "function") return v;
    const readOnly = ["getLatestLedger", "getAccount", "simulateTransaction", "getTransaction", "getNetwork"].includes(String(prop));
    return readOnly ? (...a: unknown[]) => retry(String(prop), () => (v as (...x: unknown[]) => Promise<unknown>).apply(target, a)) : v.bind(target);
  },
});

export async function waitFor(hash: string): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < 80; i++) {
    const r = await retry("getTransaction", () => server.getTransaction(hash));
    if (r.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return r;
    await sleep(1500);
  }
  throw new Error(`transaction ${hash} did not appear in a ledger`);
}
export async function send(tx: Transaction) {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${sent.errorResult?.toXDR("base64")}`);
  const done = await waitFor(sent.hash);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ${done.status}`);
  return { hash: sent.hash, done: done as rpc.Api.GetSuccessfulTransactionResponse };
}
export async function run(source: Keypair, ops: xdr.Operation[], soroban = false) {
  const account = await retry("getAccount", () => server.getAccount(source.publicKey()));
  let b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS });
  for (const op of ops) b = b.addOperation(op);
  let tx = b.setTimeout(180).build();
  if (soroban) tx = await retry("prepareTransaction", () => server.prepareTransaction(tx));
  tx.sign(source);
  return send(tx);
}

interface HorizonAccount { balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[] }
/** A Classic balance from Horizon (lags a few ledgers); null when there is no trustline. */
export async function bal(g: string, a: Asset | "native"): Promise<bigint | null> {
  const acc = await retry("horizon account", async () => {
    const r = await timedFetch(`${HORIZON}/accounts/${g}`);
    if (!r.ok) throw new Error(`horizon ${r.status}`);
    return (await r.json()) as HorizonAccount;
  });
  const hit = acc.balances.find((x) => (a === "native" ? x.asset_type === "native" : x.asset_code === a.getCode() && x.asset_issuer === a.getIssuer()));
  return hit ? parseAmount(hit.balance) : null;
}

export async function friendbot(kp: Keypair) {
  await retry("friendbot", async () => {
    const r = await timedFetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
    if (!r.ok) throw new Error(`friendbot ${r.status}`);
  });
}

export interface Market {
  issuer: Keypair; user: Keypair; solver: Keypair; maker: Keypair; stranger: Keypair;
  A: Asset; C: Asset; idA: string; idC: string; settleId: string;
}

/** Throwaway parties, assets A and C, SAC contracts, a freshly deployed settle contract. The maker has C to sell for A; the user holds A and has NO C trustline. */
export interface MarketOptions {
  /** Use these parties instead of throwaway keys (already funded when `funded` is set, e.g. created with `stellar keys generate --fund`). */
  keys?: Partial<Pick<Market, "issuer" | "user" | "solver" | "maker" | "stranger">>;
  funded?: boolean;
  /** Asset codes for A and C. Default SLFA / SLFC; a re-run with the same issuer needs fresh codes (a SAC can only be created once). */
  codes?: [string, string];
}
export async function setupMarket(opts: MarketOptions = {}): Promise<Market> {
  const k = opts.keys ?? {};
  const issuer = k.issuer ?? Keypair.random(), user = k.user ?? Keypair.random(), solver = k.solver ?? Keypair.random(), maker = k.maker ?? Keypair.random(), stranger = k.stranger ?? Keypair.random();
  if (!opts.funded) for (const kp of [issuer, user, solver, maker, stranger]) await friendbot(kp);
  console.log(`issuer ${issuer.publicKey()}\nuser   ${user.publicKey()}\nsolver ${solver.publicKey()}\nmaker  ${maker.publicKey()}`);
  const [codeA, codeC] = opts.codes ?? ["SLFA", "SLFC"];
  const A = new Asset(codeA, issuer.publicKey());
  const C = new Asset(codeC, issuer.publicKey());
  await run(user, [Operation.changeTrust({ asset: A })]);
  await run(solver, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })]);
  await run(maker, [Operation.changeTrust({ asset: A }), Operation.changeTrust({ asset: C })]);
  await run(issuer, [
    Operation.payment({ destination: user.publicKey(), asset: A, amount: "1000" }),
    Operation.payment({ destination: solver.publicKey(), asset: C, amount: "1000" }),
    Operation.payment({ destination: maker.publicKey(), asset: C, amount: "2000" }),
  ]);
  for (const asset of [A, C]) await run(solver, [Operation.createStellarAssetContract({ asset })], true);
  const wasm = readFileSync(WASM);
  const wasmHash = createHash("sha256").update(wasm).digest();
  await run(solver, [Operation.uploadContractWasm({ wasm })], true);
  const deployed = await run(solver, [Operation.createCustomContract({ address: new Address(solver.publicKey()), wasmHash, salt: Keypair.random().rawPublicKey() })], true);
  const settleId = Address.fromScVal(deployed.done.returnValue!).toString();
  console.log(`settle ${settleId}  (${wasm.length} bytes)`);
  return { issuer, user, solver, maker, stranger, A, C, idA: `${codeA}:${issuer.publicKey()}`, idC: `${codeC}:${issuer.publicKey()}`, settleId };
}

/** The maker's resting offers that SELL C for A. `setBook` cancels what is left of the previous ones and posts `tiers` (none = the book disappears). */
export class Book {
  private offerIds: string[] = [];
  constructor(private m: Market) {}
  private async exists(id: string): Promise<boolean> {
    const key = xdr.LedgerKey.offer(new xdr.LedgerKeyOffer({ sellerId: this.m.maker.xdrAccountId(), offerId: xdr.Int64.fromString(id) }));
    return (await retry("getLedgerEntries", () => server.getLedgerEntries(key))).entries.length > 0;
  }
  async set(tiers: { amountC: string; price: string }[]): Promise<string> {
    const ops: xdr.Operation[] = [];
    for (const id of this.offerIds) if (await this.exists(id)) ops.push(Operation.manageSellOffer({ selling: this.m.C, buying: this.m.A, amount: "0", price: "1", offerId: id }));
    const cancels = ops.length;
    for (const t of tiers) ops.push(Operation.manageSellOffer({ selling: this.m.C, buying: this.m.A, amount: t.amountC, price: t.price }));
    const { hash, done } = await run(this.m.maker, ops);
    const results = done.resultXdr.result().results();
    this.offerIds = [];
    for (let i = cancels; i < ops.length; i++) this.offerIds.push(results[i]!.tr().manageSellOfferResult().success().offer().offer().offerId().toString());
    return hash;
  }
}
export const BASE_TIERS = [{ amountC: "60", price: "1.03" }, { amountC: "200", price: "1.05" }];

// ---------------------------------------------------------------------------------------------------------------------
// A Horizon proxy that can be frozen: while frozen, path quotes it has already served are served again unchanged.
// FAULT INJECTION in this harness, in the style of w3's dropped response: Horizon testnet is slow to ingest offers, so
// without this the moment a cancelled book disappears from quotes is not under the script's control. The chain stays real.

export interface HorizonProxy { url: string; freeze(): void; thaw(): void; close(): Promise<void>; served: { stale: number; live: number } }
export async function startHorizonProxy(port: number): Promise<HorizonProxy> {
  const cache = new Map<string, { status: number; body: string; type: string }>();
  let frozen = false;
  const served = { stale: 0, live: 0 };
  const srv: Server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    const cached = cache.get(path);
    if (frozen && cached && path.startsWith("/paths/")) {
      served.stale++;
      res.writeHead(cached.status, { "content-type": cached.type }).end(cached.body);
      return;
    }
    try {
      const r = await retry("horizon (proxy)", async () => {
        const x = await timedFetch(`${HORIZON}${path}`);
        if (x.status >= 500) throw new Error(`horizon ${x.status}`);
        return x;
      });
      const body = await r.text();
      const type = r.headers.get("content-type") ?? "application/json";
      if (path.startsWith("/paths/") && r.ok) cache.set(path, { status: r.status, body, type });
      served.live++;
      res.writeHead(r.status, { "content-type": type }).end(body);
    } catch (e) {
      res.writeHead(502).end(String((e as Error).message));
    }
  });
  await new Promise<void>((ok) => srv.listen(port, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${port}`, freeze: () => void (frozen = true), thaw: () => void (frozen = false), close: () => new Promise((ok) => srv.close(() => ok())), served };
}

// ---------------------------------------------------------------------------------------------------------------------
// The standalone solver service, as a real child process running the built bin (`pnpm build` first).

export interface SolverProc { proc: ChildProcess; url: string; token: string; output: string[]; kill(): Promise<void>; exited: Promise<number | null> }
export function spawnSolver(o: { port: number; token: string; secret: string; settle: string; horizonUrl: string; stateDir: string; extraEnv?: Record<string, string> }): SolverProc {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SLUICE_IPV4_FIRST: "1",
    SOLVER_SECRET: o.secret,
    SOLVER_AUTH_TOKEN: o.token,
    SOLVER_SETTLE_CONTRACT: o.settle,
    SOLVER_RPC_URL: RPC,
    SOLVER_HORIZON_URL: o.horizonUrl,
    SOLVER_NETWORK_PASSPHRASE: PASS,
    SOLVER_PORT: String(o.port),
    SLUICE_STATE_DIR: o.stateDir,
    SOLVER_MIN_DEADLINE_BUFFER_SEC: "60",
    ...o.extraEnv,
  };
  const proc = spawn(process.execPath, [SOLVER_BIN], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  for (const s of [proc.stdout!, proc.stderr!]) s.on("data", (d: Buffer) => output.push(...d.toString().split("\n").filter(Boolean)));
  const exited = new Promise<number | null>((ok) => proc.on("exit", (c) => ok(c)));
  return {
    proc, url: `http://127.0.0.1:${o.port}`, token: o.token, output, exited,
    async kill() {
      if (proc.exitCode === null) proc.kill("SIGKILL"); // a crash, not a clean shutdown
      await exited;
    },
  };
}

export async function solverGet(s: { url: string; token: string }, path: string): Promise<any> {
  const r = await timedFetch(`${s.url}${path}`, { headers: { authorization: `Bearer ${s.token}` } });
  return r.json();
}
export async function waitSolverUp(s: SolverProc, timeoutMs = 60_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (s.proc.exitCode !== null) throw new Error(`solver service exited with ${s.proc.exitCode}:\n${s.output.slice(-10).join("\n")}`);
    try {
      return await solverGet(s, "/health");
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`solver service did not come up:\n${s.output.slice(-10).join("\n")}`);
}
