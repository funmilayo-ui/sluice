import type { Leg, QuoteRequest, QuoteSource } from "../types.js";
import { sacId } from "../assets.js";

interface FindPathResponse {
  success: boolean;
  swap_chain_xdr?: string;
  pools?: string[];
  tokens?: string[];
  tokens_addresses?: string[];
  amount?: string | number;
}

/**
 * Soroban quotes from the Aquarius AMM API (find-path). Open, no key needed as of 2026-10-07.
 * `amount` in the response is the output amount in stroops for the supplied input.
 */
export function aquariusSource(
  baseUrl = "https://amm-api.aqua.network",
  fetchImpl: typeof fetch = fetch,
  passphrase?: string,
): QuoteSource {
  return {
    id: "aquarius",
    layer: "soroban",
    async quote(req: QuoteRequest): Promise<Leg | null> {
      if (req.assetIn === req.assetOut) return null;
      const res = await fetchImpl(new URL("/api/external/v1/find-path/", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token_in_address: sacId(req.assetIn, passphrase),
          token_out_address: sacId(req.assetOut, passphrase),
          amount: req.amountIn.toString(),
        }),
      });
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`aquarius find-path ${res.status}`);
      const body = (await res.json()) as FindPathResponse;
      if (!body.success || body.amount === undefined) return null;
      const tokens = body.tokens ?? [];
      return {
        venue: "aquarius",
        layer: "soroban",
        assetIn: req.assetIn,
        assetOut: req.assetOut,
        amountIn: req.amountIn,
        amountOut: BigInt(body.amount),
        hops: tokens.slice(1, -1),
        raw: { swap_chain_xdr: body.swap_chain_xdr, pools: body.pools },
      };
    },
  };
}
