/** Display helpers. Amounts stay decimal strings end to end; nothing here does arithmetic on money in floats. */

export const assetCode = (id: string): string => (id === "native" ? "XLM" : id.split(":")[0]!);
export const assetIssuer = (id: string): string | undefined => (id === "native" ? undefined : id.split(":")[1]);
export const shortKey = (k: string, n = 4): string => (k.length > n * 2 + 1 ? `${k.slice(0, n)}…${k.slice(-n)}` : k);

const AMOUNT = /^\d+(\.\d{1,7})?$/;
/** True for a positive decimal with at most 7 places: what the network can represent. */
export const isAmount = (s: string): boolean => AMOUNT.test(s) && Number(s) > 0;

/** "12.3456789" -> 123456789n stroops. Only call with a string that passed `isAmount` or came from the API. */
export function toStroops(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole || "0") * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7) || "0");
}
export function fromStroops(v: bigint): string {
  const a = v < 0n ? -v : v;
  return `${v < 0n ? "-" : ""}${a / 10_000_000n}.${(a % 10_000_000n).toString().padStart(7, "0")}`;
}

/**
 * Human amount: thousands separators, trailing zeros dropped, and fewer decimals the larger the number
 * (nobody reads the seventh decimal of 288,998). Truncates, never rounds up: a figure shown as received
 * must not exceed what arrives.
 */
export function fmt(s: string | undefined, maxDecimals?: number): string {
  if (!s) return "0";
  const neg = s.startsWith("-");
  const [whole = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  const w = BigInt(whole);
  const places = maxDecimals ?? (w >= 10_000n ? 2 : w >= 100n ? 4 : 7);
  const f = frac.slice(0, places).replace(/0+$/, "");
  const grouped = w.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${f ? `.${f}` : ""}`;
}

/** A large total in short form ("699.4M"), truncated not rounded. Small values fall back to `fmt`. */
export function fmtCompact(s: string): string {
  const whole = BigInt(s.split(".")[0] || "0");
  // Thousands only from 10,000 up: "9,999" is easier to read than "9.9K".
  for (const [unit, size, from] of [["B", 1_000_000_000n, 1_000_000_000n], ["M", 1_000_000n, 1_000_000n], ["K", 1_000n, 10_000n]] as const) {
    if (whole >= from) return `${whole / size}.${((whole % size) * 10n) / size}${unit}`;
  }
  return fmt(s, 0);
}

/** A fraction as a percentage. A real but tiny value reads "<0.01%" rather than a misleading "0.00%". */
export function pct(v: number, digits = 2): string {
  const floor = 10 ** -digits;
  if (v > 0 && v * 100 < floor) return `<${floor.toFixed(digits)}%`;
  return `${(v * 100).toFixed(digits)}%`;
}

/**
 * How a route's quoted output compares with the top-ranked one, in words. A lower-ranked route can quote
 * slightly MORE than the best one (ranking applies a haircut to two-transaction routes and to weak
 * stablecoins), and saying "less" there would be false.
 */
export function versusBest(diff: number): string {
  const d = Math.abs(diff) * 100;
  const size = d < 0.01 ? "under 0.01%" : `${d.toFixed(2)}%`;
  return diff > 0 ? `${size} more, ranked lower for risk` : `${size} less`;
}

/** How much worse (negative) one output is than another, as a fraction. Display only. */
export function relDiff(a: string, b: string): number {
  const [x, y] = [Number(a), Number(b)];
  return y > 0 ? (x - y) / y : 0;
}

const VENUES: Record<string, string> = {
  "classic-path": "Stellar DEX",
  aquarius: "Aquarius",
  soroswap: "Soroswap",
  phoenix: "Phoenix",
  comet: "Comet",
  "sluice-router": "Sluice router",
  blend: "Blend",
};
export const venueName = (id: string): string => VENUES[id] ?? id;

export const explorerTx = (hash: string): string => `https://stellar.expert/explorer/public/tx/${hash}`;
export const explorerAccount = (id: string): string => `https://stellar.expert/explorer/public/account/${id}`;

/**
 * A transaction on the settlement-orders network. Only the testnet has an explorer this app knows; for any other
 * network the hash is shown without a link rather than pointing at the wrong chain.
 */
export const orderExplorerTx = (network: string, hash: string): string | undefined =>
  network === "testnet" ? `https://stellar.expert/explorer/testnet/tx/${hash}` : undefined;
export const orderExplorerAccount = (network: string, id: string): string | undefined =>
  network === "testnet" ? `https://stellar.expert/explorer/testnet/account/${id}` : undefined;

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");
