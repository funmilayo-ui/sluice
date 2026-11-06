import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SolverNode } from "./node.js";
import { preparedTxToWire, requestFromWire } from "./wire.js";

/** Constant-time comparison of two secrets of any length: both sides are hashed first, so neither length nor content leaks through timing. */
export function secretsEqual(given: string, want: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** The value of an `Authorization: Bearer ...` header, or the empty string. */
export function bearer(header: string | undefined): string {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  return m ? m[1]! : "";
}

/**
 * The solver service: the only place the solver key is used when the API runs in remote mode. Every route, health
 * included, needs the shared bearer token. Request and response bodies are JSON; amounts are decimal strings of stroops.
 * A request the solver understood always answers 200 with a `kind` that says what happened (`sent`, `refused`, `invalid`,
 * `sim_failed`, `rejected`, `busy`, `error`): HTTP errors mean the request itself was unusable (400) or unauthenticated (401).
 */
export function createSolverApp(node: SolverNode, opts: { token: string }): Hono {
  if (opts.token.length < 16) throw new Error("the solver service token must be at least 16 characters");
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!secretsEqual(bearer(c.req.header("authorization")), opts.token)) {
      return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }));

  const body = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const b = (await c.req.json()) as unknown;
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const bad = (c: Context, message: string) => c.json({ error: message }, 400);

  app.get("/health", async (c) => c.json(await node.health()));

  app.post("/fill", async (c) => {
    const b = await body(c);
    if (!b) return bad(c, "body must be JSON");
    const req = requestFromWire(b, "fill");
    if (typeof req === "string") return bad(c, req);
    return c.json(outcomeToWire(await node.fill(req as Parameters<SolverNode["fill"]>[0])));
  });

  app.post("/prepare-tx", async (c) => {
    const b = await body(c);
    if (!b) return bad(c, "body must be JSON");
    const req = requestFromWire(b, "prepare-tx");
    if (typeof req === "string") return bad(c, req);
    const r = await node.prepareTx(req as Parameters<SolverNode["prepareTx"]>[0]);
    return c.json(r.kind === "prepared" ? { kind: "prepared", tx: preparedTxToWire(r.tx) } : outcomeToWire(r));
  });

  app.post("/submit-tx", async (c) => {
    const b = await body(c);
    if (!b) return bad(c, "body must be JSON");
    if (typeof b.signedTx !== "string" || !b.signedTx) return bad(c, "signedTx is required");
    return c.json(outcomeToWire(await node.submitTx({ signedTx: b.signedTx })));
  });

  app.get("/status/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return bad(c, "hash must be 64 hex characters");
    const hedge = await node.orderStatus(hash);
    return hedge ? c.json({ known: true, hedge }) : c.json({ known: false });
  });

  // Operator routes: the positions the solver holds, and the two things only a person should decide.
  app.get("/exposures", async (c) => {
    await node.restore();
    return c.json({ exposures: node.exposures() });
  });
  app.post("/exposures/:id/retry", async (c) => {
    const b = (await body(c)) ?? {};
    const maxLossBps = b.maxLossBps === undefined ? undefined : Number(b.maxLossBps);
    if (maxLossBps !== undefined && (!Number.isInteger(maxLossBps) || maxLossBps < 0 || maxLossBps > 10_000)) return bad(c, "maxLossBps must be an integer in 0..10000");
    const hedge = await node.retryNow(c.req.param("id"), maxLossBps === undefined ? {} : { maxLossBps });
    return hedge ? c.json({ known: true, hedge }) : c.json({ known: false }, 404);
  });
  app.post("/exposures/:id/clear", async (c) => ((await node.clearExposure(c.req.param("id"))) ? c.json({ cleared: true }) : c.json({ cleared: false }, 404)));

  return app;
}

/** Outcomes carry no bigints except in `prepared`, which has its own encoder; this keeps JSON serialisation honest anyway. */
function outcomeToWire<T extends { kind: string }>(o: T): unknown {
  return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

