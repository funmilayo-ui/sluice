import type { AssetId, Leg, QuoteRequest, QuoteSource } from "../types.js";
import { formatAmount, parseAmount } from "../amounts.js";
import { parseAsset, toAssetId } from "../assets.js";
import { Asset } from "@stellar/stellar-sdk";

interface HorizonRecord {
  destination_amount: string;
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

/**
 * Classic quotes via Horizon /paths/strict-send. Core picks SDEX orderbook vs Classic pools per
 * hop at execution time, so this one source covers both Classic liquidity types.
 * Horizon is in maintenance mode; keep this behind QuoteSource so it can be swapped for an
 * RPC/indexer-based implementation.
 */
export function horizonSource(baseUrl = "https://horizon.stellar.org", fetchImpl: typeof fetch = fetch): QuoteSource {
  return {
    id: "classic-path",
    layer: "classic",
    async quote(req: QuoteRequest): Promise<Leg | null> {
      if (req.assetIn === req.assetOut) return null;
      const src = parseAsset(req.assetIn);
      const u = new URL("/paths/strict-send", baseUrl);
      u.searchParams.set("source_amount", formatAmount(req.amountIn));
      if (src.isNative()) {
        u.searchParams.set("source_asset_type", "native");
      } else {
        u.searchParams.set("source_asset_type", src.getCode().length <= 4 ? "credit_alphanum4" : "credit_alphanum12");
        u.searchParams.set("source_asset_code", src.getCode());
        u.searchParams.set("source_asset_issuer", src.getIssuer());
      }
      u.searchParams.set("destination_assets", req.assetOut);
      const res = await fetchImpl(u);
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`horizon paths ${res.status}`);
      const body = (await res.json()) as { _embedded?: { records?: HorizonRecord[] } };
      const records = body._embedded?.records ?? [];
      let best: HorizonRecord | undefined;
      for (const r of records) {
        if (!best || parseAmount(r.destination_amount) > parseAmount(best.destination_amount)) best = r;
      }
      if (!best) return null;
      const hops: AssetId[] = best.path.map((p) =>
        p.asset_type === "native" ? "native" : toAssetId(new Asset(p.asset_code!, p.asset_issuer!)),
      );
      return {
        venue: "classic-path",
        layer: "classic",
        assetIn: req.assetIn,
        assetOut: req.assetOut,
        amountIn: req.amountIn,
        amountOut: parseAmount(best.destination_amount),
        hops,
        raw: { path: best.path },
      };
    },
  };
}
