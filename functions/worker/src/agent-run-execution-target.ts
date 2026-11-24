import type { AgentDeploymentConfigV1, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type { AgentRunExecutionPins } from "@deployments-ai/agent-runtime";
import {
  activeExecutionBindingCondition,
  executionBindingIsActive,
  makeExecutionBindingPersistence,
  type DynamoDatabaseService,
  type ExecutionBindingRecordValue,
  type ExecutionBindingToolPolicy,
  type TransactionOperation,
} from "@deployments-ai/db";
import { validatePins } from "./agent-run-input.ts";
import { AgentRunWorkerRecordError, loadAgentDeployment, loadAgentRelease } from "./records.ts";
import type {
  AgentDeploymentRecordValue,
  AgentReleaseRecordValue,
  AgentRunQueueMessage,
  RunRecordValue,
  ThreadRecordValue,
} from "./types.ts";

/**
 * What a run executes: a production deployment with its pinned release, or an execution binding
 * (preview/evaluation) that carries its own validated manifest and frozen runtime config.
 */
export type RunExecutionTarget =
  | {
      readonly deployment: AgentDeploymentRecordValue;
      readonly kind: "deployment";
      readonly release: AgentReleaseRecordValue;
    }
  | {
      readonly binding: ExecutionBindingRecordValue;
      readonly kind: "binding";
    };

/** The execution inputs shared by deployment and binding targets. */
export interface RunExecutionProfile {
  readonly agentManifestHash: string;
  readonly manifest: AgentManifestV1;
  /**
   * Customer runs recall through their deployment. Preview bindings recall read-only through the
   * deployment snapshotted by `runtimeConfigFromAgentDeploymentId`. Evaluation runs never recall,
   * so scores do not depend on mutable production memory.
   */
  readonly memoryRecall: boolean;
  readonly pins: AgentRunExecutionPins;
  readonly runtimeConfig?: AgentDeploymentConfigV1;
  /** `deployment` applies the deployment's own tool policy; binding policies are explicit. */
  readonly toolPolicy: "deployment" | ExecutionBindingToolPolicy;
}

export async function loadRunExecutionTarget(
  database: DynamoDatabaseService,
  queue: Pick<AgentRunQueueMessage, "environmentId" | "organizationId">,
  run: RunRecordValue,
): Promise<RunExecutionTarget> {
  if (run.data.executionBindingId === undefined) {
    const [deployment, release] = await Promise.all([
      loadAgentDeployment(database, queue, run.data.agentDeploymentId),
      loadAgentRelease(database, queue, run.data.agentReleaseId),
    ]);
    return { deployment, kind: "deployment", release };
  }
  const binding = await makeExecutionBindingPersistence(database).get({
    environmentId: queue.environmentId,
    executionBindingId: run.data.executionBindingId,
    organizationId: queue.organizationId,
  });
  if (!binding) {
    throw new AgentRunWorkerRecordError("record_not_found", "Execution binding was not found.");
  }
  return { binding, kind: "binding" };
}

/**
 * Preview and evaluation runs are pinned to their binding rather than a deployment. They never
 * require a ready deployment, but the binding must still be active and match the run's scope.
 */
export function validateRunExecutionTarget(
  run: RunRecordValue,
  thread: ThreadRecordValue,
  target: RunExecutionTarget,
  at: Date,
): void {
  if (target.kind === "deployment") {
    validatePins(run, thread, target.deployment, target.release);
    return;
  }
  const binding = target.binding.data;
  if (thread.data.archived) {
    throw new AgentRunWorkerRecordError(
      "thread_archived",
      "Archived threads cannot execute agent runs.",
    );
  }
  for (const [label, scope] of [
    ["Thread", thread.data],
    ["Execution binding", binding],
  ] as const) {
    if (
      scope.organizationId !== run.data.organizationId ||
      scope.projectId !== run.data.projectId ||
      scope.environmentId !== run.data.environmentId
    ) {
      throw new AgentRunWorkerRecordError(
        "pinned_scope_mismatch",
        `${label} scope does not match the run scope.`,
      );
    }
  }
  if (thread.data.workspaceId !== run.data.workspaceId) {
    throw new AgentRunWorkerRecordError(
      "pinned_workspace_mismatch",
      "Thread workspace scope does not match the run workspace scope.",
    );
  }
  const releasePin = binding.source.type === "release" ? binding.source.agentReleaseId : undefined;
  if (
    run.data.executionBindingId !== binding.id ||
    thread.data.executionBindingId !== binding.id ||
    run.data.executionPurpose !== binding.purpose ||
    thread.data.executionPurpose !== binding.purpose ||
    run.data.agentReleaseId !== releasePin
  ) {
    throw new AgentRunWorkerRecordError(
      "execution_binding_mismatch",
      "Run, thread, and execution binding pins are inconsistent.",
    );
  }
  if (!executionBindingIsActive(target.binding, at)) {
    throw new AgentRunWorkerRecordError(
      "execution_binding_expired",
      "Execution binding has expired and can no longer execute runs.",
    );
  }
}

/** Claim-time fences proving the run's execution target is still executable. */
export function executionTargetConditions(
  target: RunExecutionTarget,
  at: Date,
): readonly TransactionOperation[] {
  if (target.kind === "binding") return [activeExecutionBindingCondition(target.binding, at)];
  return [
    {
      conditionExpression:
        "#data.#version = :version AND #data.#currentState = :ready AND #data.#desiredState = :running",
      expressionAttributeNames: {
        "#currentState": "currentState",
        "#data": "data",
        "#desiredState": "desiredState",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":ready": "ready",
        ":running": "running",
        ":version": target.deployment.data.version,
      },
      key: { pk: target.deployment.pk, sk: target.deployment.sk },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression: "#data.#version = :version AND #data.#status = :active",
      expressionAttributeNames: {
        "#data": "data",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":version": target.release.data.version,
      },
      key: { pk: target.release.pk, sk: target.release.sk },
      kind: "condition-check",
      table: "control",
    },
  ];
}

export function runExecutionProfile(target: RunExecutionTarget): RunExecutionProfile {
  if (target.kind === "deployment") {
    const { deployment, release } = target;
    return {
      agentManifestHash: release.data.contentHash,
      manifest: release.data.manifest,
      memoryRecall: true,
      pins: {
        agentDefinitionId: release.data.agentDefinitionId,
        agentDeploymentId: deployment.data.id,
        agentReleaseId: release.data.id,
      },
      ...(deployment.data.runtimeConfig ? { runtimeConfig: deployment.data.runtimeConfig } : {}),
      toolPolicy: "deployment",
    };
  }
  const binding = target.binding.data;
  return {
    agentManifestHash: binding.contentHash,
    manifest: binding.manifest,
    memoryRecall:
      binding.purpose === "preview" && binding.runtimeConfigSourceAgentDeploymentId !== undefined,
    pins: {
      ...(binding.source.type === "release"
        ? {
            agentDefinitionId: binding.source.agentDefinitionId,
            agentReleaseId: binding.source.agentReleaseId,
          }
        : {}),
      executionBindingId: binding.id,
      executionPurpose: binding.purpose,
    },
    ...(binding.runtimeConfig ? { runtimeConfig: binding.runtimeConfig } : {}),
    toolPolicy: binding.toolPolicy,
  };
}
