// Erasure finalizes by deleting the organization row; a cached "exists" answer
// may therefore admit an erased organization's facts for at most this long.
const ORGANIZATION_PRESENCE_TTL_MS = 60_000;
const MAX_CACHED_ORGANIZATIONS = 10_000;

export type ExistingOrganizations = (
  organizationIds: readonly string[],
) => Promise<ReadonlySet<string>>;

/** Wraps a batched control-table lookup with a short per-organization cache. */
export function cachedOrganizationPresence(
  lookup: ExistingOrganizations,
  now: () => number = Date.now,
): ExistingOrganizations {
  const cache = new Map<string, { readonly exists: boolean; readonly expiresAt: number }>();
  return async (organizationIds) => {
    const observedAt = now();
    const present = new Set<string>();
    const uncached: string[] = [];
    for (const organizationId of new Set(organizationIds)) {
      const cached = cache.get(organizationId);
      if (!cached || cached.expiresAt <= observedAt) uncached.push(organizationId);
      else if (cached.exists) present.add(organizationId);
    }
    if (uncached.length === 0) return present;
    const found = await lookup(uncached);
    if (cache.size + uncached.length > MAX_CACHED_ORGANIZATIONS) {
      for (const [organizationId, entry] of cache) {
        if (entry.expiresAt <= observedAt) cache.delete(organizationId);
      }
      if (cache.size + uncached.length > MAX_CACHED_ORGANIZATIONS) cache.clear();
    }
    const expiresAt = observedAt + ORGANIZATION_PRESENCE_TTL_MS;
    for (const organizationId of uncached) {
      const exists = found.has(organizationId);
      cache.set(organizationId, { exists, expiresAt });
      if (exists) present.add(organizationId);
    }
    return present;
  };
}
