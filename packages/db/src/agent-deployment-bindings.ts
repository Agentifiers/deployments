import type { AgentDeploymentConfigV1, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type {
  AgentDefinition,
  AgentDeployment,
  AgentLifecycleContext,
  AgentRelease,
} from "./agent-lifecycle-types.ts";
import { PersistenceError, type PersistenceInvocation } from "./persistence-types.ts";

function invalidBinding(key: string, message: string): never {
  throw new PersistenceError(
    "unprocessable",
    "invalid_agent_deployment_config",
    `/agentBindings/${key}: ${message}`,
  );
}

async function environmentRecord<T extends AgentDefinition | AgentDeployment | AgentRelease>(
  context: AgentLifecycleContext,
  invocation: PersistenceInvocation,
  id: string,
  itemType: T["itemType"],
  label: string,
): Promise<T | undefined> {
  try {
    return await context.getAgentRecord<T>({ ...invocation, id }, itemType, label);
  } catch (cause) {
    if (cause instanceof PersistenceError && cause.kind === "not-found") return undefined;
    throw cause;
  }
}

/**
 * Resolves every declared sub-agent binding to a concrete deployment in the same environment and
 * workspace whose release implements the declared agent key. Runtime delegation re-checks
 * readiness, so a binding may target a paused deployment but never a stopped one.
 */
export async function assertAgentBindingsResolvable(
  context: AgentLifecycleContext,
  invocation: PersistenceInvocation,
  input: {
    readonly agentDefinitionId: string;
    readonly config: AgentDeploymentConfigV1 | undefined;
    readonly deploymentId?: string;
    readonly manifest: AgentManifestV1;
  },
): Promise<void> {
  const bindings = Object.entries(input.config?.agentBindings ?? {});
  if (bindings.length === 0) return;
  const declared = new Map((input.manifest.spec.agents ?? []).map((agent) => [agent.key, agent]));
  const definition = await context.getAgentRecord<AgentDefinition>(
    { ...invocation, id: input.agentDefinitionId },
    "agent-definition",
    "Agent definition",
  );
  for (const [key, binding] of bindings) {
    const agent = declared.get(key);
    if (!agent) invalidBinding(key, `Sub-agent ${key} is not declared by the release.`);
    if (binding.agentDeploymentId === input.deploymentId) {
      invalidBinding(key, "A deployment cannot bind itself as a sub-agent.");
    }
    const target = await environmentRecord<AgentDeployment>(
      context,
      invocation,
      binding.agentDeploymentId,
      "agent-deployment",
      "Bound agent deployment",
    );
    if (!target) {
      invalidBinding(key, "Bound agent deployment was not found in this environment.");
    }
    if (target.data.desiredState === "stopped") {
      invalidBinding(key, "Bound agent deployment is stopped.");
    }
    const [targetDefinition, targetRelease] = await Promise.all([
      environmentRecord<AgentDefinition>(
        context,
        invocation,
        target.data.agentDefinitionId,
        "agent-definition",
        "Bound agent definition",
      ),
      environmentRecord<AgentRelease>(
        context,
        invocation,
        target.data.agentReleaseId,
        "agent-release",
        "Bound agent release",
      ),
    ]);
    if (
      !targetDefinition ||
      targetDefinition.data.status !== "active" ||
      targetDefinition.data.workspaceId !== definition.data.workspaceId
    ) {
      invalidBinding(key, "Bound agent must be active in the same workspace scope.");
    }
    if (targetRelease?.data.manifest.metadata.key !== agent.agentKey) {
      invalidBinding(
        key,
        `Bound agent deployment does not run agent key ${agent.agentKey} declared by the release.`,
      );
    }
  }
}
