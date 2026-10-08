import { Networks, rpc, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { rpcServer } from "../rpc.js";

export interface SubmitResult {
  hash: string;
  /** PENDING and DUPLICATE mean the network has it: poll `getTxStatus`. ERROR and TRY_AGAIN_LATER mean it was not accepted. */
  status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
  /** Transaction and operation result codes when the network rejected it, for example ["txBadSeq"]. */
  codes?: string[];
}

export interface TxStatus {
  hash: string;
  status: "NOT_FOUND" | "SUCCESS" | "FAILED";
  ledger?: number;
  /** Unix seconds the ledger closed. */
  createdAt?: number;
  /** Result codes when FAILED, for example ["txFailed", "pathPaymentStrictSendUnderDestmin"]. */
  codes?: string[];
  /** base64 TransactionEnvelope, TransactionResult and (Soroban only) return ScVal. */
  envelopeXdr?: string;
  resultXdr?: string;
  returnValue?: string;
}

/**
 * Parse a signed transaction and refuse anything this router would not have built: fee bumps, several
 * operations, or no signature. Throws with a message fit to show a user.
 */
export function parseSignedTx(signedXdr: string, passphrase: string = Networks.PUBLIC): Transaction {
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch {
    throw new Error("not a valid transaction envelope");
  }
  if (!(tx instanceof Transaction)) throw new Error("fee bump transactions are not accepted");
  if (tx.operations.length !== 1) throw new Error("expected exactly one operation");
  if (tx.signatures.length === 0) throw new Error("transaction is not signed");
  return tx;
}

/** Result code names from a TransactionResult: the transaction code, then each failed operation's code. */
export function resultCodes(result: xdr.TransactionResult): string[] {
  const r = result.result();
  const codes: string[] = [r.switch().name];
  if (r.switch().name !== "txFailed") return codes;
  for (const op of r.results()) {
    if (op.switch().name !== "opInner") {
      codes.push(op.switch().name);
      continue;
    }
    // Each operation result is a union whose arm name is the specific code, e.g. pathPaymentStrictSendUnderDestmin.
    const inner = op.tr().value() as { switch(): { name: string } };
    codes.push(inner.switch().name);
  }
  return codes;
}

/**
 * Send a signed transaction through Stellar RPC. RPC accepts Classic and Soroban transactions alike, so one
 * path covers every route. Nothing is signed here: the envelope arrives already signed by the user's wallet.
 */
export async function submitTx(rpcUrl: string, signedXdr: string, passphrase: string = Networks.PUBLIC): Promise<SubmitResult> {
  const tx = parseSignedTx(signedXdr, passphrase);
  // Not gated: a signed transaction must never queue behind a burst of quotes.
  const sent = await rpcServer(rpcUrl).sendTransaction(tx);
  return {
    hash: sent.hash,
    status: sent.status,
    codes: sent.errorResult ? resultCodes(sent.errorResult) : undefined,
  };
}

/** Where a submitted transaction stands. NOT_FOUND right after submit means "not in a ledger yet": keep polling. */
export async function getTxStatus(rpcUrl: string, hash: string): Promise<TxStatus> {
  const res = await rpcServer(rpcUrl).getTransaction(hash);
  if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { hash, status: "NOT_FOUND" };
  return {
    hash,
    status: res.status === rpc.Api.GetTransactionStatus.SUCCESS ? "SUCCESS" : "FAILED",
    ledger: res.ledger,
    createdAt: res.createdAt,
    codes: res.status === rpc.Api.GetTransactionStatus.FAILED ? resultCodes(res.resultXdr) : undefined,
    envelopeXdr: res.envelopeXdr.toXDR("base64"),
    resultXdr: res.resultXdr.toXDR("base64"),
    returnValue: res.status === rpc.Api.GetTransactionStatus.SUCCESS ? res.returnValue?.toXDR("base64") : undefined,
  };
}
