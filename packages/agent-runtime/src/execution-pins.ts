import type { SandboxExecutionTargetKind, Ulid } from "@deployments-ai/db";
import type { AgentRunExecutionPins } from "./types.ts";

/**
 * Copies a run's purpose-discriminated execution pins without widening them into independent
 * optional fields, so derived contexts stay either deployment-pinned or binding-pinned.
 */
export function agentRunExecutionPins(input: AgentRunExecutionPins): AgentRunExecutionPins {
  if (input.executionBindingId === undefined) {
    return {
      agentDefinitionId: input.agentDefinitionId,
      agentDeploymentId: input.agentDeploymentId,
      agentReleaseId: input.agentReleaseId,
    };
  }
  return {
    ...(input.agentDefinitionId ? { agentDefinitionId: input.agentDefinitionId } : {}),
    ...(input.agentReleaseId ? { agentReleaseId: input.agentReleaseId } : {}),
    executionBindingId: input.executionBindingId,
    executionPurpose: input.executionPurpose,
  };
}

/** The durable agent identity that acts for a run: its deployment or its execution binding. */
export function agentRunActorId(
  input:
    | { readonly agentDeploymentId: Ulid; readonly executionBindingId?: undefined }
    | { readonly agentDeploymentId?: undefined; readonly executionBindingId: Ulid },
): Ulid {
  return input.agentDeploymentId ?? input.executionBindingId;
}

/**
 * The owner of a run's sandbox state. Kind and id together identify it, so preview/evaluation
 * sandboxes never share leases or `/workspace` state with a deployment.
 */
export function agentRunSandboxOwner(
  input:
    | { readonly agentDeploymentId: Ulid; readonly executionBindingId?: undefined }
    | { readonly agentDeploymentId?: undefined; readonly executionBindingId: Ulid },
): { readonly executionTargetId: Ulid; readonly executionTargetKind: SandboxExecutionTargetKind } {
  return input.executionBindingId === undefined
    ? { executionTargetId: input.agentDeploymentId, executionTargetKind: "agent-deployment" }
    : { executionTargetId: input.executionBindingId, executionTargetKind: "execution-binding" };
}

/**
 * Raised when a preview or evaluation run reaches a capability whose durable state is owned by a
 * production deployment (sandbox leases, schedules, delegation, Brain mounts, memory writes).
 */
export class RuntimeDeploymentRequiredError extends Error {
  constructor(readonly capability: string) {
    super(
      `${capability} requires a deployed agent and is unavailable to preview and evaluation runs.`,
    );
    this.name = "RuntimeDeploymentRequiredError";
  }
}

export function requireAgentDeploymentId(input: AgentRunExecutionPins, capability: string): Ulid {
  if (input.agentDeploymentId === undefined) throw new RuntimeDeploymentRequiredError(capability);
  return input.agentDeploymentId;
}
