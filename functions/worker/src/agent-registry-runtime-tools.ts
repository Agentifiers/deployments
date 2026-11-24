import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import {
  jsonToolResult,
  optionalInteger,
  optionalString,
  toolInput,
  ulid,
  queryRecordPages,
} from "./builtin-tool-support.ts";

type AgentDefinition = Extract<PlatformRecord, { readonly itemType: "agent-definition" }>;
type AgentDeployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;

async function environmentRecords(
  database: DynamoDatabaseService,
  environmentId: string,
  itemType: "agent-definition" | "agent-deployment",
  signal?: AbortSignal,
) {
  const prefix = `${itemType.toUpperCase()}#`;
  return queryRecordPages({
    database,
    input: {
      ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
      ExpressionAttributeValues: { ":pk": key("ENV", environmentId), ":sk": prefix },
      IndexName: "gsi2",
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
      Limit: 250,
      ScanIndexForward: false,
    },
    ...(signal ? { signal } : {}),
    table: "control",
  });
}

function registryStatus(
  definition: AgentDefinition,
  deployments: readonly AgentDeployment[],
): "active" | "archived" | "paused" {
  if (definition.data.status === "archived") return "archived";
  if (definition.data.status === "disabled") return "paused";
  const ready = deployments.some(
    (deployment) =>
      deployment.data.currentState === "ready" && deployment.data.desiredState === "running",
  );
  const intentionallyInactive =
    deployments.length > 0 &&
    deployments.every((deployment) => deployment.data.desiredState !== "running");
  return !ready && intentionallyInactive ? "paused" : "active";
}

function safeDefinition(definition: AgentDefinition, deployments: readonly AgentDeployment[]) {
  return {
    deployments: deployments.map((deployment) => ({
      agentDeploymentId: deployment.data.id,
      agentReleaseId: deployment.data.agentReleaseId,
      currentState: deployment.data.currentState,
      desiredState: deployment.data.desiredState,
    })),
    id: definition.data.id,
    name: definition.data.name,
    slug: definition.data.slug,
    status: registryStatus(definition, deployments),
    workspaceId: definition.data.workspaceId,
  };
}

function inScope(
  record: AgentDefinition | AgentDeployment,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
) {
  return (
    record.data.organizationId === request.organizationId &&
    record.data.projectId === request.projectId &&
    record.data.environmentId === request.environmentId
  );
}

function loadRecord(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  itemType: "agent-definition",
  id: string,
): Promise<AgentDefinition | undefined>;
function loadRecord(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  itemType: "agent-deployment",
  id: string,
): Promise<AgentDeployment | undefined>;
async function loadRecord(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  itemType: "agent-definition" | "agent-deployment",
  id: string,
) {
  const value = await workerPersistence.read(
    database,
    "control",
    {
      pk: key("ORG", request.organizationId, "ENV", request.environmentId),
      sk: key(itemType.toUpperCase(), id),
    },
    true,
  );
  return value?.itemType === itemType ? value : undefined;
}

export function createRuntimeAgentRegistryBuiltinExecutors(
  database: DynamoDatabaseService,
): Readonly<Record<"agent.registry.get" | "agent.registry.search", ExecuteRuntimeBuiltinTool>> {
  return {
    "agent.registry.search": async (request) => {
      const input = toolInput(request.input ?? {});
      const limit = optionalInteger(input, "limit", { maximum: 100, minimum: 1 }) ?? 25;
      const query = optionalString(input, "query", 512)?.toLocaleLowerCase();
      const status = optionalString(input, "status", 32);
      const requestedWorkspace = input.workspaceId
        ? ulid(input.workspaceId, "workspaceId")
        : undefined;
      if (requestedWorkspace && requestedWorkspace !== request.workspaceId) {
        throw new TypeError("workspaceId must match the current run workspace.");
      }
      const [rawDefinitions, rawDeployments] = await Promise.all([
        environmentRecords(database, request.environmentId, "agent-definition", request.signal),
        environmentRecords(database, request.environmentId, "agent-deployment", request.signal),
      ]);
      const deployments = rawDeployments.filter(
        (record): record is AgentDeployment =>
          record.itemType === "agent-deployment" && inScope(record, request),
      );
      const results = rawDefinitions
        .filter(
          (record): record is AgentDefinition =>
            record.itemType === "agent-definition" &&
            inScope(record, request) &&
            record.data.workspaceId === request.workspaceId,
        )
        .filter((definition) => {
          if (!query) return true;
          return [definition.data.name, definition.data.slug]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLocaleLowerCase().includes(query));
        })
        .map((definition) =>
          safeDefinition(
            definition,
            deployments.filter(
              (deployment) => deployment.data.agentDefinitionId === definition.data.id,
            ),
          ),
        )
        .filter((definition) => !status || definition.status === status)
        .slice(0, limit);
      return jsonToolResult({
        fileName: "agent-registry-search.json",
        label: "Agent registry search results",
        summary: `Found ${results.length} agent(s) in the current workspace.`,
        value: results,
      });
    },
    "agent.registry.get": async (request) => {
      const input = toolInput(request.input ?? {});
      const agentId = ulid(input.agentId, "agentId");
      const directDefinition = await loadRecord(database, request, "agent-definition", agentId);
      const directDeployment = directDefinition
        ? undefined
        : await loadRecord(database, request, "agent-deployment", agentId);
      const definition =
        directDefinition ??
        (directDeployment
          ? await loadRecord(
              database,
              request,
              "agent-definition",
              directDeployment.data.agentDefinitionId,
            )
          : undefined);
      if (!definition || !inScope(definition, request)) {
        throw new TypeError("The requested agent was not found.");
      }
      if (definition.data.workspaceId !== request.workspaceId) {
        throw new TypeError("The requested agent is outside the current workspace.");
      }
      const rawDeployments = await environmentRecords(
        database,
        request.environmentId,
        "agent-deployment",
        request.signal,
      );
      const deployments = rawDeployments.filter(
        (record): record is AgentDeployment =>
          record.itemType === "agent-deployment" &&
          inScope(record, request) &&
          record.data.agentDefinitionId === definition.data.id,
      );
      const result = safeDefinition(definition, deployments);
      return jsonToolResult({
        fileName: `agent-${definition.data.id}.json`,
        label: "Agent registry details",
        summary: `Loaded agent ${definition.data.name} (${definition.data.id}).`,
        value: result,
      });
    },
  };
}
