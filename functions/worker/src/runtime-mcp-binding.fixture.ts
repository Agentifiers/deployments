import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type { RuntimeToolExecutionBinding } from "@deployments-ai/agent-runtime";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  McpConnectionRecord,
  McpServerRecord,
  tableForItemType,
  ToolAdapterRecord,
  ToolPolicyRecord,
  withCanonicalRecordKeys,
  WorkspaceConnectionAuthorizationRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { toolAdapterDefinitionFromRecord, type ToolAdapterDefinition } from "@deployments-ai/tools";
import { Schema } from "effect";
import type {
  AuthorizedRuntimeToolBindingRequest,
  RuntimeToolBindingRequest,
} from "./runtime-tools.ts";

export const ids = Array.from(
  { length: 20 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G6F${String(index).padStart(2, "0")}`,
) as Ulid[];
export const organizationId = ids[0]!;
export const projectId = ids[1]!;
export const environmentId = ids[2]!;
const workspaceId = ids[3]!;
const releaseId = ids[4]!;
const deploymentId = ids[11]!;
export const mcpConnectionId = ids[5]!;
export const mcpServerId = ids[6]!;
const policyId = ids[7]!;
export const credentialId = ids[8]!;
const authorizationId = ids[15]!;
const adapterId = ids[18]!;
export const timestamp = "2026-07-24T12:00:00.000Z";
/** Tenant extension tool name; MCP tools are no longer code-owned catalog entries. */
export const toolName = "analytics.dataflows.list";
export const remoteToolName = "list-dataflows";

/**
 * Builds the runtime definition from a persisted tenant `tool-adapter` record exactly as the
 * extension resolver does, so MCP binding tests exercise the production record shape.
 */
export function tenantMcpAdapter(
  inputSchema: Readonly<Record<string, unknown>> = {
    additionalProperties: false,
    properties: {},
    type: "object",
  },
): ToolAdapterDefinition {
  return toolAdapterDefinitionFromRecord(
    Schema.decodeUnknownSync(ToolAdapterRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          defaultPolicyAction: "allow",
          description: "List analytics dataflows.",
          effect: "read",
          environmentId,
          execution: { mcpServerId, remoteToolName, type: "mcp" },
          id: adapterId,
          inputSchema,
          name: toolName,
          organizationId,
          projectId,
          requiredScopes: [toolName],
          status: "active" as const,
          updatedAt: timestamp,
          version: 1,
        },
        itemType: "tool-adapter" as const,
      }),
    ),
  );
}

export function fixtures() {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "runtime.mcp-resolver",
      name: "Runtime MCP Resolver",
      version: "1.0.0",
    },
    spec: {
      capabilities: {
        tools: [
          {
            authorization: "workspace",
            name: toolName,
            required: true,
            requiredScopes: [toolName],
          },
        ],
      },
      instructions: "Use the configured MCP tools.",
      model: { id: "openrouter/test" },
      sandbox: { mode: "none" },
    },
  });
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids[9]!,
        contentHash: agentManifestContentHash(manifest),
        createdAt: timestamp,
        createdByPrincipalId: ids[10]!,
        environmentId,
        id: releaseId,
        manifest,
        organizationId,
        projectId,
        releaseNumber: 1,
        status: "active" as const,
        version: 0,
      },
      itemType: "agent-release" as const,
    }),
  );
  const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids[9]!,
        agentReleaseId: releaseId,
        createdAt: timestamp,
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId,
        id: deploymentId,
        organizationId,
        projectId,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: {
            [toolName]: { authorizationId, toolPolicyId: policyId },
          },
        },
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  const connection = Schema.decodeUnknownSync(McpConnectionRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        environmentId,
        id: mcpConnectionId,
        mcpServerId,
        organizationId,
        projectId,
        status: "active" as const,
        updatedAt: timestamp,
        version: 2,
      },
      itemType: "mcp-connection" as const,
    }),
  );
  const server = Schema.decodeUnknownSync(McpServerRecord)(
    withCanonicalRecordKeys({
      data: {
        authSecretRef: { credentialId, generation: 3, store: "dynamodb-kms" as const },
        createdAt: timestamp,
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/analytics/mcp",
        environmentId,
        id: mcpServerId,
        name: "Analytics",
        organizationId,
        projectId,
        status: "active" as const,
        toolAllowlist: [remoteToolName],
        updatedAt: timestamp,
        version: 4,
      },
      itemType: "mcp-server" as const,
    }),
  );
  const authorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
    withCanonicalRecordKeys({
      data: {
        authorizationVersion: 1,
        connectionId: mcpConnectionId,
        createdAt: timestamp,
        environmentId,
        externalAccountId: mcpServerId,
        externalResourceConstraints: {},
        id: authorizationId,
        organizationId,
        projectId,
        providerKey: "mcp",
        purpose: "agent-runtime",
        resourceScopeHash: "mcp-scope",
        scopes: [toolName],
        status: "active" as const,
        updatedAt: timestamp,
        version: 2,
        workspaceId,
      },
      itemType: "workspace-connection-authorization" as const,
    }),
  );
  const policy = Schema.decodeUnknownSync(ToolPolicyRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        environmentId,
        id: policyId,
        name: "Analytics reads",
        organizationId,
        projectId,
        rules: [{ action: "allow", toolName }],
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "tool-policy" as const,
    }),
  );
  return { authorization, connection, deployment, policy, release, server };
}

export function database(seed: readonly PlatformRecord[]): DynamoDatabaseService {
  const records = new Map(
    seed.map((item) => [
      `${tableForItemType(item.itemType)}\u0000${item.pk}\u0000${item.sk}`,
      item,
    ]),
  );
  return {
    deleteRecord: async () => {},
    getRecord: (table, key) =>
      Promise.resolve(
        records.has(`${table}\u0000${key.pk}\u0000${key.sk}`)
          ? records.get(`${table}\u0000${key.pk}\u0000${key.sk}`)!
          : undefined,
      ),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async () => {},
  };
}

export function request(): RuntimeToolBindingRequest {
  return {
    agentDefinitionId: ids[9]!,
    agentDeploymentId: deploymentId,
    agentReleaseId: releaseId,
    effect: "read",
    environmentId,
    idempotencyKey: "mcp-list-1",
    inputSummary: "List analytics dataflows",
    organizationId,
    projectId,
    requiredScopes: [toolName],
    runId: ids[12]!,
    threadId: ids[13]!,
    toolName,
    workspaceId,
  };
}

/** Allowed request pinned to the MCP authorization resolved at policy time. */
export function allowedRequest(
  base: RuntimeToolBindingRequest,
  authorizationFingerprint: string,
): AuthorizedRuntimeToolBindingRequest {
  const executionBinding: RuntimeToolExecutionBinding = {
    authorizationFingerprint,
    connectionId: mcpConnectionId,
    externalAccountId: mcpServerId,
    toolPlanFingerprint: "test-tool-plan",
  };
  return {
    ...base,
    decision: { action: "allow", executionBinding, reason: "allowed", toolCallId: ids[14]! },
  };
}
