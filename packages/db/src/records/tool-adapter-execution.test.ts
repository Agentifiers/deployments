import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { ToolAdapterRecord } from "./agent-definitions.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);
const timestamp = "2026-09-29T12:00:00.000Z";
const contentHash = `sha256:${"a".repeat(64)}`;

function decode(execution: unknown) {
  return Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        defaultPolicyAction: "allow",
        description: "Look up an order.",
        effect: "read",
        environmentId: id("1"),
        execution,
        id: id("2"),
        inputSchema: { type: "object" },
        name: "orders.lookup",
        organizationId: id("3"),
        projectId: id("4"),
        requiredScopes: [],
        status: "active",
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "tool-adapter" as const,
    }),
  ).data.execution;
}

const hostedCode = {
  contentHash,
  entrypoint: "handler",
  language: "javascript",
  memoryMiB: 256,
  network: "none",
  secretNames: ["API_TOKEN"],
  sourceLanguage: "typescript",
  timeoutMs: 5_000,
  type: "hosted_code",
} as const;

describe("tool adapter execution", () => {
  test("accepts every execution shape the extension and sync writers persist", () => {
    for (const execution of [
      hostedCode,
      {
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/read",
        type: "http_callback",
      },
      {
        completionMode: "sync",
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/publish",
        type: "http_callback",
        workspaceFiles: { include: ["site/**/*.html"] },
      },
      {
        completionMode: "sync",
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/draft",
        runContext: ["origin"],
        type: "http_callback",
      },
      { mcpServerId: id("5"), remoteToolName: "search-records", type: "mcp" },
      { type: "client" },
      { timeoutMs: 60_000, type: "client" },
      {
        providerKey: "docs",
        remoteToolName: "docs-update",
        toolHash: `sha256:${"c".repeat(64)}`,
        type: "vendor_mcp",
      },
    ] as const) {
      expect(decode(execution)).toEqual(execution);
    }
  });

  test("keeps hosted code unpinned: the adapter never carries an artifact location", () => {
    const decoded = decode({
      ...hostedCode,
      artifact: { bucket: "platform-artifacts", byteSize: 10, key: "k", versionId: "v1" },
    });

    expect(decoded).toEqual(hostedCode);
    expect(decoded).not.toHaveProperty("artifact");
  });

  test("accepts the definition fields stored beside a built-in execution", () => {
    const execution = {
      adapterKey: "orders.lookup",
      auditMetadata: null,
      authorizationScopes: [],
      defaultPolicyAction: "allow",
      description: "Look up an order.",
      hostPolicy: null,
      inputSchema: { type: "object" },
      providerOutboundMutation: false,
      rateLimitPolicy: null,
      resourceMetadata: null,
      retryPolicy: null,
      type: "builtin",
    } as const;

    expect(decode(execution)).toEqual(execution);
  });

  test("never persists runtime-only callback credentials", () => {
    expect(
      decode({
        authorizationHeader: "Bearer secret",
        credentialGeneration: 3,
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/read",
        type: "http_callback",
      }),
    ).toEqual({
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/v1/read",
      type: "http_callback",
    });
  });

  test("rejects malformed executions", () => {
    for (const execution of [
      {},
      { type: "http_webhook", url: "https://hooks.example.com" },
      { mcpServerId: id("5"), type: "mcp" },
      { mcpServerId: "server-1", remoteToolName: "search-records", type: "mcp" },
      { endpointOrigin: "https://callbacks.example.com", type: "http_callback" },
      { ...hostedCode, contentHash: "sha256:not-hex" },
      { ...hostedCode, network: "internet" },
      { timeoutMs: "60000", type: "client" },
      { providerKey: "docs", remoteToolName: "", toolHash: "sha256:x", type: "vendor_mcp" },
    ]) {
      expect(() => decode(execution)).toThrow();
    }
  });
});
