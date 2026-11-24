import { describe, expect, test } from "bun:test";
import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import type { PlatformRecord } from "@deployments-ai/db";
import { RemoteMcpError, type RemoteMcpToolCall } from "@deployments-ai/mcp-client";
import type { OAuthRefreshRequest, OAuthRefreshResponse } from "@deployments-ai/providers";
import { createDynamoRuntimeVendorMcp } from "./dynamodb-runtime-vendor-mcp.ts";
import type { RuntimeCredentialReadInput } from "./runtime-provider-binding.ts";
import {
  authorizedRequest,
  bindingRecords,
  bindingRequest,
  connectionId,
  credentialId,
  memoryDatabase,
  NOW,
  providerConnection,
  secretDocument,
  TOOL_HASH,
  vendorAdapter,
  vendorRegistry,
} from "./vendor-mcp-runtime.fixture.ts";

const search = vendorAdapter({
  effect: "read",
  name: "notion.notion_search",
  remoteToolName: "notion-search",
});

function harness(options: {
  readonly callTool?: (input: RemoteMcpToolCall) => Promise<unknown>;
  readonly definition?: typeof search;
  readonly grantProviderKey?: string;
  readonly omitExternalAccountId?: boolean;
  readonly providerKey?: string;
  readonly refresh?: (request: OAuthRefreshRequest) => Promise<OAuthRefreshResponse>;
  readonly refreshAfter?: string;
  readonly secretValues?: Readonly<Record<string, string>>;
}) {
  const definition = options.definition ?? search;
  const seeded = bindingRecords({
    ...(options.grantProviderKey ? { grantProviderKey: options.grantProviderKey } : {}),
    providerKey: options.providerKey ?? "notion",
    ...(options.refreshAfter ? { refreshAfter: options.refreshAfter } : {}),
    ...(options.providerKey?.endsWith("_vendor") ? { authMethod: "api_key" } : {}),
    ...(options.omitExternalAccountId ? { omitExternalAccountId: true } : {}),
    toolNames: [definition.toolName],
  });
  const { database, put } = memoryDatabase(Object.values(seeded));
  const calls: RemoteMcpToolCall[] = [];
  const reads: RuntimeCredentialReadInput[] = [];
  const runtime = createDynamoRuntimeVendorMcp({
    client: {
      callTool: async (input) => {
        calls.push(input);
        if (options.callTool) return (await options.callTool(input)) as never;
        input.onToolCallDispatch?.();
        return {
          isError: false,
          result: { content: [{ text: "Found 2 pages", type: "text" }] },
          serverName: "Notion MCP",
        };
      },
    },
    database,
    now: () => NOW,
    providerRegistry: vendorRegistry,
    readCredential: async (input) => {
      reads.push(input);
      return secretDocument(
        options.secretValues ?? { accessToken: "notion-access-token", refreshToken: "refresh" },
        input.reference.generation,
      );
    },
    ...(options.refresh ? { refreshConnection: options.refresh } : {}),
  });
  const execute = async () => {
    const request = bindingRequest(definition);
    const context = await runtime.resolveVendorMcpAuthorizationContext(request, definition);
    if (!context) throw new Error("vendor MCP authorization was denied");
    if (definition.execution?.type !== "vendor_mcp") throw new Error("not a vendor tool");
    return runtime.executeVendorMcpTool(
      authorizedRequest(request, {
        authorizationFingerprint: context.authorizationFingerprint,
        connectionId: context.connectionId,
        externalAccountId: context.externalAccountId,
        toolPlanFingerprint: "plan",
      }),
      definition,
      definition.execution,
    );
  };
  return { calls, definition, execute, put, reads, runtime, seeded };
}

describe("vendor MCP runtime", () => {
  test("executes a read with the bearer token, pinned tool hash, and grant constraints", async () => {
    const { calls, execute, reads, runtime, definition } = harness({});
    const context = await runtime.resolveVendorMcpAuthorizationContext(
      bindingRequest(definition),
      definition,
    );
    expect(context).toMatchObject({
      connectionId,
      connectorProvider: "notion",
      externalAccountId: "account-1",
      externalResourceConstraints: { workspace: "acme" },
      grantedScopes: ["tools:read", "tools:write"],
    });

    const result = await execute();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      arguments: { query: "roadmap", workspace: "acme" },
      endpointOrigin: "https://mcp.notion.example",
      endpointPath: "/mcp",
      expectedToolHash: TOOL_HASH,
      headers: { authorization: "Bearer notion-access-token" },
      toolAllowlist: ["notion-search"],
      toolName: "notion-search",
    });
    expect(reads).toEqual([
      expect.objectContaining({
        connectionId,
        purpose: "provider-oauth-token",
        reference: { credentialId, generation: 3, store: "dynamodb-kms" },
      }),
    ]);
    expect(result).toMatchObject({ outputSummary: "Found 2 pages", status: "completed" });
  });

  test("fails closed on tool drift before tools/call", async () => {
    const { execute } = harness({
      callTool: async () => {
        throw new RemoteMcpError("tool-drift", "changed");
      },
    });
    const failure = await execute().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(String((failure as Error).cause)).toContain(
      "MCP tool notion-search changed since it was synced; re-run tool sync.",
    );
  });

  test("reports a rejected credential as a re-authorization failure", async () => {
    const { execute } = harness({
      callTool: async () => {
        throw new RemoteMcpError("http", "HTTP 401", { statusCode: 401 });
      },
    });
    const failure = await execute().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(String((failure as Error).cause)).toContain(
      "vendor MCP credential rejected; re-authorize the connection",
    );
  });

  test("refreshes an expiring OAuth token and reads the new credential generation", async () => {
    const refreshes: OAuthRefreshRequest[] = [];
    const state: { put?: (record: PlatformRecord) => void } = {};
    const { calls, execute, put, reads } = harness({
      refresh: async (request) => {
        refreshes.push(request);
        state.put!(
          providerConnection({
            authMethod: "oauth",
            generation: 4,
            providerKey: "notion",
            refreshAfter: "2026-10-01T13:00:00.000Z",
            scopes: ["tools:read", "tools:write"],
            version: 5,
          }),
        );
        return {
          reference: { credentialId, generation: 4, store: "dynamodb-kms" },
          status: "refreshed",
        };
      },
      refreshAfter: "2026-10-01T12:01:00.000Z",
    });
    state.put = put;

    await execute();

    expect(refreshes).toEqual([
      expect.objectContaining({ connectionId, expectedGeneration: 3, requestedBy: "worker" }),
    ]);
    expect(reads.map((read) => read.reference.generation)).toEqual([4]);
    expect(calls).toHaveLength(1);
  });

  test("surfaces terminal and transient refresh outcomes without reading the credential", async () => {
    for (const [response, expected] of [
      [
        { code: "invalid_grant", message: "revoked", status: "reauthorization_required" },
        RuntimeToolExecutionKnownFailureError,
      ],
      [
        { code: "busy", message: "claim held", status: "retryable" },
        RuntimeToolPreparationRetryableError,
      ],
    ] as const) {
      const { calls, execute, reads } = harness({
        refresh: async () => response,
        refreshAfter: "2026-10-01T12:00:30.000Z",
      });
      expect(execute()).rejects.toBeInstanceOf(expected);
      expect(reads).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("fails a refresh-needed connection when refresh is not configured", async () => {
    const { execute } = harness({ refreshAfter: "2026-10-01T12:00:30.000Z" });
    const failure = await execute().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(String((failure as Error).cause)).toContain("OAuth refresh is not configured");
  });

  test("sends an api_key credential in the pinned header to the canonical endpoint", async () => {
    const { calls, execute, reads } = harness({
      definition: vendorAdapter({
        effect: "read",
        name: "keyed_vendor.lookup",
        providerKey: "keyed_vendor",
        remoteToolName: "lookup",
      }),
      providerKey: "keyed_vendor",
      secretValues: { apiKey: "keyed-secret" },
    });
    await execute();
    expect(reads[0]?.purpose).toBe("provider-api");
    expect(calls[0]).toMatchObject({
      endpointOrigin: "https://mcp.keyed.example",
      endpointPath: "/v2/mcp",
      headers: { "x-api-key": "keyed-secret" },
    });
  });

  test("completes vendor results that mention the Bearer scheme without the token", async () => {
    const { execute } = harness({
      callTool: async (input) => {
        input.onToolCallDispatch?.();
        return {
          isError: false,
          result: {
            content: [{ text: "Send Authorization: Bearer <your token>", type: "text" }],
          },
        };
      },
      secretValues: {
        accessToken: "notion-access-token",
        refreshToken: "refresh",
        tokenType: "Bearer",
      },
    });
    expect(execute()).resolves.toMatchObject({ status: "completed" });
  });

  test("binds an api_key connection without an external account id to its connection id", async () => {
    const { calls, execute } = harness({
      definition: vendorAdapter({
        effect: "read",
        name: "keyed_vendor.lookup",
        providerKey: "keyed_vendor",
        remoteToolName: "lookup",
      }),
      omitExternalAccountId: true,
      providerKey: "keyed_vendor",
      secretValues: { apiKey: "keyed-secret" },
    });
    expect(execute()).resolves.toMatchObject({ status: "completed" });
    expect(calls[0]?.headers).toEqual({ "x-api-key": "keyed-secret" });
  });

  test("fails a templated connection without a persisted MCP resource as a known failure", async () => {
    const { calls, execute } = harness({
      definition: vendorAdapter({
        effect: "read",
        name: "tenant_vendor.lookup",
        providerKey: "tenant_vendor",
        remoteToolName: "lookup",
      }),
      providerKey: "tenant_vendor",
      secretValues: { apiKey: "tenant-secret" },
    });
    const failure = await execute().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(String((failure as Error).cause)).toContain(
      "Vendor MCP connection has no valid MCP endpoint",
    );
    expect(calls).toHaveLength(0);
  });

  test("denies grants whose provider differs from the adapter's vendor provider", async () => {
    for (const options of [{ grantProviderKey: "keyed_vendor" }, { providerKey: "keyed_vendor" }]) {
      const { runtime, definition } = harness(options);
      expect(
        runtime.resolveVendorMcpAuthorizationContext(bindingRequest(definition), definition),
      ).resolves.toBeUndefined();
    }
  });
});
