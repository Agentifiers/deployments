import {
  makeOrganizationRequestLimiterFromEnvironment,
  makeOrganizationStandingRepository,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";
import { createOrganizationGate } from "./gate.ts";

/** See `makeOrganizationRequestLimiterFromEnvironment` for `client`. */
export function makeOrganizationGateFromEnvironment(
  input: Parameters<typeof makeOrganizationRequestLimiterFromEnvironment>[0] & {
    readonly database: DynamoDatabaseService;
  },
) {
  const installDefaults = parseInstallDefaultEntitlements(input.environment);
  return createOrganizationGate({
    defaultLimits: installDefaults.tenantLimits,
    limiter: makeOrganizationRequestLimiterFromEnvironment(input),
    service: input.environment.AWS_LAMBDA_FUNCTION_NAME?.trim() || "local",
    standing: makeOrganizationStandingRepository({ database: input.database, installDefaults }),
  });
}
