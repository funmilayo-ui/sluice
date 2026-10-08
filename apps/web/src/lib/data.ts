import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, SluiceError, type AccountResponse, type ListedAsset, type PositionsResponse, type QuoteResponse, type ScoredStablecoin, type VaultsResponse } from "./api";
import { assetCode, assetIssuer, isAmount } from "./format";
import { load, save } from "./store";

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  /** First load in flight (no data yet). */
  loading: boolean;
  /** A reload is in flight while older data is still shown. */
  refreshing: boolean;
  /** When `data` arrived, ms since epoch. */
  at: number;
  reload(): void;
}

/**
 * Load, keep showing the last good answer while reloading, and re-run on an interval while the tab is visible.
 * `key` null means "nothing to load" and clears the data, so one pair's routes are never shown for another.
 */
export function useLive<T>(key: string | null, fetcher: () => Promise<T>, opts: { refreshMs?: number; paused?: boolean } = {}): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: string; at: number }>({ key, at: 0 });
  const [inFlight, setInFlight] = useState(false);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (key === null) {
      setState({ key: null, at: 0 });
      return;
    }
    let cancelled = false;
    setInFlight(true);
    fetcherRef.current()
      .then((data) => { if (!cancelled) setState({ key, data, at: Date.now() }); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "Request failed";
        // Keep the previous data for the same key: a failed refresh should not blank the screen.
        setState((prev) => (prev.key === key ? { ...prev, error: message } : { key, error: message, at: 0 }));
      })
      .finally(() => { if (!cancelled) setInFlight(false); });
    return () => { cancelled = true; };
  }, [key, tick]);

  const { refreshMs, paused } = opts;
  useEffect(() => {
    if (!refreshMs || paused || key === null) return;
    const id = window.setInterval(() => { if (document.visibilityState === "visible") setTick((t) => t + 1); }, refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs, paused, key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: key !== null && inFlight && !(current && state.data !== undefined),
    refreshing: inFlight && current && state.data !== undefined,
    at: current ? state.at : 0,
    reload,
  };
}

/** A value that only changes after it has been stable for `ms`, so typing does not fire a request per keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const CUSTOM = "sluice.customAssets";

/** The pickable assets: public lists from the API plus anything the user added by pasting CODE:ISSUER. */
export function useAssets() {
  // The list is merged from three public hosts. While any of them has not answered, ask again every few
  // seconds (the server retries behind each answer) so the picker fills in without a page reload.
  const [complete, setComplete] = useState(false);
  const live = useLive("assets", async () => {
    try {
      const r = await api.assets();
      setComplete(r.errors.length === 0);
      return r;
    } catch (e) {
      setComplete(false);
      throw e;
    }
  }, { refreshMs: complete ? undefined : 6_000 });
  const [custom, setCustom] = useState<ListedAsset[]>(() => load<ListedAsset[]>(CUSTOM, []));
  const addCustom = useCallback((a: ListedAsset) => {
    setCustom((prev) => {
      const next = prev.some((x) => x.id === a.id) ? prev : [...prev, a];
      save(CUSTOM, next);
      return next;
    });
  }, []);
  const assets = useMemo(() => {
    const listed = live.data?.assets ?? [];
    const ids = new Set(listed.map((a) => a.id));
    return [...listed, ...custom.filter((a) => !ids.has(a.id))];
  }, [live.data, custom]);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  /** Always returns something renderable, even for an asset no list carries (a balance, a route hop). */
  const describe = useCallback(
    (id: string): ListedAsset => byId.get(id) ?? { id, code: assetCode(id), issuer: assetIssuer(id), contract: "", lists: [] },
    [byId],
  );
  return { assets, describe, addCustom, loading: live.loading, error: live.error, partial: live.data?.errors ?? [], reload: live.reload };
}
export type Assets = ReturnType<typeof useAssets>;

export interface AccountState extends Loaded<AccountResponse> {
  /** The address exists as a key but has never been funded on mainnet. */
  unfunded: boolean;
  spendable(asset: string): string | undefined;
  holds(asset: string): boolean;
}

export function useAccount(address: string | undefined): AccountState {
  const [unfunded, setUnfunded] = useState(false);
  const live = useLive(address ? `account:${address}` : null, async () => {
    try {
      const a = await api.account(address!);
      setUnfunded(false);
      return a;
    } catch (e) {
      if (e instanceof SluiceError && e.status === 404) {
        setUnfunded(true);
        return { account: address!, sequence: "0", balances: [] };
      }
      throw e;
    }
  }, { refreshMs: 20_000 });
  const map = useMemo(() => new Map((live.data?.balances ?? []).map((b) => [b.asset, b])), [live.data]);
  const spendable = useCallback((asset: string) => map.get(asset)?.spendable, [map]);
  const holds = useCallback((asset: string) => asset === "native" || map.has(asset), [map]);
  return { ...live, unfunded: unfunded && !!address, spendable, holds };
}

export interface QuoteParams { assetIn: string; assetOut: string; amount: string; slippageBps: number; atomicOnly: boolean }

/** Live routes for a pair and size. Re-quoted every 15 seconds: a ledger closes about every 5. */
export function useQuote(p: QuoteParams | null, paused: boolean): Loaded<QuoteResponse> {
  const key = p && isAmount(p.amount) && p.assetIn !== p.assetOut ? `${p.assetIn}|${p.assetOut}|${p.amount}|${p.slippageBps}|${p.atomicOnly}` : null;
  const debounced = useDebounced(key, 350);
  // When a venue did not answer (often just a cold connection), ask again sooner than the usual cadence.
  const [partial, setPartial] = useState(false);
  const live = useLive(debounced, async () => {
    const r = await api.quote(p!);
    setPartial(r.partial);
    return r;
  }, { refreshMs: partial ? 5_000 : 15_000, paused });
  // While the debounce is pending the shown routes belong to the previous input: report loading instead.
  const settling = key !== debounced;
  return settling ? { ...live, data: undefined, error: undefined, loading: key !== null, refreshing: false, at: 0 } : live;
}

export function useStablecoins() {
  // A server that has just started answers before its first scoring pass finishes; ask again shortly until
  // every asset has a score or a real reason, then settle to the five-minute cadence the scores refresh at.
  const [settled, setSettled] = useState(false);
  const live = useLive("stablecoins", async () => {
    const r = await api.stablecoins();
    setSettled(!r.assets.some((a) => "error" in a && a.error === "not scored yet"));
    return r;
  }, { refreshMs: settled ? 5 * 60_000 : 5_000 });
  const byAsset = useMemo(() => new Map((live.data?.assets ?? []).map((s) => [s.asset, s] as const)), [live.data]);
  return useCallback((asset: string): ScoredStablecoin | undefined => byAsset.get(asset), [byAsset]);
}
export type StableLookup = ReturnType<typeof useStablecoins>;

/** Pool state, refreshed every 30 seconds; sooner while a pool could not be read. */
export function useVaults(): Loaded<VaultsResponse> {
  const [ok, setOk] = useState(true);
  return useLive("vaults", async () => {
    try {
      const r = await api.vaults();
      setOk(r.errors.length === 0);
      return r;
    } catch (e) {
      setOk(false);
      throw e;
    }
  }, { refreshMs: ok ? 30_000 : 6_000 });
}
export const usePositions = (address: string | undefined): Loaded<PositionsResponse> =>
  useLive(address ? `positions:${address}` : null, () => api.positions(address!), { refreshMs: 30_000 });
