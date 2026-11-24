import { describe, expect, test } from "bun:test";
import type { TenantLimits } from "./limits.ts";
import { makeTenantLimitResolver } from "./resolver.ts";

const DEFAULTS = {
  activeSandboxes: 8,
  apiRequestBurst: 40,
  apiRequestsPerSecond: 20,
  concurrentRuns: 8,
};

function harness(load: (organizationId: string) => Promise<Partial<TenantLimits>>) {
  let clock = 0;
  const loads: string[] = [];
  const resolver = makeTenantLimitResolver({
    defaults: DEFAULTS,
    load: async (organizationId) => {
      loads.push(organizationId);
      return { ...DEFAULTS, ...(await load(organizationId)) };
    },
    now: () => clock,
    ttlMs: 1_000,
  });
  return { advance: (ms: number) => (clock += ms), loads, resolver };
}

describe("tenant limit resolver", () => {
  test("serves cached limits until the TTL elapses", async () => {
    let concurrentRuns = 16;
    const { advance, loads, resolver } = harness(async () => ({ concurrentRuns }));

    expect((await resolver.limitsFor("org-a")).concurrentRuns).toBe(16);
    concurrentRuns = 2;
    advance(999);
    expect((await resolver.limitsFor("org-a")).concurrentRuns).toBe(16);
    advance(1);
    expect((await resolver.limitsFor("org-a")).concurrentRuns).toBe(2);
    expect(loads).toEqual(["org-a", "org-a"]);
  });

  test("shares one load between concurrent callers", async () => {
    const { loads, resolver } = harness(async () => ({}));

    await Promise.all([resolver.limitsFor("org-a"), resolver.limitsFor("org-a")]);

    expect(loads).toEqual(["org-a"]);
  });

  test("serves the last known limits, else the defaults, when the store fails", async () => {
    let fail = false;
    const { advance, resolver } = harness(async (organizationId) => {
      if (fail) throw new Error("control table unavailable");
      return organizationId === "org-a" ? { activeSandboxes: 1 } : {};
    });

    await resolver.limitsFor("org-a");
    fail = true;
    advance(5_000);

    expect((await resolver.limitsFor("org-a")).activeSandboxes).toBe(1);
    expect(await resolver.limitsFor("org-b")).toEqual(DEFAULTS);
  });
});
