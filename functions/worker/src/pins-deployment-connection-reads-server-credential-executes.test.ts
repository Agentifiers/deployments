import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import {
  CredentialVaultError,
  type CredentialVaultSecretDocument,
} from "@deployments-ai/credential-vault";
import {
  AgentDeploymentRecord,
  McpServerRecord,
  withCanonicalRecordKeys,
  WorkspaceConnectionAuthorizationRecord,
} from "@deployments-ai/db";
import type { RemoteMcpClient, RemoteMcpToolCall } from "@deployments-ai/mcp-client";
import { RemoteMcpError } from "@deployments-ai/mcp-client";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createDynamoRuntimeMcp } from "./dynamodb-runtime-mcp.ts";
import {
  allowedRequest,
  credentialId,
  database,
  environmentId,
  fixtures,
  ids,
  mcpConnectionId,
  mcpServerId,
  organizationId,
  projectId,
  remoteToolName,
  request,
  tenantMcpAdapter,
  timestamp,
  toolName,
} from "./runtime-mcp-binding.fixture.ts";

const secret = (apiToken: string): CredentialVaultSecretDocument => ({
  createdAt: timestamp,
  generation: 3,
  schemaVersion: 1,
  updatedAt: timestamp,
  values: { apiToken },
});

describe("DynamoDB runtime MCP binding", () => {
  test("pins the deployment connection, reads the server credential, and executes the allowed tool", async () => {
    const seeded = fixtures();
    const remoteServerName = "界".repeat(256);
    const persistedServerName = "界".repeat(85);
    let call: RemoteMcpToolCall | undefined;
    let credentialRead: unknown;
    const runtime = createDynamoRuntimeMcp({
      client: {
        callTool: async (input) => {
          call = input;
          return {
            isError: false,
            protocolVersion: "2025-11-25",
            result: { content: [{ text: "Two dataflows", type: "text" }] },
            serverName: remoteServerName,
            serverVersion: "1.0.0",
          };
        },
      } satisfies RemoteMcpClient,
      database: database(Object.values(seeded)),
      readCredential: async (input) => {
        credentialRead = input;
        return secret("secret-token");
      },
    });
    const definition = tenantMcpAdapter();
    expect(definition).toMatchObject({
      execution: { mcpServerId, remoteToolName, type: "mcp" },
      status: "active",
      toolName,
    });
    const authorization = await runtime.resolveMcpAuthorizationContext(request(), definition);
    expect(authorization).toMatchObject({
      connectionId: mcpConnectionId,
      connectorProvider: "mcp",
      externalAccountId: mcpServerId,
      grantedScopes: [toolName],
    });

    const result = await runtime.executeMcpTool(
      allowedRequest(request(), authorization!.authorizationFingerprint),
      definition,
      remoteToolName,
    );

    expect(call).toMatchObject({
      endpointOrigin: "https://mcp.example.com",
      endpointPath: "/analytics/mcp",
      headers: { authorization: "Bearer secret-token" },
      toolAllowlist: [remoteToolName],
      toolName: remoteToolName,
    });
    expect(credentialRead).toMatchObject({
      environmentId,
      organizationId,
      projectId,
      reference: { credentialId, generation: 3, store: "dynamodb-kms" },
      serverId: mcpServerId,
    });
    expect(result).toMatchObject({
      outputSummary: "Two dataflows",
      status: "completed",
    });
    expect(result.artifacts?.[0]).toMatchObject({
      contentType: "application/json",
      metadata: {
        mcpToolName: remoteToolName,
        serverName: persistedServerName,
        source: "mcp.remote",
      },
    });
    expect(new TextEncoder().encode(result.artifacts?.[0]?.label).byteLength).toBeLessThanOrEqual(
      512,
    );
  });

  test("fails closed for legacy MCP grants without explicit persisted scopes", async () => {
    const seeded = fixtures();
    const { scopes: _legacyScopes, ...legacyAuthorizationData } = seeded.authorization.data;
    const legacyAuthorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
      withCanonicalRecordKeys({
        data: legacyAuthorizationData,
        itemType: "workspace-connection-authorization" as const,
      }),
    );
    const runtime = createDynamoRuntimeMcp({
      client: {
        callTool: async () => {
          throw new Error("not reached");
        },
      },
      database: database(Object.values({ ...seeded, authorization: legacyAuthorization })),
      readCredential: async () => {
        throw new Error("not reached");
      },
    });

    expect(
      runtime.resolveMcpAuthorizationContext(request(), tenantMcpAdapter()),
    ).resolves.toMatchObject({ grantedScopes: [] });
  });

  test("does not authorize a tool omitted from the server allowlist", async () => {
    const seeded = fixtures();
    const restrictedServer = Schema.decodeUnknownSync(McpServerRecord)(
      withCanonicalRecordKeys({
        ...seeded.server,
        data: { ...seeded.server.data, toolAllowlist: ["different-tool"] },
      }),
    );
    const runtime = createDynamoRuntimeMcp({
      client: { callTool: async () => Promise.reject(new Error("not used")) },
      database: database([
        seeded.release,
        seeded.deployment,
        seeded.connection,
        seeded.authorization,
        restrictedServer,
        seeded.policy,
      ]),
      readCredential: async () => Promise.reject(new Error("not used")),
    });

    expect(
      runtime.resolveMcpAuthorizationContext(request(), tenantMcpAdapter()),
    ).resolves.toBeUndefined();
  });

  test("does not authorize a persisted MCP tool pinned to another server", async () => {
    const seeded = fixtures();
    const runtime = createDynamoRuntimeMcp({
      client: { callTool: async () => Promise.reject(new Error("not used")) },
      database: database(Object.values(seeded)),
      readCredential: async () => Promise.reject(new Error("not used")),
    });
    const definition = tenantMcpAdapter();

    expect(
      runtime.resolveMcpAuthorizationContext(request(), {
        ...definition,
        execution: { mcpServerId: ids[16]!, remoteToolName, type: "mcp" },
      }),
    ).resolves.toBeUndefined();
  });

  test("does not authorize an MCP connection granted to a different workspace", async () => {
    const seeded = fixtures();
    const otherWorkspaceAuthorization = Schema.decodeUnknownSync(
      WorkspaceConnectionAuthorizationRecord,
    )(
      withCanonicalRecordKeys({
        ...seeded.authorization,
        data: { ...seeded.authorization.data, workspaceId: ids[16]! },
      }),
    );
    const runtime = createDynamoRuntimeMcp({
      client: { callTool: async () => Promise.reject(new Error("not used")) },
      database: database([
        seeded.release,
        seeded.deployment,
        seeded.connection,
        otherWorkspaceAuthorization,
        seeded.server,
        seeded.policy,
      ]),
      readCredential: async () => Promise.reject(new Error("not used")),
    });

    expect(
      runtime.resolveMcpAuthorizationContext(request(), tenantMcpAdapter()),
    ).resolves.toBeUndefined();
  });

  test("does not authorize a deployment that does not pin the run definition", async () => {
    const seeded = fixtures();
    const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        ...seeded.deployment,
        data: {
          ...seeded.deployment.data,
          agentDefinitionId: ids[17]!,
        },
      }),
    );
    const runtime = createDynamoRuntimeMcp({
      client: { callTool: async () => Promise.reject(new Error("not used")) },
      database: database([
        seeded.release,
        deployment,
        seeded.connection,
        seeded.authorization,
        seeded.server,
        seeded.policy,
      ]),
      readCredential: async () => Promise.reject(new Error("not used")),
    });

    expect(
      runtime.resolveMcpAuthorizationContext(request(), tenantMcpAdapter()),
    ).resolves.toBeUndefined();
  });

  test("treats revoked MCP credentials as permanent failures", async () => {
    const seeded = fixtures();
    const runtime = createDynamoRuntimeMcp({
      client: { callTool: async () => Promise.reject(new Error("not used")) },
      database: database(Object.values(seeded)),
      readCredential: async () => {
        throw new CredentialVaultError("revoked", "Credential was revoked.");
      },
    });
    const definition = tenantMcpAdapter();
    const authorization = await runtime.resolveMcpAuthorizationContext(request(), definition);

    expect(
      runtime.executeMcpTool(
        allowedRequest(request(), authorization!.authorizationFingerprint),
        definition,
        remoteToolName,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
  });

  test("retries transient MCP HTTP failures but not client errors", async () => {
    const seeded = fixtures();
    const definition = tenantMcpAdapter();
    const execute = async (statusCode: number) => {
      const runtime = createDynamoRuntimeMcp({
        client: {
          callTool: async () => {
            throw new RemoteMcpError("http", `HTTP ${statusCode}`, { statusCode });
          },
        },
        database: database(Object.values(seeded)),
        readCredential: async () => secret("secret-token"),
      });
      const authorization = await runtime.resolveMcpAuthorizationContext(request(), definition);
      return runtime.executeMcpTool(
        allowedRequest(request(), authorization!.authorizationFingerprint),
        definition,
        remoteToolName,
      );
    };

    expect(execute(401)).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(execute(503)).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });

  test("rejects MCP results that echo credential material", async () => {
    const seeded = fixtures();
    const definition = tenantMcpAdapter();
    const runtime = createDynamoRuntimeMcp({
      client: {
        callTool: async () => ({
          isError: true,
          result: { content: [{ text: "Bearer secret-token", type: "text" }] },
        }),
      },
      database: database(Object.values(seeded)),
      readCredential: async () => secret("secret-token"),
    });
    const authorization = await runtime.resolveMcpAuthorizationContext(request(), definition);

    expect(
      runtime.executeMcpTool(
        allowedRequest(request(), authorization!.authorizationFingerprint),
        definition,
        remoteToolName,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
  });

  test("rejects MCP server metadata that echoes credential material", async () => {
    const seeded = fixtures();
    const definition = tenantMcpAdapter();
    const credential = `secret-${"x".repeat(300)}`;
    const runtime = createDynamoRuntimeMcp({
      client: {
        callTool: async () => ({
          isError: false,
          result: { content: [{ text: "safe result", type: "text" }] },
          serverName: credential,
        }),
      },
      database: database(Object.values(seeded)),
      readCredential: async () => secret(credential),
    });
    const authorization = await runtime.resolveMcpAuthorizationContext(request(), definition);

    expect(
      runtime.executeMcpTool(
        allowedRequest(request(), authorization!.authorizationFingerprint),
        definition,
        remoteToolName,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
  });
});
