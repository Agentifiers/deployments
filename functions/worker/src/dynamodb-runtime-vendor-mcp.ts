import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import {
  CredentialVaultError,
  providerOAuthMaterialFromCredentialValues,
} from "@deployments-ai/credential-vault";
import { DatabaseError, RecordDecodeError, type DynamoDatabaseService } from "@deployments-ai/db";
import {
  RemoteMcpError,
  type RemoteMcpClient,
  type RemoteMcpToolCallResult,
} from "@deployments-ai/mcp-client";
import {
  codeProviderDefinitionRegistry,
  vendorMcpCanonicalUrl,
  vendorMcpServer,
  type ProviderDefinition,
  type ProviderDefinitionRegistry,
} from "@deployments-ai/providers";
import type { ToolAdapterDefinition, ToolAdapterVendorMcpExecution } from "@deployments-ai/tools";
import {
  refreshProviderConnectionIfDue,
  type RefreshProviderConnection,
} from "./oauth-refresh-runtime.ts";
import { RuntimeProviderMutationOutcomeUnknownError } from "./provider-mutation-claims.ts";
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
import {
  providerCredentialPurpose,
  resolveProviderBinding,
  RuntimeProviderBindingValidationError,
  vaultReference,
  type ReadRuntimeCredential,
  type ResolvedProviderBinding,
} from "./runtime-provider-binding.ts";
import type {
  AuthorizedRuntimeToolBindingRequest,
  ExecuteRuntimeVendorMcpTool,
  ResolveRuntimeToolAuthorizationContext,
  RuntimeToolBindingRequest,
} from "./runtime-tools.ts";

export interface DynamoRuntimeVendorMcpOptions {
  readonly client: RemoteMcpClient;
  readonly database: DynamoDatabaseService;
  readonly maxArtifactCharacters?: number;
  readonly now?: () => Date;
  /** Defaults to the code-owned provider catalog. */
  readonly providerRegistry?: ProviderDefinitionRegistry;
  /** Provider-connection vault reader; records the mandatory `credential.read` audit. */
  readonly readCredential: ReadRuntimeCredential;
  /** Absent: connections that need an OAuth refresh fail as a known tool failure. */
  readonly refreshConnection?: RefreshProviderConnection;
  readonly timeoutMs?: number;
}

interface ResolvedVendorMcpBinding extends ResolvedProviderBinding {
  readonly provider: ProviderDefinition;
}

/**
 * Resolves a synced vendor MCP tool's authority: the deployment-pinned workspace grant for the
 * adapter's provider, its active vendor_mcp provider connection with a vault credential, and the
 * optional tool policy. The fingerprint also pins the remote tool name and approved tool hash.
 */
async function resolveVendorMcpBinding(
  options: Pick<DynamoRuntimeVendorMcpOptions, "database" | "providerRegistry">,
  request: RuntimeToolBindingRequest,
  definition: ToolAdapterDefinition,
  execution: ToolAdapterVendorMcpExecution,
): Promise<ResolvedVendorMcpBinding> {
  const resolved = await resolveProviderBinding(options, request, definition, {
    remoteToolName: execution.remoteToolName.trim(),
    toolHash: execution.toolHash,
  });
  const { authorization, connection } = resolved;
  if (authorization.data.providerKey !== execution.providerKey) {
    throw new RuntimeMcpBindingValidationError(
      `Workspace authorization is not for vendor MCP provider ${execution.providerKey}.`,
    );
  }
  if (vendorMcpAccountId(connection) !== authorization.data.externalAccountId) {
    throw new RuntimeMcpBindingValidationError(
      "Vendor MCP connection account does not match the workspace authorization.",
    );
  }
  if (!connection.data.credentialRef) {
    throw new RuntimeMcpBindingValidationError("Vendor MCP connection has no credential.");
  }
  const provider = (options.providerRegistry ?? codeProviderDefinitionRegistry()).getByKey(
    execution.providerKey,
  );
  if (provider?.route !== "vendor_mcp") {
    throw new RuntimeMcpBindingValidationError(
      `Provider ${execution.providerKey} is not a vendor MCP provider.`,
    );
  }
  return { ...resolved, provider };
}

/** Mirrors grant administration: static api_key connections are identified by their id. */
function vendorMcpAccountId(connection: ResolvedProviderBinding["connection"]): string {
  return connection.data.externalAccountId ?? connection.data.id;
}

/**
 * Only secret-bearing vault values become leak materials; non-secret metadata such as the OAuth
 * `tokenType` ("Bearer") would otherwise reject any result mentioning it.
 */
function vendorMcpSensitiveMaterials(
  provider: ProviderDefinition,
  values: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const authorization = vendorMcpServer(provider).authorization;
  const secretKeys =
    authorization.kind === "oauth"
      ? ["accessToken", "refreshToken"]
      : [
          authorization.field,
          ...(provider.auth.kind === "api_key"
            ? provider.auth.fields.filter((field) => field.sensitive).map((field) => field.key)
            : []),
        ];
  const secrets: Record<string, string> = {};
  for (const key of secretKeys) {
    const value = values[key];
    if (value) secrets[key] = value;
  }
  return mcpCredentialMaterials(secrets, headers);
}

function vendorMcpHeaders(
  provider: ProviderDefinition,
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const authorization = vendorMcpServer(provider).authorization;
  if (authorization.kind === "oauth") {
    let accessToken: string | undefined;
    try {
      accessToken = providerOAuthMaterialFromCredentialValues(values).fields.accessToken;
    } catch (cause) {
      throw new RuntimeMcpBindingValidationError("Vendor MCP OAuth credential is invalid.", {
        cause,
      });
    }
    return {
      authorization: `Bearer ${validMcpHeaderValue(accessToken ?? "", "Vendor MCP access token")}`,
    };
  }
  const key = validMcpHeaderValue(values[authorization.field] ?? "", "Vendor MCP API key");
  return {
    [authorization.headerName.toLowerCase()]: authorization.scheme
      ? `${authorization.scheme} ${key}`
      : key,
  };
}

/**
 * Classifies a failed vendor `tools/call`. Before dispatch the tenant MCP classification applies.
 * After dispatch a mutation may have executed: only an HTTP 4xx response proves the server did
 * not run it; anything else is an unknown outcome that must never be redispatched.
 */
function vendorMcpCallFailure(input: {
  readonly cause: unknown;
  readonly mutationDispatched: boolean;
  readonly remoteToolName: string;
  readonly toolName: string;
}): Error {
  const { cause, toolName } = input;
  if (cause instanceof RemoteMcpError && cause.code === "tool-drift") {
    return new RuntimeToolExecutionKnownFailureError(
      toolName,
      new Error(`MCP tool ${input.remoteToolName} changed since it was synced; re-run tool sync.`, {
        cause,
      }),
    );
  }
  if (cause instanceof RemoteMcpError && cause.code === "http" && cause.statusCode === 401) {
    return new RuntimeToolExecutionKnownFailureError(
      toolName,
      new Error("vendor MCP credential rejected; re-authorize the connection", { cause }),
    );
  }
  const rejected =
    cause instanceof RemoteMcpError &&
    cause.code === "http" &&
    cause.statusCode !== undefined &&
    cause.statusCode >= 400 &&
    cause.statusCode < 500;
  if (input.mutationDispatched && !rejected) {
    return new RuntimeProviderMutationOutcomeUnknownError(toolName, { cause });
  }
  if (cause instanceof RemoteMcpError && !remoteMcpFailureRetryable(cause)) {
    return new RuntimeToolExecutionKnownFailureError(toolName, cause);
  }
  return new RuntimeToolPreparationRetryableError(toolName, cause);
}

export function createDynamoRuntimeVendorMcp(options: DynamoRuntimeVendorMcpOptions): {
  readonly executeVendorMcpTool: ExecuteRuntimeVendorMcpTool;
  readonly resolveVendorMcpAuthorizationContext: ResolveRuntimeToolAuthorizationContext;
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

  const pinnedBinding = async (
    request: AuthorizedRuntimeToolBindingRequest,
    definition: ToolAdapterDefinition,
    execution: ToolAdapterVendorMcpExecution,
  ): Promise<ResolvedVendorMcpBinding> => {
    try {
      const resolved = await resolveVendorMcpBinding(options, request, definition, execution);
      const pinned = request.decision.executionBinding;
      if (
        resolved.fingerprint !== pinned.authorizationFingerprint ||
        resolved.connection.data.id !== pinned.connectionId ||
        vendorMcpAccountId(resolved.connection) !== pinned.externalAccountId
      ) {
        throw new RuntimeMcpBindingValidationError(
          "Vendor MCP authorization changed after the tool policy decision.",
        );
      }
      return resolved;
    } catch (cause) {
      if (cause instanceof DatabaseError) {
        throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
      }
      throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
    }
  };

  return {
    resolveVendorMcpAuthorizationContext: async (request, definition) => {
      const execution = definition.execution;
      if (execution?.type !== "vendor_mcp") return undefined;
      try {
        const resolved = await resolveVendorMcpBinding(options, request, definition, execution);
        return {
          authorizationFingerprint: resolved.fingerprint,
          connectionId: resolved.connection.data.id,
          connectorProvider: resolved.connection.data.providerKey,
          externalAccountId: vendorMcpAccountId(resolved.connection),
          externalResourceConstraints: resolved.authorization.data.externalResourceConstraints,
          grantedScopes: resolved.grantedScopes,
          ...(resolved.policy ? { policyRules: resolved.policy.data.rules } : {}),
        };
      } catch (cause) {
        if (cause instanceof DatabaseError) {
          throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
        }
        if (cause instanceof RecordDecodeError || !(cause instanceof Error)) throw cause;
        return undefined;
      }
    },
    executeVendorMcpTool: async (request, definition, execution) => {
      const remoteToolName = execution.remoteToolName.trim();
      let resolved = await pinnedBinding(request, definition, execution);
      const refreshed = await refreshProviderConnectionIfDue({
        connection: resolved.connection,
        now: options.now?.() ?? new Date(),
        refresh: options.refreshConnection,
        scope: request,
        toolName: request.toolName,
      });
      if (refreshed) resolved = await pinnedBinding(request, definition, execution);

      let headers: Readonly<Record<string, string>>;
      let sensitiveMaterials: ReadonlySet<string>;
      try {
        const secret = await options.readCredential({
          connectionId: resolved.connection.data.id,
          environmentId: request.environmentId,
          organizationId: request.organizationId,
          projectId: request.projectId,
          purpose: providerCredentialPurpose(resolved.connection),
          reference: vaultReference(resolved.connection.data.credentialRef),
        });
        headers = vendorMcpHeaders(resolved.provider, secret.values);
        sensitiveMaterials = vendorMcpSensitiveMaterials(resolved.provider, secret.values, headers);
      } catch (cause) {
        if (
          cause instanceof RuntimeMcpBindingValidationError ||
          cause instanceof RuntimeProviderBindingValidationError ||
          (cause instanceof CredentialVaultError &&
            cause.code !== "crypto" &&
            cause.code !== "storage")
        ) {
          throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
        }
        throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
      }

      let endpoint: URL;
      let argumentsWithConstraints: Readonly<Record<string, unknown>>;
      try {
        endpoint = new URL(
          resolved.connection.data.oauthResource ?? vendorMcpCanonicalUrl(resolved.provider),
        );
      } catch (cause) {
        throw new RuntimeToolExecutionKnownFailureError(
          request.toolName,
          new Error(
            `Vendor MCP connection has no valid MCP endpoint; reconnect ${resolved.provider.displayName}.`,
            { cause },
          ),
        );
      }
      try {
        argumentsWithConstraints = constrainedMcpArguments(
          definition,
          request.input,
          resolved.authorization.data.externalResourceConstraints,
        );
      } catch (cause) {
        throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
      }

      const dispatch = { started: false };
      let call: RemoteMcpToolCallResult;
      try {
        call = await options.client.callTool({
          arguments: argumentsWithConstraints,
          endpointOrigin: endpoint.origin,
          endpointPath: `${endpoint.pathname}${endpoint.search}`,
          expectedToolHash: execution.toolHash,
          headers,
          onToolCallDispatch: () => {
            dispatch.started = true;
          },
          ...(request.signal ? { signal: request.signal } : {}),
          timeoutMs,
          toolAllowlist: [remoteToolName],
          toolName: remoteToolName,
        });
      } catch (cause) {
        throw vendorMcpCallFailure({
          cause,
          mutationDispatched: dispatch.started && definition.effect !== "read",
          remoteToolName,
          toolName: request.toolName,
        });
      }
      try {
        return completedMcpExecution({
          call,
          maximumCharacters,
          mcpToolName: remoteToolName,
          request,
          sensitiveMaterials,
        });
      } catch (cause) {
        // The vendor already ran the call; a write's outcome is unknown, never redispatched.
        if (definition.effect !== "read") {
          throw new RuntimeProviderMutationOutcomeUnknownError(request.toolName, { cause });
        }
        throw cause;
      }
    },
  };
}
