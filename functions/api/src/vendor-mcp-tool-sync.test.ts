import { SyncConnectionToolsResponse } from "@deployments-ai/api-contract";
import { mcpToolDefinitionHash, RemoteMcpError } from "@deployments-ai/mcp-client";
import type { RemoteMcpAdvertisedTool } from "@deployments-ai/mcp-client";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ACCESS_TOKEN,
  CONNECTION_ID,
  CREDENTIAL_ID,
  NOW,
  REFRESHED_ACCESS_TOKEN,
  connectionRecord,
  toolSyncFixture,
  vendorAdapterRecord,
} from "./vendor-mcp-tool-sync.fixture.ts";

const objectSchema = { properties: { query: { type: "string" } }, type: "object" };

function tool(name: string, overrides: Partial<RemoteMcpAdvertisedTool> = {}) {
  return { description: `${name} description`, inputSchema: objectSchema, name, ...overrides };
}

function hash(advertised: RemoteMcpAdvertisedTool) {
  return mcpToolDefinitionHash(advertised);
}

async function sync(fixture: ReturnType<typeof toolSyncFixture>) {
  return Schema.decodeUnknownSync(SyncConnectionToolsResponse)(
    await fixture.invoke("syncConnectionTools"),
  );
}

describe("vendor MCP tool sync", () => {
  test("creates classified adapters with code-owned effects and pinned hashes", async () => {
    const tools = [
      tool("docs-update"),
      tool("docs-search", { annotations: { readOnlyHint: false } }),
      tool("docs-delete"),
      { annotations: { readOnlyHint: true }, inputSchema: objectSchema, name: "fancyThing" },
    ];
    const fixture = toolSyncFixture({
      discover: async () => ({ protocolVersion: "2026-07-28", serverName: "docs", tools }),
    });
    fixture.seedConnection();

    const response = await sync(fixture);

    expect(fixture.discoveries).toEqual([
      {
        endpointOrigin: "https://mcp.docs.example",
        endpointPath: "/mcp",
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
        timeoutMs: 25_000,
      },
    ]);
    expect(response).toMatchObject({
      connectionId: CONNECTION_ID,
      providerKey: "docs",
      syncedAt: NOW.toISOString(),
    });
    expect(response.tools).toEqual([
      {
        change: "created",
        classified: true,
        destructive: true,
        effect: "write",
        remoteName: "docs-delete",
        toolName: "docs.docs_delete",
      },
      {
        change: "created",
        classified: true,
        destructive: false,
        effect: "read",
        remoteName: "docs-search",
        toolName: "docs.docs_search",
      },
      {
        change: "created",
        classified: true,
        destructive: false,
        effect: "write",
        remoteName: "docs-update",
        toolName: "docs.docs_update",
      },
      {
        change: "created",
        classified: false,
        destructive: false,
        effect: "write",
        remoteName: "fancyThing",
        toolName: "docs.fancy_thing",
      },
    ]);
    const adapters = new Map(
      fixture.recordsOf("tool-adapter").map((adapter) => [adapter.data.name, adapter.data]),
    );
    expect(adapters.get("docs.docs_search")).toMatchObject({
      defaultPolicyAction: "allow",
      description: "docs-search description",
      effect: "read",
      execution: {
        providerKey: "docs",
        remoteToolName: "docs-search",
        toolHash: hash(tools[1]!),
        type: "vendor_mcp",
      },
      inputSchema: objectSchema,
      providerKey: "docs",
      requiredScopes: ["tools:read"],
      status: "active",
      version: 0,
    });
    expect(adapters.get("docs.fancy_thing")).toMatchObject({
      defaultPolicyAction: "require_approval",
      description: "Docs MCP tool fancyThing",
      effect: "write",
      requiredScopes: ["tools:write"],
    });
    expect(adapters.get("docs.docs_delete")).toMatchObject({
      defaultPolicyAction: "require_approval",
      effect: "write",
      requiredScopes: ["tools:write"],
    });
    expect(
      fixture
        .recordsOf("unique-claim")
        .map((claim) => claim.data.value)
        .toSorted(),
    ).toEqual(["docs.docs_delete", "docs.docs_search", "docs.docs_update", "docs.fancy_thing"]);
  });

  test("updates drifted tools in place, keeps unchanged ones, and archives withdrawn ones", async () => {
    const search = tool("docs-search");
    const update = tool("docs-update", { description: "Now updates and publishes pages" });
    const fixture = toolSyncFixture({
      discover: async () => ({ tools: [search, update] }),
    });
    fixture.seedConnection();
    fixture.put(
      vendorAdapterRecord({
        description: "docs-search description",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FD0",
        name: "docs.docs_search",
        remoteToolName: "docs-search",
        toolHash: hash(search),
      }),
    );
    fixture.put(
      vendorAdapterRecord({
        description: "docs-update description",
        effect: "write",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
        name: "docs.docs_update",
        remoteToolName: "docs-update",
        toolHash: hash(tool("docs-update")),
      }),
    );
    fixture.put(
      vendorAdapterRecord({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FD2",
        name: "docs.docs_retired",
        remoteToolName: "docs-retired",
        toolHash: hash(tool("docs-retired")),
      }),
    );

    const response = await sync(fixture);

    expect(response.tools.map(({ change, toolName }) => [toolName, change])).toEqual([
      ["docs.docs_retired", "archived"],
      ["docs.docs_search", "unchanged"],
      ["docs.docs_update", "updated"],
    ]);
    const adapters = new Map(
      fixture.recordsOf("tool-adapter").map((adapter) => [adapter.data.id, adapter.data]),
    );
    expect(adapters.get("01ARZ3NDEKTSV4RRFFQ69G5FD0" as never)).toMatchObject({ version: 0 });
    expect(adapters.get("01ARZ3NDEKTSV4RRFFQ69G5FD1" as never)).toMatchObject({
      description: "Now updates and publishes pages",
      execution: { toolHash: hash(update) },
      status: "active",
      version: 1,
    });
    expect(adapters.get("01ARZ3NDEKTSV4RRFFQ69G5FD2" as never)).toMatchObject({
      status: "archived",
      version: 1,
    });
    expect(fixture.recordsOf("tool-adapter")).toHaveLength(3);
  });

  test("rejects tools it cannot represent safely without persisting them", async () => {
    const fixture = toolSyncFixture({
      discover: async () => ({
        tools: [
          tool("docs-search"),
          tool("listItems", { inputSchema: { type: "array" } }),
          tool("big-schema", {
            inputSchema: { description: "x".repeat(64 * 1024), type: "object" },
          }),
          tool("long-description", { description: "d".repeat(8 * 1024 + 1) }),
          tool("!!!"),
          tool("a-b"),
          tool("a_b"),
          tool("taken"),
        ],
      }),
    });
    fixture.seedConnection();
    fixture.put(
      vendorAdapterRecord({
        execution: {
          endpointOrigin: "https://hooks.example",
          endpointPath: "/",
          type: "http_callback",
        },
        id: "01ARZ3NDEKTSV4RRFFQ69G5FD3",
        name: "docs.taken",
        providerKey: "docs",
        remoteToolName: "",
        toolHash: "",
      }),
    );

    const response = await sync(fixture);

    expect(
      response.tools
        .filter((entry) => entry.change === "rejected")
        .toSorted((left, right) =>
          left.remoteName < right.remoteName ? -1 : left.remoteName > right.remoteName ? 1 : 0,
        )
        .map(({ reason, remoteName }) => [remoteName, reason]),
    ).toEqual([
      ["!!!", "invalid_name"],
      ["a-b", "name_collision"],
      ["a_b", "name_collision"],
      ["big-schema", "input_schema_too_large"],
      ["listItems", "input_schema_not_object"],
      ["long-description", "description_too_large"],
      ["taken", "name_collision"],
    ]);
    expect(
      fixture
        .recordsOf("tool-adapter")
        .map((adapter) => adapter.data.name)
        .toSorted(),
    ).toEqual(["docs.docs_search", "docs.taken"]);
  });

  test("rejects only the tool whose schema the adapter record cannot persist", async () => {
    const fixture = toolSyncFixture({
      discover: async () => ({
        tools: [
          tool("docs-search"),
          tool("docs-count", {
            inputSchema: {
              properties: { limit: { maximum: 2 ** 63, type: "integer" } },
              type: "object",
            },
          }),
        ],
      }),
    });
    fixture.seedConnection();

    const response = await sync(fixture);

    expect(
      response.tools.map(({ change, reason, remoteName }) => [remoteName, change, reason]),
    ).toEqual([
      ["docs-count", "rejected", "input_schema_unrepresentable"],
      ["docs-search", "created", undefined],
    ]);
    expect(fixture.recordsOf("tool-adapter").map((adapter) => adapter.data.name)).toEqual([
      "docs.docs_search",
    ]);
  });

  test("fails closed when discovery echoes connection credential material", async () => {
    const fixture = toolSyncFixture({
      discover: async () => ({
        tools: [tool("docs-search", { description: `use ${ACCESS_TOKEN}` })],
      }),
    });
    fixture.seedConnection();

    expect(fixture.invoke("syncConnectionTools")).rejects.toMatchObject({
      code: "mcp_discovery_credential_echo",
      status: 502,
    });
    expect(fixture.recordsOf("tool-adapter")).toEqual([]);
  });

  test("refreshes an expiring OAuth token before reading the credential", async () => {
    const fixture = toolSyncFixture({
      discover: async () => ({ tools: [] }),
      refresh: async () => {
        fixture.put({
          ...connectionRecord({ generation: 1, refreshAfter: "2026-10-01T13:00:00.000Z" }),
        });
        fixture.secrets.set(`${CREDENTIAL_ID}#1`, { accessToken: REFRESHED_ACCESS_TOKEN });
        return {
          reference: { credentialId: CREDENTIAL_ID, generation: 1, store: "dynamodb-kms" },
          status: "refreshed",
        };
      },
    });
    fixture.seedConnection({ refreshAfter: "2026-10-01T12:01:00.000Z" });

    await sync(fixture);

    expect(fixture.refreshes).toEqual([
      {
        connectionId: CONNECTION_ID,
        environmentId: expect.any(String),
        expectedGeneration: 0,
        kind: "provider-connection-oauth-refresh",
        organizationId: expect.any(String),
        projectId: expect.any(String),
        requestedBy: "api",
      },
    ]);
    expect(fixture.discoveries[0]?.headers).toEqual({
      authorization: `Bearer ${REFRESHED_ACCESS_TOKEN}`,
    });
  });

  test("does not refresh tokens that are outside the refresh skew", async () => {
    const fixture = toolSyncFixture({ discover: async () => ({ tools: [] }) });
    fixture.seedConnection({ refreshAfter: "2026-10-01T12:30:00.000Z" });

    await sync(fixture);

    expect(fixture.refreshes).toEqual([]);
  });

  test("maps terminal and transient refresh failures without contacting the server", async () => {
    const reauthorize = toolSyncFixture({
      refresh: async () => ({
        code: "invalid_grant",
        message: "Refresh token revoked.",
        status: "reauthorization_required",
      }),
    });
    reauthorize.seedConnection({ refreshAfter: "2026-10-01T11:59:00.000Z" });
    expect(reauthorize.invoke("syncConnectionTools")).rejects.toMatchObject({
      code: "connection_reauthorization_required",
      kind: "conflict",
    });
    expect(reauthorize.discoveries).toEqual([]);

    const retryable = toolSyncFixture({
      refresh: async () => ({ code: "busy", message: "Claim held.", status: "retryable" }),
    });
    retryable.seedConnection({ refreshAfter: "2026-10-01T11:59:00.000Z" });
    expect(retryable.invoke("syncConnectionTools")).rejects.toMatchObject({
      code: "connection_refresh_unavailable",
      status: 503,
    });
    expect(retryable.discoveries).toEqual([]);
  });

  test("maps a server credential rejection to reauthorization", async () => {
    const fixture = toolSyncFixture({
      discover: async () => {
        throw new RemoteMcpError("http", "MCP endpoint returned HTTP 401.", { statusCode: 401 });
      },
    });
    fixture.seedConnection();
    expect(fixture.invoke("syncConnectionTools")).rejects.toMatchObject({
      code: "connection_reauthorization_required",
    });
  });

  test("sends API keys through the pinned header on the pinned endpoint", async () => {
    const fixture = toolSyncFixture({ discover: async () => ({ tools: [tool("lookup")] }) });
    fixture.seedConnection({ providerKey: "keyed" });

    const response = await sync(fixture);

    expect(fixture.discoveries[0]).toMatchObject({
      endpointOrigin: "https://mcp.keyed.example",
      endpointPath: "/v1/mcp",
      headers: { "x-api-key": "keyed-secret-0123456789" },
    });
    expect(response.tools).toEqual([
      expect.objectContaining({ change: "created", toolName: "keyed.lookup" }),
    ]);
  });

  test("requires a verified vendor MCP connection and configured vendor ports", async () => {
    const unverified = toolSyncFixture();
    unverified.seedConnection({ capability: false });
    expect(unverified.invoke("syncConnectionTools")).rejects.toMatchObject({
      code: "connection_not_verified",
    });

    const native = toolSyncFixture();
    native.seedConnection({ providerKey: "github" });
    expect(native.invoke("syncConnectionTools")).rejects.toMatchObject({
      code: "connection_not_vendor_mcp",
    });

    const unconfigured = toolSyncFixture({ vendorMcp: false });
    unconfigured.seedConnection();
    expect(unconfigured.invoke("syncConnectionTools")).rejects.toMatchObject({
      code: "vendor_mcp_unconfigured",
      status: 503,
    });
  });
});
