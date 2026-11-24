import type { DynamoDatabaseService } from "../client-types.ts";
import { makeModelCatalogPersistence } from "./catalog-persistence.ts";
import type { LoadModelOperatorGrants } from "./manifest-model-admission.ts";
import { makeModelPolicyPersistence, type ModelPolicyScope } from "./policy-persistence.ts";
import {
  admitModelReferences,
  agentModelGrantScope,
  catalogLookupModelIds,
  effectiveModelPolicy,
  type ModelAdmission,
} from "@deployments-ai/model-gateway";

/** Decides whether an environment may call one model outside an agent manifest. */
export type AdmitModelId = (scope: ModelPolicyScope, modelId: string) => Promise<ModelAdmission>;

/**
 * Admits a single model id (for example an evaluation judge) against the environment's active
 * model policy (or the curated defaults), the synchronized model catalog, and the operator
 * grants. The call names no agent or workspace, so only organization and deployment-wide grants
 * apply, as when the evaluations token issuer admits the judge model.
 */
export function makeModelIdAdmission(
  database: DynamoDatabaseService,
  loadModelOperatorGrants?: LoadModelOperatorGrants,
): AdmitModelId {
  const policies = makeModelPolicyPersistence(database);
  const catalog = makeModelCatalogPersistence(database);
  return async (scope, modelId) => {
    const [activePolicy, catalogEntries, grants] = await Promise.all([
      policies.getActive(scope),
      catalog.getEntries(catalogLookupModelIds([modelId])),
      loadModelOperatorGrants ? loadModelOperatorGrants() : [],
    ]);
    const { admissions } = admitModelReferences(
      [modelId],
      effectiveModelPolicy(activePolicy),
      catalogEntries,
      grants.length > 0
        ? { grants, scope: agentModelGrantScope({ organizationId: scope.organizationId }) }
        : undefined,
    );
    return admissions[0]!;
  };
}
