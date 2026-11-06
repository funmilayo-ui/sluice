import { Keypair } from "@stellar/stellar-sdk";
import { createStellarChain } from "./chain.js";
import { MainnetRefused, isPublicNetwork } from "./guard.js";
import { SolverNode, type RetryPolicy, type SolverNodeOptions, type SolverPolicy } from "./node.js";
import type { RecoveryConfig } from "./recovery.js";
import { FileStore, MemoryStore, type StateStore } from "./store.js";

type Env = Record<string, string | undefined>;

export interface SolverNodeConfig {
  passphrase: string;
  settleContract: string;
  rpcUrl: string;
  horizonUrl: string;
  /** The solver's secret key. Never logged, never returned. */
  secret: string;
  policy: SolverPolicy;
  recovery: Partial<RecoveryConfig>;
  retry: Partial<RetryPolicy>;
}

function int(env: Env, name: string, dflt: number, min: number, max: number): number | string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : `${name} must be an integer in ${min}..${max}`;
}

/**
 * The policy and recovery knobs, read from `<prefix>MAX_ORDER_IN`, `<prefix>MIN_PROFIT_BPS`, ... The API's local mode
 * reads them with prefix `ORDERS_`, the solver service with `SOLVER_`, so the two names of one setting never drift apart.
 * Returns a message when a value is out of range.
 */
export function loadKnobs(env: Env, prefix: string): { policy: SolverPolicy; recovery: Partial<RecoveryConfig>; retry: Partial<RetryPolicy> } | string {
  const n = (suffix: string, dflt: number, min: number, max: number) => int(env, `${prefix}${suffix}`, dflt, min, max);
  const maxOrderIn = n("MAX_ORDER_IN", 1000, 1, 1_000_000_000);
  const hedgeSlippageBps = n("HEDGE_SLIPPAGE_BPS", 50, 0, 10_000);
  const minProfitBps = n("MIN_PROFIT_BPS", 20, 0, 10_000);
  const improvementShareBps = n("IMPROVEMENT_BPS", 5000, 0, 10_000);
  const minDeadlineBufferSec = n("MIN_DEADLINE_BUFFER_SEC", 60, 0, 3600);
  const maxRetries = n("MAX_RETRIES", 3, 0, 20);
  const maxLossBps = n("MAX_LOSS_BPS", 100, 0, 10_000);
  const maxUnhedged = n("MAX_UNHEDGED_OUT", 0, 0, 1_000_000_000);
  const tickMs = n("RETRY_TICK_MS", 15_000, 100, 3_600_000);
  const baseDelayMs = n("RETRY_BASE_MS", 30_000, 0, 3_600_000);
  const maxDelayMs = n("RETRY_MAX_MS", 600_000, 0, 86_400_000);
  const maxCycles = n("RETRY_MAX_CYCLES", 12, 0, 1000);
  for (const v of [maxOrderIn, hedgeSlippageBps, minProfitBps, improvementShareBps, minDeadlineBufferSec, maxRetries, maxLossBps, maxUnhedged, tickMs, baseDelayMs, maxDelayMs, maxCycles]) {
    if (typeof v === "string") return v;
  }
  const feeOutPerXlm = (env[`${prefix}FEE_OUT_PER_XLM`] ?? "0.1").trim();
  if (!/^\d+(\.\d{1,7})?$/.test(feeOutPerXlm)) return `${prefix}FEE_OUT_PER_XLM must be a decimal with at most 7 places`;
  return {
    policy: {
      maxOrderIn: BigInt(maxOrderIn as number) * 10_000_000n,
      hedgeSlippageBps: hedgeSlippageBps as number,
      minProfitBps: minProfitBps as number,
      improvementShareBps: improvementShareBps as number,
      minDeadlineBufferSec: minDeadlineBufferSec as number,
      feeOutPerXlm,
    },
    recovery: {
      maxRetries: maxRetries as number,
      maxLossBps: maxLossBps as number,
      hedgeSlippageBps: hedgeSlippageBps as number,
      maxUnhedgedExposureOut: BigInt(maxUnhedged as number) * 10_000_000n,
    },
    retry: { tickMs: tickMs as number, baseDelayMs: baseDelayMs as number, maxDelayMs: maxDelayMs as number, maxCycles: maxCycles as number },
  };
}

/** A real node: the Stellar chain behind the key, and the given store. Call `restore()` then `start()` on it. */
export function createSolverNode(config: SolverNodeConfig, store: StateStore, o: Partial<SolverNodeOptions> = {}): SolverNode {
  const chain = createStellarChain({ rpcUrl: config.rpcUrl, horizonUrl: config.horizonUrl, passphrase: config.passphrase, settleContract: config.settleContract, secret: config.secret });
  return new SolverNode({ chain, store, passphrase: config.passphrase, settleContract: config.settleContract, policy: config.policy, recovery: config.recovery, retry: config.retry, ...o });
}

/** `FileStore` at `SLUICE_STATE_DIR`, or memory (with `memory: true`) when it is not set. */
export function storeFromEnv(env: Env): { store: StateStore; memory: boolean } {
  const dir = (env.SLUICE_STATE_DIR ?? "").trim();
  return dir ? { store: new FileStore(dir), memory: false } : { store: new MemoryStore(), memory: true };
}

export interface SolverServiceConfig {
  node: SolverNodeConfig;
  /** The shared secret every request must present as `Authorization: Bearer <token>`. */
  token: string;
  port: number;
  host: string;
  stateDir?: string;
}

export type SolverServiceSetup = { ok: true; config: SolverServiceConfig } | { ok: false; reason: string };

const REQUIRED = ["SOLVER_SECRET", "SOLVER_AUTH_TOKEN", "SOLVER_SETTLE_CONTRACT", "SOLVER_RPC_URL", "SOLVER_HORIZON_URL", "SOLVER_NETWORK_PASSPHRASE"] as const;

/** Read the solver service's configuration. Never throws; the reason says what is wrong and never echoes a secret. */
export function loadSolverServiceConfig(env: Env = process.env): SolverServiceSetup {
  const passphrase = (env.SOLVER_NETWORK_PASSPHRASE ?? "").trim();
  if (passphrase && isPublicNetwork(passphrase)) return { ok: false, reason: new MainnetRefused().message };
  const missing = REQUIRED.filter((k) => (env[k] ?? "").trim() === "");
  if (missing.length) return { ok: false, reason: `missing ${missing.join(", ")}` };
  const settleContract = env.SOLVER_SETTLE_CONTRACT!.trim();
  if (!/^C[A-Z2-7]{55}$/.test(settleContract)) return { ok: false, reason: "SOLVER_SETTLE_CONTRACT is not a C... contract id" };
  for (const k of ["SOLVER_RPC_URL", "SOLVER_HORIZON_URL"] as const) {
    try {
      const u = new URL(env[k]!.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      return { ok: false, reason: `${k} is not a URL` };
    }
  }
  try {
    Keypair.fromSecret(env.SOLVER_SECRET!.trim());
  } catch {
    return { ok: false, reason: "SOLVER_SECRET is not a valid secret key" };
  }
  const token = env.SOLVER_AUTH_TOKEN!.trim();
  if (token.length < 32) return { ok: false, reason: "SOLVER_AUTH_TOKEN must be at least 32 characters (use `openssl rand -hex 32`)" };
  const knobs = loadKnobs(env, "SOLVER_");
  if (typeof knobs === "string") return { ok: false, reason: knobs };
  const port = int(env, "SOLVER_PORT", 8788, 1, 65535);
  if (typeof port === "string") return { ok: false, reason: port };
  const stateDir = (env.SLUICE_STATE_DIR ?? "").trim();
  if (!stateDir && env.SOLVER_ALLOW_MEMORY_STATE !== "1") {
    return { ok: false, reason: "SLUICE_STATE_DIR is not set: the solver would forget open positions on a restart. Set it, or set SOLVER_ALLOW_MEMORY_STATE=1 for a throwaway run" };
  }
  return {
    ok: true,
    config: {
      node: { passphrase, settleContract, rpcUrl: env.SOLVER_RPC_URL!.trim(), horizonUrl: env.SOLVER_HORIZON_URL!.trim().replace(/\/+$/, ""), secret: env.SOLVER_SECRET!.trim(), ...knobs },
      token,
      port,
      host: (env.SOLVER_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
      ...(stateDir ? { stateDir } : {}),
    },
  };
}
