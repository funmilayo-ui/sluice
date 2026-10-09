import dns from "node:dns";
import net from "node:net";

/**
 * Some hosts have a broken IPv6 route, which makes Node's fetch fail with ETIMEDOUT while curl
 * (which falls back faster) works. Call this once at process start when SLUICE_IPV4_FIRST=1.
 */
export function preferIpv4(attemptTimeoutMs = 3000): void {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(true);
  net.setDefaultAutoSelectFamilyAttemptTimeout(attemptTimeoutMs);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;
type LookupOptions = { family?: number | string; all?: boolean; hints?: number; order?: string; verbatim?: boolean };
type Lookup = (hostname: string, options: LookupOptions, callback: LookupCallback) => unknown;

/**
 * Wrap a `dns.lookup`-shaped function with a cache. Answers younger than `ttlMs` are served as they are;
 * older ones (up to `staleMs`) are still served at once while one fresh lookup runs behind them; concurrent
 * lookups of the same name share one request. Failures are never cached.
 */
export function createCachedLookup(original: Lookup, ttlMs = 5 * 60_000, staleMs = 60 * 60_000, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; address: unknown; family?: number }>();
  const pending = new Map<string, LookupCallback[]>();

  /** Start a lookup unless one is already running for this key; `cb` joins whichever it is. */
  function refresh(key: string, hostname: string, options: LookupOptions, cb?: LookupCallback): void {
    const running = pending.get(key);
    if (running) {
      if (cb) running.push(cb);
      return;
    }
    // Registered before the lookup starts, so a resolver that answers synchronously still reaches the caller.
    const callbacks: LookupCallback[] = cb ? [cb] : [];
    pending.set(key, callbacks);
    original(hostname, options, (err, address, family) => {
      pending.delete(key);
      if (!err) cache.set(key, { at: now(), address, family });
      for (const c of callbacks) c(err, Array.isArray(address) ? [...address] : address, family);
    });
  }

  return function lookup(hostname: string, options: LookupOptions | number | LookupCallback, callback?: LookupCallback): unknown {
    let opts: LookupOptions;
    if (typeof options === "function") [callback, opts] = [options, {}];
    else if (typeof options === "number") opts = { family: options };
    else opts = options ?? {};
    const cb = callback!;
    const key = `${hostname}|${opts.family ?? 0}|${opts.all ? 1 : 0}|${opts.hints ?? 0}|${opts.order ?? opts.verbatim ?? ""}`;
    const hit = cache.get(key);
    const age = hit ? now() - hit.at : Infinity;
    if (hit && age < staleMs) {
      if (age >= ttlMs) refresh(key, hostname, opts);
      const address = Array.isArray(hit.address) ? [...hit.address] : hit.address;
      queueMicrotask(() => cb(null, address, hit.family));
    } else {
      refresh(key, hostname, opts, cb);
    }
    return {};
  };
}

let dnsCached = false;
/**
 * Cache name lookups for this process. Node does not cache DNS: every new connection asks the system
 * resolver again, and idle connections close after a few seconds, so a quote that fans out to five hosts can
 * pay five fresh lookups. Measured 2026-10-09 on a host with a slow resolver: a cold lookup took about 5
 * seconds, long enough for every venue to miss the quote timeout and the first quote to come back empty.
 */
export function cacheDnsLookups(): void {
  if (dnsCached) return;
  dnsCached = true;
  const original = dns.lookup.bind(dns) as unknown as Lookup;
  (dns as unknown as { lookup: unknown }).lookup = createCachedLookup(original);
}

/** Resolve hosts ahead of the first request that needs them. Never throws; resolves when all have answered or failed. */
export function preResolve(urls: (string | undefined)[]): Promise<void> {
  const hosts = new Set<string>();
  for (const u of urls) {
    try {
      if (u) hosts.add(new URL(u).hostname);
    } catch {
      /* not a URL: nothing to resolve */
    }
  }
  return Promise.all([...hosts].map((h) => new Promise<void>((done) => dns.lookup(h, { all: true }, () => done())))).then(() => undefined);
}
