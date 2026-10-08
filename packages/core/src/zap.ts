import type { AssetId, QuoteRequest, Route } from "./types.js";
import type { Router } from "./router.js";

export interface VaultTarget {
  /** Vault contract id (C...). */
  vault: string;
  /** Underlying asset the vault accepts. */
  underlying: AssetId;
  protocol: "defindex" | "blend" | "other";
}

export interface ZapPlan {
  swap: Route | null;
  /** True when assetIn already equals the vault's underlying asset. */
  noSwapNeeded: boolean;
  deposit: { vault: string; asset: AssetId; protocol: VaultTarget["protocol"] };
  /** A zap is atomic only if the swap is ATOMIC_SOROBAN (or absent) and the deposit is a Soroban call in the same invocation. */
  fullyAtomic: boolean;
  notes: string[];
}

/**
 * Plan "any asset -> vault position". This produces the swap route and the deposit descriptor.
 * Building the deposit transaction needs the vault protocol's SDK/ABI (DeFindex API access was
 * not verified), so execution of the deposit leg is intentionally out of scope for v0.
 */
export async function planZap(router: Router, req: QuoteRequest, target: VaultTarget): Promise<ZapPlan> {
  const notes: string[] = [];
  const deposit = { vault: target.vault, asset: target.underlying, protocol: target.protocol };

  if (req.assetIn === target.underlying) {
    return { swap: null, noSwapNeeded: true, deposit, fullyAtomic: true, notes };
  }
  const { routes } = await router.quote({ ...req, assetOut: target.underlying });
  const best = routes[0] ?? null;
  if (!best) {
    notes.push("No route to the vault's underlying asset.");
    return { swap: null, noSwapNeeded: false, deposit, fullyAtomic: false, notes };
  }
  const fullyAtomic = best.atomicity === "ATOMIC_SOROBAN";
  if (!fullyAtomic) {
    notes.push(
      `Swap is ${best.atomicity}; the vault deposit cannot be in the same transaction as a Classic leg. ` +
        `Execute swap first, then deposit the actual received amount.`,
    );
  }
  return { swap: best, noSwapNeeded: false, deposit, fullyAtomic, notes };
}
