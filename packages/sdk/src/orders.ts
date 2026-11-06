/**
 * Settlement orders (testnet prototype): response types and the wallet-signing helper.
 * The endpoints are documented in the README ("Settlement orders").
 */
import type { Explained } from "./index.js";

/** What `GET /v1/orders/config` says. When `enabled` is false only `code` and `reason` are present. */
export type OrdersConfig =
  | {
      enabled: true;
      /** "testnet", "futurenet" or "custom". Never the public network. */
      network: string;
      networkPassphrase: string;
      settleContract: string;
      /** Public key of the solver that will fill orders. */
      solver: string;
      /**
       * `credentials` is the kind of authorisation entry the auth-entry tier issues. `tiers` (additive; absent on older servers,
       * which offer only "auth-entry") lists how a wallet can authorise an order: "auth-entry" needs `signAuthEntry`,
       * "tx" needs only `signTransaction` (the user then sends the transaction and pays its fee).
       */
      signing: { credentials: "address-legacy" | "address-v2"; tiers?: SigningTier[] };
      limits: { maxOrderIn: string; validForSec: { min: number; max: number; default: number } };
    }
  | { enabled: false; code: string; reason: string };

export type SigningTier = "auth-entry" | "tx";

/** The order as the user is asked to sign it. `tokenIn` / `tokenOut` are the Stellar Asset Contract ids the contract sees. */
export interface OrderFields {
  user: string;
  assetIn: string;
  tokenIn: string;
  amountIn: string;
  assetOut: string;
  tokenOut: string;
  minOut: string;
  /** Ledger close time, unix seconds. */
  deadline: number;
  createTrustline: boolean;
}

export interface PreparedOrder {
  solverWillFill: true;
  /** Opaque; send it back unchanged to `submitOrder`. */
  orderId: string;
  order: OrderFields;
  summary: {
    /** What the user gives up. */
    pay: string;
    /** The signed floor: the contract refuses the fill if the user's balance would grow by less. */
    receiveAtLeast: string;
    /** What the solver will pay if filled now. Always at least `receiveAtLeast`. */
    expected: string;
  };
  authEntry: {
    /** Unsigned SorobanAuthorizationEntry, base64 XDR. */
    xdr: string;
    /** base64 HashIdPreimage: what the wallet signs (it hashes with sha256 and signs the hash). */
    preimage: string;
    validUntilLedger: number;
    credentials: "address-legacy" | "address-v2";
    networkPassphrase: string;
  };
}

/** The solver would not fill this order now. Nothing was prepared and there is nothing to sign. */
export interface DeclinedOrder {
  solverWillFill: false;
  skipReasons: string[];
  explained: Explained;
  summary: { pay: string; /** What the Classic order book alone would pay, before the solver's costs. */ classicQuote?: string; /** The most the solver could pay at this size. */ solverMaxPay?: string };
}

export type PrepareOrderResponse = PreparedOrder | DeclinedOrder;

export interface SubmitOrderResponse { hash: string; status: "PENDING" | "DUPLICATE" }

/**
 * Tier 2, for wallets that can sign a transaction but not an authorisation entry: a transaction sourced from the user's own
 * account (the user pays its fee) that calls the settlement contract once, with the solver's half of the authorisation already
 * signed. The user's authorisation is the transaction signature itself.
 */
export interface PreparedOrderTx {
  solverWillFill: true;
  /** Opaque; send it back unchanged to `submitOrderTx`. */
  orderId: string;
  order: OrderFields;
  summary: {
    pay: string;
    receiveAtLeast: string;
    expected: string;
    /** The XLM fee the user pays for this transaction. `signOrderTx` checks it against the transaction itself. */
    networkFee: string;
  };
  tx: {
    /** Unsigned (by the user) TransactionEnvelope, base64. */
    xdr: string;
    /** The transaction hash. A signature does not change it. */
    hash: string;
    source: string;
    /** The ledger after which the solver's signature in the transaction stops working. */
    validUntilLedger: number;
    /** Unix seconds after which the network refuses the transaction. */
    maxTime: number;
    networkPassphrase: string;
  };
}
export type PrepareOrderTxResponse = PreparedOrderTx | DeclinedOrder;

/**
 * The wallet's `signTransaction`, shaped like SEP-43 / Stellar Wallets Kit: it receives the transaction XDR and returns it signed.
 */
export type SignTransaction = (
  txXdr: string,
  opts: { networkPassphrase: string; address: string },
) => Promise<{ signedTxXdr: string; signerAddress?: string }>;

/**
 * The solver's hedge of a fill (the Classic-DEX trade that gives it back what it paid out). It never changes the fill's own status.
 * PENDING (fill not landed) · HEDGING · HEDGED · RETRYING (a hedge failed; bounded automatic retries are scheduled) ·
 * UNHEDGED (a hedge failed and nothing is retrying it) · ABANDONED (retries spent; an operator must act) ·
 * NOT_NEEDED (the fill failed, so the solver took nothing) · UNKNOWN (the solver could not be asked).
 */
export type HedgeStatus =
  | { status: "PENDING" | "HEDGING" }
  | { status: "HEDGED"; hash?: string; received?: string }
  | { status: "RETRYING"; attempts: number; reason?: string; error?: string; /** Unix seconds. */ nextRetryAt?: number }
  | { status: "UNHEDGED" | "ABANDONED"; /** Absent on a server that predates recovery. */ attempts?: number; reason?: string; error: string; hash?: string }
  | { status: "NOT_NEEDED"; reason: string }
  | { status: "UNKNOWN"; reason: string };

export interface OrderStatusResponse {
  hash: string;
  status: "NOT_FOUND" | "SUCCESS" | "FAILED";
  ledger?: number;
  createdAt?: number;
  /** On SUCCESS: what the fill actually delivered to the user, read from the transaction's return value. */
  received?: string;
  explained?: Explained;
  /** The solver's hedge of this fill, when the solver knows it. Absent for a transaction the solver has no record of. */
  hedge?: HedgeStatus;
}

/**
 * The wallet's `signAuthEntry`, shaped like SEP-43 / Stellar Wallets Kit: it receives the base64
 * HashIdPreimage, signs sha256 of its bytes, and returns the 64-byte signature as base64.
 */
export type SignAuthEntry = (
  preimageBase64: string,
  opts: { networkPassphrase: string; address: string },
) => Promise<{ signedAuthEntry: string | Uint8Array; signerAddress?: string }>;

const SCALE = 10_000_000n;
function parseStroops(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(s);
  if (!m) throw new Error(`invalid amount: ${s}`);
  return BigInt(m[1]!) * SCALE + BigInt((m[2] ?? "").padEnd(7, "0") || "0");
}

export interface SignOrderOptions {
  /** From `GET /v1/orders/config`. When given, the entry must call exactly this contract. Recommended. */
  settleContract?: string;
}

/**
 * Turn a prepared order into the signed authorisation entry that `submitOrder` takes.
 *
 * Before the wallet is asked anything, the entry is checked against the order the user was shown: it must call
 * `fill` with exactly `prepared.order`, and its only sub-calls may be the user's `trust` for the output asset
 * and the exact input transfer to the settlement contract. A server that showed one order and wrapped another
 * in the signature request is caught here, not by the user reading a hash. The wallet's signature is then
 * checked against sha256(preimage) with the order's account key before anything is returned.
 *
 * Uses `@stellar/stellar-sdk` 14 (loaded on first use). That version's `authorizeEntry` only handles
 * `SOROBAN_CREDENTIALS_ADDRESS`, which is what the server issues (`credentials: "address-legacy"`); anything
 * else is refused here instead of being silently returned unsigned.
 */
export async function signOrder(prepared: PreparedOrder, signAuthEntry: SignAuthEntry, opts: SignOrderOptions = {}): Promise<string> {
  const { xdr, authorizeEntry, Address, Keypair, hash, nativeToScVal } = await import("@stellar/stellar-sdk");
  const { order, authEntry } = prepared;
  // Browsers have no global `Buffer`. The SDK's own XDR output is a Buffer (its bundled polyfill in a browser), so
  // borrow that class instead of assuming Node's.
  const Buf: typeof Buffer = (globalThis as { Buffer?: typeof Buffer }).Buffer ?? (xdr.ScVal.scvVoid().toXDR().constructor as typeof Buffer);
  if (authEntry.credentials !== "address-legacy") throw new Error(`unsupported credentials "${authEntry.credentials}": this SDK signs address-legacy entries only`);

  const entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntry.xdr, "base64");
  if (entry.credentials().switch().name !== "sorobanCredentialsAddress") throw new Error("the authorisation entry does not use address credentials");
  if (Address.fromScAddress(entry.credentials().address().address()).toString() !== order.user) throw new Error("the authorisation entry is for a different account than the order's");

  // --- Review: the entry must authorise exactly the order shown, and nothing else.
  const rootFn = entry.rootInvocation().function();
  if (rootFn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("the authorisation entry does not call a contract function");
  const settle = Address.fromScAddress(rootFn.contractFn().contractAddress()).toString();
  if (opts.settleContract && settle !== opts.settleContract) throw new Error("the authorisation entry calls a different contract than the settlement contract");
  const { userTrees } = expectedFor({ xdr, Address, nativeToScVal }, order, settle);
  if (!userTrees.map((t) => t.toXDR("base64")).includes(entry.rootInvocation().toXDR("base64"))) throw new Error("the authorisation entry does not authorise exactly the order that was shown; refusing to ask the wallet to sign it");

  // --- Sign: authorizeEntry builds the preimage itself; it must equal the one the server sent and the wallet is shown.
  const user = Keypair.fromPublicKey(order.user);
  let payload: Buffer | undefined;
  const signed = await authorizeEntry(
    entry,
    async (preimage) => {
      const b64 = preimage.toXDR("base64");
      if (b64 !== authEntry.preimage) throw new Error("the preimage does not match the authorisation entry");
      payload = hash(Buf.from(preimage.toXDR()));
      const r = await signAuthEntry(b64, { networkPassphrase: authEntry.networkPassphrase, address: order.user });
      if (r.signerAddress !== undefined && r.signerAddress !== order.user) throw new Error(`the wallet signed with ${r.signerAddress}, not the order's account ${order.user}`);
      const signature = typeof r.signedAuthEntry === "string" ? Buf.from(r.signedAuthEntry, "base64") : Buf.from(r.signedAuthEntry);
      if (signature.length !== 64) throw new Error("the wallet returned a signature that is not 64 bytes");
      if (!user.verify(payload, signature)) throw new Error("the wallet's signature does not verify against the order's preimage");
      return { signature, publicKey: order.user };
    },
    authEntry.validUntilLedger,
    authEntry.networkPassphrase,
  );

  // authorizeEntry hands back any non-address entry unsigned without saying so; check the result really carries our signature.
  const sigs = signed.credentials().address().signature();
  const pair = sigs.switch().name === "scvVec" ? sigs.vec()?.[0] : undefined;
  const sigBytes = pair?.switch().name === "scvMap" ? pair.map()?.find((m) => m.key().sym().toString() === "signature")?.val().bytes() : undefined;
  if (!payload || !sigBytes || !user.verify(payload, Buf.from(sigBytes))) throw new Error("the signed entry does not carry a valid signature");
  if (signed.credentials().address().signatureExpirationLedger() !== authEntry.validUntilLedger) throw new Error("the signed entry has an unexpected expiration ledger");
  return signed.toXDR("base64");
}


type Sdk = Pick<typeof import("@stellar/stellar-sdk"), "xdr" | "Address" | "nativeToScVal">;

/** What the contract call and its authorisation trees must look like for `order`, built the way the server and the contract build them. */
function expectedFor(sdk: Sdk, order: OrderFields, settle: string, solver?: string, amountOut?: bigint) {
  const { xdr, Address, nativeToScVal } = sdk;
  const sym = (s: string) => xdr.ScVal.scvSymbol(s);
  const kv = (k: string, v: ReturnType<typeof sym>) => new xdr.ScMapEntry({ key: sym(k), val: v });
  const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
  const amountIn = parseStroops(order.amountIn);
  const orderVal = xdr.ScVal.scvMap([
    kv("amount_in", i128(amountIn)),
    kv("create_trustline", xdr.ScVal.scvBool(order.createTrustline)),
    kv("deadline", nativeToScVal(BigInt(order.deadline), { type: "u64" })),
    kv("min_out", i128(parseStroops(order.minOut))),
    kv("token_in", new Address(order.tokenIn).toScVal()),
    kv("token_out", new Address(order.tokenOut).toScVal()),
    kv("user", new Address(order.user).toScVal()),
  ]);
  const call = (contract: string, fn: string, args: ReturnType<typeof sym>[], subs: InstanceType<typeof xdr.SorobanAuthorizedInvocation>[] = []) =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args })),
      subInvocations: subs,
    });
  const transfer = call(order.tokenIn, "transfer", [new Address(order.user).toScVal(), new Address(settle).toScVal(), i128(amountIn)]);
  const trust = call(order.tokenOut, "trust", [new Address(order.user).toScVal()]);
  const root = (subs: (typeof transfer)[]) => call(settle, "fill", [orderVal], subs);
  const userTrees = order.createTrustline ? [root([trust, transfer]), root([transfer])] : [root([transfer])];
  const solverTree =
    solver !== undefined && amountOut !== undefined
      ? call(settle, "fill", [orderVal, new Address(solver).toScVal(), i128(amountOut)], [call(order.tokenOut, "transfer", [new Address(solver).toScVal(), new Address(order.user).toScVal(), i128(amountOut)])])
      : undefined;
  return { orderVal, userTrees, solverTree, i128 };
}

export interface SignOrderTxOptions {
  /** From `GET /v1/orders/config`. When given, the transaction must call exactly this contract. Recommended. */
  settleContract?: string;
  /** From `GET /v1/orders/config`. When given, the transaction must name exactly this solver. Recommended. */
  solver?: string;
  /** Unix seconds, for the expiry check. Default: now. */
  nowSec?: number;
}

/**
 * Turn a prepared transaction into the signed transaction that `submitOrderTx` takes (tier 2: the wallet signs a transaction).
 *
 * Before the wallet is asked anything, the transaction is checked against the order the user was shown: sourced from the user's own
 * account, one operation, `fill` on the settlement contract with exactly `prepared.order`, the solver and the amount the summary promised;
 * the user's authorisation is their own signature (source-account credentials over exactly the order's input transfer and trustline);
 * the solver's authorisation is for exactly this fill and carries a valid signature; it has not expired; and the fee equals the
 * `networkFee` the user was shown. After the wallet answers, it must be the same transaction (same hash) with the user's valid signature.
 */
export async function signOrderTx(prepared: PreparedOrderTx, signTransaction: SignTransaction, opts: SignOrderTxOptions = {}): Promise<string> {
  const sdk = await import("@stellar/stellar-sdk");
  const { xdr, Address, Keypair, TransactionBuilder, Transaction, hash: sha256, scValToNative } = sdk;
  const { order, tx: shown } = prepared;
  const Buf: typeof Buffer = (globalThis as { Buffer?: typeof Buffer }).Buffer ?? (xdr.ScVal.scvVoid().toXDR().constructor as typeof Buffer);
  const refuse = (why: string): never => {
    throw new Error(`${why}; refusing to ask the wallet to sign it`);
  };

  const parse = (text: string) => {
    let t: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      t = TransactionBuilder.fromXDR(text, shown.networkPassphrase);
    } catch {
      return refuse("the transaction is not a valid envelope");
    }
    if (!(t instanceof Transaction)) return refuse("the transaction is a fee bump");
    return t;
  };
  const tx = parse(shown.xdr);
  if (tx.hash().toString("hex") !== shown.hash) refuse("the transaction does not match the hash the server reported");
  const body = tx.toEnvelope().v1().tx();
  if (body.sourceAccount().switch().name !== "keyTypeEd25519" || tx.source !== order.user || shown.source !== order.user) refuse("the transaction is not sourced from the order's account");
  if (body.operations().length !== 1) refuse("the transaction does not contain exactly one operation");
  const op = body.operations()[0]!;
  if (op.sourceAccount() || op.body().switch().name !== "invokeHostFunction") refuse("the transaction's operation is not a plain contract call");
  const hostOp = op.body().invokeHostFunctionOp();
  const fn = hostOp.hostFunction();
  if (fn.switch().name !== "hostFunctionTypeInvokeContract") refuse("the transaction's operation is not a contract call");
  const inv = fn.invokeContract();
  const settle = Address.fromScAddress(inv.contractAddress()).toString();
  if (opts.settleContract && settle !== opts.settleContract) refuse("the transaction calls a different contract than the settlement contract");
  if (inv.functionName().toString() !== "fill") refuse("the transaction does not call fill");
  const args = inv.args();
  if (args.length !== 3) refuse("fill was called with the wrong arguments");
  const solver = Address.fromScVal(args[1]!).toString();
  if (opts.solver && solver !== opts.solver) refuse("the transaction names a different solver");
  if (solver === order.user) refuse("the transaction names the user as the solver");
  if (args[2]!.switch().name !== "scvI128") refuse("amount_out is not an integer amount");
  const amountOut = scValToNative(args[2]!) as bigint;
  if (amountOut !== parseStroops(prepared.summary.expected)) refuse("the amount the transaction pays is not the amount shown");
  if (amountOut < parseStroops(order.minOut)) refuse("the transaction pays less than the minimum shown");

  const exp = expectedFor(sdk, order, settle, solver, amountOut);
  if (args[0]!.toXDR("base64") !== exp.orderVal.toXDR("base64")) refuse("the order inside the transaction is not the order that was shown");

  const auth = hostOp.auth();
  if (auth.length !== 2) refuse("the transaction must carry exactly two authorisation entries");
  const userEntry = auth.find((e) => e.credentials().switch().name === "sorobanCredentialsSourceAccount");
  const solverEntry = auth.find((e) => e.credentials().switch().name === "sorobanCredentialsAddress");
  if (!userEntry || !solverEntry) return refuse("the transaction's authorisation is not the user's own signature plus the solver's");
  if (!exp.userTrees.map((t) => t.toXDR("base64")).includes(userEntry.rootInvocation().toXDR("base64"))) refuse("the user's authorisation does not cover exactly the order that was shown");
  if (Address.fromScAddress(solverEntry.credentials().address().address()).toString() !== solver) refuse("the solver's authorisation is for a different account");
  if (!exp.solverTree || solverEntry.rootInvocation().toXDR("base64") !== exp.solverTree.toXDR("base64")) refuse("the solver's authorisation is not for exactly this fill");
  const sc = solverEntry.credentials().address();
  const sigVec = sc.signature();
  const pair = sigVec.switch().name === "scvVec" ? sigVec.vec()?.[0] : undefined;
  const sigBytes = pair?.switch().name === "scvMap" ? pair.map()?.find((m) => m.key().sym().toString() === "signature")?.val().bytes() : undefined;
  const solverPre = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({ networkId: sha256(Buf.from(shown.networkPassphrase)), nonce: sc.nonce(), invocation: solverEntry.rootInvocation(), signatureExpirationLedger: sc.signatureExpirationLedger() }),
  );
  if (!sigBytes || !Keypair.fromPublicKey(solver).verify(sha256(Buf.from(solverPre.toXDR())), Buf.from(sigBytes))) refuse("the solver's signature in the transaction is not valid");
  if (sc.signatureExpirationLedger() !== shown.validUntilLedger) refuse("the solver's signature expires at a different ledger than the one reported");

  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (maxTime === 0) refuse("the transaction never expires");
  if (maxTime <= nowSec) refuse("the transaction has already expired");
  if (maxTime !== shown.maxTime) refuse("the transaction expires at a different time than the one reported");
  if (formatStroops(BigInt(tx.fee)) !== prepared.summary.networkFee) refuse("the transaction's fee is not the fee shown");

  // --- Sign. The wallet sees the transaction and nothing else.
  const r = await signTransaction(shown.xdr, { networkPassphrase: shown.networkPassphrase, address: order.user });
  if (r.signerAddress !== undefined && r.signerAddress !== order.user) throw new Error(`the wallet signed with ${r.signerAddress}, not the order's account ${order.user}`);
  const signed = parse(r.signedTxXdr);
  if (signed.hash().toString("hex") !== shown.hash) throw new Error("the wallet returned a different transaction than the one it was given");
  const user = Keypair.fromPublicKey(order.user);
  if (!signed.signatures.some((s) => s.hint().equals(user.signatureHint()) && user.verify(signed.hash(), s.signature()))) throw new Error("the wallet's signature on the transaction does not verify for the order's account");
  return signed.toXDR();
}

function formatStroops(v: bigint): string {
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}
