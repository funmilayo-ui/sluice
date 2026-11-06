import { Account, Address, authorizeEntry, Keypair, rpc, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import {
  parseAmount, parseHorizonAccount, resultCodes, rpcServer, sacId, simulateView, viaRpc, type HorizonAccount, type SubmitResult, type TxStatus,
} from "@sluice/core";
import { isAddressEntry, reviewSolverEntry } from "./auth.js";
import type { HedgeIo } from "./executor.js";
import { fillTx, FillSimulationError, simulateFillAuth, type FillCtx } from "./fillTx.js";
import { quoteHedge, type ClassicPair, type QuotedHedge } from "./hedge.js";
import type { Order } from "./order.js";
import { Sequencer } from "./sequencer.js";
import { createStellarHedgeIo } from "./stellarIo.js";

/** A transaction as the solver needs it: the usual status, plus the settle contract's error number when a fill failed with one. */
export interface ChainTx extends TxStatus { contractError?: number }

export type SendOutcome = SubmitResult;

export interface ChainFillSimulation {
  userEntry: xdr.SorobanAuthorizationEntry;
  minResourceFee: bigint;
  /**
   * Sign as the solver and send exactly what was simulated. `beforeSend` gets the hash after signing and before the
   * network sees it, so the caller can record it durably first; if it throws nothing is sent.
   */
  send(beforeSend?: (hash: string) => Promise<void> | void): Promise<SendOutcome>;
}

/** A tier-2 transaction: source = the user, the solver's authorisation already signed. Unsigned by the user. */
export interface PreparedUserTx {
  xdr: string;
  hash: string;
  source: string;
  sequence: string;
  fee: string;
  minResourceFee: bigint;
  /** Unix seconds after which the network refuses the transaction. */
  maxTimeSec: number;
  solverNonce: string;
  solverValidUntilLedger: number;
}

/**
 * Everything the solver does on the network with its key. The real one is `createStellarChain`; tests script a fake.
 * Reads (balances, quotes, status) never need the key; signing happens only inside `simulateFill().send`,
 * `prepareUserTx` and the hedge IO.
 */
export interface SolverChain {
  readonly address: string;
  /** The network passphrase the RPC endpoint itself reports. */
  networkPassphrase(): Promise<string>;
  latestLedger(): Promise<number>;
  getTx(hash: string): Promise<ChainTx>;
  /** The solver's Classic balance of `asset` (a Classic id or "native"), in stroops. */
  solverBalance(asset: string): Promise<bigint>;
  hedgeQuote(amountIn: bigint, pair: ClassicPair): Promise<QuotedHedge | null>;
  /** Hedge I/O bound to one asset pair. `beforeSend` is called with each hedge's hash before it is sent. */
  hedgeIo(pair: ClassicPair, beforeSend?: (hash: string, expiresAtMs: number) => Promise<void> | void): HedgeIo;
  /** Enforcing simulation of a tier-1 fill with the user's signed entry. Throws `FillSimulationError`. */
  simulateFill(order: Order, amountOut: bigint, signedUser: xdr.SorobanAuthorizationEntry): Promise<ChainFillSimulation>;
  /** Tier 2. Throws `FillSimulationError`. */
  prepareUserTx(order: Order, amountOut: bigint, validForSec: number): Promise<PreparedUserTx>;
  /** Send a transaction somebody else signed (tier 2). Never signs. */
  sendSigned(txXdr: string): Promise<SendOutcome>;
}

/** The settle contract's error number in a failed transaction's diagnostic events, if the failing contract is `settle`. */
export function contractErrorOf(events: xdr.DiagnosticEvent[] | undefined, settle: string): number | undefined {
  for (const ev of events ?? []) {
    try {
      const e = ev.event();
      const id = e.contractId();
      if (!id || StrKey.encodeContract(Buffer.from(id as unknown as Uint8Array)) !== settle) continue;
      const body = e.body().v0();
      for (const v of [...body.topics(), body.data()]) {
        if (v.switch().name !== "scvError") continue;
        const err = v.error();
        if (err.switch().name === "sceContract") return err.contractCode();
      }
    } catch { /* an event we cannot read is not evidence */ }
  }
  return undefined;
}

export interface StellarChainConfig {
  rpcUrl: string;
  horizonUrl: string;
  passphrase: string;
  settleContract: string;
  secret: string;
  /** Hedge transaction validity window, seconds. */
  hedgeTimeoutSec?: number;
}

export interface StellarChainOverrides {
  server?: rpc.Server;
  fetchImpl?: typeof fetch;
}

const LEDGER_SEC = 5;

export function createStellarChain(config: StellarChainConfig, o: StellarChainOverrides = {}): SolverChain {
  const server = o.server ?? rpcServer(config.rpcUrl);
  const pass = config.passphrase;
  const solver = Keypair.fromSecret(config.secret);
  const solverId = solver.publicKey();
  const ctx: FillCtx = { settleContract: config.settleContract, passphrase: pass, solverId };
  const f: typeof fetch = o.fetchImpl ?? ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }));
  const sequencer = new Sequencer(async () => BigInt((await viaRpc(config.rpcUrl, () => server.getAccount(solverId))).sequenceNumber()));

  async function getTx(hash: string): Promise<ChainTx> {
    const res = await viaRpc(config.rpcUrl, () => server.getTransaction(hash));
    if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { hash, status: "NOT_FOUND" };
    const success = res.status === rpc.Api.GetTransactionStatus.SUCCESS;
    return {
      hash,
      status: success ? "SUCCESS" : "FAILED",
      ledger: res.ledger,
      createdAt: res.createdAt,
      codes: success ? undefined : resultCodes(res.resultXdr),
      envelopeXdr: res.envelopeXdr.toXDR("base64"),
      resultXdr: res.resultXdr.toXDR("base64"),
      returnValue: success ? res.returnValue?.toXDR("base64") : undefined,
      contractError: success ? undefined : contractErrorOf((res as { diagnosticEventsXdr?: xdr.DiagnosticEvent[] }).diagnosticEventsXdr, config.settleContract),
    };
  }

  const outcomeOf = (sent: rpc.Api.SendTransactionResponse): SendOutcome => ({
    hash: sent.hash,
    status: sent.status,
    codes: sent.errorResult ? resultCodes(sent.errorResult) : undefined,
  });

  return {
    address: solverId,
    networkPassphrase: async () => (await server.getNetwork()).passphrase,
    latestLedger: async () => (await viaRpc(config.rpcUrl, () => server.getLatestLedger())).sequence,
    getTx,
    async solverBalance(asset) {
      const r = await f(`${config.horizonUrl}/accounts/${solverId}`);
      if (!r.ok) throw new Error(`horizon accounts ${r.status}`);
      const a = parseHorizonAccount((await r.json()) as HorizonAccount);
      const b = a.balances.find((x) => x.asset === asset);
      return b ? parseAmount(b.balance) : 0n;
    },
    hedgeQuote: (amountIn, pair) => quoteHedge({ amountIn } as Order, pair, config.horizonUrl, Date.now(), f),
    hedgeIo(pair, beforeSend) {
      return createStellarHedgeIo({
        server,
        passphrase: pass,
        solver,
        quote: (amountIn) => quoteHedge({ amountIn } as Order, pair, config.horizonUrl, Date.now(), f),
        heldIn: async () => (await simulateView(config.rpcUrl, sacId(pair.tokenIn, pass), "balance", [new Address(solverId).toScVal()], { passphrase: pass })) as bigint,
        timeoutSec: config.hedgeTimeoutSec ?? 120,
        sequencer,
        beforeSend,
      });
    },

    async simulateFill(order, amountOut, signedUser) {
      const s = await simulateFillAuth(server, config.rpcUrl, ctx, order, amountOut, signedUser);
      return {
        userEntry: s.userEntry,
        minResourceFee: s.minResourceFee,
        send: (beforeSend) =>
          sequencer.run(async (base) => {
            // The sequence is taken now, not at simulation time: other sends may have happened in between.
            const tx = rpc.assembleTransaction(fillTx(ctx, new Account(solverId, base.toString()), order, amountOut, s.auth), s.enforced!).build();
            tx.sign(solver);
            await beforeSend?.(tx.hash().toString("hex"));
            const out = outcomeOf(await server.sendTransaction(tx));
            return { value: out, accepted: out.status === "PENDING" || out.status === "DUPLICATE", badSeq: !!out.codes?.includes("txBadSeq") };
          }),
      };
    },

    async prepareUserTx(order, amountOut, validForSec) {
      const sim = (tx: Transaction) => viaRpc(config.rpcUrl, () => server.simulateTransaction(tx));
      const latest = (await viaRpc(config.rpcUrl, () => server.getLatestLedger())).sequence;
      const sequence = (await viaRpc(config.rpcUrl, () => server.getAccount(order.user))).sequenceNumber();
      const build = (auth?: xdr.SorobanAuthorizationEntry[]) => fillTx(ctx, new Account(order.user, sequence), order, amountOut, auth, validForSec);
      const rec = await sim(build());
      if (rpc.Api.isSimulationError(rec)) throw new FillSimulationError(rec.error);
      const recorded = rec.result?.auth ?? [];
      const mine = recorded.filter((e) => isAddressEntry(e) && Address.fromScAddress(e.credentials().address().address()).toString() === solverId);
      if (mine.length !== 1) throw new FillSimulationError("simulation did not ask for exactly one authorisation from the solver");
      // The user is the transaction source, so the network asks for source-account credentials for their half. Anything else
      // (an address entry for the user, a third party) would need a signature this flow does not collect: refuse it.
      const others = recorded.filter((e) => e !== mine[0]);
      if (others.length !== 1 || others[0]!.credentials().switch().name !== "sorobanCredentialsSourceAccount") {
        throw new FillSimulationError("simulation asked for authorisation this flow cannot collect (expected one source-account entry for the user)");
      }
      const problem = reviewSolverEntry(mine[0]!, order, solverId, amountOut, config.settleContract);
      if (problem) throw new FillSimulationError(problem.message);
      const validUntil = latest + Math.ceil(validForSec / LEDGER_SEC) + 2;
      const signedSolver = await authorizeEntry(mine[0]!, solver, validUntil, pass);
      const auth = recorded.map((e) => (e === mine[0] ? signedSolver : e));
      const enforced = await sim(build(auth));
      if (rpc.Api.isSimulationError(enforced)) throw new FillSimulationError(enforced.error);
      const tx = rpc.assembleTransaction(build(auth), enforced).build();
      return {
        xdr: tx.toXDR(),
        hash: tx.hash().toString("hex"),
        source: order.user,
        sequence: tx.sequence,
        fee: tx.fee,
        minResourceFee: BigInt(enforced.minResourceFee),
        maxTimeSec: Number(tx.timeBounds?.maxTime ?? 0),
        solverNonce: signedSolver.credentials().address().nonce().toString(),
        solverValidUntilLedger: validUntil,
      };
    },

    async sendSigned(txXdr) {
      const tx = TransactionBuilder.fromXDR(txXdr, pass);
      return outcomeOf(await server.sendTransaction(tx));
    },
  };
}
