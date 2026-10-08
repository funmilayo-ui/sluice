import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Account, BASE_FEE, Contract, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { sacId } from "../assets.js";
import type { AssetId } from "../types.js";
import type { VaultTarget } from "../zap.js";

/** Blend request types (from the Blend pool contract). Supply earns interest and is not collateral. */
export const BLEND_REQUEST = { Supply: 0, Withdraw: 1, SupplyCollateral: 2, WithdrawCollateral: 3 } as const;

/** Blend v2 "Fixed" pool on mainnet (blend-capital/blend-utils mainnet.contracts.json). Interface read on-chain 2026-10-08. */
export const BLEND_FIXED_V2_POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";

export interface DepositOpts {
  source: string;
  sequence: string;
  passphrase?: string;
  fee?: string;
  /** How long the transaction stays valid, seconds. Default 60. */
  timeoutSec?: number;
}

/**
 * Unsigned Blend `submit(from, spender, to, [Request])` with the user as all three parties: on Supply funds go
 * user -> pool and the bTokens stay with the user, on Withdraw the underlying comes back to the user.
 * Run `prepare()` before signing. Only Blend is implemented: DeFindex vault ABIs were not verified (its API
 * needs a key), so asking for it throws.
 */
function buildVaultRequest(target: VaultTarget, asset: AssetId, amount: bigint, o: DepositOpts, request: "Supply" | "Withdraw"): string {
  if (target.protocol !== "blend") {
    throw new Error(`${request.toLowerCase()} builder not implemented for protocol "${target.protocol}"`);
  }
  if (amount <= 0n) throw new Error("amount must be positive");
  const pass = o.passphrase ?? Networks.PUBLIC;
  const user = new Address(o.source).toScVal();
  // Soroban structs are maps with keys sorted alphabetically: address, amount, request_type.
  const req = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: nativeToScVal("address", { type: "symbol" }), val: new Address(sacId(asset, pass)).toScVal() }),
    new xdr.ScMapEntry({ key: nativeToScVal("amount", { type: "symbol" }), val: nativeToScVal(amount, { type: "i128" }) }),
    new xdr.ScMapEntry({ key: nativeToScVal("request_type", { type: "symbol" }), val: nativeToScVal(BLEND_REQUEST[request], { type: "u32" }) }),
  ]);
  return new TransactionBuilder(new Account(o.source, o.sequence), { fee: o.fee ?? BASE_FEE, networkPassphrase: pass })
    .addOperation(new Contract(target.vault).call("submit", user, user, user, xdr.ScVal.scvVec([req])))
    .setTimeout(o.timeoutSec ?? 60)
    .build()
    .toXDR();
}

/** Unsigned Blend deposit (Supply: earns interest, is not collateral). */
export function buildVaultDeposit(target: VaultTarget, asset: AssetId, amount: bigint, o: DepositOpts): string {
  return buildVaultRequest(target, asset, amount, o, "Supply");
}

/**
 * Unsigned Blend withdrawal of supplied (non-collateral) funds. `amount` is in the underlying asset. The pool
 * caps it at the position (blend-contracts-v2 `apply_withdraw`: more bTokens than held burns exactly what is
 * held), so asking for more than the balance withdraws everything.
 */
export function buildVaultWithdraw(target: VaultTarget, asset: AssetId, amount: bigint, o: DepositOpts): string {
  return buildVaultRequest(target, asset, amount, o, "Withdraw");
}
