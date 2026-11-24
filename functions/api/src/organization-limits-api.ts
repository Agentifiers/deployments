import { TENANCY_API_SCHEMAS } from "@deployments-ai/api-contract";
import {
  makeOrganizationStandingRepository,
  Ulid,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { TENANT_LIMIT_NAMES, type TenantLimitName } from "@deployments-ai/tenant-limits";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";
import { Schema } from "effect";
import { ApiProblem, type OrganizationLimitsApiService } from "./api-service-contracts.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const decodeResponse = Schema.decodeUnknownSync(TENANCY_API_SCHEMAS.OrganizationLimitsResponse);

/**
 * A limit is an `override` when the operator's grant sets it, a `plan` limit when a machine
 * service's grant (such as billing's) sets it, else the install `default`.
 */
export function makeOrganizationLimitsApiService(input: {
  readonly database: DynamoDatabaseService;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): OrganizationLimitsApiService {
  const standing = makeOrganizationStandingRepository({
    database: input.database,
    installDefaults: parseInstallDefaultEntitlements(input.environment),
  });
  return {
    get: async (invocation) => {
      const organizationId = invocation.id;
      if (!organizationId || organizationId !== invocation.scope.organizationId) {
        throw new ApiProblem(
          403,
          "organization_scope_violation",
          "The resource is outside the requested scope.",
        );
      }
      const { grants, standing: effective } = await standing.readWithGrants(
        decodeUlid(organizationId),
      );
      const sourceOf = (name: TenantLimitName) =>
        grants.operator?.entitlements.tenantLimits?.[name] !== undefined
          ? "override"
          : grants.service?.entitlements.tenantLimits?.[name] !== undefined
            ? "plan"
            : "default";
      return decodeResponse({
        effective: Object.fromEntries(
          TENANT_LIMIT_NAMES.map((name) => [
            name,
            {
              source: sourceOf(name),
              value: effective.entitlements.tenantLimits[name],
            },
          ]),
        ),
        organizationId,
      });
    },
  };
}
