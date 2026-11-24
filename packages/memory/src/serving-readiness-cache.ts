import type { MemorySearchProviderClient, MemorySearchReadiness } from "./provider.ts";
import { withAbort } from "./promise-abort.ts";

const SERVING_READINESS_CACHE_MS = 60_000;
const SERVING_READINESS_MAX_ENTRIES = 1_000;
const SERVING_READINESS_REQUEST_TIMEOUT_MS = 5_000;

export function makeServingReadinessCache(
  options: {
    readonly maxEntries?: number;
    readonly now?: () => number;
    readonly requestTimeoutMs?: number;
  } = {},
) {
  const maxEntries = options.maxEntries ?? SERVING_READINESS_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? SERVING_READINESS_REQUEST_TIMEOUT_MS;
  const entries = new Map<
    string,
    { readonly expiresAt: number; readonly promise: Promise<MemorySearchReadiness> }
  >();
  const key = (provider: MemorySearchProviderClient, organizationId: string) =>
    `${provider.target.targetId}:${provider.target.schemaGeneration}:${organizationId}`;
  const invalidate = (provider: MemorySearchProviderClient, organizationId: string) => {
    entries.delete(key(provider, organizationId));
  };
  const read = async (
    provider: MemorySearchProviderClient,
    organizationId: string,
    signal?: AbortSignal,
  ) => {
    if (!provider.readiness) return undefined;
    const cacheKey = key(provider, organizationId);
    const timestamp = now();
    for (const [candidateKey, candidate] of entries) {
      if (candidate.expiresAt <= timestamp) entries.delete(candidateKey);
    }
    const cached = entries.get(cacheKey);
    if (cached) return withAbort(cached.promise, signal);
    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
    const promise = provider.readiness({
      organizationId,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    entries.set(cacheKey, { expiresAt: timestamp + SERVING_READINESS_CACHE_MS, promise });
    promise.then(
      (readiness) => {
        if (!readiness.ready && entries.get(cacheKey)?.promise === promise) {
          entries.delete(cacheKey);
        }
      },
      () => {
        if (entries.get(cacheKey)?.promise === promise) entries.delete(cacheKey);
      },
    );
    return withAbort(promise, signal);
  };
  return { invalidate, read };
}
