import { formatAmount, parseAmount } from "./amounts.js";
import type { AssetId } from "./types.js";

export interface Balance {
  asset: AssetId;
  /** Total held, decimal string. */
  balance: string;
  /** What can actually be sent: balance minus the locked reserve (XLM only) and open-offer liabilities. */
  spendable: string;
  /** Trustline limit; absent for XLM. */
  limit?: string;
  /** False when the issuer has not authorised (or has frozen) this trustline. */
  authorized: boolean;
}

export interface AccountInfo {
  sequence: string;
  /** Assets the account can receive: XLM plus every trustline. */
  assets: Set<AssetId>;
  balances: Balance[];
}

/** The subset of Horizon's account resource this module reads. */
export interface HorizonAccount {
  sequence: string;
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    limit?: string;
    selling_liabilities?: string;
    is_authorized?: boolean;
  }[];
}

/** Base reserve in stroops (0.5 XLM). An account locks two of these plus one per subentry it pays for. */
const BASE_RESERVE = 5_000_000n;

/**
 * Turn a Horizon account into balances with a spendable figure. Liquidity-pool share lines are skipped: they
 * are not routable assets.
 */
export function parseHorizonAccount(a: HorizonAccount): AccountInfo {
  const reserve = BASE_RESERVE * BigInt(2 + (a.subentry_count ?? 0) + (a.num_sponsoring ?? 0) - (a.num_sponsored ?? 0));
  const assets = new Set<AssetId>(["native"]);
  const balances: Balance[] = [];
  for (const b of a.balances) {
    const total = parseAmount(b.balance);
    const liabilities = parseAmount(b.selling_liabilities ?? "0");
    if (b.asset_type === "native") {
      const free = total - reserve - liabilities;
      balances.unshift({ asset: "native", balance: formatAmount(total), spendable: formatAmount(free > 0n ? free : 0n), authorized: true });
    } else if (b.asset_code && b.asset_issuer) {
      const id = `${b.asset_code}:${b.asset_issuer}`;
      assets.add(id);
      const free = total - liabilities;
      balances.push({ asset: id, balance: formatAmount(total), spendable: formatAmount(free > 0n ? free : 0n), limit: b.limit, authorized: b.is_authorized !== false });
    }
  }
  return { sequence: a.sequence, assets, balances };
}
