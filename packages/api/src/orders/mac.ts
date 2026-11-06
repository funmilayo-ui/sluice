import { createHmac, timingSafeEqual } from "node:crypto";
import type { Order } from "@sluice/solver";

/** Everything the server committed to when it prepared an order. Change any of it and the id stops verifying. */
export interface MacInput {
  passphrase: string;
  settleContract: string;
  solver: string;
  order: Order;
  /** What the solver agreed to pay (token_out stroops). Not part of the user's signature, so the id carries it. */
  amountOut: bigint;
  /** The auth entry's nonce: makes each prepared order unique. */
  nonce: string;
  /** The auth entry's expiration ledger. */
  validUntilLedger: number;
  /**
   * `tx` for the user-sourced transaction tier. Part of the MAC, so an id prepared for one tier cannot be replayed on the other:
   * there the nonce and expiry are the SOLVER's authorisation entry's, not the user's.
   */
  tier?: "tx";
}

function digest(secret: string, i: MacInput): Buffer {
  const o = i.order;
  // JSON of a fixed-order array: no field can be smuggled into a neighbour by choosing a separator.
  const canonical = JSON.stringify([
    i.tier === "tx" ? "sluice-order-tx-v1" : "sluice-order-v1", i.passphrase, i.settleContract, i.solver,
    o.user, o.tokenIn, o.amountIn.toString(), o.tokenOut, o.minOut.toString(), o.deadline, o.createTrustline,
    i.amountOut.toString(), i.nonce, i.validUntilLedger,
  ]);
  return createHmac("sha256", secret).update(canonical).digest();
}

/**
 * `orderId` is `<amountOut in stroops>.<hex HMAC-SHA256>`. The server keeps no state: at submit it reads
 * `amountOut` back out of the id and recomputes the MAC over the order, the auth entry's nonce and expiry and
 * its own settings. It can only verify what it signed: a different amount, min_out, asset, deadline,
 * expiry, solver, contract or network gives a different MAC.
 */
export function makeOrderId(secret: string, i: MacInput): string {
  return `${i.amountOut}.${digest(secret, i).toString("hex")}`;
}

/** The amount the id claims, without trusting it. Null when the id is not of the form `<digits>.<64 hex>`. */
export function orderIdAmount(id: string): bigint | null {
  const m = /^(\d{1,38})\.([0-9a-f]{64})$/.exec(id);
  return m ? BigInt(m[1]!) : null;
}

export function verifyOrderId(secret: string, id: string, i: Omit<MacInput, "amountOut">): bigint | null {
  const amountOut = orderIdAmount(id);
  if (amountOut === null) return null;
  const given = Buffer.from(id.split(".")[1]!, "hex");
  const want = digest(secret, { ...i, amountOut });
  return given.length === want.length && timingSafeEqual(given, want) ? amountOut : null;
}
