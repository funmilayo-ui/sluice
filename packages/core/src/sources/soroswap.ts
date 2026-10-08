import type { AssetId, Leg, QuoteRequest, QuoteSource } from "../types.js";
import { sacId } from "../assets.js";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { simulateView } from "../rpc.js";
import { SOROSWAP_ROUTER } from "../execute/soroban.js";

export interface SoroswapRaw {
  router: string;
  /** Token contract ids, first = input, last = output. */
  path: string[];
}

/**
 * Soroswap quotes straight from the router contract over Stellar RPC (`router_get_amounts_out`, read-only),
 * so no API key is needed. Tries the direct pair and one hop through each hub asset, and keeps the best.
 * Execution is a direct user call to `swap_exact_tokens_for_tokens` (signature verified on-chain 2026-10-08).
 * `hubs` are AssetIds (e.g. "native"); they are also used to label intermediate hops in the result.
 */
export function soroswapSource(opts: { rpcUrl?: string; router?: string; hubs?: AssetId[]; passphrase?: string } = {}): QuoteSource {
  const rpcUrl = opts.rpcUrl ?? "https://mainnet.sorobanrpc.com";
  const router = opts.router ?? SOROSWAP_ROUTER;
  const hubs = opts.hubs ?? ["native", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"];
  const hubById = new Map(hubs.map((h) => [sacId(h, opts.passphrase), h] as const));

  return {
    id: "soroswap",
    layer: "soroban",
    async quote(req: QuoteRequest): Promise<Leg | null> {
      if (req.assetIn === req.assetOut) return null;
      const tin = sacId(req.assetIn, opts.passphrase);
      const tout = sacId(req.assetOut, opts.passphrase);
      const paths: string[][] = [[tin, tout]];
      for (const hub of hubById.keys()) if (hub !== tin && hub !== tout) paths.push([tin, hub, tout]);

      let best: { path: string[]; out: bigint } | undefined;
      await Promise.all(
        paths.map(async (path) => {
          try {
            const amounts = (await simulateView(rpcUrl, router, "router_get_amounts_out", [
              nativeToScVal(req.amountIn, { type: "i128" }),
              xdr.ScVal.scvVec(path.map((p) => new Address(p).toScVal())),
            ])) as bigint[];
            const out = amounts[amounts.length - 1] ?? 0n;
            if (out > 0n && (!best || out > best.out)) best = { path, out };
          } catch {
            /* pair or hub pool does not exist, or the size exceeds reserves */
          }
        }),
      );
      if (!best) return null;
      const raw: SoroswapRaw = { router, path: best.path };
      return {
        venue: "soroswap", layer: "soroban", assetIn: req.assetIn, assetOut: req.assetOut,
        amountIn: req.amountIn, amountOut: best.out,
        hops: best.path.slice(1, -1).map((p) => hubById.get(p) ?? p),
        raw,
      };
    },
  };
}
