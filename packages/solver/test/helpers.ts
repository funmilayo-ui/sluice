import { randomBytes } from "node:crypto";
import { Account, Address, authorizeEntry, Keypair, Networks, Operation, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { sacId, type Leg } from "@sluice/core";
import {
  expectedTrees, FillSimulationError, SolverNode, MemoryStore, type ChainFillSimulation, type ChainTx, type ClassicPair, type HedgeIo, type Order, type PreparedUserTx,
  type QuotedHedge, type SolverChain, type SolverNodeOptions, type StateStore, type SubmitResult as HedgeSubmit,
} from "../src/index.js";

export const S = 10_000_000n;
export const PASS = Networks.TESTNET;
export const solverKp = Keypair.random();
export const userKp = Keypair.random();
export const strangerKp = Keypair.random();
export const issuerKp = Keypair.random();
export const A = `SLFA:${issuerKp.publicKey()}`;
export const C = `SLFC:${issuerKp.publicKey()}`;
export const SETTLE = StrKey.encodeContract(randomBytes(32));
export const PAIR: ClassicPair = { tokenIn: A, tokenOut: C };

export const mkOrder = (over: Partial<Order> = {}): Order => ({
  user: userKp.publicKey(), tokenIn: sacId(A, PASS), amountIn: 100n * S, tokenOut: sacId(C, PASS), minOut: 90n * S, deadline: 1_900_000_000, createTrustline: true, ...over,
});

/** A fill transaction hash that is unique per fill. */
let counter = 0;
export const nextHash = () => (++counter).toString(16).padStart(64, "0");

/** The user's authorisation entry, signed by `key` (the user by default), with a unique nonce. */
export async function signedEntry(order: Order, o: { key?: Keypair; validUntil?: number; nonce?: bigint } = {}): Promise<xdr.SorobanAuthorizationEntry> {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(order.user).toScAddress(),
        nonce: new xdr.Int64(o.nonce ?? BigInt(`0x${randomBytes(6).toString("hex")}`)),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: expectedTrees(order, SETTLE)[0]!,
  });
  return authorizeEntry(entry, o.key ?? userKp, o.validUntil ?? 5000, PASS);
}

export interface Clock { now: number }

export interface HedgeStep { result: HedgeSubmit; lands?: boolean; /** Never answer: the process "dies" mid-submission (after the hash was recorded and, if `lands`, after the chain took it). */ hang?: boolean }

/**
 * A scripted world the node runs in: a chain whose fills land when the test says so, a Classic book with one rate, a solver
 * balance, and hedge submissions that follow a script. Time is a counter that `sleep` advances, so nothing really waits.
 */
export class FakeChain implements SolverChain {
  readonly address = solverKp.publicKey();
  passphrase = PASS;
  ledger = 1000;
  clock: Clock = { now: 1_800_000_000_000 };
  /** Fill / reserved transaction statuses by hash. */
  txs = new Map<string, ChainTx["status"]>();
  /** Classic book: out per in, x1e7. null = no path. */
  rate: bigint | null = (105n * S) / 100n;
  balanceOut = 1000n * S;
  /** The solver's token_in (SAC) balance. */
  held = 0n;
  hedgeSteps: HedgeStep[] = [];
  /** Every hedge submission, in order. */
  hedgeSubmits: { hash: string; minOut: bigint }[] = [];
  fillsSent: string[] = [];
  txSent: string[] = [];
  simError: string | undefined;
  quoteThrows = false;
  /** Fail the next send of a fill with this status instead of PENDING. */
  nextSendStatus: "PENDING" | "ERROR" | "TRY_AGAIN_LATER" | "DUPLICATE" = "PENDING";
  sendThrowsAfterRecord = false;
  sendThrowsBeforeRecord = false;
  statusThrows = false;
  hedgeStatusThrows = false;
  prepared = new Map<string, Order>();
  reservedCount = 0;
  onAfterRecord: (() => void) | undefined;
  private hedgeCounter = 0;

  now = () => this.clock.now;
  /** Advances the fake clock and yields to the event loop, so a polling loop cannot starve the test that is driving it. */
  sleep = async (ms: number) => {
    this.clock.now += ms;
    await new Promise<void>((r) => setImmediate(r));
  };

  async networkPassphrase() {
    return this.passphrase;
  }
  async latestLedger() {
    return this.ledger;
  }
  async getTx(hash: string): Promise<ChainTx> {
    if (this.statusThrows) throw new Error("rpc down");
    return { hash, status: this.txs.get(hash) ?? "NOT_FOUND" };
  }
  async solverBalance() {
    return this.balanceOut;
  }
  async hedgeQuote(amountIn: bigint): Promise<QuotedHedge | null> {
    if (this.quoteThrows) throw new Error("horizon down");
    if (this.rate === null) return null;
    const out = (amountIn * this.rate) / S;
    return { quote: { amountIn, amountOut: out, quotedAtMs: this.clock.now }, leg: { venue: "horizon", layer: "classic", assetIn: A, assetOut: C, amountIn, amountOut: out, hops: [] } as Leg };
  }
  hedgeIo(pair: ClassicPair, beforeSend?: (hash: string, expiresAtMs: number) => Promise<void> | void): HedgeIo {
    void pair;
    return {
      now: this.now,
      sleep: this.sleep,
      quote: (amountIn) => this.hedgeQuote(amountIn),
      heldIn: async () => this.held,
      txStatus: async (hash) => {
        if (this.hedgeStatusThrows) throw new Error("rpc down");
        const s = this.txs.get(hash);
        return s === "SUCCESS" ? "success" : s === "FAILED" ? "failed" : "not_found";
      },
      submit: async (leg, minOut) => {
        const step = this.hedgeSteps.shift();
        const hash = `${(++this.hedgeCounter).toString(16).padStart(8, "e")}${"0".repeat(56)}`;
        await beforeSend?.(hash, this.clock.now + 120_000);
        this.hedgeSubmits.push({ hash, minOut });
        if (!step) throw new Error("test: unexpected hedge submission (double hedge?)");
        const r = step.result;
        const res: HedgeSubmit = "hash" in r ? { ...r, hash } : r;
        if (step.lands) {
          this.held -= leg.amountIn;
          this.txs.set(hash, "SUCCESS");
        } else if (res.status === "failed") this.txs.set(hash, "FAILED");
        if (step.hang) await new Promise<never>(() => undefined);
        return res;
      },
    };
  }
  async simulateFill(order: Order, _amountOut: bigint, signedUser: xdr.SorobanAuthorizationEntry): Promise<ChainFillSimulation> {
    if (this.simError) throw new FillSimulationError(this.simError);
    return {
      userEntry: signedUser,
      minResourceFee: 100_000n,
      send: async (beforeSend) => {
        if (this.sendThrowsBeforeRecord) throw new Error("rpc down before anything was built");
        const hash = nextHash();
        await beforeSend?.(hash);
        this.onAfterRecord?.();
        if (this.sendThrowsAfterRecord) {
          this.fillsSent.push(hash);
          this.txs.set(hash, "NOT_FOUND");
          throw new Error("socket hang up");
        }
        const status = this.nextSendStatus;
        if (status === "PENDING" || status === "DUPLICATE") {
          this.fillsSent.push(hash);
          this.txs.set(hash, "NOT_FOUND");
          this.orderOf.set(hash, order);
        }
        return status === "ERROR" ? { hash, status, codes: ["txBadSeq"] } : { hash, status };
      },
    };
  }
  orderOf = new Map<string, Order>();
  async prepareUserTx(order: Order, amountOut: bigint, validForSec: number): Promise<PreparedUserTx> {
    if (this.simError) throw new FillSimulationError(this.simError);
    const n = ++this.reservedCount;
    const b = new TransactionBuilder(new Account(order.user, String(1000 + n)), { fee: "140000", networkPassphrase: PASS, timebounds: { minTime: 0, maxTime: Math.floor(this.clock.now / 1000) + validForSec } })
      .addOperation(Operation.bumpSequence({ bumpTo: String(n) }));
    const tx = b.build();
    this.prepared.set(tx.hash().toString("hex"), order);
    void amountOut;
    return { xdr: tx.toXDR(), hash: tx.hash().toString("hex"), source: order.user, sequence: tx.sequence, fee: tx.fee, minResourceFee: 100_000n, maxTimeSec: Math.floor(this.clock.now / 1000) + validForSec, solverNonce: String(n), solverValidUntilLedger: this.ledger + 130 };
  }
  async sendSigned(txXdr: string) {
    const tx = TransactionBuilder.fromXDR(txXdr, PASS) as Transaction;
    const hash = tx.hash().toString("hex");
    this.txSent.push(hash);
    if (this.nextSendStatus === "ERROR") return { hash, status: "ERROR" as const, codes: ["txBadSeq"] };
    return { hash, status: "PENDING" as const };
  }

  /** The chain includes a fill: it is successful, and the solver now holds the user's input. */
  land(hash: string, status: "SUCCESS" | "FAILED" = "SUCCESS", amountIn = 100n * S) {
    this.txs.set(hash, status);
    if (status === "SUCCESS") this.held += amountIn;
  }
}

export interface Harness {
  chain: FakeChain;
  store: StateStore;
  node: SolverNode;
  logs: string[];
}

export function harness(o: { chain?: FakeChain; store?: StateStore; node?: Partial<SolverNodeOptions>; opts?: Partial<SolverNodeOptions> } = {}): Harness {
  const chain = o.chain ?? new FakeChain();
  const store = o.store ?? new MemoryStore();
  const logs: string[] = [];
  const node = new SolverNode({
    chain,
    store,
    passphrase: PASS,
    settleContract: SETTLE,
    policy: { minDeadlineBufferSec: 60, maxOrderIn: 1000n * S, hedgeSlippageBps: 50, minProfitBps: 20, improvementShareBps: 5000, feeOutPerXlm: "0.1" },
    recovery: { unknownPollMs: 10, unknownResolveTimeoutMs: 500, expiryGraceMs: 0 },
    retry: { tickMs: 20, baseDelayMs: 1000, maxDelayMs: 8000, maxCycles: 3 },
    now: chain.now,
    sleep: chain.sleep,
    pollMs: 10,
    log: (m, d) => logs.push(`${m}${d === undefined ? "" : " " + JSON.stringify(d)}`),
    ...o.opts,
    ...o.node,
  });
  return { chain, store, node, logs };
}

export const ok = (hash = "h", proceedsOut = 104n * S): HedgeStep => ({ result: { status: "success", hash, proceedsOut }, lands: true });
export const failedOnChain = (): HedgeStep => ({ result: { status: "failed", hash: "x", error: "txFailed: pathPaymentStrictSendUnderDestmin" } });
export const rejected = (): HedgeStep => ({ result: { status: "rejected", error: "network refused it: txBadSeq" } });
