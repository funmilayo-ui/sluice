import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, Networks, StrKey, xdr } from "@stellar/stellar-sdk";
import { Sluice, SluiceError, signOrder, type PreparedOrder, type SignAuthEntry } from "./index.js";

const PASS = Networks.TESTNET;
const user = Keypair.random();
const settle = StrKey.encodeContract(randomBytes(32));
const tokenIn = StrKey.encodeContract(randomBytes(32));
const tokenOut = StrKey.encodeContract(randomBytes(32));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const kv = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const orderVal = (o: { amountIn: bigint; minOut: bigint; deadline: number; trust: boolean }) =>
  xdr.ScVal.scvMap([
    kv("amount_in", i128(o.amountIn)), kv("create_trustline", xdr.ScVal.scvBool(o.trust)), kv("deadline", nativeToScVal(BigInt(o.deadline), { type: "u64" })),
    kv("min_out", i128(o.minOut)), kv("token_in", new Address(tokenIn).toScVal()), kv("token_out", new Address(tokenOut).toScVal()), kv("user", new Address(user.publicKey()).toScVal()),
  ]);
const call = (contract: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args })),
    subInvocations: subs,
  });

const base = { amountIn: 100n * 10_000_000n, minOut: 90n * 10_000_000n, deadline: 2_000_000_000, trust: true };
function entryFor(o = base, tweak?: (subs: xdr.SorobanAuthorizedInvocation[]) => xdr.SorobanAuthorizedInvocation[], contract = settle): xdr.SorobanAuthorizationEntry {
  const subs = [
    call(tokenOut, "trust", [new Address(user.publicKey()).toScVal()]),
    call(tokenIn, "transfer", [new Address(user.publicKey()).toScVal(), new Address(settle).toScVal(), i128(100n * 10_000_000n)]),
  ];
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: new Address(user.publicKey()).toScAddress(), nonce: new xdr.Int64(987654321n), signatureExpirationLedger: 5000, signature: xdr.ScVal.scvVec([]) }),
    ),
    rootInvocation: call(contract, "fill", [orderVal(o)], tweak ? tweak(subs) : subs),
  });
}
function prepared(entry = entryFor(), patch: Partial<PreparedOrder["authEntry"]> = {}): PreparedOrder {
  const a = entry.credentials().address();
  const pre = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({ networkId: sha256(Buffer.from(PASS)), nonce: a.nonce(), invocation: entry.rootInvocation(), signatureExpirationLedger: 5000 }),
  );
  return {
    solverWillFill: true,
    orderId: "1.aa",
    order: { user: user.publicKey(), assetIn: "A:G", tokenIn, amountIn: "100.0000000", assetOut: "C:G", tokenOut, minOut: "90.0000000", deadline: base.deadline, createTrustline: true },
    summary: { pay: "100.0000000", receiveAtLeast: "90.0000000", expected: "95.0000000" },
    authEntry: { xdr: entry.toXDR("base64"), preimage: pre.toXDR("base64"), validUntilLedger: 5000, credentials: "address-legacy", networkPassphrase: PASS, ...patch },
  };
}
/** A wallet with the shape of signAuthEntry: sha256 of the preimage, signed. */
const walletOf = (kp: Keypair, over: Partial<{ signerAddress: string | undefined; asBytes: boolean; truncate: boolean }> = {}): SignAuthEntry & { calls: string[] } => {
  const calls: string[] = [];
  const fn = (async (pre: string) => {
    calls.push(pre);
    let sig = kp.sign(sha256(Buffer.from(pre, "base64")));
    if (over.truncate) sig = sig.subarray(0, 63);
    return { signedAuthEntry: over.asBytes ? new Uint8Array(sig) : sig.toString("base64"), signerAddress: "signerAddress" in over ? over.signerAddress : kp.publicKey() };
  }) as unknown as SignAuthEntry & { calls: string[] };
  fn.calls = calls;
  return fn;
};

describe("signOrder", () => {
  it("shows the wallet the server's preimage and returns an entry carrying a valid signature", async () => {
    const p = prepared();
    const w = walletOf(user);
    const signed = await signOrder(p, w, { settleContract: settle });
    expect(w.calls).toEqual([p.authEntry.preimage]);
    const e = xdr.SorobanAuthorizationEntry.fromXDR(signed, "base64");
    const a = e.credentials().address();
    expect(a.signatureExpirationLedger()).toBe(5000);
    const pair = a.signature().vec()![0]!;
    const fields = Object.fromEntries(pair.map()!.map((m) => [m.key().sym().toString(), Buffer.from(m.val().bytes())]));
    expect(fields.public_key!.equals(user.rawPublicKey())).toBe(true);
    expect(user.verify(sha256(Buffer.from(p.authEntry.preimage, "base64")), fields.signature!)).toBe(true);
    // The tree is untouched by signing.
    expect(e.rootInvocation().toXDR("base64")).toBe(xdr.SorobanAuthorizationEntry.fromXDR(p.authEntry.xdr, "base64").rootInvocation().toXDR("base64"));
  });
  it("accepts a signature given as bytes, and a wallet that does not report the signer", async () => {
    await expect(signOrder(prepared(), walletOf(user, { asBytes: true }))).resolves.toBeTruthy();
    await expect(signOrder(prepared(), walletOf(user, { signerAddress: undefined }))).resolves.toBeTruthy();
  });
  it("accepts the tree without the trust call, for an account whose trustline appeared since", async () => {
    await expect(signOrder(prepared(entryFor(base, (s) => [s[1]!])), walletOf(user))).resolves.toBeTruthy();
  });
  it("refuses a wallet that signed as another account", async () => {
    const other = Keypair.random();
    await expect(signOrder(prepared(), walletOf(other, { signerAddress: other.publicKey() }))).rejects.toThrow(/not the order's account/);
  });
  it("refuses a signature by another key even when the wallet claims to be the user", async () => {
    await expect(signOrder(prepared(), walletOf(Keypair.random(), { signerAddress: user.publicKey() }))).rejects.toThrow(/does not verify/);
  });
  it("refuses a signature that is not 64 bytes", async () => {
    await expect(signOrder(prepared(), walletOf(user, { truncate: true }))).rejects.toThrow(/64 bytes/);
  });
  it("refuses, before asking the wallet, a preimage that is not the entry's", async () => {
    const w = walletOf(user);
    const p = prepared(entryFor(), { preimage: prepared(entryFor({ ...base, minOut: 1n })).authEntry.preimage });
    await expect(signOrder(p, w)).rejects.toThrow(/preimage does not match/);
    expect(w.calls).toHaveLength(0);
  });
  it("refuses an entry that authorises a different order than the one shown", async () => {
    const w = walletOf(user);
    const lowered = prepared(entryFor({ ...base, minOut: 1n })); // entry says min_out 1, summary says 90
    await expect(signOrder(lowered, w)).rejects.toThrow(/exactly the order that was shown/);
    expect(w.calls).toHaveLength(0);
    const shifted = prepared(entryFor({ ...base, deadline: base.deadline + 1 }));
    await expect(signOrder(shifted, w)).rejects.toThrow(/exactly the order/);
  });
  it("refuses an entry with an extra call under fill, or a transfer of a different amount or to a different recipient", async () => {
    const w = walletOf(user);
    const extra = prepared(entryFor(base, (s) => [...s, call(tokenIn, "transfer", [new Address(user.publicKey()).toScVal(), new Address(Keypair.random().publicKey()).toScVal(), i128(1n)])]));
    await expect(signOrder(extra, w)).rejects.toThrow(/exactly the order/);
    const more = prepared(entryFor(base, (s) => [s[0]!, call(tokenIn, "transfer", [new Address(user.publicKey()).toScVal(), new Address(settle).toScVal(), i128(500n * 10_000_000n)])]));
    await expect(signOrder(more, w)).rejects.toThrow(/exactly the order/);
    const elsewhere = prepared(entryFor(base, (s) => [s[0]!, call(tokenIn, "transfer", [new Address(user.publicKey()).toScVal(), new Address(Keypair.random().publicKey()).toScVal(), i128(100n * 10_000_000n)])]));
    await expect(signOrder(elsewhere, w)).rejects.toThrow(/exactly the order/);
    expect(w.calls).toHaveLength(0);
  });
  it("refuses an entry that calls a contract other than the settlement contract when told which it is", async () => {
    const other = StrKey.encodeContract(randomBytes(32));
    // Same tree shape against another contract: the settlement address in the transfer differs from the root.
    const p = prepared(entryFor(base, undefined, other));
    await expect(signOrder(p, walletOf(user), { settleContract: settle })).rejects.toThrow(/different contract/);
  });
  it("refuses credentials it cannot sign instead of returning the entry unsigned", async () => {
    await expect(signOrder(prepared(entryFor(), { credentials: "address-v2" }), walletOf(user))).rejects.toThrow(/unsupported credentials/);
    const src = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: entryFor().rootInvocation() });
    const p = prepared();
    p.authEntry.xdr = src.toXDR("base64");
    await expect(signOrder(p, walletOf(user))).rejects.toThrow(/address credentials/);
  });
  it("refuses an entry for another account", async () => {
    const e = entryFor();
    e.credentials().address().address(new Address(Keypair.random().publicKey()).toScAddress());
    await expect(signOrder(prepared(e), walletOf(user))).rejects.toThrow(/different account/);
  });
});

describe("Sluice sdk orders", () => {
  it("addresses config, prepare, submit and status", async () => {
    const seen: { method: string; path: string; body?: unknown }[] = [];
    const f = (async (u: URL, i?: RequestInit) => {
      seen.push({ method: i?.method ?? "GET", path: u.pathname, body: i?.body ? JSON.parse(String(i.body)) : undefined });
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const s = new Sluice("http://x", f);
    await s.ordersConfig();
    await s.prepareOrder({ account: "G", assetIn: "native", assetOut: "A:G", amount: "5", slippageBps: 25, validForSec: 300 });
    await s.submitOrder({ orderId: "1.aa", order: prepared().order, signedAuthEntry: "XDR" });
    await s.order("ab".repeat(32));
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /v1/orders/config", "POST /v1/orders/prepare", "POST /v1/orders/submit", `GET /v1/orders/${"ab".repeat(32)}`]);
    expect(seen[1]!.body).toEqual({ account: "G", assetIn: "native", assetOut: "A:G", amount: "5", slippageBps: 25, validForSec: 300 });
    expect(seen[2]!.body).toMatchObject({ orderId: "1.aa", signedAuthEntry: "XDR" });
  });
  it("returns a declined order as data and a refusal as a SluiceError with its explanation", async () => {
    const declined = { solverWillFill: false, skipReasons: ["no_hedge_quote"], explained: { code: "SOLVER_WILL_NOT_FILL", message: "m", detail: "d" }, summary: { pay: "5.0000000" } };
    expect(await new Sluice("http://x", (async () => json(declined)) as unknown as typeof fetch).prepareOrder({ account: "G", assetIn: "native", assetOut: "A:G", amount: "5" })).toEqual(declined);
    const explained = { code: "BAD_ORDER_ID", message: "m", detail: "d" };
    const f = (async () => json({ error: "orderId does not match", explained }, 400)) as unknown as typeof fetch;
    await expect(new Sluice("http://x", f).submitOrder({ orderId: "x", order: prepared().order, signedAuthEntry: "x" })).rejects.toMatchObject({ status: 400, explained });
    expect(new SluiceError(501, "m")).toBeInstanceOf(Error);
  });
  it("a disabled server answers config with enabled false, and the other routes with 501", async () => {
    const f = (async (u: URL) => (u.pathname === "/v1/orders/config" ? json({ enabled: false, code: "ORDERS_NOT_CONFIGURED", reason: "r" }) : json({ error: "r", explained: { code: "ORDERS_DISABLED", message: "m", detail: "r" } }, 501))) as unknown as typeof fetch;
    const s = new Sluice("http://x", f);
    expect(await s.ordersConfig()).toMatchObject({ enabled: false });
    await expect(s.order("ab".repeat(32))).rejects.toMatchObject({ status: 501, explained: { code: "ORDERS_DISABLED" } });
  });
  it("polls an order until it is in a ledger, and gives up without claiming failure", async () => {
    let polls = 0;
    const f = (async () => json(++polls < 3 ? { hash: "h", status: "NOT_FOUND" } : { hash: "h", status: "SUCCESS", received: "95.0000000" })) as unknown as typeof fetch;
    expect(await new Sluice("http://x", f).waitForOrder("h", { intervalMs: 1 })).toMatchObject({ status: "SUCCESS", received: "95.0000000" });
    const never = (async () => json({ hash: "h", status: "NOT_FOUND" })) as unknown as typeof fetch;
    await expect(new Sluice("http://x", never).waitForOrder("h", { timeoutMs: 5, intervalMs: 1 })).rejects.toMatchObject({ status: 408 });
  });
});
