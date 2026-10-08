import type { KvCache, Leg, QuoteRequest, QuoteSource } from "../types.js";
import { sacId } from "../assets.js";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { simulateView } from "../rpc.js";

/** Phoenix pool factory on mainnet. Interface (query_pools) verified on-chain 2026-10-08. */
export const PHOENIX_FACTORY = "CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI";

/** `Promise.all` over `items`, with at most `limit` of them in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** A pool and the two token contracts it trades. Reserves are never cached: every quote reads them live. */
interface PoolInfo { address: string; a: string; b: string }

export interface PhoenixRaw {
  pool: string;
  /** SAC id of the asset being sold. */
  offerAsset: string;
}

/**
 * Phoenix quotes. Phoenix pools are individual contracts (no router): pools are discovered from the
 * factory, then each candidate pool is asked `simulate_swap` over Stellar RPC (read-only). On mainnet the
 * real `swap` returned exactly `ask_amount` (verified 2026-10-08), so that is the quoted output.
 * Single pool per quote; multi-hop across Phoenix pools is not attempted.
 * `simulate_swap` succeeding does not prove a swap will execute (see the stake_contract skip below), so always
 * simulate the built transaction before signing.
 * Phoenix pools are small (the XLM/USDC pool held about 9,700 XLM when checked), so large sizes quote badly
 * or fail: callers should expect `null` for sizes the pool cannot take.
 */
export function phoenixSource(opts: {
  rpcUrl?: string;
  factory?: string;
  passphrase?: string;
  /** How long to cache the pool list, ms. Reserves are never cached. Default 10 minutes. */
  poolListTtlMs?: number;
  /** Shared cache for the pool list. Discovery costs two calls per pool, which a cold process pays on its first quote. */
  cache?: KvCache;
} = {}): QuoteSource {
  const rpcUrl = opts.rpcUrl ?? "https://mainnet.sorobanrpc.com";
  const factory = opts.factory ?? PHOENIX_FACTORY;
  const ttl = opts.poolListTtlMs ?? 10 * 60_000;
  const key = `phoenix:pools:${factory}`;
  let mem: { at: number; pools: PoolInfo[] } | undefined;
  let pending: Promise<PoolInfo[]> | undefined;

  async function discover(): Promise<PoolInfo[]> {
    const addrs = (await simulateView(rpcUrl, factory, "query_pools")) as string[];
    // A few pools at a time: firing two calls for every pool at once starved other requests on a cold process.
    const infos = await mapLimit(addrs, 6, async (address): Promise<PoolInfo | null> => {
      try {
        const i = (await simulateView(rpcUrl, address, "query_pool_info")) as { asset_a: { address: string; amount: bigint }; asset_b: { address: string; amount: bigint } };
        if (i.asset_a.amount <= 0n || i.asset_b.amount <= 0n) return null;
        // Observed 2026-10-08: the one XLM/USDC pool whose stake_contract equals its own address quoted via
        // simulate_swap but failed every real swap (any size, error #337). The cause is not confirmed, so this
        // is a conservative skip. /v1/build also simulates the real swap, which is the actual gate.
        const cfg = (await simulateView(rpcUrl, address, "query_config")) as { stake_contract: string };
        if (cfg.stake_contract === address) return null;
        return { address, a: i.asset_a.address, b: i.asset_b.address };
      } catch {
        return null;
      }
    });
    return infos.filter((x): x is PoolInfo => x !== null);
  }

  async function pools(): Promise<PoolInfo[]> {
    if (mem && Date.now() - mem.at < ttl) return mem.pools;
    pending ??= (async () => {
      try {
        const shared = (await opts.cache?.get(key).catch(() => undefined)) as PoolInfo[] | undefined;
        const list = Array.isArray(shared) && shared.length ? shared : await discover();
        mem = { at: Date.now(), pools: list };
        if (list !== shared) void opts.cache?.set(key, list, Math.round(ttl / 1000)).catch(() => undefined);
        return list;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }

  return {
    id: "phoenix",
    layer: "soroban",
    /** Load the pool list ahead of the first quote. Never throws. */
    async warm(): Promise<void> {
      await pools().catch(() => undefined);
    },
    async quote(req: QuoteRequest): Promise<Leg | null> {
      if (req.assetIn === req.assetOut) return null;
      const tin = sacId(req.assetIn, opts.passphrase);
      const tout = sacId(req.assetOut, opts.passphrase);
      const candidates = (await pools()).filter((p) => (p.a === tin && p.b === tout) || (p.a === tout && p.b === tin));
      let best: { pool: string; out: bigint } | undefined;
      await Promise.all(
        candidates.map(async (p) => {
          try {
            const r = (await simulateView(rpcUrl, p.address, "simulate_swap", [
              new Address(tin).toScVal(),
              nativeToScVal(req.amountIn, { type: "i128" }),
            ])) as { ask_amount: bigint };
            if (r.ask_amount > 0n && (!best || r.ask_amount > best.out)) best = { pool: p.address, out: r.ask_amount };
          } catch {
            /* pool cannot take this size */
          }
        }),
      );
      if (!best) return null;
      const raw: PhoenixRaw = { pool: best.pool, offerAsset: tin };
      return {
        venue: "phoenix", layer: "soroban", assetIn: req.assetIn, assetOut: req.assetOut,
        amountIn: req.amountIn, amountOut: best.out, hops: [], raw,
      };
    },
  };
}
