import { sacId } from "./assets.js";
import type { AssetId } from "./types.js";

export interface ListedAsset {
  id: AssetId;
  code: string;
  /** Absent for XLM. */
  issuer?: string;
  /** Stellar Asset Contract id (C...), derived from the asset, not taken from a list. */
  contract: string;
  name?: string;
  domain?: string;
  /** https icon URL as published by the list. */
  icon?: string;
  /** Which lists carry this asset. */
  lists: string[];
}

export interface AssetListSource { name: string; url: string }

/** Public SEP-42 asset lists. All three answered with code, issuer and icon fields when checked on 2026-10-08. */
export const DEFAULT_ASSET_LISTS: AssetListSource[] = [
  { name: "StellarExpert top 50", url: "https://api.stellar.expert/explorer/public/asset-list/top50" },
  { name: "Soroswap", url: "https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json" },
  { name: "LOBSTR curated", url: "https://lobstr.co/api/v1/sep/assets/curated.json" },
];

const CODE = /^[A-Za-z0-9]{1,12}$/;
const ISSUER = /^G[A-Z2-7]{55}$/;

interface RawEntry { code?: unknown; issuer?: unknown; contract?: unknown; name?: unknown; domain?: unknown; icon?: unknown }

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const httpsUrl = (v: unknown): string | undefined => {
  const s = str(v, 500);
  if (!s) return undefined;
  try {
    return new URL(s).protocol === "https:" ? s : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Merge asset lists into one: XLM first, then assets carried by the most lists, and within that by how high
 * a list places them (lists put their most used assets first), so the picker opens on what people trade. Entries are
 * untrusted third-party data: anything that is not a well-formed Classic asset is dropped, strings are length
 * capped, and icons must be https. Soroban-only tokens (a contract with no issuer) are skipped because the
 * router trades Classic assets and their asset contracts.
 */
export function mergeAssetLists(lists: { name: string; assets: unknown }[], passphrase?: string): ListedAsset[] {
  const xlm = sacId("native", passphrase);
  const byId = new Map<AssetId, ListedAsset>();
  /** Best (lowest) position of each asset in any list. */
  const rank = new Map<AssetId, number>();
  byId.set("native", { id: "native", code: "XLM", contract: xlm, name: "Stellar Lumens", domain: "stellar.org", lists: [] });
  for (const list of lists) {
    if (!Array.isArray(list.assets)) continue;
    for (const [position, e] of (list.assets as RawEntry[]).entries()) {
      if (!e || typeof e !== "object") continue;
      let id: AssetId;
      if (typeof e.issuer === "string" && ISSUER.test(e.issuer) && typeof e.code === "string" && CODE.test(e.code)) {
        id = `${e.code}:${e.issuer}`;
      } else if (!e.issuer && (e.contract === xlm || e.code === "XLM")) {
        id = "native";
      } else {
        continue;
      }
      let a = byId.get(id);
      if (!a) {
        let contract: string;
        try {
          contract = sacId(id, passphrase);
        } catch {
          continue; // issuer passes the pattern but not the checksum
        }
        a = { id, code: e.code as string, issuer: e.issuer as string, contract, lists: [] };
        byId.set(id, a);
      }
      if (!a.lists.includes(list.name)) a.lists.push(list.name);
      rank.set(id, Math.min(rank.get(id) ?? position, position));
      if (id !== "native") {
        a.name ??= str(e.name, 60);
        a.domain ??= str(e.domain, 100);
      }
      a.icon ??= httpsUrl(e.icon);
    }
  }
  const [native, ...rest] = [...byId.values()];
  rest.sort((p, q) => q.lists.length - p.lists.length || rank.get(p.id)! - rank.get(q.id)! || p.code.localeCompare(q.code));
  return [native!, ...rest];
}

export interface AssetListResult {
  assets: ListedAsset[];
  /** Lists that could not be fetched this time. */
  errors: { source: string; error: string }[];
  /** When the lists were last fetched successfully, ms since epoch. */
  at: number;
}

/**
 * Cached, merged asset list. A refresh that fails keeps serving the previous result; with nothing cached and
 * every list down it still returns XLM, with the failures reported, rather than inventing assets. Callers that
 * see `errors` should ask again shortly: the next answer comes from a fresh attempt.
 */
export function createAssetList(opts: { sources?: AssetListSource[]; fetchImpl?: typeof fetch; ttlMs?: number; passphrase?: string } = {}) {
  const sources = opts.sources ?? DEFAULT_ASSET_LISTS;
  const ttl = opts.ttlMs ?? 60 * 60_000;
  let cache: AssetListResult | undefined;
  let validUntil = 0;
  let pending: Promise<AssetListResult> | undefined;

  async function load(): Promise<AssetListResult> {
    const f = opts.fetchImpl ?? fetch;
    const errors: AssetListResult["errors"] = [];
    const lists = await Promise.all(
      sources.map(async (s) => {
        try {
          const r = await f(s.url, { signal: AbortSignal.timeout(12_000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return { name: s.name, assets: ((await r.json()) as { assets?: unknown }).assets };
        } catch (e) {
          errors.push({ source: s.name, error: (e as Error).message });
          return { name: s.name, assets: [] };
        }
      }),
    );
    // A complete list is good for the full TTL. A partial one is retried soon, and a load that got nothing is
    // retried on the very next request: a slow first moment must not leave users with XLM only for a minute.
    validUntil = Date.now() + (errors.length === 0 ? ttl : errors.length === sources.length ? 0 : 15_000);
    // Keep the last good list when this refresh got nothing at all.
    if (errors.length === sources.length && cache) cache = { ...cache, errors };
    else cache = { assets: mergeAssetLists(lists, opts.passphrase), errors, at: Date.now() };
    return cache;
  }

  return {
    async get(): Promise<AssetListResult> {
      if (cache && Date.now() < validUntil) return cache;
      pending ??= load().finally(() => { pending = undefined; });
      // Only the very first caller waits. After that an expired or failed list is refreshed behind the
      // answer already held, so an outage at a list host never makes a request hang.
      if (cache) {
        pending.catch(() => undefined);
        return cache;
      }
      return pending;
    },
  };
}
