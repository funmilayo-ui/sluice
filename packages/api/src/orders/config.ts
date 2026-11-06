import { Keypair, Networks } from "@stellar/stellar-sdk";

type Env = Record<string, string | undefined>;

/** Everything the orders feature needs. Separate from the mainnet quote/build API's own `HORIZON_URL` / `RPC_URL`. */
export interface OrdersConfig {
  settleContract: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  /** Secret key of the solver account. Held in this process: see the README for what that means. Never logged or returned. */
  solverSecret: string;
  /** Key for the HMAC that makes `orderId` verifiable without a database. */
  macSecret: string;
  /** Token_out per 1 XLM, to price network fees when the order does not pay out XLM. Testnet has no market to read it from. */
  feeOutPerXlm: string;
  policy: {
    /** Largest `amountIn` the solver takes on, in whole token_in units. */
    maxOrderIn: bigint;
    hedgeSlippageBps: number;
    minProfitBps: number;
    improvementShareBps: number;
    minDeadlineBufferSec: number;
  };
}

export type OrdersSetup =
  | { enabled: true; config: OrdersConfig }
  | { enabled: false; code: "ORDERS_NOT_CONFIGURED" | "ORDERS_INCOMPLETE" | "ORDERS_INVALID" | "ORDERS_MAINNET_REFUSED"; reason: string };

/**
 * True for the public (mainnet) network passphrase, however it is spelled.
 *
 * HARD GUARD. The settlement contract is unaudited, and in this prototype the solver's key and funds live in
 * the API process. Neither is acceptable with real money, so the orders feature refuses to run against the
 * public network until the contract has been audited and the solver has been moved out of this process
 * (see README "Settlement orders"). There is deliberately no environment switch to override this: lifting it
 * is a code change that has to be reviewed. It is enforced in three places: when the environment is read
 * (`loadOrdersConfig`), when a service is built (`assertNotMainnet`), and against the network the RPC
 * endpoint itself reports (checked on first use, cached once it passes).
 */
export function isPublicNetwork(passphrase: string): boolean {
  const p = passphrase.trim().toLowerCase();
  return p === Networks.PUBLIC.toLowerCase() || p.includes("public global stellar network");
}

export class MainnetRefused extends Error {
  constructor() {
    super("settlement orders are testnet-only: the public network is refused until the contract is audited");
    this.name = "MainnetRefused";
  }
}

export function assertNotMainnet(passphrase: string): void {
  if (isPublicNetwork(passphrase)) throw new MainnetRefused();
}

/** "testnet", "futurenet" or "custom": a label for clients, derived from the passphrase. */
export function networkName(passphrase: string): string {
  if (passphrase === Networks.TESTNET) return "testnet";
  if (passphrase === Networks.FUTURENET) return "futurenet";
  return "custom";
}

const REQUIRED = [
  ["ORDERS_SETTLE_CONTRACT", "settle contract id"],
  ["ORDERS_RPC_URL", "Soroban RPC URL"],
  ["ORDERS_HORIZON_URL", "Horizon URL"],
  ["ORDERS_NETWORK_PASSPHRASE", "network passphrase"],
  ["ORDERS_SOLVER_SECRET", "solver secret key"],
  ["ORDERS_MAC_SECRET", "order id signing secret"],
] as const;

function int(env: Env, name: string, dflt: number, min: number, max: number): number | string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : `${name} must be an integer in ${min}..${max}`;
}

/**
 * Read the orders configuration. Disabled (never throws) unless every required variable is present and valid;
 * the reason says which. Secrets are never echoed back in a reason.
 */
export function loadOrdersConfig(env: Env = process.env): OrdersSetup {
  const present = REQUIRED.filter(([k]) => (env[k] ?? "").trim() !== "");
  if (present.length === 0) {
    return { enabled: false, code: "ORDERS_NOT_CONFIGURED", reason: "settlement orders are not configured on this deployment" };
  }
  // Checked before anything else: a mainnet passphrase is refused even when the rest is missing or wrong.
  const passphrase = (env.ORDERS_NETWORK_PASSPHRASE ?? "").trim();
  if (passphrase && isPublicNetwork(passphrase)) {
    return { enabled: false, code: "ORDERS_MAINNET_REFUSED", reason: new MainnetRefused().message };
  }
  const missing = REQUIRED.filter(([k]) => (env[k] ?? "").trim() === "");
  if (missing.length) {
    return { enabled: false, code: "ORDERS_INCOMPLETE", reason: `settlement orders are half configured; missing ${missing.map(([k]) => k).join(", ")}` };
  }
  const settleContract = env.ORDERS_SETTLE_CONTRACT!.trim();
  if (!/^C[A-Z2-7]{55}$/.test(settleContract)) return { enabled: false, code: "ORDERS_INVALID", reason: "ORDERS_SETTLE_CONTRACT is not a C... contract id" };
  for (const k of ["ORDERS_RPC_URL", "ORDERS_HORIZON_URL"] as const) {
    try {
      const u = new URL(env[k]!.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      return { enabled: false, code: "ORDERS_INVALID", reason: `${k} is not a URL` };
    }
  }
  try {
    Keypair.fromSecret(env.ORDERS_SOLVER_SECRET!.trim());
  } catch {
    return { enabled: false, code: "ORDERS_INVALID", reason: "ORDERS_SOLVER_SECRET is not a valid secret key" };
  }
  const macSecret = env.ORDERS_MAC_SECRET!.trim();
  if (macSecret.length < 16) return { enabled: false, code: "ORDERS_INVALID", reason: "ORDERS_MAC_SECRET must be at least 16 characters" };
  const feeOutPerXlm = (env.ORDERS_FEE_OUT_PER_XLM ?? "0.1").trim();
  if (!/^\d+(\.\d{1,7})?$/.test(feeOutPerXlm)) return { enabled: false, code: "ORDERS_INVALID", reason: "ORDERS_FEE_OUT_PER_XLM must be a decimal with at most 7 places" };

  const maxOrderIn = int(env, "ORDERS_MAX_ORDER_IN", 1000, 1, 1_000_000_000);
  const hedgeSlippageBps = int(env, "ORDERS_HEDGE_SLIPPAGE_BPS", 50, 0, 10_000);
  const minProfitBps = int(env, "ORDERS_MIN_PROFIT_BPS", 20, 0, 10_000);
  const improvementShareBps = int(env, "ORDERS_IMPROVEMENT_BPS", 5000, 0, 10_000);
  const minDeadlineBufferSec = int(env, "ORDERS_MIN_DEADLINE_BUFFER_SEC", 60, 0, 3600);
  for (const v of [maxOrderIn, hedgeSlippageBps, minProfitBps, improvementShareBps, minDeadlineBufferSec]) {
    if (typeof v === "string") return { enabled: false, code: "ORDERS_INVALID", reason: v };
  }
  return {
    enabled: true,
    config: {
      settleContract,
      rpcUrl: env.ORDERS_RPC_URL!.trim(),
      horizonUrl: env.ORDERS_HORIZON_URL!.trim().replace(/\/+$/, ""),
      networkPassphrase: passphrase,
      solverSecret: env.ORDERS_SOLVER_SECRET!.trim(),
      macSecret,
      feeOutPerXlm,
      policy: {
        maxOrderIn: BigInt(maxOrderIn as number) * 10_000_000n,
        hedgeSlippageBps: hedgeSlippageBps as number,
        minProfitBps: minProfitBps as number,
        improvementShareBps: improvementShareBps as number,
        minDeadlineBufferSec: minDeadlineBufferSec as number,
      },
    },
  };
}
