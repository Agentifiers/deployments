export interface ExpiringValue<Value> {
  readonly validUntil: number;
  readonly value: Value;
}

/**
 * Remembers each key's answer until the `validUntil` its load returned, and shares one load among
 * concurrent lookups of a key. A failed load is not remembered. At `maxEntries`, expired answers
 * are dropped, and everything when none has expired.
 */
export function makeExpiringLookup<Value>(input: {
  readonly maxEntries: number;
  readonly now: () => number;
}) {
  const cache = new Map<string, ExpiringValue<Value>>();
  const pending = new Map<string, Promise<Value>>();

  const remember = (key: string, answer: ExpiringValue<Value>) => {
    if (cache.size >= input.maxEntries) {
      const now = input.now();
      for (const [cachedKey, cached] of cache) {
        if (cached.validUntil <= now) cache.delete(cachedKey);
      }
      if (cache.size >= input.maxEntries) cache.clear();
    }
    cache.set(key, answer);
  };

  return (key: string, load: () => Promise<ExpiringValue<Value>>): Promise<Value> => {
    const cached = cache.get(key);
    if (cached && cached.validUntil > input.now()) return Promise.resolve(cached.value);
    let lookup = pending.get(key);
    if (!lookup) {
      lookup = load()
        .then((answer) => {
          remember(key, answer);
          return answer.value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, lookup);
    }
    return lookup;
  };
}
