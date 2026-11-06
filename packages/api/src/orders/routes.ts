import type { Context, Hono } from "hono";
import { createSolverNode, FileStore, MemoryStore, RemoteSolver, type SolverNode, type SolverPort } from "@sluice/solver";
import { createOrdersService, type OrdersService } from "./service.js";
import { defaultOrdersDeps } from "./deps.js";
import { loadOrdersConfig, type OrdersConfig, type OrdersSetup } from "./config.js";

/**
 * What `createApp` is given: a running service, or the reason there is none. `background` exists only when the solver runs in
 * this process (local mode): `start()` restores its stored state and begins the recovery loop, `stop()` ends it.
 */
export type OrdersWiring =
  | { enabled: true; service: OrdersService; background?: { start(): Promise<void>; stop(): Promise<void> } }
  | { enabled: false; code: string; reason: string };

export const ORDERS_DISABLED: OrdersWiring = { enabled: false, code: "ORDERS_NOT_CONFIGURED", reason: "settlement orders are not configured on this deployment" };

export interface WireOptions {
  /** Use this solver instead of building one from the configuration (tests). */
  solver?: SolverPort;
  log?: (msg: string, detail?: unknown) => void;
}

/** Build the wiring from environment variables. Never throws: anything wrong becomes a disabled feature with its reason. */
export function ordersFromEnv(env: Record<string, string | undefined>, o: WireOptions = {}): OrdersWiring {
  return wire(loadOrdersConfig(env), o);
}

/** The in-process solver (local mode): the same `SolverNode` the standalone service runs, with its key in this process. */
export function localSolver(config: OrdersConfig, o: WireOptions = {}): SolverNode {
  if (config.solver.mode !== "local") throw new Error("not a local solver configuration");
  const log = o.log ?? ((m: string, d?: unknown) => console.warn(`[solver] ${m}${d === undefined ? "" : ` ${typeof d === "string" ? d : JSON.stringify(d)}`}`));
  if (!config.stateDir) log("SLUICE_STATE_DIR is not set: the in-process solver forgets open positions on restart");
  const store = config.stateDir ? new FileStore(config.stateDir) : new MemoryStore();
  return createSolverNode(
    {
      passphrase: config.networkPassphrase, settleContract: config.settleContract, rpcUrl: config.rpcUrl, horizonUrl: config.horizonUrl, secret: config.solver.secret,
      policy: { ...config.policy, feeOutPerXlm: config.feeOutPerXlm }, recovery: config.recovery, retry: config.retry,
    },
    store,
    { log },
  );
}

export function wire(setup: OrdersSetup, o: WireOptions = {}): OrdersWiring {
  if (!setup.enabled) return { enabled: false, code: setup.code, reason: setup.reason };
  try {
    const { config } = setup;
    let port: SolverPort;
    let background: { start(): Promise<void>; stop(): Promise<void> } | undefined;
    if (o.solver) {
      port = o.solver;
    } else if (config.solver.mode === "remote") {
      port = new RemoteSolver({ url: config.solver.url, token: config.solver.token, address: config.solverAddress });
    } else {
      const node = localSolver(config, o);
      port = node;
      background = {
        start: async () => {
          await node.restore();
          node.start();
        },
        stop: () => node.close(),
      };
    }
    return { enabled: true, service: createOrdersService(config, defaultOrdersDeps(config), port), ...(background ? { background } : {}) };
  } catch (e) {
    return { enabled: false, code: "ORDERS_INVALID", reason: (e as Error).message };
  }
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = (await c.req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `/v1/orders/*`. Registered by `createApp`; the mainnet routes do not know it exists. When the feature is not
 * configured, `config` still answers (200, `enabled: false`) so a client can find out cheaply, and every other
 * route answers 501 with `{ error, explained }`.
 */
export function registerOrderRoutes(app: Hono, orders: OrdersWiring): void {
  const disabled = (c: Context) => {
    if (orders.enabled) throw new Error("unreachable");
    const refused = orders.code === "ORDERS_MAINNET_REFUSED";
    return c.json(
      {
        error: orders.reason,
        explained: {
          code: orders.code === "ORDERS_NOT_CONFIGURED" ? "ORDERS_DISABLED" : orders.code,
          message: refused
            ? "Settlement orders are testnet-only and are refused on the public network until the contract is audited."
            : "Settlement orders are not available on this deployment.",
          detail: orders.reason,
        },
      },
      501,
    );
  };

  app.get("/v1/orders/config", (c) =>
    orders.enabled
      ? c.json(orders.service.publicConfig())
      : c.json({ enabled: false, code: orders.code, reason: orders.reason }),
  );

  app.post("/v1/orders/prepare", async (c) => {
    if (!orders.enabled) return disabled(c);
    const b = await jsonBody(c);
    if (!b) return c.json({ error: "body must be JSON" }, 400);
    const r = await orders.service.prepare(b);
    return c.json(r.body, r.status as 200);
  });

  app.post("/v1/orders/submit", async (c) => {
    if (!orders.enabled) return disabled(c);
    const b = await jsonBody(c);
    if (!b) return c.json({ error: "body must be JSON" }, 400);
    const r = await orders.service.submit(b);
    return c.json(r.body, r.status as 200);
  });

  app.post("/v1/orders/prepare-tx", async (c) => {
    if (!orders.enabled) return disabled(c);
    const b = await jsonBody(c);
    if (!b) return c.json({ error: "body must be JSON" }, 400);
    const r = await orders.service.prepareTx(b);
    return c.json(r.body, r.status as 200);
  });

  app.post("/v1/orders/submit-tx", async (c) => {
    if (!orders.enabled) return disabled(c);
    const b = await jsonBody(c);
    if (!b) return c.json({ error: "body must be JSON" }, 400);
    const r = await orders.service.submitTx(b);
    return c.json(r.body, r.status as 200);
  });

  app.get("/v1/orders/:hash", async (c) => {
    if (!orders.enabled) return disabled(c);
    const r = await orders.service.status(c.req.param("hash").toLowerCase());
    return c.json(r.body, r.status as 200);
  });
}
