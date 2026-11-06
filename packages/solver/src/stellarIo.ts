import { Keypair, rpc, Transaction, xdr } from "@stellar/stellar-sdk";
import { resultCodes, type Leg } from "@sluice/core";
import type { HedgeIo, SubmitResult, TxStatus } from "./executor.js";
import { buildHedgeTx, type QuotedHedge } from "./hedge.js";
import type { Sequencer } from "./sequencer.js";

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
  /** Share the solver account's sequence numbers with the fills signed by the same key. Without it each send reads the account. */
  sequencer?: Sequencer;
  /**
   * Called with the transaction's hash after it is signed and BEFORE it is sent, so a caller can record "this hash may
   * be in flight" durably. If the process dies after that, the hash is what lets the next process find out what happened.
   * A throw here aborts the send (reported as `rejected`: nothing left the machine).
   */
  beforeSend?: (hash: string, expiresAtMs: number) => Promise<void> | void;
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
      type Phase = { early: SubmitResult } | { hash: string; expiresAtMs: number };
      const attempt = async (sequence: string): Promise<{ value: Phase; accepted: boolean; badSeq?: boolean }> => {
        let tx: Transaction;
        try {
          tx = new Transaction(buildHedgeTx(leg, { source: o.solver.publicKey(), sequence, minOut, passphrase: o.passphrase, timeoutSec }), o.passphrase);
          tx.sign(o.solver);
        } catch (e) {
          return { value: { early: { status: "rejected", error: `not sent: ${(e as Error).message}` } }, accepted: false }; // nothing left the machine
        }
        const hash = tx.hash().toString("hex");
        const expiresAtMs = Number(tx.timeBounds?.maxTime ?? 0) * 1000 || now() + timeoutSec * 1000;
        try {
          await o.beforeSend?.(hash, expiresAtMs);
        } catch (e) {
          return { value: { early: { status: "rejected", error: `not sent: could not record the submission (${(e as Error).message})` } }, accepted: false };
        }
        let sent: rpc.Api.SendTransactionResponse;
        try {
          sent = await o.server.sendTransaction(tx);
        } catch (e) {
          // The node may have received it, so the sequence number may be used: treat it as accepted (a later txBadSeq resets it).
          return { value: { early: { status: "unknown", hash, error: `send threw, the node may have received it: ${(e as Error).message}`, expiresAtMs } }, accepted: true };
        }
        let badSeq = false;
        try {
          badSeq = !!sent.errorResult && resultCodes(sent.errorResult).includes("txBadSeq");
        } catch { /* an unreadable result is not a sequence verdict */ }
        if (sent.status === "ERROR") return { value: { early: { status: "rejected", error: `network refused it: ${describeFailure(sent.errorResult)}` } }, accepted: false, badSeq };
        if (sent.status === "TRY_AGAIN_LATER") return { value: { early: { status: "rejected", error: "node asked to try again later; not accepted" } }, accepted: false };
        return { value: { hash, expiresAtMs }, accepted: true };
      };
      let phase: Phase;
      try {
        phase = o.sequencer
          ? await o.sequencer.run((base) => attempt(base.toString()))
          : (await attempt((await read(() => o.server.getAccount(o.solver.publicKey()))).sequenceNumber())).value;
      } catch (e) {
        return { status: "rejected", error: `not sent: ${(e as Error).message}` };
      }
      if ("early" in phase) return phase.early;
      const { hash, expiresAtMs } = phase;
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
