import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import {
  DatabaseError,
  McpServerRecord,
  withCanonicalRecordKeys,
  WorkspaceConnectionAuthorizationRecord,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import type { RemoteMcpToolCall } from "@deployments-ai/mcp-client";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createDynamoRuntimeMcp } from "./dynamodb-runtime-mcp.ts";
import {
  allowedRequest,
  database,
  fixtures,
  remoteToolName,
  request,
  tenantMcpAdapter,
  timestamp,
} from "./runtime-mcp-binding.fixture.ts";

describe("DynamoDB runtime MCP binding", () => {
  test("overlays workspace resource constraints onto MCP arguments", async () => {
    const seeded = fixtures();
    const constrainedAuthorization = Schema.decodeUnknownSync(
      WorkspaceConnectionAuthorizationRecord,
    )(
      withCanonicalRecordKeys({
        ...seeded.authorization,
        data: {
          ...seeded.authorization.data,
          externalResourceConstraints: { dataflowId: "authorized-dataflow" },
          resourceScopeHash: "constrained-scope",
        },
      }),
    );
    let call: RemoteMcpToolCall | undefined;
    const runtime = createDynamoRuntimeMcp({
      client: {
        callTool: async (input) => {
          call = input;
          return { isError: false, result: { content: [{ text: "safe", type: "text" }] } };
        },
      },
      database: database([
        seeded.release,
        seeded.deployment,
        seeded.connection,
        constrainedAuthorization,
        seeded.server,
        seeded.policy,
      ]),
      readCredential: async () => ({
        createdAt: timestamp,
        generation: 3,
        schemaVersion: 1,
        updatedAt: timestamp,
        values: { apiToken: "secret-token" },
      }),
    });
    const definition = tenantMcpAdapter({
      additionalProperties: false,
      properties: {
        dataflowId: { type: "string" },
        other: { type: "string" },
      },
      required: ["dataflowId"],
      type: "object",
    });
    const constrainedRequest = {
      ...request(),
      input: { dataflowId: "caller-dataflow", other: "preserved" },
    };
    const authorization = await runtime.resolveMcpAuthorizationContext(
      constrainedRequest,
      definition,
    );

    await runtime.executeMcpTool(
      allowedRequest(constrainedRequest, authorization!.authorizationFingerprint),
      definition,
      remoteToolName,
    );

    expect(call?.arguments).toEqual({
      dataflowId: "authorized-dataflow",
      other: "preserved",
    });
  });

  test("rejects MCP arguments outside the adapter input schema", async () => {
    const seeded = fixtures();
    let calls = 0;
    const runtime = createDynamoRuntimeMcp({
      client: {
        callTool: async () => {
          calls += 1;
          return { isError: false, result: { content: [] } };
        },
      },
      database: database(Object.values(seeded)),
      readCredential: async () => ({
        createdAt: timestamp,
        generation: 3,
        schemaVersion: 1,
        updatedAt: timestamp,
        values: { apiToken: "secret-token" },
      }),
    });
    const definition = tenantMcpAdapter();
    const invalidRequest = { ...request(), input: { unexpected: true } };
    const authorization = await runtime.resolveMcpAuthorizationContext(invalidRequest, definition);

    expect(
      runtime.executeMcpTool(
        allowedRequest(invalidRequest, authorization!.authorizationFingerprint),
        definition,
        remoteToolName,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(calls).toBe(0);
  });

  test("invalidates authorization when the adapter remaps to another MCP operation", async () => {
    const seeded = fixtures();
    const expandedServer = Schema.decodeUnknownSync(McpServerRecord)(
      withCanonicalRecordKeys({
        ...seeded.server,
        data: {
          ...seeded.server.data,
          toolAllowlist: ["get-dataflow", remoteToolName],
        },
      }),
    );
    const runtime = createDynamoRuntimeMcp({
      client: { callTool: async () => Promise.reject(new Error("not used")) },
      database: database([
        seeded.release,
        seeded.deployment,
        seeded.connection,
        seeded.authorization,
        expandedServer,
        seeded.policy,
      ]),
      readCredential: async () => Promise.reject(new Error("not used")),
    });
    const definition = tenantMcpAdapter();
    const original = await runtime.resolveMcpAuthorizationContext(request(), definition);
    const remapped = await runtime.resolveMcpAuthorizationContext(request(), {
      ...definition,
      auditMetadata: { mcpToolName: "get-dataflow" },
    });

    expect(original?.authorizationFingerprint).toBeString();
    expect(remapped?.authorizationFingerprint).toBeString();
    expect(original?.authorizationFingerprint).not.toBe(remapped?.authorizationFingerprint);
  });

  test("keeps MCP database revalidation failures retryable", async () => {
    const seeded = fixtures();
    const definition = tenantMcpAdapter();
    const healthy = createDynamoRuntimeMcp({
      client: { callTool: async () => Promise.reject(new Error("not used")) },
      database: database(Object.values(seeded)),
      readCredential: async () => Promise.reject(new Error("not used")),
    });
    const authorization = await healthy.resolveMcpAuthorizationContext(request(), definition);
    const unavailableDatabase: DynamoDatabaseService = {
      deleteRecord: async () => {},
      getRecord: () =>
        Promise.reject(
          new DatabaseError({
            cause: new Error("unavailable"),
            message: "DynamoDB unavailable",
            operation: "get",
            table: "control",
          }),
        ),
      putRecord: async () => {},
      queryRecords: () => Promise.resolve({ items: [] }),
      transactWrite: async () => {},
    };
    const unavailable = createDynamoRuntimeMcp({
      client: { callTool: async () => Promise.reject(new Error("not used")) },
      database: unavailableDatabase,
      readCredential: async () => Promise.reject(new Error("not used")),
    });

    expect(
      unavailable.executeMcpTool(
        allowedRequest(request(), authorization!.authorizationFingerprint),
        definition,
        remoteToolName,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(
      unavailable.resolveMcpAuthorizationContext(request(), definition),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });
});
