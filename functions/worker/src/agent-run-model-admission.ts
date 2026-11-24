import { makeModelCatalogPersistence, makeModelPolicyPersistence } from "@deployments-ai/db";
import {
  admitModelReferences,
  agentModelGrantScope,
  catalogLookupModelIds,
  effectiveModelPolicy,
  type ImageInputSupport,
  type ModelCatalogRuntimeEntries,
} from "@deployments-ai/model-gateway";
import { AgentRunWorkerRecordError } from "./records.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

export interface AgentRunModelReferences {
  readonly modelFallbackIds: readonly string[];
  readonly modelId: string;
}

export interface AgentRunModelAdmission {
  readonly imageInput: ReadonlyMap<string, ImageInputSupport>;
  /** Runtime metadata for the admitted non-curated models with an active catalog entry. */
  readonly modelCatalog?: ModelCatalogRuntimeEntries;
}

/**
 * Re-admits a run's pinned primary and fallback models against the environment's current model
 * policy and the synchronized catalog, then the operator grants applicable to the run. Publish-time
 * admission is not enough: a policy edit, a grant removal, or a catalog retirement after publish
 * must stop further execution, so a denied reference fails the run with its admission reason as
 * the error code. Admitted non-curated models with an active catalog entry return their limits and
 * pricing so every model call of the run can pack context and meter cost.
 */
export async function admitAgentRunModels(
  dependencies: Pick<AgentRunWorkerDependencies, "database" | "loadModelOperatorGrants">,
  run: RunRecordValue,
  model: AgentRunModelReferences,
  agentDefinitionId: string | undefined,
): Promise<AgentRunModelAdmission> {
  const modelIds = [model.modelId, ...model.modelFallbackIds];
  const [activePolicy, catalogEntries, grants] = await Promise.all([
    makeModelPolicyPersistence(dependencies.database).getActive({
      environmentId: run.data.environmentId,
      organizationId: run.data.organizationId,
      projectId: run.data.projectId,
    }),
    makeModelCatalogPersistence(dependencies.database).getEntries(catalogLookupModelIds(modelIds)),
    dependencies.loadModelOperatorGrants ? dependencies.loadModelOperatorGrants() : [],
  ]);
  const { admissions, imageInput, modelCatalog } = admitModelReferences(
    modelIds,
    effectiveModelPolicy(activePolicy),
    catalogEntries,
    grants.length > 0
      ? {
          grants,
          // The scope the agent runtime sends with this run's model calls.
          scope: agentModelGrantScope({
            agentDefinitionId,
            organizationId: run.data.organizationId,
            workspaceId: run.data.workspaceId,
          }),
        }
      : undefined,
  );
  for (const admission of admissions) {
    if (admission.allowed) continue;
    throw new AgentRunWorkerRecordError(
      admission.reason,
      `Pinned model ${admission.modelId} is not admitted in this environment (${admission.reason}): ${admission.message}`,
    );
  }
  return Object.keys(modelCatalog).length > 0 ? { imageInput, modelCatalog } : { imageInput };
}
