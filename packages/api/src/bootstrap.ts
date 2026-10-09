import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cacheDnsLookups, createStablecoinScorer, DEFAULT_ASSET_LISTS, preferIpv4, preResolve, Router, type KvCache } from "@sluice/core";
import { createApp, DEFAULT_HUBS, DEFAULT_VAULTS, defaultDeps, defaultSources, type VaultConfig } from "./app.js";

type Env = Record<string, string | undefined>;
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * USD stablecoins scored when `SCORED_ASSETS` is not set. Each is fiat-USD anchored and is carried by all
 * three public asset lists or by its issuer's own stellar.toml, checked 2026-10-08:
 *  - USDC: circle.com / centre.io toml lists this issuer, anchor_asset USD.
 *  - PYUSD: the issuer account's home_domain is token-metadata.paxos.com (Paxos issues PayPal USD). That
 *    host refused the toml request from the checking machine (HTTP 403), so the toml side is unconfirmed.
 *  - USDGLO: app.glodollar.org toml lists this issuer, anchor_asset USD.
 *  - ZUSD: stablecoin.z.com toml lists this issuer, anchor_asset USD.
 * Yield-bearing and synthetic dollars (USDY, yUSDC, USDx, oUSD) are left out: their price is not meant to sit at 1.
 */
export const DEFAULT_SCORED_ASSETS = [
  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  "PYUSD:GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5",
  "USDGLO:GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV",
  "ZUSD:GDF6VOEGRWLOZ64PQQGKD2IYWA22RLT37GJKS2EJXZHT2VLAGWLC5TOB",
];

/** `BLEND_POOLS` is comma separated `CONTRACT:Display name`. Unset means the one verified pool. */
export function parseVaults(v: string | undefined): VaultConfig[] {
  const out = list(v).flatMap((entry): VaultConfig[] => {
    const [id, ...name] = entry.split(":");
    return id && /^C[A-Z2-7]{55}$/.test(id) ? [{ id, name: name.join(":").trim() || "Blend pool" }] : [];
  });
  return out.length ? out : DEFAULT_VAULTS;
}

/** The built web app next to this package, if `pnpm build` has produced it. Resolved from this module, not the cwd. */
export function builtWebDir(): string | undefined {
  const dir = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));
  return existsSync(`${dir}index.html`) ? dir : undefined;
}

/**
 * Wire the app from environment variables. Shared by the Node server and the serverless entry so both run
 * the same configuration. Nothing here starts a timer: scores and pool lists refresh when a request needs them.
 */
export function createSluice(env: Env = process.env, extra: { cache?: KvCache; webDir?: string } = {}) {
  // Some hosts have a broken IPv6 route, which makes fetch time out where curl works.
  if (env.SLUICE_IPV4_FIRST === "1") preferIpv4();
  // Keep name lookups in the process (set SLUICE_DNS_CACHE=0 to leave resolution entirely to the system).
  if (env.SLUICE_DNS_CACHE !== "0") cacheDnsLookups();

  // Stablecoins scored from live Horizon data, for the health badges and the ranking bias. Comma separated
  // CODE:ISSUER; unset uses the verified default set, an empty value turns scoring off.
  const scorer = createStablecoinScorer(env.SCORED_ASSETS === undefined ? DEFAULT_SCORED_ASSETS : list(env.SCORED_ASSETS), { horizon: env.HORIZON_URL });

  // Multi-leg Soroban chains (for example Phoenix then Comet) only exist once the Sluice contract is deployed.
  const routerContract = env.SLUICE_ROUTER_CONTRACT || undefined;

  // A venue that quotes but cannot execute is switched off here rather than shown and then failing.
  const disabled = new Set(list(env.DISABLED_VENUES));
  const sources = defaultSources(env, extra.cache).filter((s) => !disabled.has(s.id));

  const router = new Router({
    sources,
    hubs: DEFAULT_HUBS,
    assetPenaltyBps: scorer.penaltyBps,
    chainVenues: routerContract ? ["soroswap", "phoenix", "comet"] : undefined,
    // A cold process pays TLS handshakes and Phoenix pool discovery on its first quote (measured 4 to 5s).
    timeoutMs: Number(env.SOURCE_TIMEOUT_MS ?? 8000),
  });
  const deps = defaultDeps(env);
  const app = createApp(router, deps, { routerContract, scorer, vaults: parseVaults(env.BLEND_POOLS), webDir: extra.webDir });

  return {
    app,
    /**
     * Load what the first visitor would otherwise wait for. Safe to call and forget. In order of what a
     * visitor needs first: the asset list (three small fetches), then the heavier pool discovery and scoring.
     */
    async warm(): Promise<void> {
      // Names first, all at once: a cold lookup can take seconds and everything below waits on one.
      await preResolve([env.HORIZON_URL ?? "https://horizon.stellar.org", env.AQUARIUS_URL ?? "https://amm-api.aqua.network", env.RPC_URL ?? "https://mainnet.sorobanrpc.com", ...DEFAULT_ASSET_LISTS.map((l) => l.url)]);
      await deps.assets().catch(() => undefined);
      await Promise.all([...sources.map((s) => s.warm?.()), scorer.refreshIfStale()]).catch(() => undefined);
    },
  };
}
