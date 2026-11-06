import { Keypair, rpc, Transaction, xdr } from "@stellar/stellar-sdk";
import type { Leg } from "@sluice/core";
import type { HedgeIo, SubmitResult, TxStatus } from "./executor.js";
import { buildHedgeTx, type QuotedHedge } from "./hedge.js";

/**
 * The real `HedgeIo`: signs and sends the Classic hedge through Soroban RPC and reports exactly one of the three
 * failure kinds. It never retries a SUBMISSION (only reads); retrying is the executor's decision.
 */
export interface StellarHedgeIoOpts {
  server: rpc.Server;
  passphrase: string;
  solver: Keypair;
  /** Fresh Classic quote for selling `amountIn` of token_in (for example `quoteHedge` bound to the order and Horizon). */
  quote: (amountIn: bigint) => Promise<QuotedHedge | null>;
  /** Solver's current token_in balance in stroops (read it from RPC, not from a lagging indexer). */
  heldIn: () => Promise<bigint>;
  /** Transaction validity window, seconds. Also bounds how long an unknown submission can still land. Default 120. */
  timeoutSec?: number;
  /** How long to wait for an accepted transaction to show up before reporting `unknown`. Default 60s. */
  confirmTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Name of the first operation's failure inside a failed transaction result, e.g. `pathPaymentStrictSendUnderDestmin`. */
export function describeFailure(resultXdr: xdr.TransactionResult | undefined): string {
  try {
    const r = resultXdr!.result();
    const top = r.switch().name;
    if (top !== "txFailed") return top;
    const op = r.results()[0]!.tr();
    const name = op.switch().name; // e.g. pathPaymentStrictSend
    const detail = (op as unknown as Record<string, () => { switch(): { name: string } }>)[`${name}Result`]?.();
    return detail ? `${top}: ${detail.switch().name}` : `${top}: ${name}`;
  } catch {
    return "failed (result not decodable)";
  }
}

/** token_out actually delivered by a successful path-payment-strict-send, from its result; null if not readable. */
export function proceedsFromResult(resultXdr: xdr.TransactionResult | undefined): bigint | null {
  try {
    const tr = resultXdr!.result().results()[0]!.tr();
    return BigInt(tr.pathPaymentStrictSendResult().success().last().amount().toString());
  } catch {
    return null;
  }
}

export function createStellarHedgeIo(o: StellarHedgeIoOpts): HedgeIo {
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutSec = o.timeoutSec ?? 120;
  const confirmMs = o.confirmTimeoutMs ?? 60_000;
  const pollMs = o.pollMs ?? 1_500;

  /** Reads are safe to repeat; a submission is not. */
  async function read<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        await sleep(1_000 * (i + 1));
      }
    }
    throw last;
  }

  return {
    now,
    sleep,
    quote: o.quote,
    heldIn: o.heldIn,
    async txStatus(hash: string): Promise<TxStatus> {
      const r = await o.server.getTransaction(hash);
      if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) return "success";
      if (r.status === rpc.Api.GetTransactionStatus.FAILED) return "failed";
      return "not_found";
    },
    async submit(leg: Leg, minOut: bigint): Promise<SubmitResult> {
      let tx: Transaction;
      try {
        const acc = await read(() => o.server.getAccount(o.solver.publicKey()));
        tx = new Transaction(buildHedgeTx(leg, { source: o.solver.publicKey(), sequence: acc.sequenceNumber(), minOut, passphrase: o.passphrase, timeoutSec }), o.passphrase);
        tx.sign(o.solver);
      } catch (e) {
        return { status: "rejected", error: `not sent: ${(e as Error).message}` }; // nothing left the machine
      }
      const hash = tx.hash().toString("hex");
      const expiresAtMs = Number(tx.timeBounds?.maxTime ?? 0) * 1000 || now() + timeoutSec * 1000;

      let sent: rpc.Api.SendTransactionResponse;
      try {
        sent = await o.server.sendTransaction(tx);
      } catch (e) {
        return { status: "unknown", hash, error: `send threw, the node may have received it: ${(e as Error).message}`, expiresAtMs };
      }
      if (sent.status === "ERROR") return { status: "rejected", error: `network refused it: ${describeFailure(sent.errorResult)}` };
      if (sent.status === "TRY_AGAIN_LATER") return { status: "rejected", error: "node asked to try again later; not accepted" };
      // PENDING or DUPLICATE: it is (or was) in the queue. Wait for the ledger.
      const giveUp = now() + confirmMs;
      while (now() < giveUp) {
        let r: rpc.Api.GetTransactionResponse | undefined;
        try {
          r = await o.server.getTransaction(hash);
        } catch {
          r = undefined; // flaky read; keep asking until the deadline
        }
        if (r?.status === rpc.Api.GetTransactionStatus.SUCCESS) return { status: "success", hash, proceedsOut: proceedsFromResult(r.resultXdr) };
        if (r?.status === rpc.Api.GetTransactionStatus.FAILED) return { status: "failed", hash, error: describeFailure(r.resultXdr) };
        await sleep(pollMs);
      }
      return { status: "unknown", hash, error: `no ledger result for ${hash} within ${confirmMs} ms`, expiresAtMs };
    },
  };
}
