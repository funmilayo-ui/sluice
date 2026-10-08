import type { Leg, QuoteRequest, QuoteSource } from "../types.js";
import { sacId } from "../assets.js";
import { Address } from "@stellar/stellar-sdk";
import { simulateView } from "../rpc.js";

/** Comet pool used by Blend (80% BLND / 20% USDC). From blend-capital/blend-utils mainnet.contracts.json. */
export const COMET_BLEND_POOL = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";

/** Weights and fees are fixed point with 7 decimals. */
const ONE = 10_000_000;
/** Balancer-style pools reject trades above this share of the input balance. */
const MAX_IN_RATIO = 0.5;

export interface CometRaw {
  pool: string;
  tokenIn: string;
  tokenOut: string;
}

/**
 * Pure Balancer weighted-pool output. Verified against a real mainnet swap simulation on 2026-10-08:
 * the formula gave 6,991,583,333 and the pool returned 6,991,583,332, so one stroop is subtracted.
 * Floating point is fine here: this is a quote, and execution is protected by min-out.
 */
export function cometAmountOut(p: { balIn: bigint; balOut: bigint; wIn: bigint; wOut: bigint; fee: bigint; amountIn: bigint }): bigint {
  const balIn = Number(p.balIn);
  if (p.amountIn <= 0n || balIn <= 0 || Number(p.amountIn) > balIn * MAX_IN_RATIO) return 0n;
  const afterFee = Number(p.amountIn) * (1 - Number(p.fee) / ONE);
  const y = balIn / (balIn + afterFee);
  const out = Number(p.balOut) * (1 - Math.pow(y, Number(p.wIn) / Number(p.wOut)));
  const n = BigInt(Math.floor(out)) - 1n;
  return n > 0n ? n : 0n;
}

/**
 * Comet quotes computed from on-chain pool state over Stellar RPC (balances, weights, swap fee). Comet has no
 * quote function, so this uses the weighted-pool formula above. Calling a Comet pool directly needs no prior
 * token approval (verified by simulation: the input transfer succeeded, only the missing output trustline failed).
 */
export function cometSource(opts: { rpcUrl?: string; pools?: string[]; passphrase?: string } = {}): QuoteSource {
  const rpcUrl = opts.rpcUrl ?? "https://mainnet.sorobanrpc.com";
  const pools = opts.pools ?? [COMET_BLEND_POOL];
  const meta = new Map<string, { tokens: string[]; weights: Map<string, bigint>; fee: bigint }>();

  async function poolMeta(pool: string) {
    const hit = meta.get(pool);
    if (hit) return hit;
    const tokens = (await simulateView(rpcUrl, pool, "get_tokens")) as string[];
    const fee = (await simulateView(rpcUrl, pool, "get_swap_fee")) as bigint;
    const weights = new Map<string, bigint>();
    for (const t of tokens) weights.set(t, (await simulateView(rpcUrl, pool, "get_normalized_weight", [new Address(t).toScVal()])) as bigint);
    const m = { tokens, weights, fee };
    meta.set(pool, m);
    return m;
  }

  return {
    id: "comet",
    layer: "soroban",
    async quote(req: QuoteRequest): Promise<Leg | null> {
      if (req.assetIn === req.assetOut) return null;
      const tin = sacId(req.assetIn, opts.passphrase);
      const tout = sacId(req.assetOut, opts.passphrase);
      let best: { pool: string; out: bigint } | undefined;
      await Promise.all(
        pools.map(async (pool) => {
          try {
            const m = await poolMeta(pool);
            if (!m.tokens.includes(tin) || !m.tokens.includes(tout)) return;
            const [balIn, balOut] = await Promise.all([
              simulateView(rpcUrl, pool, "get_balance", [new Address(tin).toScVal()]) as Promise<bigint>,
              simulateView(rpcUrl, pool, "get_balance", [new Address(tout).toScVal()]) as Promise<bigint>,
            ]);
            const out = cometAmountOut({ balIn, balOut, wIn: m.weights.get(tin)!, wOut: m.weights.get(tout)!, fee: m.fee, amountIn: req.amountIn });
            if (out > 0n && (!best || out > best.out)) best = { pool, out };
          } catch {
            /* pool unreachable */
          }
        }),
      );
      if (!best) return null;
      const raw: CometRaw = { pool: best.pool, tokenIn: tin, tokenOut: tout };
      return {
        venue: "comet", layer: "soroban", assetIn: req.assetIn, assetOut: req.assetOut,
        amountIn: req.amountIn, amountOut: best.out, hops: [], raw,
      };
    },
  };
}
