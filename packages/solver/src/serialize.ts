/**
 * JSON with bigints. Stroop amounts are `bigint` everywhere in this package, and `JSON.stringify` throws on them,
 * so persisted state tags each one as `{"$bigint":"123"}` and `parse` turns it back. Nothing else is special-cased:
 * the persisted types hold only strings, numbers, booleans, arrays, plain objects and bigints.
 */
export function stringify(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v), space);
}

export function parse<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v as object);
      if (keys.length === 1 && keys[0] === "$bigint" && typeof (v as { $bigint: unknown }).$bigint === "string") return BigInt((v as { $bigint: string }).$bigint);
    }
    return v;
  }) as T;
}
