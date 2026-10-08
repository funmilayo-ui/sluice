import type { AssetId } from "./types.js";

export interface StablecoinSignals {
  /** Market price in units of the peg (1.0 = on peg). Absent when not measured (the reference asset). */
  pegPrice?: number;
  /** Executable depth near peg, in the peg currency. Absent when not measured (the reference asset). */
  depthNearPeg?: number;
  /** True for the asset prices are measured in: its own peg and depth cannot be read from itself. */
  reference?: boolean;
  /** Issuer sets AUTH_REQUIRED (permissioned holders). */
  authRequired: boolean;
  /** Issuer can claw back. */
  clawback: boolean;
  /** Share of supply held by the top holders, 0..1. */
  topHolderShare?: number;
}

export interface StablecoinScore {
  /** 0 (bad) .. 100 (good). */
  score: number;
  /** Ranking penalty in bps for routing through this asset. */
  penaltyBps: number;
  reasons: string[];
}

/**
 * Transparent scoring used to bias route ranking. The weights are a v0 starting point,
 * not a calibrated model; every deduction is returned in `reasons` so it is explainable.
 */
export function scoreStablecoin(s: StablecoinSignals, tradeSize = 10_000): StablecoinScore {
  let score = 100;
  const reasons: string[] = [];

  if (s.pegPrice !== undefined) {
    const dev = Math.abs(s.pegPrice - 1);
    const pegHit = Math.min(50, dev * 5000); // 1% off peg = -50
    if (pegHit > 0.5) {
      score -= pegHit;
      reasons.push(`peg deviation ${(dev * 100).toFixed(2)}%`);
    }
  }

  if (s.depthNearPeg !== undefined && s.depthNearPeg < tradeSize * 5) {
    const hit = s.depthNearPeg < tradeSize ? 30 : 15;
    score -= hit;
    reasons.push(`thin depth ${Math.round(s.depthNearPeg)} vs trade ${tradeSize}`);
  }
  if (s.authRequired) {
    score -= 10;
    reasons.push("AUTH_REQUIRED: holders must be authorised");
  }
  if (s.clawback) {
    score -= 10;
    reasons.push("issuer clawback enabled");
  }
  if ((s.topHolderShare ?? 0) > 0.6) {
    score -= 10;
    reasons.push(`top holders control ${Math.round((s.topHolderShare ?? 0) * 100)}% of supply`);
  }

  score = Math.max(0, Math.round(score));
  // 100 -> 0 bps, 0 -> 200 bps.
  const penaltyBps = Math.round(((100 - score) / 100) * 200);
  return { score, penaltyBps, reasons };
}

export function penaltyFn(scores: Map<AssetId, StablecoinScore>): (a: AssetId) => number {
  return (a) => scores.get(a)?.penaltyBps ?? 0;
}
