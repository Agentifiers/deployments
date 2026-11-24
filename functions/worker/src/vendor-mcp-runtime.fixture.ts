import type { RuntimeToolExecutionBinding } from "@deployments-ai/agent-runtime";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type { CredentialVaultSecretDocument } from "@deployments-ai/credential-vault";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  ProviderConnectionRecord,
  ToolAdapterRecord,
  WorkspaceConnectionAuthorizationRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  createProviderDefinitionRegistry,
  type ProviderDefinitionInput,
} from "@deployments-ai/providers";
import { toolAdapterDefinitionFromRecord, type ToolAdapterDefinition } from "@deployments-ai/tools";
import { Schema } from "effect";
import type {
  AuthorizedRuntimeToolBindingRequest,
  RuntimeToolBindingRequest,
} from "./runtime-tools.ts";

export const ids = Array.from(
  { length: 24 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G6F${String(index).padStart(2, "0")}`,
) as Ulid[];
export const organizationId = ids[0]!;
export const projectId = ids[1]!;
export const environmentId = ids[2]!;
const workspaceId = ids[3]!;
const releaseId = ids[4]!;
const authorizationId = ids[5]!;
export const connectionId = ids[6]!;
export const credentialId = ids[7]!;
const agentDefinitionId = ids[8]!;
const deploymentId = ids[9]!;
const timestamp = "2026-09-30T12:00:00.000Z";
export const NOW = new Date("2026-10-01T12:00:00.000Z");
const MCP_URL = "https://mcp.notion.example/mcp";
export const TOOL_HASH = `sha256:${"a".repeat(64)}`;

const verification = { method: "mcp_discovery", required: true } as const;

export const vendorRegistry = createProviderDefinitionRegistry([
  {
    auth: { kind: "oauth" },
    category: "knowledge",
    displayName: "Notion",
    key: "notion",
    mcpServer: {
      authorization: {
        authorizationEndpoint: "https://mcp.notion.example/authorize",
        issParameterSupported: true,
        issuer: "https://mcp.notion.example",
        kind: "oauth",
        protectedResourceMetadata: "published",
        registrationMethods: ["client_id_metadata_document"],
        scopes: [],
        tokenEndpoint: "https://mcp.notion.example/token",
        tokenEndpointAuthMethods: ["none"],
      },
      documentationUrl: "https://developers.notion.example/docs/mcp",
      resource: MCP_URL,
      reviewedAt: "2026-09-30",
      toolEffects: { "notion-search": "read", "notion-update-page": "write" },
      url: MCP_URL,
    },
    oauthProviderKey: "notion",
    route: "vendor_mcp",
    status: "configured",
    verification,
  },
  {
    auth: {
      fields: [{ displayName: "API key", key: "apiKey", sensitive: true }],
      kind: "api_key",
    },
    category: "data",
    displayName: "Keyed Vendor",
    key: "keyed_vendor",
    mcpServer: {
      authorization: { field: "apiKey", headerName: "x-api-key", kind: "api_key" },
      documentationUrl: "https://docs.keyed.example/mcp",
      resource: "https://mcp.keyed.example/v2/mcp",
      reviewedAt: "2026-09-30",
      toolEffects: {},
      url: "https://mcp.keyed.example/v2/mcp",
    },
    route: "vendor_mcp",
    status: "configured",
    verification,
  },
  {
    auth: {
      fields: [{ displayName: "API key", key: "apiKey", sensitive: true }],
      kind: "api_key",
    },
    category: "data",
    displayName: "Tenant Vendor",
    key: "tenant_vendor",
    mcpServer: {
      authorization: { field: "apiKey", headerName: "x-api-key", kind: "api_key" },
      documentationUrl: "https://docs.tenant.example/mcp",
      resource: "https://{tenant}.tenant.example/mcp",
      reviewedAt: "2026-09-30",
      tenant: { hostSuffixes: ["tenant.example"], label: "Tenant site" },
      toolEffects: {},
      url: "https://{tenant}.tenant.example/mcp",
    },
    route: "vendor_mcp",
    status: "configured",
    verification,
  },
] satisfies ProviderDefinitionInput[]);

export interface BindingSeedOptions {
  readonly authMethod?: string;
  readonly connectionScopes?: readonly string[];
  readonly grantProviderKey?: string;
  readonly grantScopes?: readonly string[];
  /** Static api_key connections carry no account id; grants then pin the connection id. */
  readonly omitExternalAccountId?: boolean;
  readonly providerKey: string;
  readonly refreshAfter?: string;
  readonly toolNames: readonly string[];
}

/** Ready deployment, workspace grant, and provider connection pinned for `toolNames`. */
export function bindingRecords(options: BindingSeedOptions) {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "runtime.vendor-mcp", name: "Vendor MCP", version: "1.0.0" },
    spec: {
      capabilities: {
        tools: options.toolNames.map((name) => ({
          authorization: "workspace",
          name,
          required: true,
          requiredScopes: [],
        })),
      },
      instructions: "Use the connected vendor tools.",
      model: { id: "openrouter/test" },
      sandbox: { mode: "none" },
    },
  });
  const scope = { environmentId, organizationId, projectId };
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        agentDefinitionId,
        contentHash: agentManifestContentHash(manifest),
        createdAt: timestamp,
        createdByPrincipalId: ids[10]!,
        id: releaseId,
        manifest,
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
        ...scope,
        agentDefinitionId,
        agentReleaseId: releaseId,
        createdAt: timestamp,
        currentState: "ready" as const,
        desiredState: "running" as const,
        id: deploymentId,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: Object.fromEntries(
            options.toolNames.map((name) => [name, { authorizationId }]),
          ),
        },
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  const scopes = options.connectionScopes ?? ["tools:read", "tools:write"];
  const authorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        authorizationVersion: 2,
        connectionId,
        createdAt: timestamp,
        externalAccountId: options.omitExternalAccountId ? connectionId : "account-1",
        externalResourceConstraints: { workspace: "acme" },
        id: authorizationId,
        providerKey: options.grantProviderKey ?? options.providerKey,
        purpose: "agent-runtime",
        resourceScopeHash: "scope-hash",
        scopes: [...(options.grantScopes ?? scopes)],
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
        workspaceId,
      },
      itemType: "workspace-connection-authorization" as const,
    }),
  );
  return {
    authorization,
    connection: providerConnection({
      authMethod: options.authMethod ?? "oauth",
      ...(options.omitExternalAccountId ? { omitExternalAccountId: true } : {}),
      generation: 3,
      providerKey: options.providerKey,
      ...(options.refreshAfter ? { refreshAfter: options.refreshAfter } : {}),
      scopes,
      version: 4,
    }),
    deployment,
    release,
  };
}

export interface ProviderConnectionFixtureInput {
  readonly authMethod: string;
  readonly generation: number;
  readonly oauthIssuer?: string;
  readonly omitExternalAccountId?: boolean;
  readonly oauthResource?: string;
  readonly providerKey: string;
  readonly refreshAfter?: string;
  readonly scopes: readonly string[];
  readonly version: number;
}

export function providerConnection(input: ProviderConnectionFixtureInput) {
  return Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      data: {
        authMethod: input.authMethod,
        createdAt: timestamp,
        credentialRef: { credentialId, generation: input.generation, store: "dynamodb-kms" },
        environmentId,
        ...(input.omitExternalAccountId ? {} : { externalAccountId: "account-1" }),
        id: connectionId,
        ...(input.oauthIssuer ? { oauthIssuer: input.oauthIssuer } : {}),
        ...(input.oauthResource ? { oauthResource: input.oauthResource } : {}),
        organizationId,
        projectId,
        providerKey: input.providerKey,
        ...(input.refreshAfter ? { refreshAfter: input.refreshAfter } : {}),
        scopes: [...input.scopes],
        status: "active" as const,
        updatedAt: timestamp,
        version: input.version,
      },
      itemType: "provider-connection" as const,
    }),
  );
}

export function vendorAdapter(input: {
  readonly effect: "read" | "write";
  readonly name: string;
  readonly providerKey?: string;
  readonly remoteToolName: string;
}): ToolAdapterDefinition {
  return toolAdapterDefinitionFromRecord(
    Schema.decodeUnknownSync(ToolAdapterRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          defaultPolicyAction: input.effect === "read" ? "allow" : "require_approval",
          description: `Vendor tool ${input.remoteToolName}`,
          effect: input.effect,
          environmentId,
          execution: {
            providerKey: input.providerKey ?? "notion",
            remoteToolName: input.remoteToolName,
            toolHash: TOOL_HASH,
            type: "vendor_mcp",
          },
          id: ids[11]!,
          inputSchema: {
            additionalProperties: false,
            properties: { query: { type: "string" }, workspace: { type: "string" } },
            type: "object",
          },
          name: input.name,
          organizationId,
          projectId,
          providerKey: input.providerKey ?? "notion",
          requiredScopes: [input.effect === "read" ? "tools:read" : "tools:write"],
          status: "active" as const,
          updatedAt: timestamp,
          version: 1,
        },
        itemType: "tool-adapter" as const,
      }),
    ),
  );
}

/** In-memory control table; `put` replaces a record as a writer would. */
export function memoryDatabase(seed: readonly PlatformRecord[]) {
  const records = new Map<string, PlatformRecord>();
  const put = (item: PlatformRecord) =>
    records.set(`${tableForItemType(item.itemType)}\u0000${item.pk}\u0000${item.sk}`, item);
  seed.forEach(put);
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: (table, key) =>
      Promise.resolve(records.get(`${table}\u0000${key.pk}\u0000${key.sk}`)),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async () => {},
  };
  return { database, put };
}

export function bindingRequest(
  definition: ToolAdapterDefinition,
  input: Readonly<Record<string, unknown>> = { query: "roadmap" },
): RuntimeToolBindingRequest {
  return {
    agentDefinitionId,
    agentDeploymentId: deploymentId,
    agentReleaseId: releaseId,
    effect: definition.effect,
    environmentId,
    idempotencyKey: "tool-call-1",
    input,
    inputSummary: "Use the vendor tool",
    organizationId,
    projectId,
    requiredScopes: [...(definition.requiredScopes ?? [])],
    runId: ids[12]!,
    threadId: ids[13]!,
    toolName: definition.toolName,
    workspaceId,
  };
}

export function authorizedRequest(
  request: RuntimeToolBindingRequest,
  executionBinding: RuntimeToolExecutionBinding,
): AuthorizedRuntimeToolBindingRequest {
  return {
    ...request,
    decision: { action: "allow", executionBinding, reason: "allowed", toolCallId: ids[14]! },
  };
}

export function secretDocument(
  values: Readonly<Record<string, string>>,
  generation = 3,
): CredentialVaultSecretDocument {
  return { createdAt: timestamp, generation, schemaVersion: 1, updatedAt: timestamp, values };
}
