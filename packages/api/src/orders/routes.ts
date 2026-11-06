import type { Context, Hono } from "hono";
import { createOrdersService, type OrdersHooks, type OrdersService } from "./service.js";
import { defaultOrdersDeps } from "./deps.js";
import { loadOrdersConfig, type OrdersSetup } from "./config.js";

/** What `createApp` is given: a running service, or the reason there is none. */
export type OrdersWiring =
  | { enabled: true; service: OrdersService }
  | { enabled: false; code: string; reason: string };

export const ORDERS_DISABLED: OrdersWiring = { enabled: false, code: "ORDERS_NOT_CONFIGURED", reason: "settlement orders are not configured on this deployment" };

/** Build the wiring from environment variables. Never throws: anything wrong becomes a disabled feature with its reason. */
export function ordersFromEnv(env: Record<string, string | undefined>, hooks?: OrdersHooks): OrdersWiring {
  return wire(loadOrdersConfig(env), hooks);
}

export function wire(setup: OrdersSetup, hooks?: OrdersHooks): OrdersWiring {
  if (!setup.enabled) return { enabled: false, code: setup.code, reason: setup.reason };
  try {
    return { enabled: true, service: createOrdersService(setup.config, defaultOrdersDeps(setup.config), { hooks }) };
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

  app.get("/v1/orders/:hash", async (c) => {
    if (!orders.enabled) return disabled(c);
    const r = await orders.service.status(c.req.param("hash").toLowerCase());
    return c.json(r.body, r.status as 200);
  });
}
