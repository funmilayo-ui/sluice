import { Keypair, Networks } from "@stellar/stellar-sdk";
import { assertNotMainnet, isPublicNetwork, loadKnobs, MainnetRefused, type RecoveryConfig, type RetryPolicy } from "@sluice/solver";

type Env = Record<string, string | undefined>;

/**
 * Where the solver runs.
 *   remote  production path. The solver is its own service with its own key (`packages/solver`, `SOLVER_*`); the API holds
 *           only its URL, a bearer token and its public address, and cannot sign anything as the solver.
 *   local   development and tests. The solver runs inside this process and its secret key lives here.
 */
export type SolverSetup = { mode: "local"; secret: string } | { mode: "remote"; url: string; token: string };

/** Everything the orders feature needs. Separate from the mainnet quote/build API's own `HORIZON_URL` / `RPC_URL`. */
export interface OrdersConfig {
  settleContract: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  solver: SolverSetup;
  /** The solver's public address: derived from the key in local mode, configured (and checked against the service) in remote mode. */
  solverAddress: string;
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
  /** Recovery and retry settings of an in-process solver (local mode). A remote solver reads its own. */
  recovery: Partial<RecoveryConfig>;
  retry: Partial<RetryPolicy>;
  /** `SLUICE_STATE_DIR`: where an in-process solver keeps its durable state. Unset means memory only. */
  stateDir?: string;
}

export type OrdersSetup =
  | { enabled: true; config: OrdersConfig }
  | { enabled: false; code: "ORDERS_NOT_CONFIGURED" | "ORDERS_INCOMPLETE" | "ORDERS_INVALID" | "ORDERS_MAINNET_REFUSED"; reason: string };

// The guard itself lives in @sluice/solver, which enforces it too: the solver service refuses the public network on its own.
export { assertNotMainnet, isPublicNetwork, MainnetRefused };

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
  ["ORDERS_MAC_SECRET", "order id signing secret"],
] as const;
const SOLVER_VARS = ["ORDERS_SOLVER_MODE", "ORDERS_SOLVER_SECRET", "ORDERS_SOLVER_URL", "ORDERS_SOLVER_TOKEN", "ORDERS_SOLVER_ADDRESS"] as const;

/**
 * Read the orders configuration. Disabled (never throws) unless every required variable is present and valid;
 * the reason says which. Secrets are never echoed back in a reason.
 */
export function loadOrdersConfig(env: Env = process.env): OrdersSetup {
  const present = [...REQUIRED.map(([k]) => k), ...SOLVER_VARS].filter((k) => (env[k] ?? "").trim() !== "");
  if (present.length === 0) {
    return { enabled: false, code: "ORDERS_NOT_CONFIGURED", reason: "settlement orders are not configured on this deployment" };
  }
  // Checked before anything else: a mainnet passphrase is refused even when the rest is missing or wrong.
  const passphrase = (env.ORDERS_NETWORK_PASSPHRASE ?? "").trim();
  if (passphrase && isPublicNetwork(passphrase)) {
    return { enabled: false, code: "ORDERS_MAINNET_REFUSED", reason: new MainnetRefused().message };
  }
  const has = (k: string) => (env[k] ?? "").trim() !== "";
  const invalid = (reason: string): OrdersSetup => ({ enabled: false, code: "ORDERS_INVALID", reason });

  // Which solver: explicit, else inferred (a secret means local, a URL means remote), else local so the old message about the secret still applies.
  const rawMode = (env.ORDERS_SOLVER_MODE ?? "").trim();
  if (rawMode && rawMode !== "local" && rawMode !== "remote") return invalid("ORDERS_SOLVER_MODE must be 'local' or 'remote'");
  const mode: "local" | "remote" = (rawMode as "local" | "remote" | "") || (has("ORDERS_SOLVER_URL") && !has("ORDERS_SOLVER_SECRET") ? "remote" : "local");

  const missing: string[] = REQUIRED.filter(([k]) => !has(k)).map(([k]) => k);
  if (mode === "local" && !has("ORDERS_SOLVER_SECRET")) missing.push("ORDERS_SOLVER_SECRET");
  if (mode === "remote") for (const k of ["ORDERS_SOLVER_URL", "ORDERS_SOLVER_TOKEN", "ORDERS_SOLVER_ADDRESS"]) if (!has(k)) missing.push(k);
  if (missing.length) {
    return { enabled: false, code: "ORDERS_INCOMPLETE", reason: `settlement orders are half configured; missing ${missing.join(", ")}` };
  }
  // The point of remote mode is that this process cannot sign as the solver. A secret next to a remote URL is a mistake worth stopping on.
  if (mode === "remote" && has("ORDERS_SOLVER_SECRET")) {
    return invalid("ORDERS_SOLVER_MODE=remote: unset ORDERS_SOLVER_SECRET; the API must not hold the solver key when the solver runs as its own service");
  }
  if (mode === "local" && (has("ORDERS_SOLVER_URL") || has("ORDERS_SOLVER_TOKEN"))) {
    return invalid("ORDERS_SOLVER_MODE=local but ORDERS_SOLVER_URL / ORDERS_SOLVER_TOKEN are set; choose one solver");
  }

  const settleContract = env.ORDERS_SETTLE_CONTRACT!.trim();
  if (!/^C[A-Z2-7]{55}$/.test(settleContract)) return invalid("ORDERS_SETTLE_CONTRACT is not a C... contract id");
  for (const k of ["ORDERS_RPC_URL", "ORDERS_HORIZON_URL"] as const) {
    try {
      const u = new URL(env[k]!.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      return invalid(`${k} is not a URL`);
    }
  }
  let solver: SolverSetup;
  let solverAddress: string;
  if (mode === "local") {
    try {
      solverAddress = Keypair.fromSecret(env.ORDERS_SOLVER_SECRET!.trim()).publicKey();
    } catch {
      return invalid("ORDERS_SOLVER_SECRET is not a valid secret key");
    }
    solver = { mode: "local", secret: env.ORDERS_SOLVER_SECRET!.trim() };
  } else {
    try {
      const u = new URL(env.ORDERS_SOLVER_URL!.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      return invalid("ORDERS_SOLVER_URL is not a URL");
    }
    solverAddress = env.ORDERS_SOLVER_ADDRESS!.trim();
    try {
      Keypair.fromPublicKey(solverAddress);
    } catch {
      return invalid("ORDERS_SOLVER_ADDRESS is not a valid public key (G...)");
    }
    const token = env.ORDERS_SOLVER_TOKEN!.trim();
    if (token.length < 32) return invalid("ORDERS_SOLVER_TOKEN must be at least 32 characters");
    solver = { mode: "remote", url: env.ORDERS_SOLVER_URL!.trim().replace(/\/+$/, ""), token };
  }
  const macSecret = env.ORDERS_MAC_SECRET!.trim();
  if (macSecret.length < 16) return invalid("ORDERS_MAC_SECRET must be at least 16 characters");
  const knobs = loadKnobs(env, "ORDERS_");
  if (typeof knobs === "string") return invalid(knobs);
  const stateDir = (env.SLUICE_STATE_DIR ?? "").trim();
  const { feeOutPerXlm, ...policy } = knobs.policy;
  return {
    enabled: true,
    config: {
      settleContract,
      rpcUrl: env.ORDERS_RPC_URL!.trim(),
      horizonUrl: env.ORDERS_HORIZON_URL!.trim().replace(/\/+$/, ""),
      networkPassphrase: passphrase,
      solver,
      solverAddress,
      macSecret,
      feeOutPerXlm,
      policy,
      recovery: knobs.recovery,
      retry: knobs.retry,
      ...(stateDir ? { stateDir } : {}),
    },
  };
}
