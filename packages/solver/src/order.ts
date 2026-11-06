import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * The order the user signs, exactly as the settle contract's `Order` struct. Addresses are strkeys (the user is
 * a G... account, the tokens are Stellar Asset Contract C... ids). Amounts are 7-decimal stroops; both tokens
 * are assumed to have 7 decimals (every Classic asset does).
 */
export interface Order {
  user: string;
  tokenIn: string;
  amountIn: bigint;
  tokenOut: string;
  minOut: bigint;
  /** Ledger close time, unix seconds, after which the contract refuses the fill. */
  deadline: number;
  createTrustline: boolean;
}

/** A Soroban struct is a map with its symbol keys in sorted order. This is the order the contract defines. */
export const ORDER_KEYS = ["amount_in", "create_trustline", "deadline", "min_out", "token_in", "token_out", "user"] as const;

const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });

export function encodeOrder(o: Order): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry("amount_in", i128(o.amountIn)),
    entry("create_trustline", xdr.ScVal.scvBool(o.createTrustline)),
    entry("deadline", nativeToScVal(BigInt(o.deadline), { type: "u64" })),
    entry("min_out", i128(o.minOut)),
    entry("token_in", new Address(o.tokenIn).toScVal()),
    entry("token_out", new Address(o.tokenOut).toScVal()),
    entry("user", new Address(o.user).toScVal()),
  ]);
}

/** Inverse of `encodeOrder`. Throws on anything that is not exactly the contract's struct. */
export function decodeOrder(v: xdr.ScVal): Order {
  if (v.switch().name !== "scvMap") throw new Error("order: not a map");
  const entries = v.map() ?? [];
  const keys = entries.map((e) => (e.key().switch().name === "scvSymbol" ? e.key().sym().toString() : "?"));
  if (keys.length !== ORDER_KEYS.length || keys.some((k, i) => k !== ORDER_KEYS[i])) {
    throw new Error(`order: expected keys ${ORDER_KEYS.join(",")} in order, got ${keys.join(",")}`);
  }
  const f = (k: (typeof ORDER_KEYS)[number]) => scValToNative(entries[ORDER_KEYS.indexOf(k)]!.val());
  const deadline = f("deadline") as bigint;
  if (deadline > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("order: deadline out of range");
  return {
    user: f("user") as string,
    tokenIn: f("token_in") as string,
    amountIn: f("amount_in") as bigint,
    tokenOut: f("token_out") as string,
    minOut: f("min_out") as bigint,
    deadline: Number(deadline),
    createTrustline: f("create_trustline") as boolean,
  };
}
