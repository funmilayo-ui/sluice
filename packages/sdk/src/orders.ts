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
      signing: { credentials: "address-legacy" | "address-v2" };
      limits: { maxOrderIn: string; validForSec: { min: number; max: number; default: number } };
    }
  | { enabled: false; code: string; reason: string };

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

export type HedgeStatus =
  | { status: "PENDING" | "HEDGING" }
  | { status: "HEDGED"; hash: string; received?: string }
  | { status: "UNHEDGED"; error: string }
  | { status: "NOT_NEEDED"; reason: string };

export interface OrderStatusResponse {
  hash: string;
  status: "NOT_FOUND" | "SUCCESS" | "FAILED";
  ledger?: number;
  createdAt?: number;
  /** On SUCCESS: what the fill actually delivered to the user, read from the transaction's return value. */
  received?: string;
  explained?: Explained;
  /** The solver's hedge, if this server filled the order and still remembers it (in memory only). */
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
  const rootFn = entry.rootInvocation().function();
  if (rootFn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("the authorisation entry does not call a contract function");
  const settle = Address.fromScAddress(rootFn.contractFn().contractAddress()).toString();
  if (opts.settleContract && settle !== opts.settleContract) throw new Error("the authorisation entry calls a different contract than the settlement contract");
  const transfer = call(order.tokenIn, "transfer", [new Address(order.user).toScVal(), new Address(settle).toScVal(), i128(amountIn)]);
  const trust = call(order.tokenOut, "trust", [new Address(order.user).toScVal()]);
  const root = (subs: (typeof transfer)[]) => call(settle, "fill", [orderVal], subs);
  const allowed = (order.createTrustline ? [root([trust, transfer]), root([transfer])] : [root([transfer])]).map((t) => t.toXDR("base64"));
  if (!allowed.includes(entry.rootInvocation().toXDR("base64"))) throw new Error("the authorisation entry does not authorise exactly the order that was shown; refusing to ask the wallet to sign it");

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
