import type {
  AgentDeploymentConfigV1,
  AgentManifestV1,
  AgentToolAuthorizationBinding,
} from "@deployments-ai/agent-manifest/schema";
import {
  agentDeploymentConfigSemanticIssues,
  type AgentManifestSemanticIssue,
} from "@deployments-ai/agent-manifest/semantics";

export type DeploymentConfig = AgentDeploymentConfigV1;
export type ToolBinding = AgentToolAuthorizationBinding;
/** Per-tool edits to a deployment's tool authorizations; `null` removes the tool's binding. */
export type ToolBindingChanges = Readonly<Record<string, ToolBinding | null>>;

export const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig = {
  apiVersion: "agents.deployments.ai/v1",
  kind: "AgentDeploymentConfig",
};

/**
 * The console's only writer of a deployment's runtime configuration. An update replaces the
 * whole configuration, so every key other than `toolAuthorizations` passes through untouched.
 */
export function withToolBindings(
  config: DeploymentConfig | undefined,
  changes: ToolBindingChanges,
): DeploymentConfig {
  const { toolAuthorizations, ...rest } = config ?? DEFAULT_DEPLOYMENT_CONFIG;
  const bindings = new Map(Object.entries(toolAuthorizations ?? {}));
  for (const [tool, binding] of Object.entries(changes)) {
    if (binding) bindings.set(tool, binding);
    else bindings.delete(tool);
  }
  return bindings.size > 0 ? { ...rest, toolAuthorizations: Object.fromEntries(bindings) } : rest;
}

/** Whether every target release declares the tool with workspace authorization. */
export function bindableInEvery(manifests: readonly AgentManifestV1[], tool: string) {
  return manifests.every((manifest) =>
    (manifest.spec.capabilities?.tools ?? []).some(
      (capability) => capability.name === tool && capability.authorization === "workspace",
    ),
  );
}

export interface AssembledConfig {
  readonly config: DeploymentConfig;
  /** Base bindings no target release can accept, removed instead of failing the deploy. */
  readonly dropped: readonly string[];
  /** What the API's deploy-time check would refuse, from the platform's own validator. */
  readonly issues: readonly AgentManifestSemanticIssue[];
}

/**
 * Applies `changes` to `base` for the releases a deployment runs (primary, plus the candidate
 * during a canary) and checks the result the way the API does before it accepts the update.
 */
export function assembleRuntimeConfig(input: {
  readonly base: DeploymentConfig | undefined;
  readonly changes: ToolBindingChanges;
  readonly manifests: readonly AgentManifestV1[];
}): AssembledConfig {
  const { base, changes, manifests } = input;
  const dropped = Object.keys(base?.toolAuthorizations ?? {}).filter(
    (tool) => !Object.hasOwn(changes, tool) && !bindableInEvery(manifests, tool),
  );
  const config = withToolBindings(base, {
    ...Object.fromEntries(dropped.map((tool) => [tool, null])),
    ...changes,
  });
  const issues = new Map<string, AgentManifestSemanticIssue>();
  for (const manifest of manifests) {
    for (const issue of agentDeploymentConfigSemanticIssues(config, manifest)) {
      issues.set(`${issue.code} ${issue.path}`, issue);
    }
  }
  return { config, dropped, issues: [...issues.values()] };
}
