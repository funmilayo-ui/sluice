import { Asset, Networks } from "@stellar/stellar-sdk";
import type { AssetId } from "./types.js";

export function parseAsset(id: AssetId): Asset {
  if (id === "native") return Asset.native();
  const [code, issuer] = id.split(":");
  if (!code || !issuer) throw new Error(`invalid asset id: ${id}`);
  return new Asset(code, issuer);
}

export function toAssetId(a: Asset): AssetId {
  return a.isNative() ? "native" : `${a.getCode()}:${a.getIssuer()}`;
}

/** Stellar Asset Contract id (C...) for a Classic asset. */
export function sacId(id: AssetId, passphrase: string = Networks.PUBLIC): string {
  return parseAsset(id).contractId(passphrase);
}
