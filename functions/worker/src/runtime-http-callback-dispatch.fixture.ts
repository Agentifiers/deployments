import {
  agentManifestContentHash,
  type AgentDeploymentConfigV1,
} from "@deployments-ai/agent-manifest";
import {
  AgentDeploymentRecord,
  CredentialVaultEntryRecord,
  ExecutionBindingRecord,
  ProviderConnectionRecord,
  ToolAdapterRecord,
  WorkspaceConnectionAuthorizationRecord,
  withCanonicalRecordKeys,
  type BoundExecutionPurpose,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id } from "./agent-run.fixture.ts";
import type { AuthorizedRuntimeToolBindingRequest } from "./runtime-tool-planning.ts";

type CustomerAuthorizedRuntimeToolBindingRequest = Extract<
  AuthorizedRuntimeToolBindingRequest,
  { readonly executionPurpose?: "customer" }
>;

export const now = new Date("2026-08-08T12:00:00.000Z");
export const executionBindingId = id(85);

export function request(
  fixture: ReturnType<typeof fixtures>,
  overrides: Partial<CustomerAuthorizedRuntimeToolBindingRequest> = {},
): CustomerAuthorizedRuntimeToolBindingRequest {
  return {
    agentDefinitionId: fixture.deployment.data.agentDefinitionId,
    agentDeploymentId: fixture.deployment.data.id,
    agentReleaseId: fixture.release.data.id,
    decision: {
      action: "allow",
      executionBinding: {
        authorizationFingerprint: "sha256:authorization-v1",
        connectionId: id(80),
        externalAccountId: "vertical-account",
        inputHash: `sha256:${"a".repeat(64)}`,
        toolAdapterId: id(81),
        toolPlanFingerprint: "sha256:tool-plan-v1",
      },
      reason: "Allowed by policy.",
      toolCallId: id(82),
    },
    effect: "write",
    environmentId: fixture.run.data.environmentId,
    idempotencyKey: "callback-write-1",
    input: { resourceId: "caller-resource" },
    inputSummary: "Write through callback.",
    organizationId: fixture.run.data.organizationId,
    policyAction: "allow",
    projectId: fixture.run.data.projectId,
    requiredScopes: ["callback:write"],
    runId: fixture.run.data.id,
    threadId: fixture.run.data.threadId,
    toolName: "vertical.callback.write",
    workspaceId: fixture.run.data.workspaceId!,
    ...overrides,
  };
}

function executionBinding(
  fixture: ReturnType<typeof fixtures>,
  purpose: BoundExecutionPurpose,
  runtimeConfig: AgentDeploymentConfigV1,
  overrides: { readonly createdAt?: string; readonly expiresAt?: string } = {},
) {
  const { manifest } = fixture.release.data;
  const expiresAt = overrides.expiresAt ?? "2026-08-09T12:00:00.000Z";
  return Schema.decodeUnknownSync(ExecutionBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        contentHash: agentManifestContentHash(manifest),
        createdAt: overrides.createdAt ?? now.toISOString(),
        createdBy: { id: id(86), type: "principal" as const },
        environmentId: fixture.run.data.environmentId,
        expiresAt,
        id: executionBindingId,
        idempotencyKey: "preview-binding-1",
        manifest,
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
        purpose,
        runtimeConfig,
        source: {
          agentDefinitionId: fixture.release.data.agentDefinitionId,
          agentReleaseId: fixture.release.data.id,
          type: "release" as const,
        },
        status: "active" as const,
        toolPolicy: purpose === "evaluation" ? ("evaluation" as const) : ("interactive" as const),
        updatedAt: overrides.createdAt ?? now.toISOString(),
        version: 0,
      },
      itemType: "execution-binding" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }),
  );
}

export function controlSnapshot(
  fixture: ReturnType<typeof fixtures>,
  authorized: AuthorizedRuntimeToolBindingRequest,
  bindingOverrides?: { readonly createdAt?: string; readonly expiresAt?: string },
) {
  const timestamp = now.toISOString();
  const workspaceAuthorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
    withCanonicalRecordKeys({
      data: {
        authorizationVersion: 1,
        connectionId: authorized.decision.executionBinding.connectionId,
        createdAt: timestamp,
        environmentId: authorized.environmentId,
        externalAccountId: authorized.decision.executionBinding.externalAccountId,
        externalResourceConstraints: {},
        id: id(83),
        organizationId: authorized.organizationId,
        projectId: authorized.projectId,
        providerKey: "github",
        purpose: "agent-runtime",
        resourceScopeHash: "sha256:resource-scope-v1",
        scopes: [...(authorized.requiredScopes ?? [])],
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
        workspaceId: authorized.workspaceId!,
      },
      itemType: "workspace-connection-authorization" as const,
    }),
  );
  const runtimeConfig: AgentDeploymentConfigV1 = {
    apiVersion: "agents.deployments.ai/v1" as const,
    kind: "AgentDeploymentConfig" as const,
    toolAuthorizations: {
      [authorized.toolName]: { authorizationId: workspaceAuthorization.data.id },
    },
  };
  const executionTarget =
    authorized.executionBindingId === undefined
      ? Schema.decodeUnknownSync(AgentDeploymentRecord)(
          withCanonicalRecordKeys({
            ...fixture.deployment,
            data: { ...fixture.deployment.data, runtimeConfig },
          }),
        )
      : executionBinding(fixture, authorized.executionPurpose, runtimeConfig, bindingOverrides);
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      data: {
        authMethod: "static",
        createdAt: timestamp,
        environmentId: authorized.environmentId,
        externalAccountId: authorized.decision.executionBinding.externalAccountId,
        id: authorized.decision.executionBinding.connectionId,
        organizationId: authorized.organizationId,
        projectId: authorized.projectId,
        providerKey: workspaceAuthorization.data.providerKey,
        scopes: [...(authorized.requiredScopes ?? [])],
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "provider-connection" as const,
    }),
  );
  const toolAdapter = Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        authSecretRef: { credentialId: id(84), generation: 3, store: "dynamodb-kms" as const },
        createdAt: timestamp,
        effect: authorized.effect,
        environmentId: authorized.environmentId,
        execution: {
          completionMode: "sync",
          endpointOrigin: "https://callbacks.example.com",
          endpointPath: "/v1/tools/write",
          type: "http_callback",
        },
        id: authorized.decision.executionBinding.toolAdapterId!,
        name: authorized.toolName,
        organizationId: authorized.organizationId,
        projectId: authorized.projectId,
        providerKey: workspaceAuthorization.data.providerKey,
        requiredScopes: [...(authorized.requiredScopes ?? [])],
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "tool-adapter" as const,
    }),
  );
  const toolCredential = Schema.decodeUnknownSync(CredentialVaultEntryRecord)(
    withCanonicalRecordKeys({
      data: {
        algorithm: "AES-256-GCM" as const,
        authTag: "encrypted-auth-tag",
        ciphertext: "encrypted-callback-secret",
        createdAt: timestamp,
        encryptedDataKey: "encrypted-data-key",
        encryptionContextHash: "sha256:encryption-context-v1",
        environmentId: authorized.environmentId,
        generation: 3,
        id: id(84),
        iv: "initialization-vector",
        kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/callback",
        organizationId: authorized.organizationId,
        ownerId: toolAdapter.data.id,
        ownerType: "tool-adapter" as const,
        projectId: authorized.projectId,
        purpose: "tool-adapter-auth",
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "credential-vault-entry" as const,
    }),
  );
  return {
    connection,
    executionTarget,
    providerUsesNoCredential: false,
    toolAdapter,
    toolCredential,
    workspaceAuthorization,
  } as const;
}
