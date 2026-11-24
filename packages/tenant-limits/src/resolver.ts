import type { TenantLimits } from "./limits.ts";

export interface TenantLimitResolver {
  readonly limitsFor: (organizationId: string) => Promise<TenantLimits>;
}

interface CacheEntry {
  readonly limits: TenantLimits;
  readonly loadedAt: number;
}

/**
 * Caches each organization's effective limits from `load`. A failed load enforces the last limits
 * this process saw for the organization, or `defaults` when it saw none.
 */
export function makeTenantLimitResolver(input: {
  readonly defaults: TenantLimits;
  readonly load: (organizationId: string) => Promise<TenantLimits>;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly onLoadError?: (organizationId: string, cause: unknown) => void;
}): TenantLimitResolver {
  const ttlMs = input.ttlMs ?? 30_000;
  const maxEntries = input.maxEntries ?? 10_000;
  const now = input.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const loading = new Map<string, Promise<TenantLimits>>();

  const remember = (organizationId: string, limits: TenantLimits) => {
    cache.delete(organizationId);
    cache.set(organizationId, { limits, loadedAt: now() });
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return limits;
  };

  const load = (organizationId: string) => {
    const inFlight = loading.get(organizationId);
    if (inFlight) return inFlight;
    const pending = input
      .load(organizationId)
      .then(
        (limits) => remember(organizationId, limits),
        (cause: unknown) => {
          input.onLoadError?.(organizationId, cause);
          return cache.get(organizationId)?.limits ?? input.defaults;
        },
      )
      .finally(() => loading.delete(organizationId));
    loading.set(organizationId, pending);
    return pending;
  };

  return {
    limitsFor: async (organizationId) => {
      const cached = cache.get(organizationId);
      if (cached && now() - cached.loadedAt < ttlMs) return cached.limits;
      return load(organizationId);
    },
  };
}
