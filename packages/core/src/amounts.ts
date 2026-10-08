const SCALE = 10_000_000n;

/** "12.3456789" -> 123456789n. Rejects more than 7 decimals. */
export function parseAmount(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid amount: ${s}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(7, "0") || "0");
  return whole * SCALE + frac;
}

/** 123456789n -> "12.3456789". */
export function formatAmount(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function applyBps(v: bigint, bps: number): bigint {
  return (v * BigInt(10_000 - bps)) / 10_000n;
}
