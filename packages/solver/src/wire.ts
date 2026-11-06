import { Keypair } from "@stellar/stellar-sdk";
import type { Order } from "./order.js";
import type { FillRequest, PreparedTx, PrepareTxRequest } from "./port.js";

/** The JSON form of an `Order` between the API and the solver service: stroop amounts as integer strings. */
export interface OrderWire {
  user: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  minOut: string;
  deadline: number;
  createTrustline: boolean;
}

export const orderToWire = (o: Order): OrderWire => ({
  user: o.user, tokenIn: o.tokenIn, amountIn: o.amountIn.toString(), tokenOut: o.tokenOut, minOut: o.minOut.toString(), deadline: o.deadline, createTrustline: o.createTrustline,
});

const STROOPS = /^\d{1,38}$/;
const ACCOUNT = /^G[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;
const ASSET = /^(native|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$/;

/** Parse an order from JSON. Returns a message when it is malformed. */
export function orderFromWire(v: unknown): Order | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "order must be an object";
  const b = v as Record<string, unknown>;
  if (typeof b.user !== "string" || !ACCOUNT.test(b.user)) return "order.user must be a G... address";
  try {
    Keypair.fromPublicKey(b.user);
  } catch {
    return "order.user is not a valid address";
  }
  if (typeof b.tokenIn !== "string" || !CONTRACT.test(b.tokenIn) || typeof b.tokenOut !== "string" || !CONTRACT.test(b.tokenOut)) return "order.tokenIn and order.tokenOut must be C... contract ids";
  if (typeof b.amountIn !== "string" || !STROOPS.test(b.amountIn) || typeof b.minOut !== "string" || !STROOPS.test(b.minOut)) return "order.amountIn and order.minOut must be integer strings of stroops";
  if (typeof b.deadline !== "number" || !Number.isSafeInteger(b.deadline) || b.deadline <= 0) return "order.deadline must be a unix timestamp in seconds";
  if (typeof b.createTrustline !== "boolean") return "order.createTrustline must be a boolean";
  return { user: b.user, tokenIn: b.tokenIn, amountIn: BigInt(b.amountIn), tokenOut: b.tokenOut, minOut: BigInt(b.minOut), deadline: b.deadline, createTrustline: b.createTrustline };
}

export function fillRequestToWire(r: FillRequest) {
  return { order: orderToWire(r.order), assetIn: r.assetIn, assetOut: r.assetOut, amountOut: r.amountOut.toString(), signedUserEntry: r.signedUserEntry, ...(r.quoteOut !== undefined ? { quoteOut: r.quoteOut.toString() } : {}) };
}
export function prepareTxRequestToWire(r: PrepareTxRequest) {
  return { order: orderToWire(r.order), assetIn: r.assetIn, assetOut: r.assetOut, amountOut: r.amountOut.toString(), validForSec: r.validForSec, ...(r.quoteOut !== undefined ? { quoteOut: r.quoteOut.toString() } : {}) };
}

/** Parse a `/fill` or `/prepare-tx` body. Returns a message when it is malformed. */
export function requestFromWire(b: Record<string, unknown>, route: "fill" | "prepare-tx"): FillRequest | PrepareTxRequest | string {
  const order = orderFromWire(b.order);
  if (typeof order === "string") return order;
  if (typeof b.assetIn !== "string" || !ASSET.test(b.assetIn) || typeof b.assetOut !== "string" || !ASSET.test(b.assetOut)) return "assetIn and assetOut must be 'native' or 'CODE:ISSUER'";
  if (typeof b.amountOut !== "string" || !STROOPS.test(b.amountOut)) return "amountOut must be an integer string of stroops";
  let quoteOut: bigint | undefined;
  if (b.quoteOut !== undefined) {
    if (typeof b.quoteOut !== "string" || !STROOPS.test(b.quoteOut)) return "quoteOut must be an integer string of stroops";
    quoteOut = BigInt(b.quoteOut);
  }
  const common = { order, assetIn: b.assetIn, assetOut: b.assetOut, amountOut: BigInt(b.amountOut), ...(quoteOut !== undefined ? { quoteOut } : {}) };
  if (route === "fill") {
    if (typeof b.signedUserEntry !== "string" || !b.signedUserEntry) return "signedUserEntry is required";
    return { ...common, signedUserEntry: b.signedUserEntry };
  }
  if (typeof b.validForSec !== "number" || !Number.isInteger(b.validForSec)) return "validForSec must be an integer";
  return { ...common, validForSec: b.validForSec };
}

export const preparedTxToWire = (t: PreparedTx) => ({ ...t, minResourceFee: t.minResourceFee.toString() });
export const preparedTxFromWire = (t: Record<string, unknown>): PreparedTx | undefined => {
  if (typeof t.xdr !== "string" || typeof t.hash !== "string" || typeof t.source !== "string" || typeof t.sequence !== "string" || typeof t.minResourceFee !== "string" || !STROOPS.test(t.minResourceFee)) return undefined;
  if (typeof t.maxTimeSec !== "number" || typeof t.solverNonce !== "string" || typeof t.solverValidUntilLedger !== "number") return undefined;
  return { xdr: t.xdr, hash: t.hash, source: t.source, sequence: t.sequence, minResourceFee: BigInt(t.minResourceFee), maxTimeSec: t.maxTimeSec, solverNonce: t.solverNonce, solverValidUntilLedger: t.solverValidUntilLedger };
};
