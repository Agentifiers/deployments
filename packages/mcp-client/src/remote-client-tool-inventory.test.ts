import { describe, expect, test } from "bun:test";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";
import {
  MAX_REMOTE_MCP_TOOL_PAGES,
  MAX_REMOTE_MCP_TOOLS,
  createRemoteMcpClient,
  mcpToolDefinitionHash,
  type RemoteMcpError,
} from "./index.ts";

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 as const }];
const ENDPOINT = { endpointOrigin: "https://mcp.example.com", endpointPath: "/mcp" } as const;

interface RpcMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

function rpcResult(id: RpcMessage["id"], result: Readonly<Record<string, unknown>>) {
  return new Response(JSON.stringify({ id, jsonrpc: "2.0", result }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

/** Fake Streamable HTTP MCP server; `listPage(n, cursor)` answers the n-th tools/list. */
function fakeServer(
  listPage: (page: number, cursor: unknown) => Readonly<Record<string, unknown>>,
  options: { readonly maxResponseBytes?: number } = {},
) {
  const methods: string[] = [];
  let pages = 0;
  const client = createRemoteMcpClient({
    dnsLookup: PUBLIC_DNS,
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    pinnedRequest: async (request: ExecutePinnedHttpRequestOptions) => {
      if (request.method === "DELETE") {
        methods.push("DELETE");
        return new Response(null, { status: 204 });
      }
      const message = JSON.parse(String(request.body ?? "{}")) as RpcMessage;
      methods.push(message.method ?? "<none>");
      if (message.method === "initialize") {
        return new Response(
          JSON.stringify({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: message.params?.protocolVersion,
              serverInfo: { name: " Vendor MCP ", version: "2.0.0" },
            },
          }),
          { headers: { "content-type": "application/json", "mcp-session-id": "s-1" }, status: 200 },
        );
      }
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (message.method === "tools/list") {
        pages += 1;
        return rpcResult(message.id, listPage(pages, message.params?.cursor));
      }
      if (message.method === "tools/call") {
        return rpcResult(message.id, { content: [{ text: "done", type: "text" }] });
      }
      throw new Error(`Unexpected MCP request ${message.method}.`);
    },
  });
  return { client, methods, pages: () => pages };
}

const SEARCH_TOOL = {
  annotations: { readOnlyHint: true, title: "Search" },
  description: "Search pages",
  inputSchema: { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
  name: "search",
  title: "Search",
} as const;

describe("mcpToolDefinitionHash", () => {
  test("is independent of object key order but sensitive to array order and content", () => {
    const base = mcpToolDefinitionHash({
      description: "Search pages",
      inputSchema: {
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a", "b"],
        type: "object",
      },
      name: "search",
    });
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      mcpToolDefinitionHash({
        inputSchema: {
          type: "object",
          required: ["a", "b"],
          properties: { b: { type: "number" }, a: { type: "string" } },
        },
        name: "search",
        description: "Search pages",
      }),
    ).toBe(base);
    expect(
      mcpToolDefinitionHash({
        description: "Search pages",
        inputSchema: {
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["b", "a"],
          type: "object",
        },
        name: "search",
      }),
    ).not.toBe(base);
    expect(
      mcpToolDefinitionHash({
        description: "Search all pages",
        inputSchema: {
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a", "b"],
          type: "object",
        },
        name: "search",
      }),
    ).not.toBe(base);
  });

  test("hashes the documented canonical JSON with a null description when absent", () => {
    const canonical =
      '{"description":null,"inputSchema":{"properties":{"x":{"type":"string"}},"type":"object"},"name":"t"}';
    const expected = `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`;
    expect(
      mcpToolDefinitionHash({
        inputSchema: { type: "object", properties: { x: { type: "string" } } },
        name: "t",
      }),
    ).toBe(expected);
    expect(mcpToolDefinitionHash({ description: "", inputSchema: {}, name: "t" })).not.toBe(
      mcpToolDefinitionHash({ inputSchema: {}, name: "t" }),
    );
  });
});

describe("discoverAllTools", () => {
  test("returns every advertised tool across pages with server metadata and terminates the session", async () => {
    const server = fakeServer((page) =>
      page === 1
        ? { nextCursor: "page-2", tools: [SEARCH_TOOL] }
        : { tools: [{ inputSchema: { type: "object" }, name: "create-page" }] },
    );

    const result = await server.client.discoverAllTools(ENDPOINT);

    expect(result).toEqual({
      protocolVersion: expect.any(String),
      serverName: "Vendor MCP",
      serverVersion: "2.0.0",
      tools: [SEARCH_TOOL, { inputSchema: { type: "object" }, name: "create-page" }],
    });
    expect(server.methods.at(-1)).toBe("DELETE");
  });

  test("rejects duplicate names, tool-count overflow, byte overflow, and unbounded paging", async () => {
    const duplicate = fakeServer((page) => ({
      ...(page === 1 ? { nextCursor: "page-2" } : {}),
      tools: [SEARCH_TOOL],
    }));
    expect(duplicate.client.discoverAllTools(ENDPOINT)).rejects.toThrow("duplicate tool search");

    const tooMany = fakeServer((page) => ({
      nextCursor: `page-${page + 1}`,
      tools: Array.from({ length: 1_000 }, (_, index) => ({
        inputSchema: { type: "object" },
        name: `tool-${page}-${index}`,
      })),
    }));
    expect(tooMany.client.discoverAllTools(ENDPOINT)).rejects.toThrow(
      `more than ${MAX_REMOTE_MCP_TOOLS} tools`,
    );
    expect(tooMany.pages()).toBe(MAX_REMOTE_MCP_TOOLS / 1_000 + 1);

    const oversized = fakeServer(
      (page) => ({
        ...(page === 1 ? { nextCursor: "page-2" } : {}),
        tools: [
          { description: "x".repeat(250), inputSchema: { type: "object" }, name: `big-${page}` },
        ],
      }),
      { maxResponseBytes: 512 },
    );
    expect(oversized.client.discoverAllTools(ENDPOINT)).rejects.toThrow(
      "discovery exceeded 512 bytes",
    );

    const endless = fakeServer((page) => ({ nextCursor: `page-${page + 1}`, tools: [] }));
    expect(endless.client.discoverAllTools(ENDPOINT)).rejects.toMatchObject({
      code: "protocol",
      message: `MCP tool discovery exceeded ${MAX_REMOTE_MCP_TOOL_PAGES} pages.`,
    } satisfies Partial<RemoteMcpError>);
    expect(endless.pages()).toBe(MAX_REMOTE_MCP_TOOL_PAGES);
  });
});

describe("callTool expectedToolHash", () => {
  const call = (expectedToolHash: string, events: string[]) => ({
    ...ENDPOINT,
    arguments: { query: "roadmap" },
    expectedToolHash,
    onToolCallDispatch: () => events.push("dispatch"),
    toolAllowlist: ["search"],
    toolName: "search",
  });

  test("calls the tool and signals dispatch once, right before tools/call", async () => {
    const server = fakeServer(() => ({ tools: [SEARCH_TOOL] }));
    const approved = (await server.client.discoverAllTools(ENDPOINT)).tools[0]!;
    server.methods.length = 0;

    const result = await server.client.callTool(
      call(mcpToolDefinitionHash(approved), server.methods),
    );

    expect(result.result).toEqual({ content: [{ text: "done", type: "text" }] });
    // The SDK may also open a body-less GET stream ("<none>"); only RPC order matters here.
    expect(server.methods.filter((method) => method !== "<none>")).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "dispatch",
      "tools/call",
      "DELETE",
    ]);
  });

  test("fails with tool-drift before tools/call when the definition changed", async () => {
    const approvedHash = mcpToolDefinitionHash(SEARCH_TOOL);
    const server = fakeServer(() => ({
      tools: [{ ...SEARCH_TOOL, inputSchema: { ...SEARCH_TOOL.inputSchema, required: [] } }],
    }));

    expect(server.client.callTool(call(approvedHash, server.methods))).rejects.toMatchObject({
      code: "tool-drift",
    } satisfies Partial<RemoteMcpError>);
    expect(server.methods).not.toContain("dispatch");
    expect(server.methods).not.toContain("tools/call");
    expect(server.methods.at(-1)).toBe("DELETE");
  });
});
