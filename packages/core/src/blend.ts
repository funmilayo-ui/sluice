import { Address } from "@stellar/stellar-sdk";
import { formatAmount } from "./amounts.js";
import { sacId } from "./assets.js";
import { simulateView } from "./rpc.js";
import type { AssetId } from "./types.js";

/** Blend fixed point: rates use 12 decimals, config ratios use 7 (blend-contracts-v2 `constants.rs`). */
const SCALAR_12 = 1_000_000_000_000n;
const S7 = 10_000_000;

/** Pool status as defined in blend-contracts-v2 `pool/status.rs`. */
export const BLEND_STATUS = ["Admin active", "Active", "Admin on-ice", "On-ice", "Admin frozen", "Frozen", "Setup"] as const;

interface ReserveConfig { decimals: number; enabled: boolean; index: number; util: number; max_util: number; r_base: number; r_one: number; r_two: number; r_three: number; supply_cap: bigint }
interface ReserveData { b_rate: bigint; b_supply: bigint; d_rate: bigint; d_supply: bigint; ir_mod: bigint }
interface RawReserve { asset: string; config: ReserveConfig; data: ReserveData }

export interface BlendReserve {
  asset: AssetId;
  /** Token contract id (C...). */
  contract: string;
  /** Position key inside the pool. */
  index: number;
  /** Total supplied and borrowed, in the underlying asset. */
  supplied: string;
  borrowed: string;
  /** Borrowed over supplied, 0..1. */
  utilization: number;
  /** Supplier and borrower rates per year at the current utilisation, as fractions (0.05 = 5%). Variable. */
  supplyApr: number;
  borrowApr: number;
  /** Room left under the reserve's supply cap, in the underlying asset. */
  capRemaining: string;
}

export interface BlendPool {
  id: string;
  status: number;
  statusLabel: string;
  /** Supply is rejected by the contract when the pool is frozen (status above 3). Withdraw is always allowed. */
  supplyOpen: boolean;
  reserves: BlendReserve[];
}

export interface BlendPosition {
  asset: AssetId;
  /** Supplied (non-collateral) plus collateral, in the underlying asset, at the current bToken rate. */
  supplied: string;
  collateral: string;
}

/**
 * Yearly borrow and supply rates for a reserve, following `calc_accrual` in blend-contracts-v2
 * `pool/interest.rs` (three-segment curve scaled by the rate modifier). Suppliers receive the interest
 * borrowers pay, minus the backstop's share: supply = borrow x utilisation x (1 - bstop_rate).
 * Floating point is fine: this is a displayed estimate of a rate that moves with every borrow and repay.
 */
export function blendRates(cfg: Pick<ReserveConfig, "util" | "r_base" | "r_one" | "r_two" | "r_three">, utilization: number, irMod: bigint, bstopRate: number): { borrowApr: number; supplyApr: number } {
  const target = cfg.util / S7;
  const [rBase, rOne, rTwo, rThree] = [cfg.r_base / S7, cfg.r_one / S7, cfg.r_two / S7, cfg.r_three / S7];
  const mod = Number(irMod) / S7;
  let borrowApr: number;
  if (utilization <= target) {
    borrowApr = ((utilization / target) * rOne + rBase) * mod;
  } else if (utilization <= 0.95) {
    borrowApr = (((utilization - target) / (0.95 - target)) * rTwo + rOne + rBase) * mod;
  } else {
    borrowApr = ((utilization - 0.95) / 0.05) * rThree + mod * (rTwo + rOne + rBase);
  }
  return { borrowApr, supplyApr: borrowApr * utilization * (1 - bstopRate / S7) };
}

/** Turn one `get_reserve` result into display figures. Exported for tests. */
export function describeReserve(asset: AssetId, r: RawReserve, bstopRate: number): BlendReserve {
  const supplied = (r.data.b_supply * r.data.b_rate) / SCALAR_12;
  const borrowed = (r.data.d_supply * r.data.d_rate) / SCALAR_12;
  const utilization = supplied > 0n ? Math.min(1, Number(borrowed) / Number(supplied)) : 0;
  const cap = r.config.supply_cap - supplied;
  return {
    asset,
    contract: r.asset,
    index: r.config.index,
    supplied: formatAmount(supplied),
    borrowed: formatAmount(borrowed),
    utilization,
    ...blendRates(r.config, utilization, r.data.ir_mod, bstopRate),
    capRemaining: formatAmount(cap > 0n ? cap : 0n),
  };
}

/**
 * A token contract's Classic asset, or null when it is not a Stellar Asset Contract. The asset contract's
 * `name()` returns "native" or "CODE:ISSUER"; the id is re-derived and compared so a token that merely
 * claims a name is not mistaken for the real asset.
 */
async function assetOf(rpcUrl: string, contract: string, passphrase?: string): Promise<AssetId | null> {
  try {
    const name = String(await simulateView(rpcUrl, contract, "name", [], { passphrase }));
    return sacId(name, passphrase) === contract ? name : null;
  } catch {
    return null;
  }
}

/**
 * Live state of a Blend v2 pool, read from the contract over Stellar RPC (`get_config`, `get_reserve_list`,
 * `get_reserve`; interface read on-chain 2026-10-08). Only enabled 7-decimal reserves whose token is a
 * Classic asset are returned, because those are the ones this router can swap into and deposit.
 */
export async function fetchBlendPool(rpcUrl: string, pool: string, passphrase?: string): Promise<BlendPool> {
  const view = (fn: string, args: Parameters<typeof simulateView>[3] = []) => simulateView(rpcUrl, pool, fn, args, { passphrase });
  const [config, list] = (await Promise.all([view("get_config"), view("get_reserve_list")])) as [{ bstop_rate: number; status: number }, string[]];
  const reserves = await Promise.all(
    list.map(async (contract): Promise<BlendReserve | null> => {
      const [asset, raw] = await Promise.all([assetOf(rpcUrl, contract, passphrase), view("get_reserve", [new Address(contract).toScVal()]) as Promise<RawReserve>]);
      if (!asset || !raw.config.enabled || raw.config.decimals !== 7) return null;
      return describeReserve(asset, raw, config.bstop_rate);
    }),
  );
  return {
    id: pool,
    status: config.status,
    statusLabel: BLEND_STATUS[config.status] ?? `Status ${config.status}`,
    supplyOpen: config.status <= 3,
    reserves: reserves.filter((r): r is BlendReserve => r !== null),
  };
}

/** What `account` has supplied to a pool, valued in the underlying asset at the current bToken rate. */
export async function fetchBlendPositions(rpcUrl: string, pool: string, account: string, passphrase?: string): Promise<BlendPosition[]> {
  const view = (fn: string, args: Parameters<typeof simulateView>[3] = []) => simulateView(rpcUrl, pool, fn, args, { passphrase });
  const [positions, list] = (await Promise.all([view("get_positions", [new Address(account).toScVal()]), view("get_reserve_list")])) as [
    { supply: Record<string, bigint> | Map<number, bigint>; collateral: Record<string, bigint> | Map<number, bigint> },
    string[],
  ];
  const at = (m: Record<string, bigint> | Map<number, bigint>, i: number): bigint => (m instanceof Map ? m.get(i) : m[String(i)]) ?? 0n;
  const out: BlendPosition[] = [];
  await Promise.all(
    list.map(async (contract, index) => {
      const [supply, collateral] = [at(positions.supply, index), at(positions.collateral, index)];
      if (supply <= 0n && collateral <= 0n) return;
      const [asset, raw] = await Promise.all([assetOf(rpcUrl, contract, passphrase), view("get_reserve", [new Address(contract).toScVal()]) as Promise<RawReserve>]);
      if (!asset) return;
      const value = (b: bigint) => formatAmount((b * raw.data.b_rate) / SCALAR_12);
      out.push({ asset, supplied: value(supply), collateral: value(collateral) });
    }),
  );
  return out.sort((p, q) => p.asset.localeCompare(q.asset));
}
