export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = Readonly<Record<string, Json>>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The same value with every object's keys in sorted order, so equal values have equal text. */
export function canonicalize(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item as Json));
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalize(value[key] as Json)]),
    );
  }
  return value;
}

export function canonicalJson(value: Json): string {
  return JSON.stringify(canonicalize(value));
}

/** The values of a list with repeats removed and a fixed order, for keywords whose order means nothing. */
export function sortedUnique<T extends Json>(values: readonly T[]): T[] {
  const byText = new Map<string, T>();
  for (const value of values) byText.set(canonicalJson(value), value);
  return [...byText.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v);
}

/**
 * The values of a list in a fixed order with every repeat kept, for keywords whose order means nothing but
 * whose repeats do: `oneOf` needs exactly one branch to match, so a branch written twice can never be the one.
 */
export function sortedWithRepeats<T extends Json>(values: readonly T[]): T[] {
  return values
    .map((value) => [canonicalJson(value), value] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
}
