/** Optional properties keep their `?` modifier but no longer admit an explicit `undefined`. */
export type DefinedFields<T> = {
  readonly [P in keyof T]: {} extends Pick<T, P> ? Exclude<T[P], undefined> : T[P];
};

/** Copies `data` without the `omitted` keys and without properties whose value is `undefined`. */
export function definedFields<T extends object, const K extends PropertyKey = never>(
  data: T,
  omitted: readonly K[] = [],
): DefinedFields<Omit<T, K>> {
  const excluded = new Set<PropertyKey>(omitted);
  // Object.fromEntries cannot carry key-level types; the filter drops exactly the omitted keys and undefined values.
  return Object.fromEntries(
    Object.entries(data).filter(([key, value]) => value !== undefined && !excluded.has(key)),
  ) as DefinedFields<Omit<T, K>>;
}
