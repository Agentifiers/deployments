import type { TenantLimitResolver, TenantLimits } from "@deployments-ai/tenant-limits";
import type { TenantLimitHit, TenantLimitMetrics } from "./tenant-limit-metrics.ts";

const TEST_TENANT_LIMITS: TenantLimits = {
  activeSandboxes: 256,
  apiRequestBurst: 1_000,
  apiRequestsPerSecond: 500,
  concurrentRuns: 256,
};

export function testTenantLimits(overrides: Partial<TenantLimits> = {}) {
  let limits: TenantLimits = { ...TEST_TENANT_LIMITS, ...overrides };
  const resolver: TenantLimitResolver = { limitsFor: async () => limits };
  return {
    resolver,
    set: (next: Partial<TenantLimits>) => {
      limits = { ...limits, ...next };
    },
  };
}

export function recordingTenantLimitMetrics() {
  const hits: TenantLimitHit[] = [];
  const metrics: TenantLimitMetrics = { record: (hit) => void hits.push(hit) };
  return { hits, metrics };
}
