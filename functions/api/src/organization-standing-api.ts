import { TENANCY_API_SCHEMAS } from "@deployments-ai/api-contract";
import {
  makeOrganizationStandingRepository,
  Ulid,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";
import { Schema } from "effect";
import { ApiProblem, type OrganizationStandingApiService } from "./api-service-contracts.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const decodeResponse = Schema.decodeUnknownSync(TENANCY_API_SCHEMAS.OrganizationStandingResponse);

/**
 * What members see of their organization's standing: never who placed a hold or set the data
 * boundary, or the notes on either.
 */
export function makeOrganizationStandingApiService(input: {
  readonly database: DynamoDatabaseService;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): OrganizationStandingApiService {
  const repository = makeOrganizationStandingRepository({
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
      const { dataBoundary, standing } = await repository.readWithGrants(
        decodeUlid(organizationId),
        { consistent: true },
      );
      const suspended = standing.state === "suspended";
      return decodeResponse({
        dataBoundary: dataBoundary
          ? { profile: dataBoundary.profile, since: dataBoundary.setAt }
          : null,
        effective: standing.entitlements,
        holds: suspended
          ? standing.holds.map((hold) => ({
              customerMessage: hold.customerMessage,
              reason: hold.reason,
              since: hold.placedAt,
            }))
          : [],
        organizationId,
        state: standing.state,
        suspendedAt: suspended ? standing.suspendedAt : null,
      });
    },
  };
}
