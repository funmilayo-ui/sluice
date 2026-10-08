import { scValToNative, xdr } from "@stellar/stellar-sdk";

/** Contract function each Soroban venue is called with, and where its return value carries the output amount. */
const SOROBAN_OUT: Record<string, (ret: unknown) => unknown> = {
  swap_exact_tokens_for_tokens: (r) => (Array.isArray(r) ? r[r.length - 1] : undefined), // Soroswap: Vec<i128> of amounts along the path
  swap_exact_amount_in: (r) => (Array.isArray(r) ? r[0] : undefined), // Comet: (amount_out, spot_price_after)
  swap_chained: (r) => r, // Aquarius: u128
  swap: (r) => r, // Phoenix: i128
  swap_exact_in: (r) => r, // Sluice router: i128
};

export interface Settled {
  /** "classic" for a path payment, otherwise the contract function that was invoked. */
  kind: string;
  /** Output amount in stroops. */
  amount: bigint;
}

/**
 * What a settled swap actually delivered, read from the transaction itself rather than from a balance, so
 * unrelated payments to the account cannot skew it. Returns null for anything that is not a swap this router
 * builds (a trustline change, a vault deposit) or when the result cannot be decoded.
 * The second leg of a two-transaction route and a zap's deposit are sized from this, never from the quote.
 */
export function receivedAmount(tx: { envelopeXdr?: string; resultXdr?: string; returnValue?: string }): Settled | null {
  if (!tx.envelopeXdr) return null;
  try {
    const env = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64");
    if (env.switch().name !== "envelopeTypeTx") return null;
    const op = env.v1().tx().operations()[0]?.body();
    if (!op) return null;

    if (op.switch().name === "pathPaymentStrictSend") {
      if (!tx.resultXdr) return null;
      const res = xdr.TransactionResult.fromXDR(tx.resultXdr, "base64").result();
      if (res.switch().name !== "txSuccess") return null;
      const last = res.results()[0]!.tr().pathPaymentStrictSendResult().success().last();
      return { kind: "classic", amount: BigInt(last.amount().toString()) };
    }

    if (op.switch().name === "invokeHostFunction") {
      const fn = op.invokeHostFunctionOp().hostFunction();
      if (fn.switch().name !== "hostFunctionTypeInvokeContract" || !tx.returnValue) return null;
      const name = fn.invokeContract().functionName().toString();
      const pick = SOROBAN_OUT[name];
      if (!pick) return null;
      const out = pick(scValToNative(xdr.ScVal.fromXDR(tx.returnValue, "base64")));
      return typeof out === "bigint" && out > 0n ? { kind: name, amount: out } : null;
    }
    return null;
  } catch {
    return null;
  }
}
