import { describe, expect, test } from "bun:test";
import { toolEgress } from "./egress.ts";
import type { ToolAdapterDefinition, ToolAdapterExecution } from "./types.ts";

function tool(execution?: ToolAdapterExecution, egress?: ToolAdapterDefinition["egress"]) {
  return {
    defaultPolicyAction: "allow",
    description: "Test tool.",
    effect: "read",
    ...(egress ? { egress } : {}),
    ...(execution ? { execution } : {}),
    toolName: "test.tool",
  } satisfies ToolAdapterDefinition;
}

const hostedCode = (network: "none" | "sandbox") =>
  ({
    contentHash: "sha256:test",
    entrypoint: "index.js",
    language: "javascript",
    memoryMiB: 256,
    network,
    secretNames: [],
    sourceLanguage: "javascript",
    timeoutMs: 1_000,
    type: "hosted_code",
  }) as const;

describe("toolEgress", () => {
  test("hosted code reaches the public internet only with sandbox network access", () => {
    expect(toolEgress(tool(hostedCode("none")))).toBe("platform");
    expect(toolEgress(tool(hostedCode("sandbox")))).toBe("public");
  });

  test("client tools stay with the calling member", () => {
    expect(toolEgress(tool({ type: "client" }))).toBe("platform");
  });

  test("MCP, vendor MCP, and HTTP callbacks reach an admin-configured destination", () => {
    expect(toolEgress(tool({ mcpServerId: "mcp", remoteToolName: "search", type: "mcp" }))).toBe(
      "configured",
    );
    expect(
      toolEgress(
        tool({
          providerKey: "vendor",
          remoteToolName: "search",
          toolHash: "h",
          type: "vendor_mcp",
        }),
      ),
    ).toBe("configured");
    expect(
      toolEgress(
        tool({
          completionMode: "sync",
          endpointOrigin: "https://callback.example.com",
          endpointPath: "/tool",
          type: "http_callback",
        }),
      ),
    ).toBe("configured");
  });

  test("a builtin uses its declared egress and counts as public when undeclared", () => {
    expect(toolEgress(tool({ type: "builtin" }, "platform"))).toBe("platform");
    expect(toolEgress(tool({ type: "builtin" }))).toBe("public");
  });

  test("a tool without an execution counts as public", () => {
    expect(toolEgress(tool())).toBe("public");
  });
});
