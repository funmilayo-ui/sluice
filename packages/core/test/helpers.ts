import type { AssetId, Layer, Leg, QuoteRequest, QuoteSource } from "../src/types.js";

export const XLM: AssetId = "native";
export const USDC: AssetId = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const AQUA: AssetId = "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";

/** Table-driven fake venue: rates[`${in}>${out}`] = output per 1 input unit (x1e4 fixed point). */
export function fakeSource(id: string, layer: Layer, rates: Record<string, number>): QuoteSource {
  return {
    id,
    layer,
    async quote(req: QuoteRequest): Promise<Leg | null> {
      const rate = rates[`${req.assetIn}>${req.assetOut}`];
      if (rate === undefined) return null;
      return {
        venue: id,
        layer,
        assetIn: req.assetIn,
        assetOut: req.assetOut,
        amountIn: req.amountIn,
        amountOut: (req.amountIn * BigInt(rate)) / 10_000n,
        hops: [],
      };
    },
  };
}
