import { agentManifestModelPolicyIssues } from "@deployments-ai/agent-manifest";
import type { AdmitManifest, AgentModelAdmissionScope } from "../agent-model-admission.ts";
import { makeAgentLifecycleRecordStore } from "../agent-lifecycle-storage.ts";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import {
  boundaryAdmitsModel,
  makeOrganizationDataBoundaryReader,
} from "../organization-standing/data-boundary.ts";
import { PersistenceError } from "../persistence-types.ts";
import type { PlatformRecord } from "../records/index.ts";
import { makeModelCatalogPersistence } from "./catalog-persistence.ts";
import { makeModelPolicyPersistence } from "./policy-persistence.ts";
import {
  admitModelReferences,
  agentModelGrantScope,
  catalogLookupModelIds,
  effectiveModelPolicy,
  type ModelAdmission,
  type ModelOperatorGrant,
  type OperatorModelGrants,
} from "@deployments-ai/model-gateway";

/**
 * Loads the operator model grants, from the same deploy-time configuration the model token
 * issuers admit with.
 */
export type LoadModelOperatorGrants = () => Promise<readonly ModelOperatorGrant[]>;

async function definitionWorkspaceId(
  database: DynamoDatabaseService,
  scope: AgentModelAdmissionScope & { readonly agentDefinitionId: string },
) {
  let record: PlatformRecord | undefined;
  try {
    record = await makeAgentLifecycleRecordStore(database).getEnvironmentRecord(
      scope,
      "agent-definition",
      scope.agentDefinitionId,
    );
  } catch {
    throw new PersistenceError(
      "internal",
      "persistence_error",
      "Agent definition lookup for model admission failed.",
    );
  }
  return record?.itemType === "agent-definition" ? record.data.workspaceId : undefined;
}

/**
 * The operator grants that apply to the agent's model calls. The route scope mirrors the one the
 * agent runtime sends the gateway: the definition id as `agentId`, the organization, and the
 * definition's workspace (run-time admission uses the run's thread workspace instead).
 */
async function operatorModelGrantsFor(
  database: DynamoDatabaseService,
  scope: AgentModelAdmissionScope,
  loadModelOperatorGrants: LoadModelOperatorGrants | undefined,
): Promise<OperatorModelGrants | undefined> {
  const grants = loadModelOperatorGrants ? await loadModelOperatorGrants() : [];
  if (grants.length === 0) return undefined;
  const workspaceId = scope.agentDefinitionId
    ? await definitionWorkspaceId(database, {
        ...scope,
        agentDefinitionId: scope.agentDefinitionId,
      })
    : undefined;
  return {
    grants,
    scope: agentModelGrantScope({
      agentDefinitionId: scope.agentDefinitionId,
      organizationId: scope.organizationId,
      workspaceId,
    }),
  };
}

/**
 * Admits a manifest's primary and fallback models against the organization's data boundary, then
 * the operator grants applicable to the agent, the environment's active model policy (or the
 * curated defaults), and the synchronized model catalog, as publish, deploy, and binding creation
 * require.
 */
export function makeManifestModelAdmission(
  database: DynamoDatabaseService,
  loadModelOperatorGrants?: LoadModelOperatorGrants,
): AdmitManifest {
  const policies = makeModelPolicyPersistence(database);
  const catalog = makeModelCatalogPersistence(database);
  const dataBoundaries = makeOrganizationDataBoundaryReader(database);
  return async (scope, manifest) => {
    const requested = [manifest.spec.model.id, ...(manifest.spec.model.fallbackIds ?? [])];
    const [boundary, activePolicy, catalogEntries, operatorGrants] = await Promise.all([
      dataBoundaries.read(scope.organizationId as Ulid),
      policies.getActive(scope),
      catalog.getEntries(catalogLookupModelIds(requested)),
      operatorModelGrantsFor(database, scope, loadModelOperatorGrants),
    ]);
    const { admissions } = admitModelReferences(
      requested,
      effectiveModelPolicy(activePolicy),
      catalogEntries,
      operatorGrants,
    );
    const admissionByModelId = new Map<string, ModelAdmission>(
      requested.map((modelId, index) => [modelId, admissions[index]!]),
    );
    return agentManifestModelPolicyIssues(manifest, (modelId) => {
      if (!boundaryAdmitsModel(boundary, modelId)) {
        return {
          allowed: false,
          code: "model_outside_data_boundary",
          message: `Model ${modelId} is outside this organization's ${boundary.profile} data boundary, which allows only ${[...boundary.modelProviders].join(", ")} models.`,
        };
      }
      const admission = admissionByModelId.get(modelId)!;
      return admission.allowed
        ? { allowed: true }
        : { allowed: false, code: admission.reason, message: admission.message };
    });
  };
}
