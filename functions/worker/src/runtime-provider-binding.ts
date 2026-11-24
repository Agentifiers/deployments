import type { RuntimeToolBindingRequest } from "./runtime-tools.ts";
import {
  Ulid,
  executionBindingIsActive,
  grantCoversWorkspace,
  key,
  makeExecutionBindingPersistence,
  type DynamoDatabaseService,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";
import type { AgentDeploymentConfigV1, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type {
  CredentialVaultReference,
  CredentialVaultSecretDocument,
} from "@deployments-ai/credential-vault";
import {
  codeProviderDefinitionRegistry,
  providerUsesNoCredential,
} from "@deployments-ai/providers";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";
import { Schema } from "effect";
import { createHash } from "node:crypto";

type ExecutionTarget = Extract<
  PlatformRecord,
  { readonly itemType: "agent-deployment" | "execution-binding" }
>;
export type RuntimeProviderConnection = Extract<
  PlatformRecord,
  { readonly itemType: "provider-connection" }
>;
type ProviderConnection = RuntimeProviderConnection;
type ToolAdapter = Extract<PlatformRecord, { readonly itemType: "tool-adapter" }>;
type ToolCredential = Extract<PlatformRecord, { readonly itemType: "credential-vault-entry" }>;
type ToolPolicy = Extract<PlatformRecord, { readonly itemType: "tool-policy" }>;
type WorkspaceAuthorization = Extract<
  PlatformRecord,
  { readonly itemType: "workspace-connection-authorization" }
>;

export interface RuntimeCredentialReadInput {
  readonly connectionId: Ulid;
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly purpose: "provider-api" | "provider-oauth-token";
  readonly reference: CredentialVaultReference;
}

export type ReadRuntimeCredential = (
  input: RuntimeCredentialReadInput,
) => Promise<CredentialVaultSecretDocument>;

export interface RuntimeProviderBindingOptions {
  readonly database: DynamoDatabaseService;
}

interface ReleaseToolAuthorizationBinding {
  readonly authorizationId: Ulid;
  readonly toolPolicyId?: Ulid;
}

export interface ResolvedProviderBinding {
  readonly authorization: WorkspaceAuthorization;
  readonly connection: ProviderConnection;
  /** The ready deployment, or the active execution binding for preview/evaluation runs. */
  readonly executionTarget: ExecutionTarget;
  readonly fingerprint: string;
  readonly grantedScopes: readonly string[];
  readonly policy?: ToolPolicy;
  readonly providerUsesNoCredential: boolean;
  readonly toolAdapter?: ToolAdapter;
  readonly toolCredential?: ToolCredential;
}

export class RuntimeProviderBindingValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeProviderBindingValidationError";
  }
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
    | "provider-connection"
    | "credential-vault-entry"
    | "tool-adapter"
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
    throw new RuntimeProviderBindingValidationError(`Runtime ${itemType} was not found.`);
  }
  return value as Extract<PlatformRecord, { readonly itemType: ItemType }>;
}

function optionalUlid(value: unknown, label: string): Ulid | undefined {
  if (value === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch (cause) {
    throw new RuntimeProviderBindingValidationError(`${label} must be a canonical ULID.`, {
      cause,
    });
  }
}

function deploymentBinding(
  runtimeConfig: AgentDeploymentConfigV1 | undefined,
  toolName: string,
): ReleaseToolAuthorizationBinding {
  const rawBinding = runtimeConfig?.toolAuthorizations?.[toolName];
  if (!rawBinding) {
    throw new RuntimeProviderBindingValidationError(
      `Agent deployment authorization for ${toolName} is required.`,
    );
  }
  const authorizationId = optionalUlid(
    rawBinding.authorizationId,
    `Agent deployment authorization ${toolName}.authorizationId`,
  );
  if (!authorizationId) {
    throw new RuntimeProviderBindingValidationError(
      `Agent deployment authorization ${toolName}.authorizationId is required.`,
    );
  }
  const toolPolicyId = optionalUlid(
    rawBinding.toolPolicyId,
    `Agent deployment authorization ${toolName}.toolPolicyId`,
  );
  return { authorizationId, ...(toolPolicyId ? { toolPolicyId } : {}) };
}

function persistedAdapterVersion(definition: ToolAdapterDefinition): number | undefined {
  const audit = definition.auditMetadata;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return undefined;
  const persisted = (audit as Readonly<Record<string, unknown>>).persistedAdapter;
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) return undefined;
  const version = (persisted as Readonly<Record<string, unknown>>).version;
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : undefined;
}

function assertScope(recordValue: PlatformRecord, request: RuntimeToolBindingRequest) {
  const data = recordValue.data as Readonly<Record<string, unknown>>;
  if (
    data.organizationId !== request.organizationId ||
    data.projectId !== request.projectId ||
    data.environmentId !== request.environmentId
  ) {
    throw new RuntimeProviderBindingValidationError(
      `Runtime ${recordValue.itemType} does not match the run scope.`,
    );
  }
}

export function providerCredentialPurpose(
  connection: ProviderConnection,
): RuntimeCredentialReadInput["purpose"] {
  const method = connection.data.authMethod.trim().toLowerCase();
  return method === "oauth" || method === "oauth2" ? "provider-oauth-token" : "provider-api";
}

/** Backend identity pinned into a provider fingerprint beyond the connection authority. */
export interface ProviderFingerprintExtension {
  readonly remoteToolName: string;
  readonly toolHash: string;
}

/**
 * Authority of a workspace grant over a provider connection. Built only from stable authority
 * fields: record version and credential generation churn on every token refresh, so they are
 * excluded and refresh never invalidates pending decisions or approvals, while grant, account,
 * status, issuer, resource, application, or scope changes still do.
 */
function providerAuthorizationFingerprint(input: {
  readonly authorization: WorkspaceAuthorization;
  readonly connection: ProviderConnection;
  readonly extension?: ProviderFingerprintExtension;
  readonly grantedScopes: readonly string[];
  readonly policy?: ToolPolicy;
  readonly toolName: string;
}) {
  const connection = input.connection.data;
  return createHash("sha256")
    .update(
      JSON.stringify({
        authorizationId: input.authorization.data.id,
        authorizationVersion: input.authorization.data.authorizationVersion,
        authorizationRecordVersion: input.authorization.data.version,
        connectionAuthorizationScopes: [...(connection.authorizationScopes ?? [])].toSorted(),
        connectionExternalAccountId: connection.externalAccountId ?? null,
        connectionId: connection.id,
        connectionOAuthIssuer: connection.oauthIssuer ?? null,
        connectionOAuthResource: connection.oauthResource ?? null,
        connectionProviderApplicationId: connection.providerApplicationId ?? null,
        connectionScopes: [...connection.scopes].toSorted(),
        connectionStatus: connection.status,
        externalAccountId: input.authorization.data.externalAccountId,
        policyId: input.policy?.data.id ?? null,
        policyVersion: input.policy?.data.version ?? null,
        providerKey: input.authorization.data.providerKey,
        ...(input.extension
          ? {
              remoteToolName: input.extension.remoteToolName,
              toolHash: input.extension.toolHash,
            }
          : {}),
        resourceScopeHash: input.authorization.data.resourceScopeHash,
        scopes: [...input.grantedScopes].toSorted(),
        toolName: input.toolName,
      }),
    )
    .digest("hex");
}

/**
 * The manifest and frozen tool authorizations a run executes with: a ready deployment and its
 * active release, or an active execution binding for preview/evaluation runs.
 */
export async function executionSource(
  options: RuntimeProviderBindingOptions,
  request: RuntimeToolBindingRequest,
): Promise<{
  readonly manifest: AgentManifestV1;
  readonly runtimeConfig?: AgentDeploymentConfigV1;
  readonly target: ExecutionTarget;
}> {
  if (request.executionBindingId !== undefined) {
    const binding = await makeExecutionBindingPersistence(options.database).get({
      environmentId: request.environmentId,
      executionBindingId: request.executionBindingId,
      organizationId: request.organizationId,
    });
    if (!binding)
      throw new RuntimeProviderBindingValidationError("Execution binding was not found.");
    assertScope(binding, request);
    if (!executionBindingIsActive(binding, new Date())) {
      throw new RuntimeProviderBindingValidationError("Execution binding is not active.");
    }
    return {
      manifest: binding.data.manifest,
      ...(binding.data.runtimeConfig ? { runtimeConfig: binding.data.runtimeConfig } : {}),
      target: binding,
    };
  }
  const release = expected(
    await load(options.database, request, "agent-release", request.agentReleaseId),
    "agent-release",
  );
  assertScope(release, request);
  if (release.data.status !== "active") {
    throw new RuntimeProviderBindingValidationError("Agent release is not active.");
  }
  const deployment = expected(
    await load(options.database, request, "agent-deployment", request.agentDeploymentId),
    "agent-deployment",
  );
  assertScope(deployment, request);
  if (
    release.data.agentDefinitionId !== request.agentDefinitionId ||
    deployment.data.agentDefinitionId !== request.agentDefinitionId ||
    deployment.data.agentDefinitionId !== release.data.agentDefinitionId ||
    deployment.data.currentState !== "ready" ||
    deployment.data.desiredState !== "running"
  ) {
    throw new RuntimeProviderBindingValidationError(
      "Agent deployment is not ready or does not pin the requested release.",
    );
  }
  return {
    manifest: release.data.manifest,
    ...(deployment.data.runtimeConfig ? { runtimeConfig: deployment.data.runtimeConfig } : {}),
    target: deployment,
  };
}

/**
 * Resolves the deployment-pinned workspace grant, provider connection, and optional tool policy
 * for a provider-backed tool and fingerprints their authority.
 */
export async function resolveProviderBinding(
  options: RuntimeProviderBindingOptions,
  request: RuntimeToolBindingRequest,
  definition: ToolAdapterDefinition,
  extension?: ProviderFingerprintExtension,
): Promise<ResolvedProviderBinding> {
  if (!request.workspaceId) {
    throw new RuntimeProviderBindingValidationError(
      "Runtime provider tools require a workspace-scoped run.",
    );
  }
  const source = await executionSource(options, request);
  const capability = (source.manifest.spec.capabilities?.tools ?? []).find(
    (candidate) => candidate.name === definition.toolName,
  );
  if (!capability) {
    throw new RuntimeProviderBindingValidationError(
      `Agent release does not declare tool capability ${definition.toolName}.`,
    );
  }
  if (capability.authorization !== "workspace") {
    throw new RuntimeProviderBindingValidationError(
      `Agent release tool capability ${definition.toolName} does not allow workspace authorization.`,
    );
  }
  const callbackExecution =
    definition.execution?.type === "http_callback" ? definition.execution : undefined;
  const callbackToolAdapterId = callbackExecution ? definition.toolAdapterId : undefined;
  if (callbackExecution && !callbackToolAdapterId) {
    throw new RuntimeProviderBindingValidationError(
      "HTTP callback execution requires a durable tool adapter.",
    );
  }
  const toolAdapter = callbackToolAdapterId
    ? expected(
        await load(options.database, request, "tool-adapter", callbackToolAdapterId),
        "tool-adapter",
      )
    : undefined;
  if (toolAdapter) {
    assertScope(toolAdapter, request);
    const reference = toolAdapter.data.authSecretRef;
    const credentialGeneration =
      reference && "generation" in reference ? reference.generation : undefined;
    if (
      !definition.toolAdapterId ||
      toolAdapter.data.id !== definition.toolAdapterId ||
      toolAdapter.data.name !== definition.toolName ||
      toolAdapter.data.effect !== definition.effect ||
      toolAdapter.data.status !== "active" ||
      toolAdapter.data.version !== persistedAdapterVersion(definition) ||
      credentialGeneration !== callbackExecution?.credentialGeneration
    ) {
      throw new RuntimeProviderBindingValidationError(
        "HTTP callback tool adapter changed after its execution plan was loaded.",
      );
    }
  }
  const toolCredentialReference = toolAdapter?.data.authSecretRef;
  if (
    toolAdapter &&
    (!toolCredentialReference ||
      !("store" in toolCredentialReference) ||
      toolCredentialReference.store !== "dynamodb-kms")
  ) {
    throw new RuntimeProviderBindingValidationError(
      "HTTP callback tool adapter requires a DynamoDB/KMS credential.",
    );
  }
  const toolCredential =
    toolCredentialReference && "credentialId" in toolCredentialReference
      ? expected(
          await load(
            options.database,
            request,
            "credential-vault-entry",
            toolCredentialReference.credentialId,
          ),
          "credential-vault-entry",
        )
      : undefined;
  const toolCredentialGeneration =
    toolCredentialReference && "generation" in toolCredentialReference
      ? toolCredentialReference.generation
      : undefined;
  if (toolCredential) {
    assertScope(toolCredential, request);
    const expiresAt = toolCredential.data.expiresAt
      ? Date.parse(toolCredential.data.expiresAt)
      : undefined;
    if (
      toolCredential.data.status !== "active" ||
      toolCredential.data.ownerType !== "tool-adapter" ||
      toolCredential.data.ownerId !== toolAdapter?.data.id ||
      toolCredential.data.generation !== toolCredentialGeneration ||
      (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))
    ) {
      throw new RuntimeProviderBindingValidationError(
        "HTTP callback tool adapter credential is not active.",
      );
    }
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
  const grantProviderUsesNoCredential = providerUsesNoCredential(
    codeProviderDefinitionRegistry().resolve(authorization.data.providerKey),
  );
  if (
    authorization.data.status !== "active" ||
    !grantCoversWorkspace(authorization.data, request.workspaceId, grantProviderUsesNoCredential) ||
    authorization.data.purpose !== "agent-runtime"
  ) {
    throw new RuntimeProviderBindingValidationError(
      "Workspace provider authorization is not active for this run.",
    );
  }
  const connection = expected(
    await load(options.database, request, "provider-connection", authorization.data.connectionId),
    "provider-connection",
  );
  assertScope(connection, request);
  const connectionAuthMethod = connection.data.authMethod.trim().toLowerCase();
  const legacyOAuthConnection =
    !connection.data.externalAccountId &&
    (connectionAuthMethod === "oauth" || connectionAuthMethod === "oauth2");
  if (
    connection.data.status !== "active" ||
    connection.data.providerKey !== authorization.data.providerKey ||
    // Grants pin `externalAccountId ?? connection.id` (static api_key connections have no account).
    (!legacyOAuthConnection &&
      (connection.data.externalAccountId ?? connection.data.id) !==
        authorization.data.externalAccountId)
  ) {
    throw new RuntimeProviderBindingValidationError(
      "Provider connection does not match the workspace authorization.",
    );
  }
  // Legacy grants without persisted scopes predate durable scope authorization.
  // They require an explicit backfill rather than inheriting expanding connection scopes.
  const grantedScopes = authorization.data.scopes ?? [];
  const currentScopes = new Set(connection.data.scopes);
  if (grantedScopes.some((scope) => !currentScopes.has(scope))) {
    throw new RuntimeProviderBindingValidationError(
      "Workspace provider authorization contains scopes no longer verified on the connection.",
    );
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
      throw new RuntimeProviderBindingValidationError("Runtime tool policy is not active.");
    }
  }
  return {
    authorization,
    connection,
    executionTarget: source.target,
    fingerprint: providerAuthorizationFingerprint({
      authorization,
      connection,
      ...(extension ? { extension } : {}),
      grantedScopes,
      ...(policy ? { policy } : {}),
      toolName: definition.toolName,
    }),
    grantedScopes,
    ...(policy ? { policy } : {}),
    providerUsesNoCredential: grantProviderUsesNoCredential,
    ...(toolAdapter ? { toolAdapter } : {}),
    ...(toolCredential ? { toolCredential } : {}),
  };
}

export function vaultReference(
  value: ProviderConnection["data"]["credentialRef"],
): CredentialVaultReference {
  if (!value || !("store" in value) || value.store !== "dynamodb-kms") {
    throw new RuntimeProviderBindingValidationError(
      "Provider connection requires a DynamoDB/KMS credential reference.",
    );
  }
  return value;
}
