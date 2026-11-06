import { describe, expect, it } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { Asset, Networks } from "@stellar/stellar-sdk";
import { decodeOrder, encodeOrder, ORDER_KEYS, type Order } from "../src/index.js";

const issuer = Keypair.random().publicKey();
const order: Order = {
  user: Keypair.random().publicKey(),
  tokenIn: new Asset("SLFA", issuer).contractId(Networks.TESTNET),
  amountIn: 1_000_000_000n,
  tokenOut: new Asset("SLFC", issuer).contractId(Networks.TESTNET),
  minOut: 900_000_000n,
  deadline: 1_900_000_000,
  createTrustline: true,
};

describe("order encoding", () => {
  it("round-trips", () => expect(decodeOrder(encodeOrder(order))).toEqual(order));
  it("is a map with the contract's sorted symbol keys", () => {
    const v = encodeOrder(order);
    expect(v.switch().name).toBe("scvMap");
    expect(v.map()!.map((e) => e.key().sym().toString())).toEqual([...ORDER_KEYS]);
    expect([...ORDER_KEYS]).toEqual([...ORDER_KEYS].sort());
  });
  it("uses i128 amounts, a u64 deadline and a bool", () => {
    const m = encodeOrder(order).map()!;
    const t = (k: string) => m.find((e) => e.key().sym().toString() === k)!.val().switch().name;
    expect([t("amount_in"), t("min_out"), t("deadline"), t("create_trustline"), t("user"), t("token_in")]).toEqual(["scvI128", "scvI128", "scvU64", "scvBool", "scvAddress", "scvAddress"]);
  });
  it("survives an XDR round trip", () => {
    const back = xdr.ScVal.fromXDR(encodeOrder(order).toXDR("base64"), "base64");
    expect(decodeOrder(back)).toEqual(order);
  });
  it("rejects a non-map and wrong or reordered keys", () => {
    expect(() => decodeOrder(xdr.ScVal.scvBool(true))).toThrow(/not a map/);
    const m = encodeOrder(order).map()!;
    expect(() => decodeOrder(xdr.ScVal.scvMap(m.slice(1)))).toThrow(/expected keys/);
    expect(() => decodeOrder(xdr.ScVal.scvMap([...m].reverse()))).toThrow(/expected keys/);
  });
});
