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
interface Resolved { address: string; family: number }

const notFound = (hostname: string): NodeJS.ErrnoException => Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname });

/**
 * Wrap a `dns.lookup`-shaped function with a cache keyed by host name. Each name is resolved for all its
 * addresses, and every shape of question (one address or all, IPv4 only, IPv6 only) is answered from that, so
 * a lookup made ahead of time serves the connections that follow whatever options they pass.
 * Answers younger than `ttlMs` are served as they are; older ones (up to `staleMs`) are still served at once
 * while a fresh lookup runs behind them. Callers asking for a name that is already being resolved share that
 * request, but only for `hedgeMs`: a first lookup can hang on a slow resolver for many seconds while a second
 * one, asked a moment later, is answered at once (seen 2026-10-09: sharing without this limit pinned every
 * connection to a lookup that took over 20 seconds). After `hedgeMs` the name is asked again, on a timer or
 * when another caller arrives, up to three attempts in all. The first success answers everyone; a failure is
 * only reported when no attempt is left, and is never cached. Addresses keep the resolver's order.
 */
export function createCachedLookup(original: Lookup, ttlMs = 5 * 60_000, staleMs = 60 * 60_000, now: () => number = Date.now, hedgeMs = 1500) {
  type Waiter = (err: NodeJS.ErrnoException | null, list: Resolved[]) => void;
  interface Flight { waiters: Waiter[]; attempts: number; launched: number; lastStart: number }
  const MAX_ATTEMPTS = 3;
  const cache = new Map<string, { at: number; list: Resolved[] }>();
  const pending = new Map<string, Flight>();

  function settle(hostname: string, flight: Flight, err: NodeJS.ErrnoException | null, list: Resolved[]): void {
    if (pending.get(hostname) !== flight) return; // already answered by another attempt
    pending.delete(hostname);
    for (const w of flight.waiters) w(err, list);
  }

  function launch(hostname: string, flight: Flight): void {
    flight.attempts++;
    flight.launched++;
    flight.lastStart = now();
    // Ask again by itself if this attempt is still out after the hedge interval: the callers already waiting
    // must not depend on someone else arriving later to be rescued from a hung lookup.
    const again = setTimeout(() => {
      if (pending.get(hostname) === flight && flight.launched < MAX_ATTEMPTS) launch(hostname, flight);
    }, hedgeMs);
    again.unref?.();
    original(hostname, { all: true }, (err, address) => {
      flight.attempts--;
      const list = !err && Array.isArray(address) ? (address as Resolved[]) : [];
      if (list.length) {
        cache.set(hostname, { at: now(), list });
        settle(hostname, flight, null, list);
      } else if (flight.attempts === 0) {
        settle(hostname, flight, err ?? notFound(hostname), []);
      }
    });
  }

  /** Resolve `hostname`, joining a lookup already running unless it has been running for too long. */
  function refresh(hostname: string, waiter?: Waiter): void {
    let flight = pending.get(hostname);
    if (!flight) {
      // The waiter is registered before the lookup starts, so a resolver that answers synchronously still reaches it.
      flight = { waiters: waiter ? [waiter] : [], attempts: 0, launched: 0, lastStart: 0 };
      pending.set(hostname, flight);
      launch(hostname, flight);
      return;
    }
    if (waiter) flight.waiters.push(waiter);
    if (now() - flight.lastStart >= hedgeMs && flight.launched < MAX_ATTEMPTS) launch(hostname, flight);
  }

  function answer(hostname: string, opts: LookupOptions, cb: LookupCallback, list: Resolved[]): void {
    const want = opts.family === 4 || opts.family === "IPv4" ? 4 : opts.family === 6 || opts.family === "IPv6" ? 6 : 0;
    const fit = want ? list.filter((a) => a.family === want) : list;
    if (!fit.length) cb(notFound(hostname));
    else if (opts.all) cb(null, fit.map((a) => ({ ...a })));
    else cb(null, fit[0]!.address, fit[0]!.family);
  }

  return function lookup(hostname: string, options: LookupOptions | number | LookupCallback, callback?: LookupCallback): unknown {
    let opts: LookupOptions;
    if (typeof options === "function") [callback, opts] = [options, {}];
    else if (typeof options === "number") opts = { family: options };
    else opts = options ?? {};
    const cb = callback!;
    const hit = cache.get(hostname);
    const age = hit ? now() - hit.at : Infinity;
    if (hit && age < staleMs) {
      if (age >= ttlMs) refresh(hostname);
      queueMicrotask(() => answer(hostname, opts, cb, hit.list));
    } else {
      refresh(hostname, (err, list) => (err ? cb(err) : answer(hostname, opts, cb, list)));
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
