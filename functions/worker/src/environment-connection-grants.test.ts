import { describe, expect, test } from "bun:test";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  CredentialVaultEntryRecord,
  ProviderConnectionRecord,
  ToolAdapterRecord,
  WorkspaceConnectionAuthorizationRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { toolAdapterDefinitionFromRecord } from "@deployments-ai/tools";
import { Schema } from "effect";
import { createDynamoRuntimeMcp } from "./dynamodb-runtime-mcp.ts";
import { createDynamoRuntimeToolResolvers } from "./dynamodb-runtime-tools.ts";
import {
  database,
  fixtures as mcpFixtures,
  ids as mcpIds,
  mcpConnectionId,
  request as mcpRequest,
  tenantMcpAdapter,
} from "./runtime-mcp-binding.fixture.ts";
import type { RuntimeToolBindingRequest } from "./runtime-tools.ts";

const ids = Array.from(
  { length: 20 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G7F${String(index).padStart(2, "0")}`,
) as Ulid[];
const organizationId = ids[0]!;
const projectId = ids[1]!;
const environmentId = ids[2]!;
const firstWorkspaceId = ids[3]!;
const secondWorkspaceId = ids[4]!;
const releaseId = ids[5]!;
const deploymentId = ids[6]!;
const authorizationId = ids[7]!;
const connectionId = ids[8]!;
const adapterId = ids[9]!;
const adapterCredentialId = ids[10]!;
const toolName = "vertical.callback.draft";
const scope = "callback:draft:propose";
const timestamp = "2026-10-18T12:00:00.000Z";
const tenant = { environmentId, organizationId, projectId };

function callbackRecords(grantWorkspaceId: Ulid | undefined, providerKey = "extension_callback") {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "runtime.environment-grant", name: "Environment Grant", version: "1.0.0" },
    spec: {
      capabilities: {
        tools: [
          { authorization: "workspace", name: toolName, required: true, requiredScopes: [scope] },
        ],
      },
      instructions: "Draft through the callback.",
      model: { id: "openrouter/test" },
      sandbox: { mode: "none" },
    },
  });
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        ...tenant,
        agentDefinitionId: ids[11]!,
        contentHash: agentManifestContentHash(manifest),
        createdAt: timestamp,
        createdByPrincipalId: ids[12]!,
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
        ...tenant,
        agentDefinitionId: ids[11]!,
        agentReleaseId: releaseId,
        createdAt: timestamp,
        currentState: "ready" as const,
        desiredState: "running" as const,
        id: deploymentId,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: { [toolName]: { authorizationId } },
        },
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      data: {
        ...tenant,
        authMethod: "none",
        createdAt: timestamp,
        externalAccountId: connectionId,
        id: connectionId,
        providerKey,
        scopes: [scope],
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "provider-connection" as const,
    }),
  );
  const authorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
    withCanonicalRecordKeys({
      data: {
        ...tenant,
        authorizationVersion: 1,
        connectionId,
        createdAt: timestamp,
        externalAccountId: connectionId,
        externalResourceConstraints: {},
        id: authorizationId,
        providerKey,
        purpose: "agent-runtime",
        resourceScopeHash: "callback-scope",
        scopes: [scope],
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
        ...(grantWorkspaceId ? { workspaceId: grantWorkspaceId } : {}),
      },
      itemType: "workspace-connection-authorization" as const,
    }),
  );
  const adapter = Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        ...tenant,
        authSecretRef: { credentialId: adapterCredentialId, generation: 2, store: "dynamodb-kms" },
        createdAt: timestamp,
        effect: "write" as const,
        execution: {
          completionMode: "sync",
          endpointOrigin: "https://callbacks.example.com",
          endpointPath: "/v1/tools/draft",
          type: "http_callback",
        },
        id: adapterId,
        name: toolName,
        providerKey,
        requiredScopes: [scope],
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "tool-adapter" as const,
    }),
  );
  const adapterCredential = Schema.decodeUnknownSync(CredentialVaultEntryRecord)(
    withCanonicalRecordKeys({
      data: {
        ...tenant,
        algorithm: "AES-256-GCM" as const,
        authTag: "encrypted-auth-tag",
        ciphertext: "encrypted-callback-secret",
        createdAt: timestamp,
        encryptedDataKey: "encrypted-data-key",
        encryptionContextHash: "sha256:encryption-context-v1",
        generation: 2,
        id: adapterCredentialId,
        iv: "initialization-vector",
        kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/callback",
        ownerId: adapterId,
        ownerType: "tool-adapter" as const,
        purpose: "tool-adapter-auth",
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "credential-vault-entry" as const,
    }),
  );
  const loaded = toolAdapterDefinitionFromRecord(adapter);
  if (loaded.execution?.type !== "http_callback") throw new Error("expected an HTTP callback");
  const definition = {
    ...loaded,
    execution: {
      ...loaded.execution,
      authorizationHeader: "Bearer callback-secret",
      credentialGeneration: 2,
    },
  };
  const resolvers = createDynamoRuntimeToolResolvers({
    database: database([
      release,
      deployment,
      connection,
      authorization,
      adapter,
      adapterCredential,
    ]),
    readCredential: async () => Promise.reject(new Error("not used")),
  });
  return {
    resolve: (workspaceId: Ulid | undefined) =>
      resolvers.resolveAuthorizationContext(callbackRequest(workspaceId), definition),
  };
}

function callbackRequest(workspaceId: Ulid | undefined): RuntimeToolBindingRequest {
  return {
    ...tenant,
    agentDefinitionId: ids[11]!,
    agentDeploymentId: deploymentId,
    agentReleaseId: releaseId,
    effect: "write",
    idempotencyKey: "callback-draft-1",
    inputSummary: "Draft through the callback.",
    requiredScopes: [scope],
    runId: ids[13]!,
    threadId: ids[14]!,
    toolName,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function mcpRuntime(grantWorkspaceId: Ulid | undefined) {
  const seeded = mcpFixtures();
  const { workspaceId: _fixtureWorkspaceId, ...grantData } = seeded.authorization.data;
  const authorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
    withCanonicalRecordKeys({
      data: { ...grantData, ...(grantWorkspaceId ? { workspaceId: grantWorkspaceId } : {}) },
      itemType: "workspace-connection-authorization" as const,
    }),
  );
  const runtime = createDynamoRuntimeMcp({
    client: { callTool: async () => Promise.reject(new Error("not used")) },
    database: database(Object.values({ ...seeded, authorization })),
    readCredential: async () => Promise.reject(new Error("not used")),
  });
  return {
    resolve: (workspaceId: Ulid | undefined) => {
      const { workspaceId: _requestWorkspaceId, ...base } = mcpRequest();
      return runtime.resolveMcpAuthorizationContext(
        { ...base, ...(workspaceId ? { workspaceId } : {}) },
        tenantMcpAdapter(),
      );
    },
  };
}

describe("environment connection grants at runtime", () => {
  test("an environment grant authorizes HTTP callback runs in two workspaces", async () => {
    const { resolve } = callbackRecords(undefined);
    const expected = {
      connectionId,
      connectorProvider: "extension_callback",
      externalAccountId: connectionId,
      grantedScopes: [scope],
    };

    expect(await resolve(firstWorkspaceId)).toMatchObject(expected);
    expect(await resolve(secondWorkspaceId)).toMatchObject(expected);
  });

  test("a workspace grant still refuses an HTTP callback run in another workspace", async () => {
    const { resolve } = callbackRecords(firstWorkspaceId);

    expect(await resolve(firstWorkspaceId)).toMatchObject({ connectionId });
    expect(await resolve(secondWorkspaceId)).toBeUndefined();
  });

  test("an HTTP callback run without a workspace is refused under either grant", async () => {
    expect(await callbackRecords(undefined).resolve(undefined)).toBeUndefined();
    expect(await callbackRecords(firstWorkspaceId).resolve(undefined)).toBeUndefined();
  });

  test("an environment grant stops authorizing once its provider needs a credential", async () => {
    expect(await callbackRecords(undefined, "github").resolve(firstWorkspaceId)).toBeUndefined();
    expect(
      await callbackRecords(firstWorkspaceId, "github").resolve(firstWorkspaceId),
    ).toMatchObject({ connectionId, connectorProvider: "github" });
  });

  test("an environment grant never authorizes MCP runs", async () => {
    expect(await mcpRuntime(undefined).resolve(mcpIds[18]!)).toBeUndefined();
    expect(await mcpRuntime(mcpIds[18]!).resolve(mcpIds[18]!)).toMatchObject({
      connectionId: mcpConnectionId,
      connectorProvider: "mcp",
    });
  });

  test("a workspace grant still refuses an MCP run in another workspace", async () => {
    const { resolve } = mcpRuntime(mcpIds[18]!);

    expect(await resolve(mcpIds[18]!)).toMatchObject({ connectionId: mcpConnectionId });
    expect(await resolve(mcpIds[19]!)).toBeUndefined();
  });

  test("an MCP run without a workspace is refused under either grant", async () => {
    expect(await mcpRuntime(undefined).resolve(undefined)).toBeUndefined();
    expect(await mcpRuntime(mcpIds[18]!).resolve(undefined)).toBeUndefined();
  });
});
