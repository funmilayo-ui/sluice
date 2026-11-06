import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  aquariusSource,
  BLEND_FIXED_V2_POOL,
  buildChangeTrust,
  buildVaultDeposit,
  buildVaultWithdraw,
  cometSource,
  explainCodes,
  explainSimulation,
  formatAmount,
  horizonSource,
  parseAmount,
  parseSignedTx,
  phoenixSource,
  planExecution,
  receivedAmount,
  routeKey,
  Router,
  sacId,
  soroswapSource,
  type createStablecoinScorer,
  type KvCache,
  type QuoteResult,
  type QuoteSource,
  type Route,
} from "@sluice/core";
import { ACCOUNT_NOT_FOUND, defaultDeps, type Deps } from "./deps.js";
import { ORDERS_DISABLED, registerOrderRoutes, type OrdersWiring } from "./orders/routes.js";

export { defaultDeps, type Deps } from "./deps.js";

export const DEFAULT_HUBS = [
  "native",
  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
];

/** Blend pools offered for deposit. The default is the one pool whose interface and deposit were verified. */
export interface VaultConfig { id: string; name: string }
export const DEFAULT_VAULTS: VaultConfig[] = [{ id: BLEND_FIXED_V2_POOL, name: "Blend Fixed Pool V2" }];

/** Long enough to read and approve a wallet prompt; the builders' own default of 60s is not. */
const TX_TIMEOUT_SEC = 300;

export function defaultSources(env: Record<string, string | undefined> = process.env, cache?: KvCache): QuoteSource[] {
  const rpcUrl = env.RPC_URL;
  const sources: QuoteSource[] = [
    horizonSource(env.HORIZON_URL),
    aquariusSource(env.AQUARIUS_URL),
    phoenixSource({ rpcUrl, cache }),
    cometSource({ rpcUrl }),
  ];
  sources.push(soroswapSource({ rpcUrl, hubs: DEFAULT_HUBS }));
  return sources;
}

/** bigint is not JSON-serialisable; amounts go out as decimal strings plus raw stroops. */
export function serializeRoute(r: Route) {
  return {
    key: routeKey(r),
    atomicity: r.atomicity,
    assetIn: r.assetIn,
    assetOut: r.assetOut,
    amountIn: formatAmount(r.amountIn),
    amountOut: formatAmount(r.amountOut),
    effectiveOut: formatAmount(r.effectiveOut),
    risks: r.risks,
    legs: r.legs.map((l, i) => ({
      venue: l.venue,
      layer: l.layer,
      assetIn: l.assetIn,
      assetOut: l.assetOut,
      amountIn: formatAmount(l.amountIn),
      amountOut: formatAmount(l.amountOut),
      minOut: formatAmount(r.minOuts[i]!),
      hops: l.hops,
    })),
  };
}

const ACCOUNT = /^G[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;
const ASSET = /^(native|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$/;
const TX_HASH = /^[0-9a-f]{64}$/;

export interface AppOpts {
  routerContract?: string;
  /** Stablecoins scored for ranking; exposed at /v1/stablecoins and refreshed lazily before quoting. */
  scorer?: ReturnType<typeof createStablecoinScorer>;
  vaults?: VaultConfig[];
  /** Directory holding the built web app (index.html and assets). Omit when a CDN serves it. */
  webDir?: string;
  /** Settlement orders (testnet prototype). Omit and `/v1/orders/*` answers that the feature is off. */
  orders?: OrdersWiring;
}

/**
 * Headers for the web app's HTML. Scripts only from this origin; styles allow inline because the wallet
 * picker injects its own; images and connections allow https because asset icons and wallets live elsewhere.
 * `vercel.json` repeats these for the CDN-served deployment: keep the two in step.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "font-src 'self'",
    "connect-src 'self' https: wss:",
    "frame-src https:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

/** Resolve after `ms` at the latest, so slow background work never holds a response. */
const within = (p: Promise<unknown>, ms: number) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);

export function createApp(router: Router, overrides: Partial<Deps> = {}, opts: AppOpts = {}) {
  const deps: Deps = { ...defaultDeps(), ...overrides };
  const vaults = opts.vaults ?? DEFAULT_VAULTS;
  const app = new Hono();

  // The API is public infrastructure (wallets call it from their own origin) and uses no cookies.
  app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type"], maxAge: 86400 }));

  app.get("/health", (c) => c.json({ ok: true }));

  /** Read a JSON object body, or null when it is not one. */
  async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
    try {
      const b = (await c.req.json()) as unknown;
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  // Identical quote requests inside a few seconds share one fan-out: an auto-refreshing page and several
  // tabs would otherwise multiply RPC calls for no fresher answer (ledgers close about every 5 seconds).
  const QUOTE_TTL_MS = 3000;
  const quoteCache = new Map<string, { at: number; result: Promise<QuoteResult> }>();
  function cachedQuote(assetIn: string, assetOut: string, amountIn: bigint, slippageBps: number): Promise<QuoteResult> {
    const now = Date.now();
    for (const [k, v] of quoteCache) if (now - v.at > QUOTE_TTL_MS) quoteCache.delete(k);
    const key = `${assetIn}|${assetOut}|${amountIn}|${slippageBps}`;
    let hit = quoteCache.get(key);
    if (!hit) {
      hit = { at: now, result: router.quote({ assetIn, assetOut, amountIn, slippageBps }) };
      quoteCache.set(key, hit);
      hit.result.catch(() => quoteCache.delete(key));
    }
    return hit.result;
  }

  app.get("/v1/quote", async (c) => {
    const assetIn = c.req.query("assetIn") ?? "";
    const assetOut = c.req.query("assetOut") ?? "";
    const amount = c.req.query("amount") ?? "";
    const slippage = Number(c.req.query("slippageBps") ?? "50");

    if (!ASSET.test(assetIn) || !ASSET.test(assetOut)) {
      return c.json({ error: "assetIn and assetOut must be 'native' or 'CODE:ISSUER'" }, 400);
    }
    if (assetIn === assetOut) return c.json({ error: "assetIn and assetOut are identical" }, 400);
    if (!Number.isInteger(slippage) || slippage < 0 || slippage > 5000) {
      return c.json({ error: "slippageBps must be an integer in 0..5000" }, 400);
    }
    let amountIn: bigint;
    try {
      amountIn = parseAmount(amount);
    } catch {
      return c.json({ error: "amount must be a decimal with at most 7 places" }, 400);
    }
    if (amountIn <= 0n) return c.json({ error: "amount must be positive" }, 400);

    const atomicOnly = c.req.query("atomicOnly") === "1";
    if (opts.scorer) await within(opts.scorer.refreshIfStale(), 1500);
    const quoted = await cachedQuote(assetIn, assetOut, amountIn, slippage);
    const errors = quoted.errors;
    const routes = atomicOnly ? quoted.routes.filter((r) => r.atomicity !== "TWO_STEP") : quoted.routes;
    return c.json({
      routes: routes.map(serializeRoute),
      best: routes[0] ? serializeRoute(routes[0]) : null,
      partial: errors.length > 0,
      errors,
    });
  });

  /** Assets a user can pick, merged from public asset lists. Third-party data: clients must render it as text. */
  app.get("/v1/assets", async (c) => {
    const list = await deps.assets();
    c.header("cache-control", list.errors.length ? "public, max-age=60" : "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
    return c.json(list);
  });

  /** Check that a pasted CODE:ISSUER really exists on this network before offering it. */
  app.get("/v1/asset", async (c) => {
    const id = c.req.query("id") ?? "";
    if (!ASSET.test(id)) return c.json({ error: "id must be 'native' or 'CODE:ISSUER'" }, 400);
    if (id === "native") return c.json({ id, code: "XLM", contract: sacId(id) });
    let contract: string;
    try {
      contract = sacId(id);
    } catch {
      return c.json({ error: "issuer is not a valid account address" }, 400);
    }
    try {
      const info = await deps.assetInfo(id);
      if (!info) return c.json({ error: "no such asset on this network" }, 404);
      const [code, issuer] = id.split(":");
      return c.json({ id, code, issuer, contract, ...info });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /** Balances and spendable amounts, so a client can validate an amount before building. */
  app.get("/v1/account/:id", async (c) => {
    const account = c.req.param("id");
    if (!ACCOUNT.test(account)) return c.json({ error: "account must be a G... address" }, 400);
    try {
      const a = await deps.getAccount(account);
      return c.json({ account, sequence: a.sequence, balances: a.balances ?? [] });
    } catch (e) {
      const message = (e as Error).message;
      return c.json({ error: message }, message === ACCOUNT_NOT_FOUND ? 404 : 502);
    }
  });

  /**
   * Unsigned Blend supply or withdrawal, simulated first. Body: { account, vault, protocol: "blend", asset, amount }.
   * A zap is: build and settle the swap, then call deposit with the amount actually received.
   */
  const vaultRequest = (build: typeof buildVaultDeposit) => async (c: Context) => {
    const b = await jsonBody(c);
    if (!b) return c.json({ error: "body must be JSON" }, 400);
    const account = String(b.account ?? "");
    const vault = String(b.vault ?? "");
    const asset = String(b.asset ?? "");
    const protocol = String(b.protocol ?? "");
    if (!ACCOUNT.test(account)) return c.json({ error: "account must be a G... address" }, 400);
    if (!CONTRACT.test(vault)) return c.json({ error: "vault must be a C... contract id" }, 400);
    if (!ASSET.test(asset)) return c.json({ error: "invalid asset" }, 400);
    if (protocol !== "blend") return c.json({ error: `protocol "${protocol}" is not supported (only blend is verified)` }, 501);
    let amount: bigint;
    try {
      amount = parseAmount(String(b.amount ?? ""));
    } catch {
      return c.json({ error: "amount must be a decimal with at most 7 places" }, 400);
    }
    if (amount <= 0n) return c.json({ error: "amount must be positive" }, 400);

    let acct: Awaited<ReturnType<Deps["getAccount"]>>;
    try {
      acct = await deps.getAccount(account);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
    const xdrIn = build({ vault, underlying: asset, protocol: "blend" }, asset, amount, { source: account, sequence: acct.sequence, timeoutSec: TX_TIMEOUT_SEC });
    try {
      const p = await deps.prepare(xdrIn);
      return c.json({ kind: "transaction", venue: "blend", xdr: p.xdr, resourceFee: p.minResourceFee, unsigned: true });
    } catch (e) {
      const raw = (e as Error).message;
      return c.json({ error: raw.split("\n")[0], explained: explainSimulation(raw, "blend") }, 422);
    }
  };
  app.post("/v1/deposit", vaultRequest(buildVaultDeposit));
  app.post("/v1/withdraw", vaultRequest(buildVaultWithdraw));

  // Pool state moves with every borrow and repay but a few seconds of staleness is harmless for display.
  const VAULT_TTL_MS = 30_000;
  const vaultCache = new Map<string, { at: number; pool: ReturnType<Deps["blendPool"]> }>();
  function cachedPool(id: string) {
    const hit = vaultCache.get(id);
    if (hit && Date.now() - hit.at < VAULT_TTL_MS) return hit.pool;
    const pool = deps.blendPool(id);
    vaultCache.set(id, { at: Date.now(), pool });
    pool.catch(() => vaultCache.delete(id));
    return pool;
  }

  /** Vaults offered for deposit with their live reserves, rates and status, read from the pool contracts. */
  app.get("/v1/vaults", async (c) => {
    const errors: { vault: string; error: string }[] = [];
    const out = await Promise.all(
      vaults.map(async (v) => {
        try {
          return { protocol: "blend" as const, name: v.name, ...(await cachedPool(v.id)) };
        } catch (e) {
          errors.push({ vault: v.id, error: (e as Error).message.split("\n")[0]! });
          return null;
        }
      }),
    );
    return c.json({ vaults: out.filter((v) => v !== null), errors });
  });

  /** What an account has supplied to each offered vault, in the underlying assets. */
  app.get("/v1/positions", async (c) => {
    const account = c.req.query("account") ?? "";
    if (!ACCOUNT.test(account)) return c.json({ error: "account must be a G... address" }, 400);
    const errors: { vault: string; error: string }[] = [];
    const out = await Promise.all(
      vaults.map(async (v) => {
        try {
          return { protocol: "blend" as const, vault: v.id, name: v.name, positions: await deps.blendPositions(v.id, account) };
        } catch (e) {
          errors.push({ vault: v.id, error: (e as Error).message.split("\n")[0]! });
          return null;
        }
      }),
    );
    return c.json({ account, vaults: out.filter((v) => v !== null), errors });
  });

  /** Live peg, depth and issuer-flag signals plus the explainable score used to bias route ranking. */
  app.get("/v1/stablecoin", async (c) => {
    const asset = c.req.query("asset") ?? "";
    if (!ASSET.test(asset) || asset === "native") return c.json({ error: "asset must be CODE:ISSUER" }, 400);
    try {
      return c.json(await deps.stablecoin(asset));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /** Every stablecoin this deployment scores, with its current score or the reason it could not be scored. */
  app.get("/v1/stablecoins", async (c) => {
    const scorer = opts.scorer;
    if (!scorer) return c.json({ assets: [] });
    await within(scorer.refreshIfStale(), 4000);
    return c.json({
      assets: scorer.assets.map((asset) => {
        const s = scorer.scores.get(asset);
        return s
          ? { asset, score: s.score, penaltyBps: s.penaltyBps, reasons: s.reasons, signals: s.signals, at: s.at }
          : { asset, error: scorer.errors.get(asset) ?? "not scored yet" };
      }),
    });
  });

  /**
   * Relay a transaction the user's wallet already signed. Body: { xdr }. This server never signs: it only
   * forwards the envelope to Stellar RPC, and refuses anything other than one signed operation.
   */
  app.post("/v1/submit", async (c) => {
    const b = await jsonBody(c);
    if (!b) return c.json({ error: "body must be JSON" }, 400);
    const signed = String(b.xdr ?? "");
    try {
      parseSignedTx(signed);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    try {
      const sent = await deps.submit(signed);
      if (sent.status === "ERROR") {
        return c.json({ error: "the network rejected this transaction", hash: sent.hash, status: sent.status, explained: explainCodes(sent.codes ?? []) }, 422);
      }
      if (sent.status === "TRY_AGAIN_LATER") {
        return c.json({ error: "the network is busy, submit again in a few seconds", hash: sent.hash, status: sent.status }, 503);
      }
      return c.json({ hash: sent.hash, status: sent.status });
    } catch (e) {
      return c.json({ error: (e as Error).message.split("\n")[0] }, 502);
    }
  });

  /**
   * Where a submitted transaction stands. NOT_FOUND shortly after submit means it is not in a ledger yet.
   * On success `received` is what a swap actually delivered; on failure `explained` says why.
   */
  app.get("/v1/tx/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase();
    if (!TX_HASH.test(hash)) return c.json({ error: "hash must be 64 hex characters" }, 400);
    try {
      const t = await deps.getTx(hash);
      const got = t.status === "SUCCESS" ? receivedAmount(t) : null;
      return c.json({
        hash,
        status: t.status,
        ledger: t.ledger,
        createdAt: t.createdAt,
        received: got ? formatAmount(got.amount) : undefined,
        explained: t.status === "FAILED" ? explainCodes(t.codes ?? []) : undefined,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message.split("\n")[0] }, 502);
    }
  });

  /**
   * Build unsigned transactions for a route. Body: { assetIn, assetOut, amount, account, slippageBps?,
   * atomicOnly?, routeKey?, routeIndex? }. Nothing is signed or submitted here.
   * Prefer `routeKey` (from /v1/quote): it names the route itself, where an index names a position that
   * shifts when prices move. With neither, the best route is used and the next ones are tried if it fails.
   */
  app.post("/v1/build", async (c) => {
    const b = await jsonBody(c);
    if (!b) return c.json({ error: "body must be JSON" }, 400);
    const assetIn = String(b.assetIn ?? "");
    const assetOut = String(b.assetOut ?? "");
    const account = String(b.account ?? "");
    const slippage = Number(b.slippageBps ?? 50);
    const key = b.routeKey === undefined ? undefined : String(b.routeKey);
    // With neither routeKey nor routeIndex, fall back to the next route if a simulation fails; otherwise use exactly that route.
    const explicit = key !== undefined || b.routeIndex !== undefined;
    let routeIndex = Number(b.routeIndex ?? 0);
    if (!ASSET.test(assetIn) || !ASSET.test(assetOut) || assetIn === assetOut) return c.json({ error: "invalid assetIn/assetOut" }, 400);
    if (!ACCOUNT.test(account)) return c.json({ error: "account must be a G... address" }, 400);
    if (!Number.isInteger(slippage) || slippage < 0 || slippage > 5000) return c.json({ error: "slippageBps must be an integer in 0..5000" }, 400);
    if (!Number.isInteger(routeIndex) || routeIndex < 0) return c.json({ error: "routeIndex must be a non-negative integer" }, 400);
    let amountIn: bigint;
    try {
      amountIn = parseAmount(String(b.amount ?? ""));
    } catch {
      return c.json({ error: "amount must be a decimal with at most 7 places" }, 400);
    }
    if (amountIn <= 0n) return c.json({ error: "amount must be positive" }, 400);

    if (opts.scorer) await within(opts.scorer.refreshIfStale(), 1500);
    const quoted = await router.quote({ assetIn, assetOut, amountIn, slippageBps: slippage });
    const routes = b.atomicOnly === true ? quoted.routes.filter((r) => r.atomicity !== "TWO_STEP") : quoted.routes;
    if (key !== undefined) {
      routeIndex = routes.findIndex((r) => routeKey(r) === key);
      if (routeIndex < 0) {
        return c.json({ error: "that route is no longer offered for this pair and size; quote again", code: "ROUTE_GONE", available: routes.length }, 409);
      }
    }
    if (!routes[routeIndex]) return c.json({ error: "no route at that index", available: routes.length }, 404);

    let acct: Awaited<ReturnType<Deps["getAccount"]>>;
    try {
      acct = await deps.getAccount(account);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }

    const skipped: { venue: string; error: string }[] = [];
    const last = explicit ? routeIndex : Math.min(routes.length - 1, routeIndex + 4);
    for (let idx = routeIndex; idx <= last; idx++) {
      const route = routes[idx]!;
      const steps: unknown[] = [];
      let failure: { error: string; leg: number; venue: string } | undefined;
      const plan = { account, routerContract: opts.routerContract, timeoutSec: TX_TIMEOUT_SEC };

      // A Classic output asset needs a trustline first. Plan once to learn which legs are pre-built, then
      // re-plan with the sequence advanced past the trustline transactions.
      const dry = planExecution(route, { ...plan, sequence: acct.sequence });
      const missing = [...new Set(dry.flatMap((st) => (st.kind === "transaction" ? [route.legs[st.leg]!.assetOut] : [])))].filter(
        (a) => a !== "native" && !acct.assets.has(a),
      );
      const base = (BigInt(acct.sequence) + BigInt(missing.length)).toString();
      missing.forEach((asset, n) => {
        steps.push({
          kind: "prerequisite", type: "changeTrust", asset,
          xdr: buildChangeTrust(asset, { source: account, sequence: (BigInt(acct.sequence) + BigInt(n)).toString(), timeoutSec: TX_TIMEOUT_SEC }),
          reason: "Account has no trustline for this asset; the swap cannot deliver it until this is submitted.",
        });
      });

      for (const step of planExecution(route, { ...plan, sequence: base })) {
        if (step.kind !== "transaction") {
          steps.push(step);
          continue;
        }
        let xdr = step.xdr;
        let resourceFee: string | undefined;
        if (step.needsSimulation && missing.length > 0) {
          // Simulation would fail until the trustline exists, so this step ships unsimulated.
          steps.push({ ...step, xdr, minOut: formatAmount(step.minOut), simulated: false, note: "Submit the trustline first, then re-call /v1/build to get this step simulated." });
          continue;
        }
        if (step.needsSimulation) {
          try {
            const p = await deps.prepare(xdr);
            xdr = p.xdr;
            resourceFee = p.minResourceFee;
          } catch (e) {
            // A route that would revert must not reach a signature prompt.
            failure = { error: (e as Error).message, leg: step.leg, venue: step.venue };
            break;
          }
        }
        steps.push({ ...step, xdr, resourceFee, minOut: formatAmount(step.minOut) });
      }
      if (!failure) return c.json({ route: serializeRoute(route), steps, unsigned: true, skipped });
      skipped.push({ venue: failure.venue, error: failure.error.split("\n")[0]!.slice(0, 200) });
      if (explicit || idx === last) {
        return c.json({ error: failure.error.split("\n")[0], explained: explainSimulation(failure.error), leg: failure.leg, venue: failure.venue, skipped }, 422);
      }
    }
    return c.json({ error: "no route could be built" }, 404);
  });

  // Settlement orders live beside the mainnet routes and share nothing with them: their own network, RPC and keys.
  registerOrderRoutes(app, opts.orders ?? ORDERS_DISABLED);

  // The built web app, when this process is the one serving it. Registered last so it only sees paths no
  // API route claimed. Only known file types, only inside the directory.
  if (opts.webDir) {
    const root = path.resolve(opts.webDir);
    app.get("*", async (c) => {
      let rel: string;
      try {
        rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "") || "index.html";
      } catch {
        return c.text("not found", 404);
      }
      const file = path.resolve(root, rel);
      const type = MIME[path.extname(file)];
      if (!type || !file.startsWith(root + path.sep)) return c.text("not found", 404);
      try {
        const body = await readFile(file);
        const html = type.startsWith("text/html");
        return c.body(body, 200, {
          "content-type": type,
          // Hashed build output never changes; the HTML that points at it must always be fresh.
          "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          ...(html ? SECURITY_HEADERS : { "x-content-type-options": "nosniff" }),
        });
      } catch {
        return c.text("not found", 404);
      }
    });
  }

  return app;
}
