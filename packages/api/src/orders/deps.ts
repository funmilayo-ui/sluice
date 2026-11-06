import { rpc, type Transaction, type xdr } from "@stellar/stellar-sdk";
import { parseAmount, parseHorizonAccount, rpcServer, viaRpc, type HorizonAccount } from "@sluice/core";
import { contractErrorOf, FillSimulationError, quoteHedge, simulateFillAuth, type ClassicPair, type FillCtx, type Order } from "@sluice/solver";
import { ACCOUNT_NOT_FOUND } from "../deps.js";
import type { OrdersConfig } from "./config.js";
import type { OrdersDeps } from "./service.js";

export { contractErrorOf };

export interface OrdersDepsOverrides {
  server?: rpc.Server;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The API's own reads of the settlement network, against the ORDERS_* endpoints only: accounts, ledgers, simulations,
 * transaction status, the Classic order book. Nothing here signs, and nothing here needs the solver's key: it is built
 * from the solver's PUBLIC address, so it is identical whether the solver runs in this process or as its own service.
 */
export function defaultOrdersDeps(config: OrdersConfig, o: OrdersDepsOverrides = {}): OrdersDeps {
  const server = o.server ?? rpcServer(config.rpcUrl);
  const solverId = config.solverAddress;
  const ctx: FillCtx = { settleContract: config.settleContract, passphrase: config.networkPassphrase, solverId };
  const f: typeof fetch = o.fetchImpl ?? ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }));

  async function horizonAccount(g: string) {
    const r = await f(`${config.horizonUrl}/accounts/${g}`);
    if (r.status === 404) throw new Error(ACCOUNT_NOT_FOUND);
    if (!r.ok) throw new Error(`horizon accounts ${r.status}`);
    return parseHorizonAccount((await r.json()) as HorizonAccount);
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
    async simulateFill(order, amountOut, signedUser) {
      const s = await simulateFillAuth(server, config.rpcUrl, ctx, order, amountOut, signedUser);
      return { userEntry: s.userEntry, minResourceFee: s.minResourceFee };
    },
    async simulateTx(tx: Transaction) {
      const sim = await viaRpc(config.rpcUrl, () => server.simulateTransaction(tx));
      if (rpc.Api.isSimulationError(sim)) throw new FillSimulationError(sim.error);
      return { minResourceFee: BigInt(sim.minResourceFee) };
    },
    async accountSequence(account) {
      return (await viaRpc(config.rpcUrl, () => server.getAccount(account))).sequenceNumber();
    },
    async getTx(hash) {
      const res = await viaRpc(config.rpcUrl, () => server.getTransaction(hash));
      return chainTxOf(hash, res, config.settleContract);
    },
  };
}

import { resultCodes } from "@sluice/core";
import type { OrderTx } from "./service.js";

function chainTxOf(hash: string, res: rpc.Api.GetTransactionResponse, settle: string): OrderTx {
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
    contractError: success ? undefined : contractErrorOf((res as { diagnosticEventsXdr?: xdr.DiagnosticEvent[] }).diagnosticEventsXdr, settle),
  };
}
