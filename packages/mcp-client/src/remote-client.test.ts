import { describe, expect, test } from "bun:test";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";
import { MAX_REMOTE_MCP_TOOL_PAGES, RemoteMcpError, createRemoteMcpClient } from "./index.ts";

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 as const }];

function rpcResponse(message: Readonly<Record<string, unknown>>, headers?: RequestInit["headers"]) {
  return new Response(JSON.stringify(message), {
    headers: { "content-type": "Application/JSON", ...Object.fromEntries(new Headers(headers)) },
    status: 200,
  });
}

describe("remote MCP client", () => {
  test("initializes, discovers an allowed tool, and executes it over pinned HTTPS", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const serverName = `coupler-test-${"x".repeat(300)}`;
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async (request) => {
        requests.push(request);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const message = JSON.parse(String(request.body ?? "{}")) as {
          readonly id?: string | number;
          readonly method?: string;
          readonly params?: Readonly<Record<string, unknown>>;
        };
        if (message.method === "initialize") {
          return rpcResponse(
            {
              id: message.id,
              jsonrpc: "2.0",
              result: {
                capabilities: { tools: {} },
                protocolVersion: message.params?.protocolVersion,
                serverInfo: { name: serverName, version: "1.2.3" },
              },
            },
            { "mcp-session-id": "session-1" },
          );
        }
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 200 });
        }
        if (message.method === "tools/list") {
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              tools: [
                {
                  description: "List dataflows",
                  inputSchema: { type: "object" },
                  name: "list-dataflows",
                },
              ],
            },
          });
        }
        if (message.method === "tools/call") {
          expect(message.params).toEqual({ arguments: {}, name: "list-dataflows" });
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: { content: [{ text: "Two dataflows", type: "text" }] },
          });
        }
        throw new Error(`Unexpected MCP request ${message.method}.`);
      },
    });

    const result = await client.callTool({
      endpointOrigin: "https://mcp.example.com",
      endpointPath: "/v1/mcp",
      headers: { authorization: "Bearer secret" },
      toolAllowlist: ["list-dataflows"],
      toolName: "list-dataflows",
    });

    expect(result).toMatchObject({
      result: { content: [{ text: "Two dataflows", type: "text" }] },
      serverName,
      serverVersion: "1.2.3",
    });
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "POST",
      "POST",
      "DELETE",
    ]);
    expect(
      requests.every((request) => request.url.toString() === "https://mcp.example.com/v1/mcp"),
    ).toBe(true);
    expect(requests[0]?.headers?.authorization).toBe("Bearer secret");
    expect(requests[0]?.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);

    const discovered = await client.discoverTools({
      endpointOrigin: "https://mcp.example.com",
      endpointPath: "/v1/mcp",
      headers: { authorization: "Bearer secret" },
      toolAllowlist: ["list-dataflows"],
    });
    expect(discovered.tools).toEqual([
      {
        description: "List dataflows",
        inputSchema: { type: "object" },
        remoteName: "list-dataflows",
      },
    ]);
    expect(requests.slice(5).map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "POST",
      "DELETE",
    ]);
  });

  test("rejects tools outside the configured allowlist before making a request", async () => {
    let requests = 0;
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async () => {
        requests += 1;
        throw new Error("not used");
      },
    });

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["allowed"],
        toolName: "not-allowed",
      }),
    ).rejects.toMatchObject({ code: "tool-not-allowed" } satisfies Partial<RemoteMcpError>);
    expect(requests).toBe(0);
  });

  test("fails closed when the server does not advertise the pinned tool", async () => {
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async (request) => {
        const message = JSON.parse(String(request.body ?? "{}")) as {
          readonly id?: string | number;
          readonly method?: string;
          readonly params?: Readonly<Record<string, unknown>>;
        };
        if (message.method === "initialize") {
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: message.params?.protocolVersion,
              serverInfo: { name: "empty", version: "1" },
            },
          });
        }
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 200 });
        }
        return rpcResponse({ id: message.id, jsonrpc: "2.0", result: { tools: [] } });
      },
    });

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["expected"],
        toolName: "expected",
      }),
    ).rejects.toMatchObject({ code: "tool-not-found" } satisfies Partial<RemoteMcpError>);
  });

  test("fails discovery instead of returning a page-limited tool list", async () => {
    let listedPages = 0;
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async (request) => {
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const message = JSON.parse(String(request.body ?? "{}")) as {
          readonly id?: string | number;
          readonly method?: string;
          readonly params?: Readonly<Record<string, unknown>>;
        };
        if (message.method === "initialize") {
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: message.params?.protocolVersion,
              serverInfo: { name: "paginated", version: "1" },
            },
          });
        }
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 200 });
        }
        listedPages += 1;
        return rpcResponse({
          id: message.id,
          jsonrpc: "2.0",
          result: { nextCursor: `page-${listedPages}`, tools: [] },
        });
      },
    });

    expect(
      client.discoverTools({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["expected"],
      }),
    ).rejects.toMatchObject({ code: "protocol" } satisfies Partial<RemoteMcpError>);
    expect(listedPages).toBe(MAX_REMOTE_MCP_TOOL_PAGES);
  });

  test("rejects duplicate names and cumulatively oversized discovery results", async () => {
    const clientFor = (duplicate: boolean) => {
      let listedPages = 0;
      return createRemoteMcpClient({
        dnsLookup: PUBLIC_DNS,
        maxResponseBytes: 512,
        pinnedRequest: async (request) => {
          if (request.method === "DELETE") return new Response(null, { status: 204 });
          const message = JSON.parse(String(request.body ?? "{}")) as {
            readonly id?: string | number;
            readonly method?: string;
            readonly params?: Readonly<Record<string, unknown>>;
          };
          if (message.method === "initialize") {
            return rpcResponse({
              id: message.id,
              jsonrpc: "2.0",
              result: {
                capabilities: { tools: {} },
                protocolVersion: message.params?.protocolVersion,
                serverInfo: { name: "bounded", version: "1" },
              },
            });
          }
          if (message.method === "notifications/initialized") {
            return new Response(null, { status: 200 });
          }
          listedPages += 1;
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              ...(listedPages === 1 ? { nextCursor: "page-2" } : {}),
              tools: [
                {
                  description: "x".repeat(250),
                  inputSchema: { type: "object" },
                  name: duplicate ? "allowed" : `allowed-${listedPages}`,
                },
              ],
            },
          });
        },
      });
    };

    expect(
      clientFor(true).discoverTools({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["allowed"],
      }),
    ).rejects.toThrow("duplicate tool allowed");
    expect(
      clientFor(false).discoverTools({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["allowed-1", "allowed-2"],
      }),
    ).rejects.toThrow("discovery exceeded 512 bytes");
  });

  test("bounds remote response bodies before protocol parsing", async () => {
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      maxResponseBytes: 16,
      pinnedRequest: async () =>
        new Response('{"jsonrpc":"2.0"}', {
          headers: { "content-length": "17", "content-type": "application/json" },
          status: 200,
        }),
    });

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["expected"],
        toolName: "expected",
      }),
    ).rejects.toMatchObject({ code: "protocol" } satisfies Partial<RemoteMcpError>);
  });

  test("delivers SSE results without waiting for the response stream to close", async () => {
    const encoder = new TextEncoder();
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async (request) => {
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const message = JSON.parse(String(request.body ?? "{}")) as {
          readonly id?: string | number;
          readonly method?: string;
          readonly params?: Readonly<Record<string, unknown>>;
        };
        if (message.method === "initialize") {
          return rpcResponse(
            {
              id: message.id,
              jsonrpc: "2.0",
              result: {
                capabilities: { tools: {} },
                protocolVersion: message.params?.protocolVersion,
                serverInfo: { name: "streaming", version: "1" },
              },
            },
            { "mcp-session-id": "stream-session" },
          );
        }
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 200 });
        }
        if (message.method === "tools/list") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `event: message\ndata: ${JSON.stringify({
                      id: message.id,
                      jsonrpc: "2.0",
                      result: {
                        tools: [{ inputSchema: { type: "object" }, name: "stream-tool" }],
                      },
                    })}\n\n`,
                  ),
                );
                request.signal.addEventListener("abort", () => controller.close(), { once: true });
              },
            }),
            { headers: { "content-type": "Text/Event-Stream" }, status: 200 },
          );
        }
        return rpcResponse({
          id: message.id,
          jsonrpc: "2.0",
          result: { content: [{ text: "streamed", type: "text" }] },
        });
      },
    });

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        timeoutMs: 500,
        toolAllowlist: ["stream-tool"],
        toolName: "stream-tool",
      }),
    ).resolves.toMatchObject({
      result: { content: [{ text: "streamed", type: "text" }] },
    });
  });

  test("keeps session termination within the configured deadline", async () => {
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async (request) => {
        if (request.method === "DELETE") {
          return await new Promise<Response>((resolve) => {
            const fallback = setTimeout(() => resolve(new Response(null, { status: 204 })), 200);
            request.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(fallback);
                resolve(new Response(null, { status: 499 }));
              },
              { once: true },
            );
          });
        }
        const message = JSON.parse(String(request.body ?? "{}")) as {
          readonly id?: string | number;
          readonly method?: string;
          readonly params?: Readonly<Record<string, unknown>>;
        };
        if (message.method === "initialize") {
          return rpcResponse(
            {
              id: message.id,
              jsonrpc: "2.0",
              result: {
                capabilities: { tools: {} },
                protocolVersion: message.params?.protocolVersion,
                serverInfo: { name: "cleanup", version: "1" },
              },
            },
            { "mcp-session-id": "cleanup-session" },
          );
        }
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 200 });
        }
        if (message.method === "tools/list") {
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: { tools: [{ inputSchema: { type: "object" }, name: "cleanup-tool" }] },
          });
        }
        return rpcResponse({
          id: message.id,
          jsonrpc: "2.0",
          result: { content: [{ text: "done", type: "text" }] },
        });
      },
    });
    const startedAt = Date.now();

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        timeoutMs: 50,
        toolAllowlist: ["cleanup-tool"],
        toolName: "cleanup-tool",
      }),
    ).resolves.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  test("preserves MCP tool error results for the agent", async () => {
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async (request) => {
        const message = JSON.parse(String(request.body ?? "{}")) as {
          readonly id?: string | number;
          readonly method?: string;
          readonly params?: Readonly<Record<string, unknown>>;
        };
        if (message.method === "initialize") {
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: message.params?.protocolVersion,
              serverInfo: { name: "errors", version: "1" },
            },
          });
        }
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 200 });
        }
        if (message.method === "tools/list") {
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: { tools: [{ inputSchema: { type: "object" }, name: "error-tool" }] },
          });
        }
        return rpcResponse({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            content: [{ text: "dataflowId is required", type: "text" }],
            isError: true,
          },
        });
      },
    });

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["error-tool"],
        toolName: "error-tool",
      }),
    ).resolves.toMatchObject({
      isError: true,
      result: { content: [{ text: "dataflowId is required", type: "text" }], isError: true },
    });
  });

  test("preserves HTTP status for permanent remote failures", async () => {
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async () =>
        new Response("Bearer reflected-secret", {
          headers: { "content-type": "text/plain" },
          status: 401,
        }),
    });

    try {
      await client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["tool"],
        toolName: "tool",
      });
      throw new Error("Expected the MCP HTTP request to fail.");
    } catch (cause) {
      expect(cause).toMatchObject({ code: "http", statusCode: 401 });
      expect((cause as Error).message).not.toContain("reflected-secret");
      expect((cause as Error).cause).toBeUndefined();
    }
  });

  test("applies the MCP deadline to DNS resolution", async () => {
    const client = createRemoteMcpClient({
      dnsLookup: async () => await new Promise<never>(() => undefined),
      pinnedRequest: async () => {
        throw new Error("request must not start before DNS resolves");
      },
    });
    const startedAt = Date.now();

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        timeoutMs: 50,
        toolAllowlist: ["tool"],
        toolName: "tool",
      }),
    ).rejects.toMatchObject({ code: "timeout" } satisfies Partial<RemoteMcpError>);
    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  test("treats a server without tool capability as permanently incompatible", async () => {
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async (request) => {
        const message = JSON.parse(String(request.body ?? "{}")) as {
          readonly id?: string | number;
          readonly method?: string;
          readonly params?: Readonly<Record<string, unknown>>;
        };
        if (message.method === "initialize") {
          return rpcResponse({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: {},
              protocolVersion: message.params?.protocolVersion,
              serverInfo: { name: "no-tools", version: "1" },
            },
          });
        }
        return new Response(null, { status: 200 });
      },
    });

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com",
        endpointPath: "/mcp",
        toolAllowlist: ["tool"],
        toolName: "tool",
      }),
    ).rejects.toMatchObject({ code: "protocol" } satisfies Partial<RemoteMcpError>);
  });

  test("rejects endpoint origins that contain a path", async () => {
    let requests = 0;
    const client = createRemoteMcpClient({
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async () => {
        requests += 1;
        throw new Error("not used");
      },
    });

    expect(
      client.callTool({
        endpointOrigin: "https://mcp.example.com/team-a",
        endpointPath: "/mcp",
        toolAllowlist: ["tool"],
        toolName: "tool",
      }),
    ).rejects.toMatchObject({ code: "configuration" } satisfies Partial<RemoteMcpError>);
    expect(requests).toBe(0);
  });
});
