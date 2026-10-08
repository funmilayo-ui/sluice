/** Small typed localStorage wrapper. Storage can be blocked or full; the app must work without it. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota: nothing to do */
  }
}

/**
 * A two-transaction route in progress: leg 1 has settled and the account holds the intermediate asset.
 * Kept so a closed tab or a refresh never strands the user without the way forward (finish leg 2 or unwind).
 */
export interface PendingRoute {
  account: string;
  /** Asset the user started with and the one they wanted. */
  from: string;
  to: string;
  /** What leg 1 delivered. */
  held: string;
  heldAmount: string;
  slippageBps: number;
  /** Minimum the user accepted for leg 2 when they started, decimal string. */
  acceptedMin: string;
  leg1Hash: string;
  at: number;
}

const PENDING = "sluice.pending";
export const loadPending = (account: string | undefined): PendingRoute | null => {
  const p = load<PendingRoute | null>(PENDING, null);
  return p && account && p.account === account ? p : null;
};
export const savePending = (p: PendingRoute | null): void => save(PENDING, p);
