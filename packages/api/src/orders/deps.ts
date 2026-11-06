import {
  Account, Address, BASE_FEE, Keypair, nativeToScVal, Operation, rpc, StrKey, Transaction, TransactionBuilder, xdr,
} from "@stellar/stellar-sdk";
import { parseAmount, parseHorizonAccount, receivedAmount, resultCodes, rpcServer, viaRpc, type HorizonAccount, type SubmitResult } from "@sluice/core";
import { buildHedgeTx, encodeOrder, quoteHedge, type ClassicPair, type Order } from "@sluice/solver";
import { ACCOUNT_NOT_FOUND } from "../deps.js";
import { isAddressEntry } from "./auth.js";
import type { OrdersConfig } from "./config.js";
import { FillSimulationError, type FillSimulation, type HedgeOutcome, type OrderTx, type OrdersDeps } from "./service.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export interface OrdersDepsOverrides {
  server?: rpc.Server;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Network access for the orders feature, against the ORDERS_* endpoints only. The solver key signs in here and
 * nowhere else. Sequence numbers of the solver account are handed out one transaction at a time and tracked
 * locally, because an RPC node does not count a transaction it has accepted but not yet closed.
 */
export function defaultOrdersDeps(config: OrdersConfig, o: OrdersDepsOverrides = {}): OrdersDeps {
  const server = o.server ?? rpcServer(config.rpcUrl);
  const pass = config.networkPassphrase;
  const solver = Keypair.fromSecret(config.solverSecret);
  const solverId = solver.publicKey();
  const f: typeof fetch = o.fetchImpl ?? ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }));

  async function horizonAccount(g: string) {
    const r = await f(`${config.horizonUrl}/accounts/${g}`);
    if (r.status === 404) throw new Error(ACCOUNT_NOT_FOUND);
    if (!r.ok) throw new Error(`horizon accounts ${r.status}`);
    return parseHorizonAccount((await r.json()) as HorizonAccount);
  }

  let lastSeq = 0n;
  let chain: Promise<unknown> = Promise.resolve();
  /** Run `fn` after every earlier locked call has finished, whether those succeeded or not. */
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  /** The solver account at the next sequence number it may use. */
  async function solverAccount(): Promise<Account> {
    const seq = BigInt((await viaRpc(config.rpcUrl, () => server.getAccount(solverId))).sequenceNumber());
    return new Account(solverId, (seq > lastSeq ? seq : lastSeq).toString());
  }
  const accepted = (r: { status: string }, used: bigint) => {
    if (r.status === "PENDING" || r.status === "DUPLICATE") lastSeq = used;
  };

  const fillOp = (order: Order, amountOut: bigint) =>
    Operation.invokeContractFunction({
      contract: config.settleContract,
      function: "fill",
      args: [encodeOrder(order), new Address(solverId).toScVal(), nativeToScVal(amountOut, { type: "i128" })],
    });
  const fillTx = (acc: Account, order: Order, amountOut: bigint, auth?: xdr.SorobanAuthorizationEntry[]): Transaction => {
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: pass }).addOperation(fillOp(order, amountOut)).setTimeout(300).build();
    if (!auth) return tx;
    const env = tx.toEnvelope();
    env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth(auth);
    return new Transaction(env, pass);
  };

  async function simulateFill(order: Order, amountOut: bigint, signedUser?: xdr.SorobanAuthorizationEntry): Promise<FillSimulation> {
    const sim = (tx: Transaction) => viaRpc(config.rpcUrl, () => server.simulateTransaction(tx));
    const rec = await sim(fillTx(await solverAccount(), order, amountOut));
    if (rpc.Api.isSimulationError(rec)) throw new FillSimulationError(rec.error);
    const recorded = rec.result?.auth ?? [];
    const mine = recorded.find((e) => isAddressEntry(e) && Address.fromScAddress(e.credentials().address().address()).toString() === order.user);
    if (!mine) throw new FillSimulationError("simulation asked for no authorisation from the user");
    if (!signedUser) {
      return { userEntry: mine, minResourceFee: BigInt(rec.minResourceFee), send: async () => { throw new Error("a recording simulation cannot be sent"); } };
    }
    // Enforcing mode: the user's signed entry replaces the recorded one, so the network really checks the signature.
    const auth = recorded.map((e) => (e === mine ? signedUser : e));
    const enforced = await sim(fillTx(await solverAccount(), order, amountOut, auth));
    if (rpc.Api.isSimulationError(enforced)) throw new FillSimulationError(enforced.error);
    return {
      userEntry: signedUser,
      minResourceFee: BigInt(enforced.minResourceFee),
      send: () =>
        locked(async () => {
          // The sequence is taken now, not at simulation time: other fills may have been sent in between.
          const acc = await solverAccount();
          const used = BigInt(acc.sequenceNumber()) + 1n;
          const tx = rpc.assembleTransaction(fillTx(acc, order, amountOut, auth), enforced).build();
          tx.sign(solver);
          const sent = await server.sendTransaction(tx);
          accepted(sent, used);
          const out: SubmitResult = { hash: sent.hash, status: sent.status, codes: sent.errorResult ? resultCodes(sent.errorResult) : undefined };
          if (out.codes?.includes("txBadSeq")) lastSeq = 0n;
          return out;
        }),
    };
  }

  async function getTx(hash: string): Promise<OrderTx> {
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

  return {
    now: o.now ?? Date.now,
    networkPassphrase: async () => (await server.getNetwork()).passphrase,
    latestLedger: async () => (await viaRpc(config.rpcUrl, () => server.getLatestLedger())).sequence,
    async trustlines(account) {
      return (await horizonAccount(account)).assets;
    },
    async solverBalance(asset) {
      const a = await horizonAccount(solverId);
      const b = a.balances.find((x) => x.asset === asset);
      return b ? parseAmount(b.balance) : 0n;
    },
    hedgeQuote: (order: Order, pair: ClassicPair) => quoteHedge(order, pair, config.horizonUrl, Date.now(), f),
    simulateFill,
    getTx,
    async hedge(order: Order, pair: ClassicPair, _amountOut: bigint): Promise<HedgeOutcome> {
      // Sell the input the fill delivered. The book may have moved since the order was priced, so quote again and
      // protect the sale with the configured slippage buffer instead of the old figure.
      const quoted = await quoteHedge(order, pair, config.horizonUrl, Date.now(), f);
      if (!quoted) throw new Error("no Classic path to sell the filled input on");
      const minOut = (quoted.quote.amountOut * BigInt(10_000 - config.policy.hedgeSlippageBps)) / 10_000n;
      const hash = await locked(async () => {
        const acc = await solverAccount();
        const used = BigInt(acc.sequenceNumber()) + 1n;
        const tx = TransactionBuilder.fromXDR(buildHedgeTx(quoted.leg, { source: solverId, sequence: acc.sequenceNumber(), minOut, passphrase: pass }), pass) as Transaction;
        tx.sign(solver);
        const sent = await server.sendTransaction(tx);
        accepted(sent, used);
        if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
          if (sent.errorResult && resultCodes(sent.errorResult).includes("txBadSeq")) lastSeq = 0n;
          throw new Error(`hedge not accepted: ${sent.errorResult ? resultCodes(sent.errorResult).join(", ") : sent.status}`);
        }
        return sent.hash;
      });
      for (let i = 0; i < 60; i++) {
        const t = await getTx(hash).catch(() => ({ status: "NOT_FOUND" }) as OrderTx);
        if (t.status === "SUCCESS") return { hash, received: receivedAmount(t)?.amount };
        if (t.status === "FAILED") throw new Error(`hedge ${hash} failed: ${(t.codes ?? []).join(", ")}`);
        await sleep(1500);
      }
      throw new Error(`hedge ${hash} was not seen in a ledger`);
    },
  };
}
