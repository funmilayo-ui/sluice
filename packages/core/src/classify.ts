import type { Atomicity, Leg } from "./types.js";

/**
 * Classify a sequence of legs by what the protocol lets us do atomically.
 * A Soroban transaction holds exactly one operation, so a Classic leg cannot share a
 * transaction with a Soroban leg.
 */
export function classify(legs: Leg[]): Atomicity {
  if (legs.length === 0) throw new Error("route has no legs");
  const layers = new Set(legs.map((l) => l.layer));
  if (layers.size > 1) return "TWO_STEP";
  if (layers.has("soroban")) return "ATOMIC_SOROBAN";
  // Multiple Classic legs can still be one path payment; we only emit one Classic leg per route.
  return legs.length === 1 ? "CLASSIC_ONLY" : "TWO_STEP";
}
