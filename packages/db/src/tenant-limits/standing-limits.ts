import { makeTenantLimitResolver, type TenantLimitResolver } from "@deployments-ai/tenant-limits";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import type { InstallDefaults } from "../organization-standing/effective-standing.ts";
import { makeOrganizationStandingRepository } from "../organization-standing/repository.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);

/**
 * Each organization's effective tenant limits from its standing: the operator grant, then the
 * service grant, then the install defaults. For callers that admit work without reading standing
 * themselves, such as run and sandbox capacity.
 */
export function makeStandingTenantLimitResolver(input: {
  readonly database: DynamoDatabaseService;
  readonly installDefaults: InstallDefaults;
  readonly onLoadError?: (organizationId: string, cause: unknown) => void;
  readonly ttlMs?: number;
}): TenantLimitResolver {
  const standing = makeOrganizationStandingRepository({
    database: input.database,
    installDefaults: input.installDefaults,
  });
  return makeTenantLimitResolver({
    defaults: input.installDefaults.tenantLimits,
    load: async (organizationId) =>
      (await standing.read(decodeUlid(organizationId))).entitlements.tenantLimits,
    ...(input.onLoadError ? { onLoadError: input.onLoadError } : {}),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
}
