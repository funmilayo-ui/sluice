import { createHash } from "node:crypto";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { encodeOrder, type Order } from "@sluice/solver";

/** Why an entry cannot be used, as a stable code plus a sentence. */
export interface EntryProblem {
  code: "UNSUPPORTED_CREDENTIALS" | "WRONG_SIGNER" | "ENTRY_MISMATCH" | "BAD_SIGNATURE";
  message: string;
}

const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest();

/** The only credentials this version issues and accepts: `SOROBAN_CREDENTIALS_ADDRESS` (the legacy, widest-supported kind). */
export function isAddressEntry(e: xdr.SorobanAuthorizationEntry): boolean {
  return e.credentials().switch().name === "sorobanCredentialsAddress";
}

/** The HashIdPreimage a wallet signs (sha256 of its XDR) to authorise `entry` until `validUntilLedger`. */
export function buildPreimage(entry: xdr.SorobanAuthorizationEntry, validUntilLedger: number, passphrase: string): xdr.HashIdPreimage {
  const a = entry.credentials().address();
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: sha256(Buffer.from(passphrase)),
      nonce: a.nonce(),
      invocation: entry.rootInvocation(),
      signatureExpirationLedger: validUntilLedger,
    }),
  );
}

/** A copy of an address-credential entry with its expiration ledger set. The signature is left as it is. */
export function withExpiration(entry: xdr.SorobanAuthorizationEntry, validUntilLedger: number): xdr.SorobanAuthorizationEntry {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  clone.credentials().address().signatureExpirationLedger(validUntilLedger);
  return clone;
}

const call = (contract: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args }),
    ),
    subInvocations: subs,
  });

/**
 * The invocation tree the user must be asked to authorise for `order`: fill(order), under it an optional
 * `token_out.trust(user)` and the exact input transfer `token_in.transfer(user, settle, amount_in)`.
 * Anything else in a tree (another call, other amounts, another recipient) is refused.
 */
export function expectedTrees(order: Order, settleContract: string): xdr.SorobanAuthorizedInvocation[] {
  const transfer = call(order.tokenIn, "transfer", [
    new Address(order.user).toScVal(),
    new Address(settleContract).toScVal(),
    nativeToScVal(order.amountIn, { type: "i128" }),
  ]);
  const trust = call(order.tokenOut, "trust", [new Address(order.user).toScVal()]);
  const root = (subs: xdr.SorobanAuthorizedInvocation[]) => call(settleContract, "fill", [encodeOrder(order)], subs);
  // `trust` only asks for the user's authorisation when it actually creates a trustline, so a tree without it is
  // the right shape for an order whose trustline appeared since it was prepared.
  return order.createTrustline ? [root([trust, transfer]), root([transfer])] : [root([transfer])];
}

export function reviewEntry(entry: xdr.SorobanAuthorizationEntry, order: Order, settleContract: string): EntryProblem | null {
  if (!isAddressEntry(entry)) {
    return { code: "UNSUPPORTED_CREDENTIALS", message: "The authorisation entry must use address credentials (SOROBAN_CREDENTIALS_ADDRESS)." };
  }
  if (Address.fromScAddress(entry.credentials().address().address()).toString() !== order.user) {
    return { code: "WRONG_SIGNER", message: "The authorisation entry is for a different account than the order's." };
  }
  const have = entry.rootInvocation().toXDR("base64");
  if (!expectedTrees(order, settleContract).some((t) => t.toXDR("base64") === have)) {
    return { code: "ENTRY_MISMATCH", message: "The authorisation entry does not authorise exactly this order: the contract, the order or the input transfer differ." };
  }
  return null;
}

/** The (public key, signature) pairs inside an entry's signature, or null when it is not the Vec[Map{public_key, signature}] account shape. */
export function readSignatures(entry: xdr.SorobanAuthorizationEntry): { publicKey: Buffer; signature: Buffer }[] | null {
  const sig = entry.credentials().address().signature();
  if (sig.switch().name !== "scvVec") return null;
  const out: { publicKey: Buffer; signature: Buffer }[] = [];
  for (const item of sig.vec() ?? []) {
    if (item.switch().name !== "scvMap") return null;
    let publicKey: Buffer | undefined;
    let signature: Buffer | undefined;
    for (const kv of item.map() ?? []) {
      if (kv.key().switch().name !== "scvSymbol") return null;
      const name = kv.key().sym().toString();
      if (kv.val().switch().name !== "scvBytes") return null;
      if (name === "public_key") publicKey = Buffer.from(kv.val().bytes());
      else if (name === "signature") signature = Buffer.from(kv.val().bytes());
    }
    if (!publicKey || !signature) return null;
    out.push({ publicKey, signature });
  }
  return out;
}

/** The entry must carry exactly one ed25519 signature, by the order's user, over sha256 of the preimage rebuilt from the entry itself. */
export function checkSignature(entry: xdr.SorobanAuthorizationEntry, order: Order, passphrase: string): EntryProblem | null {
  const sigs = readSignatures(entry);
  const bad = (message: string): EntryProblem => ({ code: "BAD_SIGNATURE", message });
  if (!sigs || sigs.length !== 1) return bad("The authorisation entry is not signed (expected one account signature).");
  const s = sigs[0]!;
  const user = Keypair.fromPublicKey(order.user);
  if (!user.rawPublicKey().equals(s.publicKey)) return { code: "WRONG_SIGNER", message: "The entry was signed by a different key than the order's account." };
  const payload = sha256(buildPreimage(entry, entry.credentials().address().signatureExpirationLedger(), passphrase).toXDR());
  if (s.signature.length !== 64 || !user.verify(payload, s.signature)) return bad("The signature does not verify for this order on this network.");
  return null;
}
