import {
  createAssetList,
  fetchBlendPool,
  fetchBlendPositions,
  fetchStablecoinSignals,
  getTxStatus,
  parseAsset,
  parseHorizonAccount,
  prepare as rpcPrepare,
  scoreStablecoin,
  submitTx,
  type AccountInfo,
  type AssetListResult,
  type BlendPool,
  type BlendPosition,
  type HorizonAccount,
  type SubmitResult,
  type TxStatus,
} from "@sluice/core";

export const ACCOUNT_NOT_FOUND = "account not found on this network";

/** Issuer-level facts about a Classic asset, from Horizon. */
export interface AssetInfo {
  authRequired: boolean;
  clawback: boolean;
  /** Accounts with an authorised trustline. */
  holders: number;
}

/** Everything the API reads from or sends to the network, injectable so tests never leave the process. */
export interface Deps {
  /** Account sequence, the Classic assets it already has a trustline for, and (when known) its balances. */
  getAccount(account: string): Promise<Pick<AccountInfo, "sequence" | "assets"> & Partial<Pick<AccountInfo, "balances">>>;
  prepare(xdr: string): Promise<{ xdr: string; minResourceFee: string }>;
  stablecoin(asset: string): Promise<ReturnType<typeof scoreStablecoin> & { signals: Awaited<ReturnType<typeof fetchStablecoinSignals>> }>;
  /** Relay an already-signed transaction. */
  submit(signedXdr: string): Promise<SubmitResult>;
  getTx(hash: string): Promise<TxStatus>;
  assets(): Promise<AssetListResult>;
  /** null when the asset does not exist on this network. */
  assetInfo(asset: string): Promise<AssetInfo | null>;
  blendPool(pool: string): Promise<BlendPool>;
  blendPositions(pool: string, account: string): Promise<BlendPosition[]>;
}

export function defaultDeps(env: Record<string, string | undefined> = process.env): Deps {
  const horizon = env.HORIZON_URL ?? "https://horizon.stellar.org";
  const rpcUrl = env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
  const assetList = createAssetList();
  return {
    async getAccount(account) {
      const r = await fetch(`${horizon}/accounts/${account}`);
      if (r.status === 404) throw new Error(ACCOUNT_NOT_FOUND);
      if (!r.ok) throw new Error(`horizon accounts ${r.status}`);
      return parseHorizonAccount((await r.json()) as HorizonAccount);
    },
    prepare: (xdr) => rpcPrepare(rpcUrl, xdr),
    async stablecoin(asset) {
      const signals = await fetchStablecoinSignals(asset, { horizon });
      return { ...scoreStablecoin(signals), signals };
    },
    submit: (signedXdr) => submitTx(rpcUrl, signedXdr),
    getTx: (hash) => getTxStatus(rpcUrl, hash),
    assets: () => assetList.get(),
    async assetInfo(asset) {
      const a = parseAsset(asset);
      const r = await fetch(new URL(`/assets?asset_code=${a.getCode()}&asset_issuer=${a.getIssuer()}&limit=1`, horizon));
      if (!r.ok) throw new Error(`horizon assets ${r.status}`);
      type Rec = { flags?: { auth_required?: boolean; auth_clawback_enabled?: boolean }; accounts?: { authorized?: number } };
      const rec = ((await r.json()) as { _embedded?: { records?: Rec[] } })._embedded?.records?.[0];
      if (!rec) return null;
      return { authRequired: rec.flags?.auth_required === true, clawback: rec.flags?.auth_clawback_enabled === true, holders: rec.accounts?.authorized ?? 0 };
    },
    blendPool: (pool) => fetchBlendPool(rpcUrl, pool),
    blendPositions: (pool, account) => fetchBlendPositions(rpcUrl, pool, account),
  };
}
