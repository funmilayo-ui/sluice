import { formatAmount, parseAmount } from "./amounts.js";
import { parseAsset } from "./assets.js";
import type { AssetId } from "./types.js";
import { scoreStablecoin, type StablecoinScore, type StablecoinSignals } from "./stablecoin.js";

export const USDC_REFERENCE: AssetId = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

export interface SignalOpts {
  horizon?: string;
  fetchImpl?: typeof fetch;
  /** Asset the price is measured in. Default: Circle USDC. */
  reference?: AssetId;
  /** Expected price of 1 unit in `reference`. 1 for USD coins; set it for EUR or other pegs. */
  expectedPrice?: number;
  /** Trade sizes (whole units) probed for depth, ascending. */
  sizes?: number[];
}

interface PathsBody { _embedded?: { records?: { destination_amount: string }[] } }

async function priceFor(base: string, asset: AssetId, reference: AssetId, units: number, f: typeof fetch): Promise<number | null> {
  const src = parseAsset(asset);
  const u = new URL("/paths/strict-send", base);
  u.searchParams.set("source_amount", formatAmount(parseAmount(String(units))));
  u.searchParams.set("source_asset_type", src.getCode().length <= 4 ? "credit_alphanum4" : "credit_alphanum12");
  u.searchParams.set("source_asset_code", src.getCode());
  u.searchParams.set("source_asset_issuer", src.getIssuer());
  u.searchParams.set("destination_assets", reference);
  const r = await f(u);
  if (!r.ok) return null;
  const rec = ((await r.json()) as PathsBody)._embedded?.records ?? [];
  let best = 0n;
  for (const x of rec) {
    const v = parseAmount(x.destination_amount);
    if (v > best) best = v;
  }
  return best > 0n ? Number(best) / 1e7 / units : null;
}

/**
 * Live stablecoin inputs from Horizon. Peg price and depth come from executable path quotes (what you would
 * actually get), not an oracle. `depthNearPeg` is the largest probed size (in units) whose average price stays
 * within 0.5% of the smallest probe's price. Issuer flags come from the Horizon assets endpoint. Holder
 * concentration is not available from Horizon cheaply and is left undefined, never guessed.
 */
export async function fetchStablecoinSignals(asset: AssetId, o: SignalOpts = {}): Promise<StablecoinSignals & { sizesProbed: number[] }> {
  const base = o.horizon ?? "https://horizon.stellar.org";
  const f = o.fetchImpl ?? fetch;
  const reference = o.reference ?? USDC_REFERENCE;
  const expected = o.expectedPrice ?? 1;
  const sizes = o.sizes ?? [100, 1_000, 10_000, 100_000];
  if (asset === "native") throw new Error("native is not a stablecoin");

  // The reference asset is the unit of measurement: its peg and depth are left unset, not assumed perfect.
  let pegPrice: number | undefined;
  let depth: number | undefined;
  if (asset !== reference) {
    const prices: (number | null)[] = await Promise.all(sizes.map((n) => priceFor(base, asset, reference, n, f)));
    const first = prices[0];
    if (first === null || first === undefined) throw new Error(`no executable path from ${asset} to ${reference}`);
    pegPrice = first / expected;
    depth = 0;
    for (let i = 0; i < sizes.length; i++) {
      const p = prices[i];
      if (p === null || p === undefined || Math.abs(p - first) / first > 0.005) break;
      depth = sizes[i]!;
    }
  }

  const a = parseAsset(asset);
  const r = await f(new URL(`/assets?asset_code=${a.getCode()}&asset_issuer=${a.getIssuer()}&limit=1`, base));
  if (!r.ok) throw new Error(`horizon assets ${r.status}`);
  const rec = ((await r.json()) as { _embedded?: { records?: { flags?: { auth_required?: boolean; auth_clawback_enabled?: boolean } }[] } })._embedded?.records?.[0];
  if (!rec) throw new Error(`asset ${asset} not found on Horizon`);
  return {
    pegPrice,
    depthNearPeg: depth,
    reference: asset === reference ? true : undefined,
    authRequired: rec.flags?.auth_required === true,
    clawback: rec.flags?.auth_clawback_enabled === true,
    sizesProbed: asset === reference ? [] : sizes,
  };
}

/**
 * Caches scores so the synchronous ranking hook (`assetPenaltyBps`) never waits on the network. Failures keep
 * the previous score and are exposed in `errors`; an asset that was never scored has no penalty and the
 * route carries no claim about it. `refreshIfStale` replaces a timer, so the same code works in a
 * long-running server and in a serverless function that only runs while a request is in flight.
 */
export function createStablecoinScorer(assets: AssetId[], o: SignalOpts & { tradeSize?: number; ttlMs?: number } = {}) {
  const scores = new Map<AssetId, StablecoinScore & { signals: StablecoinSignals; at: number }>();
  const errors = new Map<AssetId, string>();
  const ttl = o.ttlMs ?? 5 * 60_000;
  let refreshedAt = 0;
  let pending: Promise<void> | undefined;
  async function refresh(): Promise<void> {
    // One asset at a time: each makes four depth probes at once, and scoring every asset together was part
    // of a cold-start burst that slowed the first visitor's requests.
    for (const a of assets) {
      try {
        const signals = await fetchStablecoinSignals(a, o);
        scores.set(a, { ...scoreStablecoin(signals, o.tradeSize), signals, at: Date.now() });
        errors.delete(a);
      } catch (e) {
        errors.set(a, (e as Error).message);
      }
    }
    refreshedAt = Date.now();
  }
  return {
    assets,
    refresh,
    /** Refresh when older than the TTL; concurrent callers share one refresh. Resolves immediately when fresh or empty. */
    refreshIfStale(): Promise<void> {
      if (!assets.length || Date.now() - refreshedAt < ttl) return Promise.resolve();
      pending ??= refresh().finally(() => { pending = undefined; });
      return pending;
    },
    scores,
    errors,
    penaltyBps: (a: AssetId) => scores.get(a)?.penaltyBps ?? 0,
  };
}
