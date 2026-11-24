import { describe, expect, test } from "bun:test";
import { RuntimeToolExecutionKnownFailureError } from "@deployments-ai/agent-runtime";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import { credentialValuesWithProviderOAuthMaterial } from "@deployments-ai/credential-vault";
import type { RuntimeToolBindingRequest } from "./runtime-tools.ts";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  CredentialVaultEntryRecord,
  DatabaseError,
  ProviderConnectionRecord,
  ToolAdapterRecord,
  ToolPolicyRecord,
  WorkspaceConnectionAuthorizationRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  findPlatformToolAdapterDefinition,
  toolAdapterDefinitionFromRecord,
} from "@deployments-ai/tools";
import { Schema } from "effect";
import { createDynamoRuntimeToolResolvers } from "./dynamodb-runtime-tools.ts";

const ids = Array.from(
  { length: 20 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];
const organizationId = ids[0]!;
const projectId = ids[1]!;
const environmentId = ids[2]!;
const workspaceId = ids[3]!;
const releaseId = ids[4]!;
const deploymentId = ids[12]!;
const authorizationId = ids[5]!;
const connectionId = ids[6]!;
const unrelatedConnectionId = ids[7]!;
const policyId = ids[8]!;
const credentialId = ids[9]!;
const toolName = "shopify.products.search";
const timestamp = "2026-07-23T12:00:00.000Z";

function fixtures() {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "runtime.tool-resolver",
      name: "Runtime Tool Resolver",
      version: "1.0.0",
    },
    spec: {
      capabilities: {
        tools: [
          {
            authorization: "workspace",
            name: toolName,
            required: true,
            requiredScopes: ["read_products"],
          },
        ],
      },
      instructions: "Use the configured repository tools.",
      model: { id: "openrouter/test" },
      sandbox: { mode: "none" },
    },
  });
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids[10]!,
        contentHash: agentManifestContentHash(manifest),
        createdAt: timestamp,
        createdByPrincipalId: ids[11]!,
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
        agentDefinitionId: ids[10]!,
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
  const connection = (id: Ulid, externalAccountId?: string, mappedScopes = true) =>
    Schema.decodeUnknownSync(ProviderConnectionRecord)(
      withCanonicalRecordKeys({
        data: {
          authMethod: "oauth2",
          ...(mappedScopes ? { authorizationScopes: ["oauth-read-products"] } : {}),
          createdAt: timestamp,
          credentialRef: { credentialId, generation: 3, store: "dynamodb-kms" as const },
          environmentId,
          ...(externalAccountId ? { externalAccountId } : {}),
          id,
          oauthResource: "https://api.example.test",
          organizationId,
          projectId,
          providerKey: "shopify",
          scopes: ["read_products"],
          status: "active" as const,
          updatedAt: timestamp,
          version: 2,
        },
        itemType: "provider-connection" as const,
      }),
    );
  const authorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
    withCanonicalRecordKeys({
      data: {
        authorizationVersion: 4,
        connectionId,
        createdAt: timestamp,
        environmentId,
        externalAccountId: "shopify-account-1",
        externalResourceConstraints: { shop: "deployments-ai" },
        id: authorizationId,
        organizationId,
        projectId,
        providerKey: "shopify",
        purpose: "agent-runtime",
        resourceScopeHash: "scope-hash",
        scopes: ["read_products"],
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
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
        name: "Read-only GitHub",
        organizationId,
        projectId,
        rules: [{ action: "allow", toolName }],
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "tool-policy" as const,
    }),
  );
  return {
    authorization,
    connection: connection(connectionId, "shopify-account-1"),
    deployment,
    legacyConnection: connection(connectionId, undefined, false),
    policy,
    release,
    unrelated: connection(unrelatedConnectionId, "wrong-account"),
  };
}

function database(seed: readonly PlatformRecord[]): DynamoDatabaseService {
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

function request(): RuntimeToolBindingRequest {
  return {
    agentDefinitionId: ids[10]!,
    agentDeploymentId: deploymentId,
    agentReleaseId: releaseId,
    effect: "read",
    environmentId,
    idempotencyKey: "tool-call-1",
    inputSummary: "Read repository",
    organizationId,
    projectId,
    requiredScopes: ["read_products"],
    runId: ids[13]!,
    threadId: ids[14]!,
    toolName,
    workspaceId,
  };
}

describe("DynamoDB runtime tool resolvers", () => {
  test("returns exact callback control-plane records for transactional fencing", async () => {
    const seeded = fixtures();
    const adapterId = ids[15]!;
    const adapterCredentialId = ids[16]!;
    const adapter = Schema.decodeUnknownSync(ToolAdapterRecord)(
      withCanonicalRecordKeys({
        data: {
          authSecretRef: {
            credentialId: adapterCredentialId,
            generation: 5,
            store: "dynamodb-kms" as const,
          },
          createdAt: timestamp,
          effect: "read" as const,
          environmentId,
          execution: {
            completionMode: "sync",
            endpointOrigin: "https://callbacks.example.com",
            endpointPath: "/v1/tools/read",
            type: "http_callback",
          },
          id: adapterId,
          name: toolName,
          organizationId,
          projectId,
          providerKey: "shopify",
          requiredScopes: ["read_products"],
          status: "active" as const,
          updatedAt: timestamp,
          version: 4,
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
          environmentId,
          generation: 5,
          id: adapterCredentialId,
          iv: "initialization-vector",
          kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/callback",
          organizationId,
          ownerId: adapterId,
          ownerType: "tool-adapter" as const,
          projectId,
          purpose: "tool-adapter-auth",
          status: "active" as const,
          updatedAt: timestamp,
          version: 2,
        },
        itemType: "credential-vault-entry" as const,
      }),
    );
    const baseDefinition = toolAdapterDefinitionFromRecord(adapter);
    const definition = {
      ...baseDefinition,
      execution: {
        ...baseDefinition.execution,
        authorizationHeader: "Bearer callback-secret",
        credentialGeneration: 5,
      },
    } as typeof baseDefinition;
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database([
        seeded.release,
        seeded.deployment,
        seeded.authorization,
        seeded.connection,
        seeded.policy,
        adapter,
        toolCredential,
      ]),
      readCredential: async () => {
        throw new Error("authorization context must not read provider credentials");
      },
    });

    const context = await resolvers.resolveAuthorizationContext(request(), definition);

    expect(context?.callbackControlSnapshot).toEqual({
      connection: seeded.connection,
      executionTarget: seeded.deployment,
      providerUsesNoCredential: false,
      toolAdapter: adapter,
      toolCredential,
      toolPolicy: seeded.policy,
      workspaceAuthorization: seeded.authorization,
    });
  });

  test("selects only the release-pinned authorization and returns its credential", async () => {
    const seeded = fixtures();
    let credentialRead: unknown;
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database([
        seeded.release,
        seeded.deployment,
        seeded.authorization,
        seeded.connection,
        seeded.policy,
        seeded.unrelated,
      ]),
      readCredential: async (input) => {
        credentialRead = input;
        return {
          createdAt: timestamp,
          generation: 3,
          schemaVersion: 1,
          scopes: ["oauth-read-products"],
          updatedAt: timestamp,
          values: credentialValuesWithProviderOAuthMaterial(
            { token: "secret-token" },
            {
              requestHeaders: { "developer-token": "developer-secret" },
              resource: "https://api.example.test",
            },
          ),
        };
      },
    });
    const definition = findPlatformToolAdapterDefinition(toolName)!;
    const authorization = await resolvers.resolveAuthorizationContext(request(), definition);
    expect(authorization).toMatchObject({
      connectionId,
      connectorProvider: "shopify",
      externalAccountId: "shopify-account-1",
    });

    const credential = await resolvers.resolveProviderCredential(
      {
        ...request(),
        decision: {
          action: "allow",
          executionBinding: {
            authorizationFingerprint: authorization!.authorizationFingerprint,
            connectionId,
            externalAccountId: "shopify-account-1",
            toolPlanFingerprint: "test-tool-plan",
          },
          reason: "allowed",
          toolCallId: ids[15]!,
        },
      },
      definition as never,
    );

    expect(credential.connectionId).toBe(connectionId);
    expect(credential.grantedScopes).toEqual(["read_products"]);
    expect(credential.externalAccountId).not.toBe("wrong-account");
    expect(credential.fields).toEqual({ token: "secret-token" });
    expect(credential.requestHeaders).toEqual({ "developer-token": "developer-secret" });
    expect(credential.resourceDefaults).toEqual({ oauthResource: "https://api.example.test" });
    expect(credential.resourceBindings).toEqual({ shop: "deployments-ai" });
    expect(credentialRead).toMatchObject({
      connectionId,
      environmentId,
      organizationId,
      projectId,
      purpose: "provider-oauth-token",
      reference: { credentialId, generation: 3, store: "dynamodb-kms" },
    });
  });

  test("uses authorization identity for a legacy OAuth connection", async () => {
    const seeded = fixtures();
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database([
        seeded.release,
        seeded.deployment,
        seeded.authorization,
        seeded.legacyConnection,
        seeded.policy,
      ]),
      readCredential: async () => ({
        createdAt: timestamp,
        generation: 3,
        schemaVersion: 1,
        scopes: ["read_products"],
        updatedAt: timestamp,
        values: credentialValuesWithProviderOAuthMaterial(
          { token: "secret-token" },
          { resource: "https://api.example.test" },
        ),
      }),
    });
    const definition = findPlatformToolAdapterDefinition(toolName)!;
    const authorization = await resolvers.resolveAuthorizationContext(request(), definition);

    expect(authorization).toMatchObject({
      connectionId,
      externalAccountId: "shopify-account-1",
    });
    expect(
      resolvers.resolveProviderCredential(
        {
          ...request(),
          decision: {
            action: "allow",
            executionBinding: {
              authorizationFingerprint: authorization!.authorizationFingerprint,
              connectionId,
              externalAccountId: "shopify-account-1",
              toolPlanFingerprint: "test-tool-plan",
            },
            reason: "allowed",
            toolCallId: ids[15]!,
          },
        },
        definition as never,
      ),
    ).resolves.toMatchObject({ externalAccountId: "shopify-account-1" });
  });

  test("fails closed for legacy provider grants without explicit persisted scopes", async () => {
    const seeded = fixtures();
    const { scopes: _scopes, ...legacyGrantData } = seeded.authorization.data;
    const legacyGrant = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
      withCanonicalRecordKeys({
        ...seeded.authorization,
        data: legacyGrantData,
      }),
    );
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database([
        seeded.release,
        seeded.deployment,
        legacyGrant,
        seeded.connection,
        seeded.policy,
      ]),
      readCredential: async () => {
        throw new Error("scope-less authorization must not load credentials");
      },
    });

    expect(
      resolvers.resolveAuthorizationContext(
        request(),
        findPlatformToolAdapterDefinition(toolName)!,
      ),
    ).resolves.toMatchObject({ grantedScopes: [] });
  });

  test("rejects grants containing scopes no longer verified on the connection", async () => {
    const seeded = fixtures();
    const staleAuthorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
      withCanonicalRecordKeys({
        ...seeded.authorization,
        data: {
          ...seeded.authorization.data,
          scopes: ["read_products", "write_fulfillments"],
        },
      }),
    );
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database([
        seeded.release,
        seeded.deployment,
        staleAuthorization,
        seeded.connection,
        seeded.policy,
      ]),
      readCredential: async () => {
        throw new Error("stale authorization must not load credentials");
      },
    });

    expect(
      resolvers.resolveAuthorizationContext(
        request(),
        findPlatformToolAdapterDefinition(toolName)!,
      ),
    ).resolves.toBeUndefined();
  });

  test("classifies changed pinned authorization bindings as permanent failures", async () => {
    const seeded = fixtures();
    let credentialReads = 0;
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database(Object.values(seeded)),
      readCredential: async () => {
        credentialReads += 1;
        throw new Error("must not read a changed binding");
      },
    });

    expect(
      resolvers.resolveProviderCredential(
        {
          ...request(),
          decision: {
            action: "allow",
            executionBinding: {
              authorizationFingerprint: "stale-fingerprint",
              connectionId,
              externalAccountId: "shopify-account-1",
              toolPlanFingerprint: "test-tool-plan",
            },
            reason: "allowed",
            toolCallId: ids[15]!,
          },
        },
        findPlatformToolAdapterDefinition(toolName)! as never,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(credentialReads).toBe(0);
  });

  test("rejects workspace authorizations that are not intended for agent runtime", async () => {
    const seeded = fixtures();
    const authorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
      withCanonicalRecordKeys({
        ...seeded.authorization,
        data: { ...seeded.authorization.data, purpose: "deployment" },
      }),
    );
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database([
        seeded.release,
        seeded.deployment,
        authorization,
        seeded.connection,
        seeded.unrelated,
      ]),
      readCredential: async () => {
        throw new Error("must not read credentials");
      },
    });

    expect(
      await resolvers.resolveAuthorizationContext(
        request(),
        findPlatformToolAdapterDefinition(toolName)!,
      ),
    ).toBeUndefined();
  });

  test("fails closed when the deployment does not explicitly select an authorization", async () => {
    const seeded = fixtures();
    const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        ...seeded.deployment,
        data: {
          ...seeded.deployment.data,
          runtimeConfig: {
            apiVersion: "agents.deployments.ai/v1",
            kind: "AgentDeploymentConfig",
          },
          version: 0,
        },
      }),
    );
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database([
        seeded.release,
        deployment,
        seeded.authorization,
        seeded.connection,
        seeded.unrelated,
      ]),
      readCredential: async () => {
        throw new Error("must not read credentials");
      },
    });

    expect(
      await resolvers.resolveAuthorizationContext(
        request(),
        findPlatformToolAdapterDefinition(toolName)!,
      ),
    ).toBeUndefined();
  });

  test("fails closed when the deployment does not pin the run definition", async () => {
    const seeded = fixtures();
    const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        ...seeded.deployment,
        data: {
          ...seeded.deployment.data,
          agentDefinitionId: ids[13]!,
        },
      }),
    );
    const resolvers = createDynamoRuntimeToolResolvers({
      database: database([
        seeded.release,
        deployment,
        seeded.authorization,
        seeded.connection,
        seeded.unrelated,
      ]),
      readCredential: async () => {
        throw new Error("must not read credentials");
      },
    });

    expect(
      await resolvers.resolveAuthorizationContext(
        request(),
        findPlatformToolAdapterDefinition(toolName)!,
      ),
    ).toBeUndefined();
  });

  test("propagates DynamoDB failures so authorization can be retried", async () => {
    const resolvers = createDynamoRuntimeToolResolvers({
      database: {
        ...database([]),
        getRecord: () =>
          Promise.reject(
            new DatabaseError({
              cause: new Error("unavailable"),
              message: "unavailable",
              operation: "get",
              table: "control",
            }),
          ),
      },
      readCredential: async () => {
        throw new Error("must not read credentials");
      },
    });

    expect(
      resolvers.resolveAuthorizationContext(
        request(),
        findPlatformToolAdapterDefinition(toolName)!,
      ),
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
