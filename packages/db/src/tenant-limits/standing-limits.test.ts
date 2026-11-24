import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService } from "../client-types.ts";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { makeOrganizationStandingRepository } from "../organization-standing/repository.ts";
import {
  BILLING,
  INSTALL_DEFAULTS,
  OPERATOR,
  ORGANIZATION_ID,
  minuteClock,
  organizationRecord,
} from "../organization-standing/test-support.ts";
import { makeStandingTenantLimitResolver } from "./standing-limits.ts";

function harness(
  input: { readonly wrap?: (database: DynamoDatabaseService) => DynamoDatabaseService } = {},
) {
  const memory = evaluationMemoryDatabase([organizationRecord(ORGANIZATION_ID)]);
  const database = (input.wrap ?? ((database) => database))(memory.database);
  const standing = makeOrganizationStandingRepository({
    database: memory.database,
    installDefaults: INSTALL_DEFAULTS,
    now: minuteClock(),
  });
  const errors: string[] = [];
  const resolver = makeStandingTenantLimitResolver({
    database,
    installDefaults: INSTALL_DEFAULTS,
    onLoadError: (organizationId) => void errors.push(organizationId),
    ttlMs: 0,
  });
  return { errors, resolver, standing };
}

describe("tenant limits from organization standing", () => {
  test("enforces install defaults for an organization without a grant", async () => {
    const { resolver } = harness();

    expect(await resolver.limitsFor(ORGANIZATION_ID)).toEqual({
      activeSandboxes: 1,
      apiRequestBurst: 40,
      apiRequestsPerSecond: 20,
      concurrentRuns: 2,
    });
  });

  test("takes the service grant's fields, and the operator grant's over them", async () => {
    const { resolver, standing } = harness();
    await standing.setGrant({
      actor: BILLING,
      entitlements: { tenantLimits: { activeSandboxes: 8, concurrentRuns: 16 } },
      organizationId: ORGANIZATION_ID,
    });
    const serviceOnly = await resolver.limitsFor(ORGANIZATION_ID);
    await standing.setGrant({
      actor: OPERATOR,
      entitlements: { tenantLimits: { activeSandboxes: 3 } },
      organizationId: ORGANIZATION_ID,
    });

    expect([serviceOnly, await resolver.limitsFor(ORGANIZATION_ID)]).toEqual([
      { activeSandboxes: 8, apiRequestBurst: 40, apiRequestsPerSecond: 20, concurrentRuns: 16 },
      { activeSandboxes: 3, apiRequestBurst: 40, apiRequestsPerSecond: 20, concurrentRuns: 16 },
    ]);
  });

  test("enforces install defaults when standing cannot be read", async () => {
    const { errors, resolver } = harness({
      wrap: (database) => ({
        ...database,
        getRecord: async () => {
          throw new Error("control table unavailable");
        },
      }),
    });

    expect((await resolver.limitsFor(ORGANIZATION_ID)).concurrentRuns).toBe(2);
    expect(errors).toEqual([ORGANIZATION_ID]);
  });
});
