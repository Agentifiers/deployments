import {
  executionBindingIsActive,
  makeExecutionBindingPersistence,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import * as Types from "./platform-types.ts";

/** The deployment whose agent memory grants a run uses, and whether the run may write. */
export interface RunMemorySubject {
  readonly agentDeploymentId: Ulid;
  readonly readOnly: boolean;
}

function unavailable(message: string): never {
  throw new Types.MemoryPlatformError(409, "execution_binding_memory_unavailable", message);
}

/**
 * Flushes, candidate imports, memory writes, and release lookups belong to customer runs only:
 * preview recall is read-only and evaluation runs never touch memory.
 */
export function customerRun(run: Types.Run) {
  if (run.data.executionBindingId !== undefined) {
    return unavailable("Preview and evaluation runs cannot write deployment memory.");
  }
  return { ...run, data: run.data };
}

export function makeRunMemorySubjects(input: {
  readonly database: DynamoDatabaseService;
  readonly now: () => Date;
}) {
  const bindings = makeExecutionBindingPersistence(input.database);

  /**
   * Customer runs read and write through their own deployment. Preview runs recall read-only
   * through the deployment their binding snapshotted with `runtimeConfigFromAgentDeploymentId`, so
   * a preview sees the memory that deployment's agent would see without ever changing it.
   * Evaluation runs recall nothing by default: scores must not depend on mutable production memory.
   */
  async function forRun(run: Types.Run): Promise<RunMemorySubject> {
    if (run.data.executionBindingId === undefined) {
      return { agentDeploymentId: run.data.agentDeploymentId, readOnly: false };
    }
    if (run.data.executionPurpose !== "preview") {
      return unavailable("Evaluation runs do not recall deployment memory.");
    }
    const binding = await bindings.get({
      environmentId: run.data.environmentId,
      executionBindingId: run.data.executionBindingId,
      organizationId: run.data.organizationId,
    });
    if (
      !binding ||
      binding.data.projectId !== run.data.projectId ||
      binding.data.purpose !== "preview" ||
      !executionBindingIsActive(binding, input.now())
    ) {
      return unavailable("Preview memory recall requires an active preview execution binding.");
    }
    const agentDeploymentId = binding.data.runtimeConfigSourceAgentDeploymentId;
    if (agentDeploymentId === undefined) {
      return unavailable(
        "Preview runs recall memory only when their binding snapshots a source deployment.",
      );
    }
    return { agentDeploymentId, readOnly: true };
  }

  return { forRun };
}
