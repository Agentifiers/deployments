import type { EvaluateToolPolicyRequest } from "@deployments-ai/api-contract";
import {
  PersistenceError,
  apiPersistence,
  key,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import type { ToolPolicyDecision } from "@deployments-ai/providers";
import {
  decideToolPolicy,
  findPlatformToolAdapterDefinition,
  toolAdapterDefinitionFromRecord,
  toolCatalogDenial,
  toolCatalogStatus,
  toolExecutionRoute,
  toolPolicyBinding,
  type ToolAdapterDefinition,
  type ToolCatalogStatus,
  type ToolExecutionRoute,
  type ToolPolicyConnection,
} from "@deployments-ai/tools";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence-context.ts";

type EvaluationRecordType =
  | "agent-deployment"
  | "agent-release"
  | "tool-policy"
  | "workspace-connection-authorization";
type EvaluationRecord<ItemType extends EvaluationRecordType> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;
type ToolPolicyRecord = EvaluationRecord<"tool-policy">;

interface ToolPolicyEvaluationResult {
  readonly action: ToolPolicyDecision["action"];
  readonly basis: ToolPolicyDecision["basis"] | "unavailable";
  readonly catalogStatus: ToolCatalogStatus;
  readonly matchedRuleIndex: number | null;
  readonly policyApplies: boolean;
  readonly reason: string;
  readonly toolName: string;
  readonly toolPolicyId: string | null;
}

/** Inputs that resolve a `connection` tool's decision, or the reason the runtime denies it. */
type ConnectionResolution =
  | { readonly connection: ToolPolicyConnection; readonly toolPolicyId: string | null }
  | { readonly denial: string; readonly toolPolicyId: string | null };

function unavailable(
  toolName: string,
  catalogStatus: ToolCatalogStatus,
  reason: string,
  policyApplies: boolean,
  toolPolicyId: string | null = null,
): ToolPolicyEvaluationResult {
  return {
    action: "deny",
    basis: "unavailable",
    catalogStatus,
    matchedRuleIndex: null,
    policyApplies,
    reason,
    toolName,
    toolPolicyId,
  };
}

function decided(
  definition: ToolAdapterDefinition,
  decision: ToolPolicyDecision,
  policyApplies: boolean,
  toolPolicyId: string | null,
): ToolPolicyEvaluationResult {
  return {
    action: decision.action,
    basis: decision.basis,
    catalogStatus: "active",
    matchedRuleIndex: decision.matchedRuleIndex ?? null,
    policyApplies,
    reason: decision.reason,
    toolName: definition.toolName,
    toolPolicyId,
  };
}

/** Tenant MCP tools authorize under the tool's provider (or `mcp`); other routes use the grant's. */
function connectorProvider(
  definition: ToolAdapterDefinition,
  route: ToolExecutionRoute,
  grantedProvider: string,
) {
  return route === "mcp" ? (definition.provider ?? "mcp") : grantedProvider;
}

type Admission =
  | { readonly result: ToolPolicyEvaluationResult }
  | { readonly definition: ToolAdapterDefinition; readonly route: ToolExecutionRoute };

/** The runtime's checks before policy evaluation: registered, active, and executable. */
function admit(toolName: string, definition: ToolAdapterDefinition | undefined): Admission {
  const catalogStatus = toolCatalogStatus(toolName, definition);
  const denial = toolCatalogDenial(toolName, catalogStatus);
  if (denial || !definition) {
    return {
      result: unavailable(
        toolName,
        catalogStatus,
        denial ?? `Runtime tool ${toolName} is not registered.`,
        false,
      ),
    };
  }
  const route = toolExecutionRoute(definition);
  if (!route) {
    return {
      result: unavailable(
        toolName,
        catalogStatus,
        `Runtime tool ${toolName} has no worker execution binding.`,
        false,
      ),
    };
  }
  return { definition, route };
}

function resolvedResult(
  definition: ToolAdapterDefinition,
  resolution: ConnectionResolution,
): ToolPolicyEvaluationResult {
  return "denial" in resolution
    ? unavailable(definition.toolName, "active", resolution.denial, true, resolution.toolPolicyId)
    : decided(
        definition,
        decideToolPolicy(definition, resolution.connection),
        true,
        resolution.toolPolicyId,
      );
}

/**
 * Evaluates tool policies with the runtime's admission and decision functions, without side effects.
 * The policy form assumes a connection to the tool's own provider that grants the tool's required
 * scopes; the deployment form resolves the deployment's pinned grants and policies.
 */
export function makeToolPolicyEvaluation(context: AdministrationPersistenceContext) {
  async function read<ItemType extends EvaluationRecordType>(
    invocation: AdministrationInvocation,
    itemType: ItemType,
    id: Ulid | string,
  ): Promise<EvaluationRecord<ItemType> | undefined> {
    const scope = await context.environment(invocation);
    const record = await context.databaseValue(
      apiPersistence.read(
        context.dependencies.database,
        "control",
        {
          pk: key("ORG", scope.organizationId, "ENV", scope.id),
          sk: key(itemType.toUpperCase(), id),
        },
        true,
      ),
    );
    return record?.itemType === itemType ? (record as EvaluationRecord<ItemType>) : undefined;
  }

  async function required<ItemType extends EvaluationRecordType>(
    invocation: AdministrationInvocation,
    itemType: ItemType,
    id: string,
    label: string,
  ) {
    const record = await read(invocation, itemType, id);
    if (!record)
      throw new PersistenceError("not-found", "resource_not_found", `${label} was not found.`);
    return record;
  }

  /** Platform definitions shadow tenant extensions, matching the runtime lookup order. */
  async function definitions(invocation: AdministrationInvocation, toolNames: readonly string[]) {
    const resolved = new Map<string, ToolAdapterDefinition>();
    const extensionNames = new Set<string>();
    for (const toolName of toolNames) {
      const platform = findPlatformToolAdapterDefinition(toolName);
      if (platform) resolved.set(toolName, platform);
      else extensionNames.add(toolName);
    }
    if (extensionNames.size === 0) return resolved;
    const adapters = await context.listAllRecordsConsistently(
      invocation,
      "tool-adapter",
      (record) =>
        record.itemType === "tool-adapter" &&
        record.data.status === "active" &&
        extensionNames.has(record.data.name),
    );
    for (const adapter of adapters) {
      if (adapter.itemType !== "tool-adapter" || resolved.has(adapter.data.name)) continue;
      resolved.set(adapter.data.name, toolAdapterDefinitionFromRecord(adapter));
    }
    return resolved;
  }

  async function evaluatePolicy(
    invocation: AdministrationInvocation,
    toolPolicyId: string,
    toolNames: readonly string[],
  ) {
    const policy = await required(invocation, "tool-policy", toolPolicyId, "Tool policy");
    const resolved = await definitions(invocation, toolNames);
    const results = toolNames.map((toolName) => {
      const admission = admit(toolName, resolved.get(toolName));
      if ("result" in admission) return admission.result;
      const { definition, route } = admission;
      if (toolPolicyBinding(route) === "catalog") {
        return decided(definition, decideToolPolicy(definition), false, null);
      }
      return resolvedResult(
        definition,
        policy.data.status === "active"
          ? {
              connection: {
                connectorProvider: connectorProvider(definition, route, definition.provider ?? ""),
                grantedScopes: definition.requiredScopes ?? [],
                policyRules: policy.data.rules,
              },
              toolPolicyId,
            }
          : { denial: "Runtime tool policy is not active.", toolPolicyId },
      );
    });
    return { results, toolPolicyId };
  }

  async function connectionResolution(
    invocation: AdministrationInvocation,
    deployment: EvaluationRecord<"agent-deployment">,
    definition: ToolAdapterDefinition,
    route: ToolExecutionRoute,
  ): Promise<ConnectionResolution> {
    const toolName = definition.toolName;
    const pinned = deployment.data.runtimeConfig?.toolAuthorizations?.[toolName];
    const toolPolicyId = pinned?.toolPolicyId ?? null;
    if (!pinned?.authorizationId) {
      return {
        denial: `Agent deployment authorization for ${toolName} is required.`,
        toolPolicyId,
      };
    }
    const inactive = {
      denial: `Runtime tool ${toolName} requires an active ${
        route === "mcp" || route === "vendor_mcp" ? "MCP" : "provider"
      } connection.`,
      toolPolicyId,
    };
    const authorization = await read(
      invocation,
      "workspace-connection-authorization",
      pinned.authorizationId,
    );
    if (
      !authorization ||
      authorization.data.status !== "active" ||
      authorization.data.purpose !== "agent-runtime"
    ) {
      return inactive;
    }
    let policy: ToolPolicyRecord | undefined;
    if (pinned.toolPolicyId) {
      policy = await read(invocation, "tool-policy", pinned.toolPolicyId);
      if (!policy) return inactive;
      if (policy.data.status !== "active") {
        return { denial: "Runtime tool policy is not active.", toolPolicyId };
      }
    }
    return {
      connection: {
        connectorProvider: connectorProvider(definition, route, authorization.data.providerKey),
        grantedScopes: authorization.data.scopes ?? [],
        ...(policy ? { policyRules: policy.data.rules } : {}),
      },
      toolPolicyId,
    };
  }

  async function evaluateDeployment(
    invocation: AdministrationInvocation,
    agentDeploymentId: string,
    requestedToolNames: readonly string[] | undefined,
  ) {
    const deployment = await required(
      invocation,
      "agent-deployment",
      agentDeploymentId,
      "Agent deployment",
    );
    const release = await required(
      invocation,
      "agent-release",
      deployment.data.agentReleaseId,
      "Agent release",
    );
    const capabilities = new Map(
      (release.data.manifest.spec.capabilities?.tools ?? []).map(
        (capability) => [capability.name, capability] as const,
      ),
    );
    const toolNames = requestedToolNames ?? [...capabilities.keys()];
    const resolved = await definitions(invocation, toolNames);
    const results: ToolPolicyEvaluationResult[] = [];
    for (const toolName of toolNames) {
      const admission = admit(toolName, resolved.get(toolName));
      if ("result" in admission) {
        results.push(admission.result);
        continue;
      }
      const { definition, route } = admission;
      const binding = toolPolicyBinding(route);
      const capability = capabilities.get(toolName);
      if (!capability) {
        results.push(
          unavailable(
            toolName,
            "active",
            `Agent release does not declare tool capability ${toolName}.`,
            binding === "connection",
          ),
        );
      } else if (binding === "catalog") {
        results.push(decided(definition, decideToolPolicy(definition), false, null));
      } else if (capability.authorization !== "workspace") {
        results.push(
          unavailable(
            toolName,
            "active",
            `Agent release tool capability ${toolName} does not allow workspace authorization.`,
            true,
          ),
        );
      } else {
        results.push(
          resolvedResult(
            definition,
            await connectionResolution(invocation, deployment, definition, route),
          ),
        );
      }
    }
    return { agentDeploymentId: deployment.data.id, agentReleaseId: release.data.id, results };
  }

  return {
    evaluateToolPolicy: async (invocation: AdministrationInvocation) => {
      const body = invocation.body as typeof EvaluateToolPolicyRequest.Type;
      return "toolPolicyId" in body
        ? evaluatePolicy(invocation, body.toolPolicyId, body.toolNames)
        : evaluateDeployment(invocation, body.agentDeploymentId, body.toolNames);
    },
  };
}
