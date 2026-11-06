import { Address, Keypair, scValToNative, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { checkSignatureBy, encodeOrder, expectedTrees, isAddressEntry, reviewSolverEntry, type Order } from "@sluice/solver";

/**
 * Tier 2: wallets that cannot `signAuthEntry` but can sign a transaction. The user is the transaction source (and pays the
 * fee), the one operation is `settle.fill(order, solver, amount_out)`, and the two authorisations are:
 *   the user's: source-account credentials (the network's own signature check on the transaction envelope)
 *   the solver's: an address entry the solver signed when it prepared the transaction
 * Everything in this file checks that a transaction a user is about to send, or has signed, is exactly that and nothing else.
 */

export interface TxProblem {
  code: "UNSUPPORTED_ENVELOPE" | "WRONG_SOURCE" | "TX_MISMATCH" | "BAD_AUTH" | "BAD_SIGNATURE" | "BAD_TIMEBOUNDS";
  message: string;
}

export interface TxContext {
  settleContract: string;
  solver: string;
  passphrase: string;
}

/** Parse a transaction envelope for this network. Fee bumps are refused. */
export function parseUserTx(txXdr: string, passphrase: string): Transaction | TxProblem {
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(txXdr, passphrase);
  } catch {
    return { code: "UNSUPPORTED_ENVELOPE", message: "That is not a transaction envelope." };
  }
  if (!(tx instanceof Transaction)) return { code: "UNSUPPORTED_ENVELOPE", message: "Fee bump transactions are not accepted." };
  return tx;
}

export const isProblem = (v: unknown): v is TxProblem => !!v && typeof v === "object" && "code" in v && "message" in v && !(v instanceof Transaction);

interface FillCall {
  args: xdr.ScVal[];
  auth: xdr.SorobanAuthorizationEntry[];
}

/** The single `invokeContract` of the settle contract's `fill` this transaction makes, or why it is not one. */
function fillCall(tx: Transaction, ctx: TxContext): FillCall | TxProblem {
  const env = tx.toEnvelope();
  if (env.switch().name !== "envelopeTypeTx") return { code: "UNSUPPORTED_ENVELOPE", message: "Only plain transactions are accepted." };
  const body = env.v1().tx();
  if (body.sourceAccount().switch().name !== "keyTypeEd25519") return { code: "UNSUPPORTED_ENVELOPE", message: "A muxed source account is not accepted." };
  if (body.operations().length !== 1) return { code: "TX_MISMATCH", message: "The transaction must contain exactly one operation." };
  const op = body.operations()[0]!;
  if (op.sourceAccount()) return { code: "TX_MISMATCH", message: "The operation must not name a source account of its own." };
  if (op.body().switch().name !== "invokeHostFunction") return { code: "TX_MISMATCH", message: "The operation is not a contract call." };
  const hostOp = op.body().invokeHostFunctionOp();
  const fn = hostOp.hostFunction();
  if (fn.switch().name !== "hostFunctionTypeInvokeContract") return { code: "TX_MISMATCH", message: "The operation is not a contract call." };
  const inv = fn.invokeContract();
  if (Address.fromScAddress(inv.contractAddress()).toString() !== ctx.settleContract || inv.functionName().toString() !== "fill") {
    return { code: "TX_MISMATCH", message: "The transaction does not call fill on the settlement contract." };
  }
  return { args: inv.args(), auth: hostOp.auth() };
}

/** The solver entry's nonce and expiry, so the order id can be checked before anything else. A problem when the transaction is not recognisably a fill. */
export function solverEntryOf(tx: Transaction, ctx: TxContext): { nonce: string; validUntilLedger: number; entry: xdr.SorobanAuthorizationEntry } | TxProblem {
  const call = fillCall(tx, ctx);
  if ("code" in call) return call;
  const mine = call.auth.filter((e) => isAddressEntry(e) && Address.fromScAddress(e.credentials().address().address()).toString() === ctx.solver);
  if (mine.length !== 1) return { code: "BAD_AUTH", message: "The solver's authorisation entry is missing from the transaction." };
  const c = mine[0]!.credentials().address();
  return { nonce: c.nonce().toString(), validUntilLedger: c.signatureExpirationLedger(), entry: mine[0]! };
}

export interface TxFacts {
  /** The amount_out argument of the call. */
  amountOut: bigint;
  /** Unix seconds after which the network refuses the transaction. */
  maxTimeSec: number;
  solverNonce: string;
  solverValidUntilLedger: number;
}

/**
 * Check the whole transaction against the order the user was shown: source, operation, contract, function and every argument,
 * both authorisation entries and the solver's signature in its entry, the time bounds and the fee. `requireUserSignature`
 * additionally demands the user's signature on the envelope (set on submit, not on prepare).
 * Returns the facts the order id must agree with, or the first problem.
 */
export function inspectUserTx(tx: Transaction, order: Order, ctx: TxContext, o: { nowSec: number; requireUserSignature: boolean; maxFeeStroops?: bigint; maxWindowSec?: number }): TxFacts | TxProblem {
  const call = fillCall(tx, ctx);
  if ("code" in call) return call;
  if (tx.source !== order.user) return { code: "WRONG_SOURCE", message: "The transaction is not sourced from the order's account: the user must be the one who sends it." };

  const [orderArg, solverArg, amountArg] = call.args;
  if (call.args.length !== 3 || !orderArg || !solverArg || !amountArg) return { code: "TX_MISMATCH", message: "fill was called with the wrong number of arguments." };
  if (orderArg.toXDR("base64") !== encodeOrder(order).toXDR("base64")) return { code: "TX_MISMATCH", message: "The order inside the transaction is not the order that was shown." };
  if (solverArg.toXDR("base64") !== new Address(ctx.solver).toScVal().toXDR("base64")) return { code: "TX_MISMATCH", message: "The transaction names a different solver than this server's." };
  if (amountArg.switch().name !== "scvI128") return { code: "TX_MISMATCH", message: "amount_out is not an integer amount." };
  const amountOut = scValToNative(amountArg) as bigint;
  if (amountOut < order.minOut) return { code: "TX_MISMATCH", message: "amount_out is below the order's minimum." };

  // Authorisations: exactly the user's (source account) and the solver's (signed address entry).
  if (call.auth.length !== 2) return { code: "BAD_AUTH", message: "The transaction must carry exactly two authorisation entries (the user's and the solver's)." };
  const solverEntries = call.auth.filter((e) => isAddressEntry(e) && Address.fromScAddress(e.credentials().address().address()).toString() === ctx.solver);
  const userEntries = call.auth.filter((e) => !solverEntries.includes(e));
  if (solverEntries.length !== 1 || userEntries.length !== 1) return { code: "BAD_AUTH", message: "The solver's authorisation entry is missing." };
  const userEntry = userEntries[0]!;
  if (userEntry.credentials().switch().name !== "sorobanCredentialsSourceAccount") {
    return { code: "BAD_AUTH", message: "The user's authorisation must be the transaction's own source account, not a separate signature." };
  }
  const have = userEntry.rootInvocation().toXDR("base64");
  if (!expectedTrees(order, ctx.settleContract).some((t) => t.toXDR("base64") === have)) {
    return { code: "BAD_AUTH", message: "The user's authorisation does not cover exactly this order: the contract, the order or the input transfer differ." };
  }
  const solverEntry = solverEntries[0]!;
  const sp = reviewSolverEntry(solverEntry, order, ctx.solver, amountOut, ctx.settleContract) ?? checkSignatureBy(solverEntry, ctx.solver, ctx.passphrase);
  if (sp) return { code: "BAD_AUTH", message: sp.code === "BAD_SIGNATURE" || sp.code === "WRONG_SIGNER" ? `The solver's signature in the transaction is not valid: ${sp.message}` : sp.message };

  // Time: a transaction that never expires, or one valid for hours, is not what was prepared.
  const tb = tx.timeBounds;
  const minT = Number(tb?.minTime ?? 0);
  const maxT = Number(tb?.maxTime ?? 0);
  if (!tb || maxT === 0) return { code: "BAD_TIMEBOUNDS", message: "The transaction has no expiry." };
  if (minT > o.nowSec) return { code: "BAD_TIMEBOUNDS", message: "The transaction is not valid yet." };
  if (maxT > o.nowSec + (o.maxWindowSec ?? 3600 + 120)) return { code: "BAD_TIMEBOUNDS", message: "The transaction stays valid for longer than a prepared order does." };

  if (BigInt(tx.fee) > (o.maxFeeStroops ?? 100_000_000n)) return { code: "TX_MISMATCH", message: "The transaction's fee is far above what was prepared." };

  if (o.requireUserSignature) {
    const user = Keypair.fromPublicKey(order.user);
    const hash = tx.hash();
    const ok = tx.signatures.some((s) => s.hint().equals(user.signatureHint()) && user.verify(hash, s.signature()));
    if (!ok) return { code: "BAD_SIGNATURE", message: "The transaction is not signed by the order's account (or the signature does not match this exact transaction)." };
  }
  return { amountOut, maxTimeSec: maxT, solverNonce: solverEntry.credentials().address().nonce().toString(), solverValidUntilLedger: solverEntry.credentials().address().signatureExpirationLedger() };
}
