import { describe, expect, test } from "bun:test";
import {
  ListExtensionToolsResponse,
  ListMcpConnectionsResponse,
  ListMcpServersResponse,
  PublicId,
} from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { extensionDirectory, extensionSummary, mcpDirectory } from "./tool-directory.ts";

const id = (label: string) => Schema.decodeUnknownSync(PublicId)(`01K${label.padStart(23, "0")}`);
const HASH = `sha256:${"b".repeat(64)}`;
const AT = "2026-10-01T00:00:00.000Z";
const INPUT_SCHEMA = { properties: { query: { type: "string" } }, type: "object" };

function extension(label: string, name: string, execution: Record<string, unknown>, extra = {}) {
  return {
    createdAt: AT,
    defaultPolicyAction: "require_approval",
    description: "A tool.",
    effect: "read",
    execution,
    hasCallbackAuth: false,
    id: id(label),
    inputSchema: INPUT_SCHEMA,
    name,
    requiredScopes: ["records:read"],
    status: "active",
    updatedAt: AT,
    version: 2,
    ...extra,
  };
}

const EXTENSIONS = Schema.decodeUnknownSync(ListExtensionToolsResponse)({
  items: [extension("E9", "client.pick", { type: "client" })],
  nextCursor: null,
}).items;
const SERVERS = Schema.decodeUnknownSync(ListMcpServersResponse)({
  items: [
    {
      createdAt: AT,
      endpointOrigin: "https://mcp.example.com",
      endpointPath: "/mcp",
      hasAuth: true,
      id: id("S1"),
      name: "Example MCP",
      status: "active",
      toolAllowlist: ["search"],
      updatedAt: AT,
      version: 4,
    },
  ],
  nextCursor: null,
}).items;
const CONNECTIONS = Schema.decodeUnknownSync(ListMcpConnectionsResponse)({
  items: [
    {
      createdAt: AT,
      id: id("C1"),
      mcpServerId: id("S1"),
      status: "active",
      updatedAt: AT,
      version: 1,
    },
  ],
  nextCursor: null,
}).items;

function lastPage<Item>(items: readonly Item[]) {
  return async () => ({ items, nextCursor: null });
}

function endless<Item>(items: readonly Item[]) {
  const cursors: (string | undefined)[] = [];
  return {
    cursors,
    fetchPage: async (cursor: string | undefined) => {
      cursors.push(cursor);
      return { items, nextCursor: `page-${cursors.length}` };
    },
  };
}

describe("tool directory projections", () => {
  test("extension summaries keep each execution's identifying fields and drop schemas", () => {
    const { items } = Schema.decodeUnknownSync(ListExtensionToolsResponse)({
      items: [
        extension("E1", "mcp.search", {
          mcpServerId: id("S1"),
          remoteToolName: "search",
          type: "mcp",
        }),
        extension(
          "E2",
          "vendor.search",
          { providerKey: "acme", remoteToolName: "search", toolHash: HASH, type: "vendor_mcp" },
          { outputSchema: INPUT_SCHEMA, providerKey: "acme" },
        ),
        extension("E3", "callback.post", {
          endpointOrigin: "https://hooks.example.com",
          endpointPath: "/tools/post",
          type: "http_callback",
          workspaceFiles: { include: ["reports/*.csv"] },
        }),
        extension("E4", "client.pick", { timeoutMs: 60_000, type: "client" }),
        extension("E5", "hosted.sum", {
          contentHash: HASH,
          entrypoint: "main",
          language: "javascript",
          memoryMiB: 256,
          network: "none",
          secretNames: ["API_TOKEN"],
          sourceLanguage: "typescript",
          timeoutMs: 30_000,
          type: "hosted_code",
        }),
      ],
      nextCursor: null,
    });
    const common = {
      defaultPolicyAction: "require_approval",
      effect: "read",
      requiredScopes: ["records:read"],
      status: "active",
      version: 2,
    } as const;
    expect(items.map(extensionSummary)).toEqual([
      {
        ...common,
        execution: { mcpServerId: id("S1"), remoteToolName: "search", type: "mcp" },
        id: id("E1"),
        name: "mcp.search",
      },
      {
        ...common,
        execution: { providerKey: "acme", remoteToolName: "search", type: "vendor_mcp" },
        id: id("E2"),
        name: "vendor.search",
        providerKey: "acme",
      },
      {
        ...common,
        execution: {
          endpointOrigin: "https://hooks.example.com",
          endpointPath: "/tools/post",
          type: "http_callback",
        },
        id: id("E3"),
        name: "callback.post",
      },
      { ...common, execution: { type: "client" }, id: id("E4"), name: "client.pick" },
      {
        ...common,
        execution: { contentHash: HASH, secretNames: ["API_TOKEN"], type: "hosted_code" },
        id: id("E5"),
        name: "hosted.sum",
      },
    ]);
  });

  test("the MCP directory keeps server identity and connection state only", async () => {
    expect(await mcpDirectory(lastPage(SERVERS), lastPage(CONNECTIONS))).toEqual({
      complete: true,
      connections: [
        { id: id("C1"), mcpServerId: id("S1"), status: "active", updatedAt: AT, version: 1 },
      ],
      servers: [
        {
          endpointOrigin: "https://mcp.example.com",
          hasAuth: true,
          id: id("S1"),
          name: "Example MCP",
          status: "active",
          toolAllowlist: ["search"],
          version: 4,
        },
      ],
    });
  });
});

describe("tool directory drains", () => {
  test("the extension drain stops after 20 pages of a cursor chain that never ends", async () => {
    const tools = endless(EXTENSIONS);
    const directory = await extensionDirectory(tools.fetchPage);
    expect({
      complete: directory.complete,
      extensions: directory.extensions.length,
      requests: tools.cursors.length,
    }).toEqual({ complete: false, extensions: 20, requests: 20 });
  });

  test("each MCP drain stops after 20 pages and either one leaves the directory incomplete", async () => {
    const servers = endless(SERVERS);
    const connections = endless(CONNECTIONS);
    const both = await mcpDirectory(servers.fetchPage, connections.fetchPage);
    expect({
      complete: both.complete,
      connections: both.connections.length,
      requests: [servers.cursors.length, connections.cursors.length],
      servers: both.servers.length,
    }).toEqual({ complete: false, connections: 20, requests: [20, 20], servers: 20 });
    expect((await mcpDirectory(lastPage(SERVERS), endless(CONNECTIONS).fetchPage)).complete).toBe(
      false,
    );
    expect((await mcpDirectory(endless(SERVERS).fetchPage, lastPage(CONNECTIONS))).complete).toBe(
      false,
    );
  });
});
