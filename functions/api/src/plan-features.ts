import type { PlanFeature } from "@deployments-ai/api-contract";
import {
  makeOrganizationStandingRepository,
  type DynamoDatabaseService,
  type PlanFeatureName,
  type Ulid,
} from "@deployments-ai/db";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";

/** Reads the organization's plan features, for routes a plan can switch off. */
export function planFeaturesFromEnvironment(input: {
  readonly database: DynamoDatabaseService;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) {
  const repository = makeOrganizationStandingRepository({
    database: input.database,
    installDefaults: parseInstallDefaultEntitlements(input.environment),
  });
  return async (organizationId: Ulid) =>
    (await repository.read(organizationId, { consistent: true })).entitlements.features;
}

// The record keeps its own copy of the feature names because the db package cannot depend on
// the public contract; this fails to compile when the two lists drift apart.
type SameFeatures<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
const featuresMatch: SameFeatures<PlanFeature, PlanFeatureName> = true;
void featuresMatch;
