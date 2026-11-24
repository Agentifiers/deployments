import type { AgentDeploymentConfigV1, AgentManifestV1 } from "./schema.ts";
import type { AgentManifestSemanticIssue } from "./semantics.ts";

export const AGENT_DELEGATE_TOOL_NAME = "agent.delegate";

/** Release-level checks for declared sub-agents; environment bindings are validated at deploy time. */
export function subAgentSemanticIssues(manifest: AgentManifestV1): AgentManifestSemanticIssue[] {
  const agents = manifest.spec.agents ?? [];
  if (agents.length === 0) return [];
  const issues: AgentManifestSemanticIssue[] = [];
  const keys = new Set<string>();
  for (const [index, agent] of agents.entries()) {
    if (keys.has(agent.key)) {
      issues.push({
        code: "duplicate_sub_agent_key",
        message: `Sub-agent key ${agent.key} is declared more than once.`,
        path: `/spec/agents/${index}/key`,
      });
    }
    keys.add(agent.key);
    if (agent.agentKey === manifest.metadata.key) {
      issues.push({
        code: "sub_agent_targets_self",
        message: `Sub-agent ${agent.key} cannot target the agent that declares it.`,
        path: `/spec/agents/${index}/agentKey`,
      });
    }
  }
  const declaresDelegate = (manifest.spec.capabilities?.tools ?? []).some(
    (tool) => tool.name === AGENT_DELEGATE_TOOL_NAME,
  );
  if (!declaresDelegate) {
    issues.push({
      code: "sub_agents_require_delegate_capability",
      message: `Declared sub-agents require the ${AGENT_DELEGATE_TOOL_NAME} tool capability.`,
      path: "/spec/agents",
    });
  } else {
    const runtime = manifest.spec.runtime;
    const reachable =
      (runtime?.modelTools ?? []).includes(AGENT_DELEGATE_TOOL_NAME) ||
      (runtime?.toolRequests ?? []).some(
        (request) => request.toolName === AGENT_DELEGATE_TOOL_NAME,
      );
    if (!reachable) {
      issues.push({
        code: "sub_agents_require_delegate_tool",
        message: `Declared sub-agents require ${AGENT_DELEGATE_TOOL_NAME} in spec.runtime.modelTools or a preconfigured tool request.`,
        path: "/spec/agents",
      });
    }
  }
  return issues;
}

/** Deployment-level checks that bindings exactly cover the release's declared sub-agents. */
export function agentBindingSemanticIssues(
  config: AgentDeploymentConfigV1,
  manifest: AgentManifestV1,
): AgentManifestSemanticIssue[] {
  const issues: AgentManifestSemanticIssue[] = [];
  const declared = new Map((manifest.spec.agents ?? []).map((agent) => [agent.key, agent]));
  const bindings = config.agentBindings ?? {};
  for (const key of Object.keys(bindings)) {
    if (!declared.has(key)) {
      issues.push({
        code: "undeclared_agent_binding",
        message: `Deployment configuration binds undeclared sub-agent ${key}.`,
        path: `/agentBindings/${key}`,
      });
    }
  }
  for (const agent of declared.values()) {
    if (agent.required && !Object.hasOwn(bindings, agent.key)) {
      issues.push({
        code: "missing_agent_binding",
        message: `Deployment configuration must bind required sub-agent ${agent.key}.`,
        path: `/agentBindings/${agent.key}`,
      });
    }
  }
  return issues;
}
