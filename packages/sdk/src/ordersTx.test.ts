import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Account, Address, authorizeEntry, Keypair, nativeToScVal, Networks, Operation, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { Sluice, signOrderTx, type PreparedOrderTx, type SignTransaction } from "./index.js";

const PASS = Networks.TESTNET;
const user = Keypair.random();
const solver = Keypair.random();
const stranger = Keypair.random();
const settle = StrKey.encodeContract(randomBytes(32));
const tokenIn = StrKey.encodeContract(randomBytes(32));
const tokenOut = StrKey.encodeContract(randomBytes(32));
const S = 10_000_000n;
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const kv = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v });
const call = (contract: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args })),
    subInvocations: subs,
  });
const base = { amountIn: 100n * S, minOut: 90n * S, deadline: 2_000_000_000, trust: true };
const orderVal = (o = base) =>
  xdr.ScVal.scvMap([
    kv("amount_in", i128(o.amountIn)), kv("create_trustline", xdr.ScVal.scvBool(o.trust)), kv("deadline", nativeToScVal(BigInt(o.deadline), { type: "u64" })),
    kv("min_out", i128(o.minOut)), kv("token_in", new Address(tokenIn).toScVal()), kv("token_out", new Address(tokenOut).toScVal()), kv("user", new Address(user.publicKey()).toScVal()),
  ]);
const AMOUNT = 95n * S;

interface Build { amountOut?: bigint; solverKey?: Keypair; callArgs?: xdr.ScVal[]; source?: string; validUntil?: number; timeoutSec?: number; fee?: string; extra?: (auth: xdr.SorobanAuthorizationEntry[]) => xdr.SorobanAuthorizationEntry[]; ops?: xdr.Operation[]; userTreeSubs?: xdr.SorobanAuthorizedInvocation[] }
async function build(b: Build = {}): Promise<PreparedOrderTx> {
  const amountOut = b.amountOut ?? AMOUNT;
  const solverTree = call(settle, "fill", [orderVal(), new Address(solver.publicKey()).toScVal(), i128(amountOut)], [call(tokenOut, "transfer", [new Address(solver.publicKey()).toScVal(), new Address(user.publicKey()).toScVal(), i128(amountOut)])]);
  const nonce = new xdr.Int64(424242n);
  const solverEntry = await authorizeEntry(
    new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(solver.publicKey()).toScAddress(), nonce, signatureExpirationLedger: 0, signature: xdr.ScVal.scvVec([]) })), rootInvocation: solverTree }),
    b.solverKey ?? solver, b.validUntil ?? 5000, PASS,
  );
  if (b.solverKey) solverEntry.credentials().address().signatureExpirationLedger(b.validUntil ?? 5000);
  const userTree = call(settle, "fill", [orderVal()], b.userTreeSubs ?? [
    call(tokenOut, "trust", [new Address(user.publicKey()).toScVal()]),
    call(tokenIn, "transfer", [new Address(user.publicKey()).toScVal(), new Address(settle).toScVal(), i128(100n * S)]),
  ]);
  const userEntry = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: userTree });
  const op = Operation.invokeContractFunction({ contract: settle, function: "fill", args: b.callArgs ?? [orderVal(), new Address(solver.publicKey()).toScVal(), i128(amountOut)] });
  const tb = new TransactionBuilder(new Account(b.source ?? user.publicKey(), "99"), { fee: b.fee ?? "140000", networkPassphrase: PASS }).addOperation(op);
  for (const extra of b.ops ?? []) tb.addOperation(extra as never);
  const tx0 = tb.setTimeout(b.timeoutSec ?? 600).build();
  const env = tx0.toEnvelope();
  env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth((b.extra ?? ((a) => a))([userEntry, solverEntry]));
  const tx = new Transaction(env, PASS);
  return {
    solverWillFill: true,
    orderId: "95000000.aa",
    order: { user: user.publicKey(), assetIn: "A:G", tokenIn, amountIn: "100.0000000", assetOut: "C:G", tokenOut, minOut: "90.0000000", deadline: base.deadline, createTrustline: true },
    summary: { pay: "100.0000000", receiveAtLeast: "90.0000000", expected: "95.0000000", networkFee: "0.0140000" },
    tx: { xdr: tx.toXDR(), hash: tx.hash().toString("hex"), source: b.source ?? user.publicKey(), validUntilLedger: b.validUntil ?? 5000, maxTime: Number(tx.timeBounds!.maxTime), networkPassphrase: PASS },
  };
}
const opts = { settleContract: settle, solver: solver.publicKey() };
const walletOf = (key: Keypair, over: Partial<{ signerAddress: string | undefined; replace: string }> = {}): SignTransaction & { calls: string[] } => {
  const calls: string[] = [];
  const fn = (async (x: string, o: { networkPassphrase: string; address: string }) => {
    calls.push(`${o.address}@${o.networkPassphrase}`);
    const tx = TransactionBuilder.fromXDR(over.replace ?? x, PASS) as Transaction;
    tx.sign(key);
    return { signedTxXdr: tx.toXDR(), signerAddress: "signerAddress" in over ? over.signerAddress : key.publicKey() };
  }) as SignTransaction & { calls: string[] };
  fn.calls = calls;
  return fn;
};
const mutate = (x: string, f: (t: xdr.Transaction) => void): string => {
  const env = xdr.TransactionEnvelope.fromXDR(x, "base64");
  f(env.v1().tx());
  return new Transaction(env, PASS).toXDR();
};
const rehash = (p: PreparedOrderTx, xdrText: string): PreparedOrderTx => ({ ...p, tx: { ...p.tx, xdr: xdrText, hash: (TransactionBuilder.fromXDR(xdrText, PASS) as Transaction).hash().toString("hex") } });

describe("signOrderTx", () => {
  it("asks the wallet to sign the very transaction it was shown, and returns it signed by the user", async () => {
    const p = await build();
    const w = walletOf(user);
    const signed = await signOrderTx(p, w, opts);
    expect(w.calls).toEqual([`${user.publicKey()}@${PASS}`]);
    const tx = TransactionBuilder.fromXDR(signed, PASS) as Transaction;
    expect(tx.hash().toString("hex")).toBe(p.tx.hash);
    expect(tx.signatures).toHaveLength(1);
    expect(user.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
  });
  it("works without the optional config checks (settleContract / solver)", async () => {
    expect(await signOrderTx(await build(), walletOf(user))).toMatch(/^AAAA/);
  });

  const refuses = (name: string, mk: () => Promise<PreparedOrderTx> | PreparedOrderTx, why: RegExp, o: { settleContract?: string; solver?: string; nowSec?: number } = opts) =>
    it(`refuses ${name} without ever asking the wallet`, async () => {
      const w = walletOf(user);
      await expect(signOrderTx(await mk(), w, o)).rejects.toThrow(why);
      expect(w.calls).toHaveLength(0);
    });
  refuses("a transaction whose hash is not the one reported", async () => ({ ...(await build()), tx: { ...(await build()).tx, hash: "00".repeat(32) } }), /hash the server reported/);
  refuses("a transaction sourced from another account", async () => build({ source: stranger.publicKey() }), /not sourced from the order's account/);
  refuses("a muxed source account", async () => { const p = await build(); return rehash(p, mutate(p.tx.xdr, (t) => t.sourceAccount(xdr.MuxedAccount.keyTypeMuxedEd25519(new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString("3"), ed25519: user.rawPublicKey() }))))); }, /not sourced/);
  refuses("a different settlement contract than the server's config", async () => build(), /different contract/, { ...opts, settleContract: StrKey.encodeContract(randomBytes(32)) });
  refuses("a different solver than the server's config", async () => build(), /different solver/, { ...opts, solver: stranger.publicKey() });
  refuses("the user named as the solver", async () => build({ callArgs: [orderVal(), new Address(user.publicKey()).toScVal(), i128(AMOUNT)] }), /user as the solver/, { settleContract: settle });
  refuses("an order that is not the one shown", async () => build({ callArgs: [orderVal({ ...base, minOut: 1n }), new Address(solver.publicKey()).toScVal(), i128(AMOUNT)] }), /not the order that was shown/);
  refuses("a different amount than the summary promised", async () => build({ amountOut: 96n * S }), /not the amount shown/);
  refuses("a payout below the signed minimum", async () => {
    const p = await build({ amountOut: 80n * S });
    return { ...p, summary: { ...p.summary, expected: "80.0000000" } };
  }, /less than the minimum/);
  refuses("a second operation", async () => build({ ops: [Operation.bumpSequence({ bumpTo: "5" })] }), /exactly one operation/);
  refuses("an extra authorisation entry", async () => build({ extra: (a) => [...a, a[0]!] }), /exactly two authorisation entries/);
  refuses("a user authorisation that covers more than the order's transfer", async () => build({ userTreeSubs: [] }), /does not cover exactly/);
  refuses("a user authorisation that moves a different amount", async () => build({ userTreeSubs: [call(tokenIn, "transfer", [new Address(user.publicKey()).toScVal(), new Address(settle).toScVal(), i128(101n * S)])] }), /does not cover exactly/);
  refuses("a user entry with address credentials instead of the transaction signature", async () => build({
    extra: ([u, s]) => [new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(user.publicKey()).toScAddress(), nonce: new xdr.Int64(1n), signatureExpirationLedger: 1, signature: xdr.ScVal.scvVec([]) })), rootInvocation: u!.rootInvocation() }), s!],
  }), /user's own signature plus the solver's|exactly the order/);
  refuses("a solver signature made by another key", async () => build({ solverKey: stranger }), /signature in the transaction is not valid/);
  refuses("a solver signature that expires at another ledger than reported", async () => { const p = await build(); return { ...p, tx: { ...p.tx, validUntilLedger: 9999 } }; }, /different ledger/);
  refuses("a transaction that has already expired", async () => build({ timeoutSec: 1 }), /already expired/, { ...opts, nowSec: Math.floor(Date.now() / 1000) + 3600 });
  refuses("a transaction that never expires", async () => { const p = await build(); return rehash(p, mutate(p.tx.xdr, (t) => t.cond(xdr.Preconditions.precondTime(new xdr.TimeBounds({ minTime: xdr.Uint64.fromString("0"), maxTime: xdr.Uint64.fromString("0") }))))); }, /never expires/);
  refuses("an expiry other than the one reported", async () => { const p = await build(); return { ...p, tx: { ...p.tx, maxTime: p.tx.maxTime + 100 } }; }, /different time/);
  refuses("a fee other than the one shown to the user", async () => build({ fee: "9000000" }), /fee is not the fee shown/);
  refuses("a garbage envelope", async () => { const p = await build(); return { ...p, tx: { ...p.tx, xdr: "AAAA" } }; }, /not a valid envelope/);

  it("refuses a wallet that answers with a different transaction, no signature, another account, or a signature that does not verify", async () => {
    const p = await build();
    const other = await build({ amountOut: 94n * S });
    await expect(signOrderTx(p, walletOf(user, { replace: other.tx.xdr }), opts)).rejects.toThrow(/different transaction/);
    await expect(signOrderTx(p, (async (x) => ({ signedTxXdr: x })) as SignTransaction, opts)).rejects.toThrow(/does not verify/);
    await expect(signOrderTx(p, walletOf(stranger), opts)).rejects.toThrow(/signed with|does not verify/);
    await expect(signOrderTx(p, walletOf(stranger, { signerAddress: undefined }), opts)).rejects.toThrow(/does not verify/);
    await expect(signOrderTx(p, (async () => { throw new Error("User declined access"); }) as SignTransaction, opts)).rejects.toThrow(/declined/);
  });
});

describe("Sluice client, tier 2", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  it("posts to prepare-tx and submit-tx and reads the existing order status", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const f = (async (u: string, init?: RequestInit) => {
      seen.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(u).endsWith("/v1/orders/prepare-tx")) return json({ solverWillFill: false, skipReasons: ["circuit_breaker"], explained: { code: "SOLVER_WILL_NOT_FILL", message: "paused", detail: "circuit_breaker" }, summary: { pay: "1.0000000" } });
      if (String(u).endsWith("/v1/orders/submit-tx")) return json({ hash: "ab".repeat(32), status: "PENDING" });
      if (String(u).endsWith("/v1/orders/config")) return json({ enabled: true, network: "testnet", networkPassphrase: PASS, settleContract: settle, solver: solver.publicKey(), signing: { credentials: "address-legacy", tiers: ["auth-entry", "tx"] }, limits: { maxOrderIn: "1.0000000", validForSec: { min: 120, max: 3600, default: 600 } } });
      return json({ hash: "ab".repeat(32), status: "SUCCESS", hedge: { status: "ABANDONED", attempts: 3, error: "x" } });
    }) as unknown as typeof fetch;
    const c = new Sluice("http://x", f);
    const r = await c.prepareOrderTx({ account: user.publicKey(), assetIn: "A:G", assetOut: "C:G", amount: "1" });
    expect(r.solverWillFill).toBe(false);
    const p = await build();
    expect(await c.submitOrderTx({ orderId: p.orderId, order: p.order, signedTx: "x" })).toEqual({ hash: "ab".repeat(32), status: "PENDING" });
    expect(seen.map((s) => s.url)).toEqual(["http://x/v1/orders/prepare-tx", "http://x/v1/orders/submit-tx"]);
    expect(seen[1]!.body).toEqual({ orderId: p.orderId, order: p.order, signedTx: "x" });
    const cfg = await c.ordersConfig();
    expect(cfg.enabled && cfg.signing.tiers).toEqual(["auth-entry", "tx"]);
    expect((await c.order("ab".repeat(32))).hedge).toMatchObject({ status: "ABANDONED" });
  });
});

