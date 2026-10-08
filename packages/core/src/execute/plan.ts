import { buildClassicSwap } from "./classic.js";
import { buildAquariusSwap, buildCometSwap, buildPhoenixSwap, buildSluiceRouterSwap, buildSoroswapSwap, type RouterLeg } from "./soroban.js";
import type { SoroswapRaw } from "../sources/soroswap.js";
import type { CometRaw } from "../sources/comet.js";
import type { PhoenixRaw } from "../sources/phoenix.js";
import { sacId } from "../assets.js";
import type { Leg, Route } from "../types.js";

export interface PlanOpts {
  /** Signer, G... */
  account: string;
  /** Current sequence number of `account`. */
  sequence: string;
  passphrase?: string;
  /** Deployed Sluice router contract (C...). Required to execute multi-leg Soroban routes atomically. */
  routerContract?: string;
  /** Unix seconds for the contract deadline. Default now + 5 minutes. */
  deadline?: bigint;
  /** How long each built transaction stays valid, seconds. Default 60; a wallet prompt needs longer. */
  timeoutSec?: number;
}

export type PlanStep =
  | {
      kind: "transaction";
      leg: number;
      layer: Leg["layer"];
      venue: string;
      /** Unsigned. Soroban steps still need `prepare()` (simulation) before signing. */
      xdr: string;
      needsSimulation: boolean;
      minOut: bigint;
    }
  | {
      kind: "deferred";
      leg: number;
      layer: Leg["layer"];
      venue: string;
      /** Why this leg is not pre-built, and what to do instead. */
      reason: string;
    }
  | { kind: "unsupported"; leg: number; venue: string; reason: string };

/**
 * Turn a route into transaction steps. Only the first leg is pre-built for TWO_STEP routes: the second
 * leg's input is whatever the first actually delivered, so it must be re-quoted from the real balance
 * after leg 1 settles. Venues without a verified execution path come back as `unsupported` instead of
 * a guessed transaction.
 */
export function planExecution(route: Route, o: PlanOpts): PlanStep[] {
  if (route.atomicity === "ATOMIC_SOROBAN" && route.legs.length > 1) return planChain(route, o);
  return route.legs.map((leg, i): PlanStep => {
    if (i > 0 && route.atomicity === "TWO_STEP") {
      return {
        kind: "deferred",
        leg: i,
        layer: leg.layer,
        venue: leg.venue,
        reason:
          "Depends on the amount leg 1 actually delivers. After leg 1 settles, re-quote this pair with the " +
          "received balance and execute the fresh route. Do not reuse this quote.",
      };
    }
    const minOut = route.minOuts[i]!;
    if (leg.layer === "classic") {
      return {
        kind: "transaction", leg: i, layer: "classic", venue: leg.venue, needsSimulation: false, minOut,
        xdr: buildClassicSwap(leg, { source: o.account, sequence: o.sequence, minOut, passphrase: o.passphrase, timeoutSec: o.timeoutSec }),
      };
    }
    if (leg.venue === "aquarius") {
      const raw = leg.raw as { swap_chain_xdr?: string } | undefined;
      if (!raw?.swap_chain_xdr) return { kind: "unsupported", leg: i, venue: leg.venue, reason: "quote carried no swap_chain_xdr" };
      return {
        kind: "transaction", leg: i, layer: "soroban", venue: leg.venue, needsSimulation: true, minOut,
        xdr: buildAquariusSwap({
          source: o.account, sequence: o.sequence, passphrase: o.passphrase, timeoutSec: o.timeoutSec,
          swapChainXdr: raw.swap_chain_xdr, tokenIn: sacId(leg.assetIn, o.passphrase), amountIn: leg.amountIn, minOut,
        }),
      };
    }
    if (leg.venue === "phoenix") {
      const raw = leg.raw as PhoenixRaw | undefined;
      if (!raw?.pool || !raw.offerAsset) return { kind: "unsupported", leg: i, venue: leg.venue, reason: "quote carried no pool" };
      return {
        kind: "transaction", leg: i, layer: "soroban", venue: leg.venue, needsSimulation: true, minOut,
        xdr: buildPhoenixSwap({ source: o.account, sequence: o.sequence, passphrase: o.passphrase, timeoutSec: o.timeoutSec, pool: raw.pool, offerAsset: raw.offerAsset, amountIn: leg.amountIn, minOut }),
      };
    }
    if (leg.venue === "comet") {
      const raw = leg.raw as CometRaw | undefined;
      if (!raw?.pool) return { kind: "unsupported", leg: i, venue: leg.venue, reason: "quote carried no pool" };
      return {
        kind: "transaction", leg: i, layer: "soroban", venue: leg.venue, needsSimulation: true, minOut,
        xdr: buildCometSwap({ source: o.account, sequence: o.sequence, passphrase: o.passphrase, timeoutSec: o.timeoutSec, pool: raw.pool, tokenIn: raw.tokenIn, tokenOut: raw.tokenOut, amountIn: leg.amountIn, minOut }),
      };
    }
    if (leg.venue === "soroswap") {
      const raw = leg.raw as SoroswapRaw | undefined;
      if (!raw?.router || !raw.path?.length) return { kind: "unsupported", leg: i, venue: leg.venue, reason: "quote carried no path" };
      return {
        kind: "transaction", leg: i, layer: "soroban", venue: leg.venue, needsSimulation: true, minOut,
        xdr: buildSoroswapSwap({ source: o.account, sequence: o.sequence, passphrase: o.passphrase, timeoutSec: o.timeoutSec, router: raw.router, path: raw.path, amountIn: leg.amountIn, minOut }),
      };
    }
    return { kind: "unsupported", leg: i, venue: leg.venue, reason: "No verified execution path for this venue." };
  });
}

/** Convert a quoted leg to the contract's leg, or null when the contract cannot run that venue. */
function toRouterLeg(leg: Leg, passphrase?: string): RouterLeg | null {
  if (leg.venue === "soroswap") {
    const raw = leg.raw as SoroswapRaw | undefined;
    return raw?.router && raw.path?.length ? { kind: "Soroswap", venue: raw.router, path: raw.path } : null;
  }
  if (leg.venue === "phoenix") {
    const raw = leg.raw as PhoenixRaw | undefined;
    return raw?.pool && raw.offerAsset ? { kind: "Phoenix", venue: raw.pool, path: [raw.offerAsset, sacId(leg.assetOut, passphrase)] } : null;
  }
  if (leg.venue === "comet") {
    const raw = leg.raw as CometRaw | undefined;
    return raw?.pool ? { kind: "Comet", venue: raw.pool, path: [raw.tokenIn, raw.tokenOut] } : null;
  }
  return null;
}

/** Multi-leg Soroban route: one invocation of the Sluice router contract, atomic. */
function planChain(route: Route, o: PlanOpts): PlanStep[] {
  const legs = route.legs.map((l) => toRouterLeg(l, o.passphrase));
  const bad = legs.findIndex((l) => l === null);
  const refuse = (reason: string): PlanStep[] =>
    route.legs.map((l, i) => ({ kind: "unsupported", leg: i, venue: l.venue, reason }) as PlanStep);
  if (!o.routerContract) return refuse("Multi-leg Soroban routes run through the Sluice router contract, which is not configured (SLUICE_ROUTER_CONTRACT).");
  if (bad >= 0) return refuse(`Leg ${bad} (${route.legs[bad]!.venue}) cannot be run by the Sluice router contract.`);
  const minOut = route.minOuts[route.minOuts.length - 1]!;
  const xdr = buildSluiceRouterSwap({
    source: o.account, sequence: o.sequence, passphrase: o.passphrase, timeoutSec: o.timeoutSec, routerContract: o.routerContract,
    legs: legs as RouterLeg[], amountIn: route.amountIn, minOut,
    deadline: o.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 300),
  });
  // One transaction covers every leg; report it on the first leg and mark the rest as included.
  return route.legs.map((l, i): PlanStep =>
    i === 0
      ? { kind: "transaction", leg: 0, layer: "soroban", venue: "sluice-router", needsSimulation: true, minOut, xdr }
      : { kind: "deferred", leg: i, layer: "soroban", venue: l.venue, reason: "Included in the single Sluice router transaction above." },
  );
}
