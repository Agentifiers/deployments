import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import type {
  CredentialVaultReference,
  CredentialVaultSecretDocument,
} from "@deployments-ai/credential-vault";
import { CredentialVaultError } from "@deployments-ai/credential-vault";
import {
  DatabaseError,
  RecordDecodeError,
  Ulid,
  grantCoversWorkspace,
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";
import { RemoteMcpError, type RemoteMcpClient } from "@deployments-ai/mcp-client";
import {
  codeProviderDefinitionRegistry,
  providerUsesNoCredential,
} from "@deployments-ai/providers";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import type {
  ExecuteRuntimeMcpTool,
  ResolveRuntimeToolAuthorizationContext,
  RuntimeToolBindingRequest,
} from "./runtime-tools.ts";
import { executionSource } from "./runtime-provider-binding.ts";
import {
  completedMcpExecution,
  constrainedMcpArguments,
  DEFAULT_RUNTIME_MCP_ARTIFACT_MAX_CHARACTERS,
  DEFAULT_RUNTIME_MCP_TIMEOUT_MS,
  mcpCredentialMaterials,
  positiveRuntimeMcpInteger,
  remoteMcpFailureRetryable,
  RuntimeMcpBindingValidationError,
  validMcpHeaderValue,
} from "./runtime-mcp-results.ts";
import type { AgentDeploymentConfigV1 } from "@deployments-ai/agent-manifest";

type McpConnection = Extract<PlatformRecord, { readonly itemType: "mcp-connection" }>;
type McpServer = Extract<PlatformRecord, { readonly itemType: "mcp-server" }>;
type ToolPolicy = Extract<PlatformRecord, { readonly itemType: "tool-policy" }>;
type WorkspaceAuthorization = Extract<
  PlatformRecord,
  { readonly itemType: "workspace-connection-authorization" }
>;

interface RuntimeMcpCredentialReadInput {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly reference: CredentialVaultReference;
  readonly serverId: Ulid;
}

export type ReadRuntimeMcpCredential = (
  input: RuntimeMcpCredentialReadInput,
) => Promise<CredentialVaultSecretDocument>;

export interface DynamoRuntimeMcpOptions {
  readonly client: RemoteMcpClient;
  readonly database: DynamoDatabaseService;
  readonly maxArtifactCharacters?: number;
  readonly readCredential: ReadRuntimeMcpCredential;
  readonly timeoutMs?: number;
}

interface DeploymentMcpBinding {
  readonly authorizationId: Ulid;
  readonly toolPolicyId?: Ulid;
}

interface ResolvedMcpBinding {
  readonly authorization: WorkspaceAuthorization;
  readonly connection: McpConnection;
  readonly fingerprint: string;
  readonly policy?: ToolPolicy;
  readonly server: McpServer;
}

function environmentPartition(organizationId: Ulid, environmentId: Ulid) {
  return key("ORG", organizationId, "ENV", environmentId);
}

async function load(
  database: DynamoDatabaseService,
  input: RuntimeToolBindingRequest,
  itemType:
    | "agent-deployment"
    | "agent-release"
    | "mcp-connection"
    | "mcp-server"
    | "tool-policy"
    | "workspace-connection-authorization",
  id: Ulid,
): Promise<PlatformRecord | undefined> {
  const result = await workerPersistence.read(
    database,
    "control",
    {
      pk: environmentPartition(input.organizationId, input.environmentId),
      sk: key(itemType.toUpperCase(), id),
    },
    true,
  );
  return result;
}

function expected<ItemType extends PlatformRecord["itemType"]>(
  value: PlatformRecord | undefined,
  itemType: ItemType,
): Extract<PlatformRecord, { readonly itemType: ItemType }> {
  if (!value || value.itemType !== itemType) {
    throw new RuntimeMcpBindingValidationError(`Runtime ${itemType} was not found.`);
  }
  return value as Extract<PlatformRecord, { readonly itemType: ItemType }>;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeMcpBindingValidationError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalUlid(value: unknown, label: string): Ulid | undefined {
  if (value === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch (cause) {
    throw new RuntimeMcpBindingValidationError(`${label} must be a canonical ULID.`, { cause });
  }
}

function deploymentBinding(
  runtimeConfig: AgentDeploymentConfigV1 | undefined,
  toolName: string,
): DeploymentMcpBinding {
  const rawBinding = runtimeConfig?.toolAuthorizations?.[toolName];
  if (!rawBinding) {
    throw new RuntimeMcpBindingValidationError(
      `Agent deployment authorization for ${toolName} is required.`,
    );
  }
  const authorizationId = optionalUlid(
    rawBinding.authorizationId,
    `Agent deployment authorization ${toolName}.authorizationId`,
  );
  if (!authorizationId) {
    throw new RuntimeMcpBindingValidationError(
      `Agent deployment authorization ${toolName}.authorizationId is required.`,
    );
  }
  const toolPolicyId = optionalUlid(
    rawBinding.toolPolicyId,
    `Agent deployment authorization ${toolName}.toolPolicyId`,
  );
  return { authorizationId, ...(toolPolicyId ? { toolPolicyId } : {}) };
}

function assertScope(value: PlatformRecord, request: RuntimeToolBindingRequest) {
  const data = value.data as Readonly<Record<string, unknown>>;
  if (
    data.organizationId !== request.organizationId ||
    data.projectId !== request.projectId ||
    data.environmentId !== request.environmentId
  ) {
    throw new RuntimeMcpBindingValidationError(
      `Runtime ${value.itemType} does not match the run scope.`,
    );
  }
}

function authorizationFingerprint(input: {
  readonly authorization: WorkspaceAuthorization;
  readonly connection: McpConnection;
  readonly mcpToolName: string;
  readonly policy?: ToolPolicy;
  readonly server: McpServer;
  readonly toolName: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        authorizationId: input.authorization.data.id,
        authorizationRecordVersion: input.authorization.data.version,
        authorizationVersion: input.authorization.data.authorizationVersion,
        connectionId: input.connection.data.id,
        connectionVersion: input.connection.data.version,
        mcpToolName: input.mcpToolName,
        policyId: input.policy?.data.id ?? null,
        policyVersion: input.policy?.data.version ?? null,
        serverCredentialGeneration:
          input.server.data.authSecretRef && "generation" in input.server.data.authSecretRef
            ? input.server.data.authSecretRef.generation
            : null,
        serverId: input.server.data.id,
        serverVersion: input.server.data.version,
        scopes: [...(input.authorization.data.scopes ?? [])].toSorted(),
        toolAllowlist: [...input.server.data.toolAllowlist].toSorted(),
        toolName: input.toolName,
      }),
    )
    .digest("hex");
}

function configuredMcpServerId(definition: ToolAdapterDefinition): string | undefined {
  return definition.execution?.type === "mcp"
    ? definition.execution.mcpServerId.trim() || undefined
    : undefined;
}

async function resolvedBinding(
  options: DynamoRuntimeMcpOptions,
  request: RuntimeToolBindingRequest,
  definition: ToolAdapterDefinition,
  mcpToolName: string,
): Promise<ResolvedMcpBinding> {
  if (!request.workspaceId) {
    throw new RuntimeMcpBindingValidationError("Runtime MCP tools require a workspace-scoped run.");
  }
  const source = await executionSource(options, request);
  const capability = (source.manifest.spec.capabilities?.tools ?? []).find(
    (candidate) => candidate.name === definition.toolName,
  );
  if (!capability) {
    throw new RuntimeMcpBindingValidationError(
      `Agent release does not declare tool capability ${definition.toolName}.`,
    );
  }
  if (capability.authorization !== "workspace") {
    throw new RuntimeMcpBindingValidationError(
      `Agent release tool capability ${definition.toolName} does not allow workspace authorization.`,
    );
  }
  const binding = deploymentBinding(source.runtimeConfig, definition.toolName);
  const authorization = expected(
    await load(
      options.database,
      request,
      "workspace-connection-authorization",
      binding.authorizationId,
    ),
    "workspace-connection-authorization",
  );
  assertScope(authorization, request);
  if (
    authorization.data.status !== "active" ||
    !grantCoversWorkspace(
      authorization.data,
      request.workspaceId,
      providerUsesNoCredential(
        codeProviderDefinitionRegistry().resolve(authorization.data.providerKey),
      ),
    ) ||
    authorization.data.purpose !== "agent-runtime"
  ) {
    throw new RuntimeMcpBindingValidationError(
      "Workspace MCP authorization is not active for this run.",
    );
  }
  const connection = expected(
    await load(options.database, request, "mcp-connection", authorization.data.connectionId),
    "mcp-connection",
  );
  assertScope(connection, request);
  if (
    connection.data.status !== "active" ||
    authorization.data.providerKey !== (definition.provider ?? "mcp") ||
    authorization.data.externalAccountId !== connection.data.mcpServerId
  ) {
    throw new RuntimeMcpBindingValidationError("MCP connection is not active.");
  }
  const server = expected(
    await load(options.database, request, "mcp-server", connection.data.mcpServerId),
    "mcp-server",
  );
  assertScope(server, request);
  if (server.data.status !== "active") {
    throw new RuntimeMcpBindingValidationError("MCP server is not active.");
  }
  const expectedServerId = configuredMcpServerId(definition);
  if (expectedServerId && expectedServerId !== server.data.id) {
    throw new RuntimeMcpBindingValidationError(
      "MCP tool adapter does not match the authorized server.",
    );
  }
  if (!server.data.toolAllowlist.includes(mcpToolName)) {
    throw new RuntimeMcpBindingValidationError(`MCP server does not allow tool ${mcpToolName}.`);
  }
  const policy = binding.toolPolicyId
    ? expected(
        await load(options.database, request, "tool-policy", binding.toolPolicyId),
        "tool-policy",
      )
    : undefined;
  if (policy) {
    assertScope(policy, request);
    if (policy.data.status !== "active") {
      throw new RuntimeMcpBindingValidationError("Runtime MCP tool policy is not active.");
    }
  }
  return {
    authorization,
    connection,
    fingerprint: authorizationFingerprint({
      authorization,
      connection,
      mcpToolName,
      ...(policy ? { policy } : {}),
      server,
      toolName: definition.toolName,
    }),
    ...(policy ? { policy } : {}),
    server,
  };
}

function credentialReference(server: McpServer): CredentialVaultReference | undefined {
  const reference = server.data.authSecretRef;
  if (!reference) return undefined;
  if (!("store" in reference) || reference.store !== "dynamodb-kms") {
    throw new RuntimeMcpBindingValidationError(
      "MCP server requires a DynamoDB/KMS credential reference.",
    );
  }
  return reference;
}

function credentialHeaders(
  secret: CredentialVaultSecretDocument,
): Readonly<Record<string, string>> {
  const values = secret.values;
  const authorization = values.authorization
    ? validMcpHeaderValue(values.authorization, "MCP authorization credential")
    : undefined;
  const tokenValue = values.bearerToken ?? values.apiToken;
  const bearer = tokenValue
    ? `Bearer ${validMcpHeaderValue(tokenValue, "MCP bearer credential")}`
    : undefined;
  if (authorization && bearer) {
    throw new RuntimeMcpBindingValidationError(
      "MCP credential must not define both authorization and bearer token fields.",
    );
  }
  const supported = new Set(["apiToken", "authorization", "bearerToken"]);
  const unsupported = Object.keys(values).filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    throw new RuntimeMcpBindingValidationError(
      `MCP credential contains unsupported fields: ${unsupported.toSorted().join(", ")}.`,
    );
  }
  return authorization || bearer ? { authorization: authorization ?? bearer! } : {};
}

export function createDynamoRuntimeMcp(options: DynamoRuntimeMcpOptions): {
  readonly executeMcpTool: ExecuteRuntimeMcpTool;
  readonly resolveMcpAuthorizationContext: ResolveRuntimeToolAuthorizationContext;
} {
  const maximumCharacters = positiveRuntimeMcpInteger(
    options.maxArtifactCharacters,
    DEFAULT_RUNTIME_MCP_ARTIFACT_MAX_CHARACTERS,
    "Runtime MCP artifact limit",
  );
  const timeoutMs = positiveRuntimeMcpInteger(
    options.timeoutMs,
    DEFAULT_RUNTIME_MCP_TIMEOUT_MS,
    "Runtime MCP timeout",
  );

  return {
    resolveMcpAuthorizationContext: async (request, definition) => {
      const metadata = record(definition.auditMetadata, `MCP metadata for ${definition.toolName}`);
      const mcpToolName = metadata.mcpToolName;
      if (typeof mcpToolName !== "string" || !mcpToolName.trim()) return undefined;
      try {
        const resolved = await resolvedBinding(options, request, definition, mcpToolName.trim());
        return {
          authorizationFingerprint: resolved.fingerprint,
          connectionId: resolved.connection.data.id,
          connectorProvider: definition.provider ?? "mcp",
          externalAccountId: resolved.server.data.id,
          externalResourceConstraints: resolved.authorization.data.externalResourceConstraints,
          // Legacy grants without explicit scopes are not authorization evidence; migration must
          // backfill them rather than inferring broader access from the current tool definition.
          grantedScopes: resolved.authorization.data.scopes ?? [],
          ...(resolved.policy ? { policyRules: resolved.policy.data.rules } : {}),
        };
      } catch (cause) {
        if (cause instanceof DatabaseError) {
          throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
        }
        if (cause instanceof RecordDecodeError) throw cause;
        if (!(cause instanceof Error)) throw cause;
        return undefined;
      }
    },
    executeMcpTool: async (
      request,
      definition,
      mcpToolName,
    ): Promise<RuntimeToolExecutionResult> => {
      let resolved: ResolvedMcpBinding;
      try {
        resolved = await resolvedBinding(options, request, definition, mcpToolName);
        const pinned = request.decision.executionBinding;
        if (
          resolved.fingerprint !== pinned.authorizationFingerprint ||
          resolved.connection.data.id !== pinned.connectionId ||
          resolved.server.data.id !== pinned.externalAccountId
        ) {
          throw new RuntimeMcpBindingValidationError(
            "MCP authorization changed after the tool policy decision.",
          );
        }
      } catch (cause) {
        if (cause instanceof DatabaseError) {
          throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
        }
        if (cause instanceof RecordDecodeError) {
          throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
        }
        throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
      }
      let headers: Readonly<Record<string, string>> | undefined;
      let sensitiveMaterials: ReadonlySet<string> = new Set();
      try {
        const reference = credentialReference(resolved.server);
        if (reference) {
          const secret = await options.readCredential({
            environmentId: request.environmentId,
            organizationId: request.organizationId,
            projectId: request.projectId,
            reference,
            serverId: resolved.server.data.id,
          });
          headers = credentialHeaders(secret);
          sensitiveMaterials = mcpCredentialMaterials(secret.values, headers);
        }
      } catch (cause) {
        if (cause instanceof RuntimeMcpBindingValidationError) {
          throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
        }
        if (
          cause instanceof CredentialVaultError &&
          cause.code !== "crypto" &&
          cause.code !== "storage"
        ) {
          throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
        }
        throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
      }
      try {
        let argumentsWithConstraints: Readonly<Record<string, unknown>>;
        try {
          argumentsWithConstraints = constrainedMcpArguments(
            definition,
            request.input,
            resolved.authorization.data.externalResourceConstraints,
          );
        } catch (cause) {
          throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
        }
        const call = await options.client.callTool({
          arguments: argumentsWithConstraints,
          endpointOrigin: resolved.server.data.endpointOrigin,
          endpointPath: resolved.server.data.endpointPath,
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          timeoutMs,
          toolAllowlist: resolved.server.data.toolAllowlist,
          toolName: mcpToolName,
        });
        return completedMcpExecution({
          call,
          maximumCharacters,
          mcpToolName,
          request,
          sensitiveMaterials,
        });
      } catch (cause) {
        if (cause instanceof RuntimeToolExecutionKnownFailureError) throw cause;
        if (cause instanceof RemoteMcpError && !remoteMcpFailureRetryable(cause)) {
          throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
        }
        throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
      }
    },
  };
}
