import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_NAME_PATTERN_SOURCE } from "@deployments-ai/agent-manifest/schema";
import { Schema } from "effect";
import { makePublicOpenApiSpec } from "./openapi.ts";
import { PUBLIC_API_SCHEMAS } from "./schema-registry.ts";
import {
  CallbackToolExecution,
  CreateExtensionToolRequest,
  ExtensionToolResponse,
  McpServerResponse,
  TOOLING_API_ROUTES,
  TOOLING_API_SCHEMAS,
  ToolPolicyDocument,
  UpdateExtensionToolRequest,
  UpdateToolPolicyRequest,
} from "./tooling.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = "2026-07-25T00:00:00.000Z";

const publicOpenApiSpec = makePublicOpenApiSpec();

function operation(method: string, path: string) {
  const openApiPath = path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}");
  return publicOpenApiSpec.paths[openApiPath]?.[method.toLowerCase()];
}

describe("tooling and extension administration API contract", () => {
  test("publishes unique, registered environment-scoped routes", () => {
    const names = TOOLING_API_ROUTES.map((route) => route.name);
    const methodPaths = TOOLING_API_ROUTES.map(
      (route) => `${route.method} ${route.path.replaceAll(/:[^/]+/gu, "{}")}`,
    );

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(methodPaths).size).toBe(methodPaths.length);

    for (const route of TOOLING_API_ROUTES) {
      expect(route.authentication).toBe("platform-bearer");
      expect(route.scopeHeaders).toBe("environment");
      expect(route.idempotency).toBe(route.method === "GET" ? "none" : "required");
      expect(PUBLIC_API_SCHEMAS).toHaveProperty(route.responseBody);
      expect(TOOLING_API_SCHEMAS).toHaveProperty(route.responseBody);
      if ("requestBody" in route && route.requestBody) {
        expect(PUBLIC_API_SCHEMAS).toHaveProperty(route.requestBody);
      }
      expect(operation(route.method, route.path)?.operationId).toBe(route.name);
    }
  });

  test("publishes extension tool-name path patterns in OpenAPI", () => {
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const parameters = operation(method, "/v1/extensions/:toolName")?.parameters as
        | readonly {
            readonly name?: string;
            readonly schema?: Readonly<Record<string, unknown>>;
          }[]
        | undefined;
      expect(parameters?.find((parameter) => parameter.name === "toolName")?.schema).toMatchObject({
        pattern: AGENT_TOOL_NAME_PATTERN_SOURCE,
        type: "string",
      });
    }
  });

  test("keeps MCP authentication material out of response projections", () => {
    const server = Schema.decodeUnknownSync(McpServerResponse)({
      auth: { bearerToken: "must-not-leak" },
      authSecretRef: { credentialId: ID, generation: 1, store: "dynamodb-kms" },
      createdAt: NOW,
      endpointOrigin: "https://mcp.example.test",
      endpointPath: "/mcp",
      hasAuth: true,
      id: ID,
      name: "Customer MCP",
      status: "active",
      toolAllowlist: ["list-records"],
      updatedAt: NOW,
      version: 1,
    });

    expect(server).not.toHaveProperty("auth");
    expect(server).not.toHaveProperty("authSecretRef");
  });

  test("uses structured policy documents and optimistic updates", () => {
    expect(
      Schema.decodeUnknownSync(ToolPolicyDocument)({
        defaultAction: "deny",
        rules: [
          {
            action: "require_approval",
            effect: "write",
            providerKey: "github",
            requiredScopes: ["repo:write"],
            toolPrefix: "github.",
          },
        ],
      }),
    ).toMatchObject({
      defaultAction: "deny",
      rules: [expect.objectContaining({ action: "require_approval", effect: "write" })],
    });
    expect(() =>
      Schema.decodeUnknownSync(ToolPolicyDocument)({
        rules: [{ action: "sometimes", effect: "write" }],
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(UpdateToolPolicyRequest)({
        expectedVersion: 3,
        policy: { rules: [] },
      }),
    ).toEqual({ expectedVersion: 3, policy: { rules: [] } });
    expect(
      Schema.decodeUnknownSync(ToolPolicyDocument)({
        rules: [
          {
            action: "deny",
            connectorProvider: "mcp",
            effect: ["read", "write"],
            requiredScopes: ["https://www.googleapis.com/auth/adwords"],
          },
        ],
      }),
    ).toMatchObject({
      rules: [
        {
          connectorProvider: "mcp",
          effect: ["read", "write"],
        },
      ],
    });
  });

  test("registers arbitrary MCP and callback tools through one extension schema", () => {
    const common = {
      defaultPolicyAction: "allow",
      description: "Look up a customer record.",
      effect: "read",
      inputSchema: {
        additionalProperties: false,
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
        type: "object",
      },
      name: "customer.records.get",
      requiredScopes: ["customer:read"],
    } as const;

    const mcp = Schema.decodeUnknownSync(CreateExtensionToolRequest)({
      ...common,
      providerKey: "github",
      execution: { mcpServerId: ID, remoteToolName: "get-record", type: "mcp" },
    });
    expect(mcp.execution.type).toBe("mcp");
    expect(mcp).not.toHaveProperty("providerKey");
    expect(() =>
      Schema.decodeUnknownSync(CreateExtensionToolRequest)({
        ...common,
        effect: "write",
        execution: { mcpServerId: ID, remoteToolName: "get-record", type: "mcp" },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(CreateExtensionToolRequest)({
        ...common,
        callbackSecret: "callback-secret",
        execution: {
          endpointOrigin: "https://callbacks.example.test",
          endpointPath: "/tools/get-record",
          type: "http_callback",
        },
        providerKey: "github",
      }).execution.type,
    ).toBe("http_callback");
    expect(() =>
      Schema.decodeUnknownSync(CreateExtensionToolRequest)({
        ...common,
        execution: {
          endpointOrigin: "https://callbacks.example.test",
          endpointPath: "/tools/get-record",
          type: "http_callback",
        },
        providerKey: "github",
      }),
    ).toThrow();
    for (const inputSchema of [{}, { type: "string" }]) {
      expect(() =>
        Schema.decodeUnknownSync(CreateExtensionToolRequest)({
          ...common,
          inputSchema,
          execution: { mcpServerId: ID, remoteToolName: "get-record", type: "mcp" },
        }),
      ).toThrow();
    }
  });

  test("bounds callback workspace file patterns to relative globs under /workspace", () => {
    const execution = (include: unknown) => ({
      endpointOrigin: "https://callbacks.example.test",
      endpointPath: "/tools/publish",
      type: "http_callback",
      workspaceFiles: { include },
    });
    const accepted = ["site/*.html", "site/**/*.css", "index.html", "a".repeat(256)];
    expect(
      Schema.decodeUnknownSync(CallbackToolExecution)(execution(accepted)).workspaceFiles,
    ).toEqual({ include: accepted });
    expect(
      Schema.decodeUnknownSync(UpdateExtensionToolRequest)({
        execution: execution(["site/**"]),
        expectedVersion: 1,
      }).execution,
    ).toMatchObject({ workspaceFiles: { include: ["site/**"] } });
    for (const include of [
      [],
      Array.from({ length: 17 }, (_, index) => `f${index}`),
      [""],
      ["/workspace/site/*.html"],
      ["site/../../etc/passwd"],
      [".."],
      ["site/\0.html"],
      ["a".repeat(257)],
      [1],
    ]) {
      expect(() => Schema.decodeUnknownSync(CallbackToolExecution)(execution(include))).toThrow();
    }
  });

  test("lets callback tools opt in to the closed run context list", () => {
    const execution = (runContext: unknown) => ({
      endpointOrigin: "https://callbacks.example.test",
      endpointPath: "/tools/draft",
      runContext,
      type: "http_callback",
    });
    expect(
      Schema.decodeUnknownSync(UpdateExtensionToolRequest)({
        execution: execution(["origin"]),
        expectedVersion: 1,
      }).execution,
    ).toEqual({
      endpointOrigin: "https://callbacks.example.test",
      endpointPath: "/tools/draft",
      runContext: ["origin"],
      type: "http_callback",
    });
    for (const runContext of [[], ["origin", "origin"], ["sender"], "origin"]) {
      expect(() =>
        Schema.decodeUnknownSync(CallbackToolExecution)(execution(runContext)),
      ).toThrow();
    }
  });

  test("registers client-executed tools with bounded timeouts and object output schemas", () => {
    const decode = Schema.decodeUnknownSync(CreateExtensionToolRequest);
    const client = {
      defaultPolicyAction: "allow",
      description: "Read the caller's local weather sensor.",
      effect: "read",
      execution: { type: "client" },
      inputSchema: { properties: { city: { type: "string" } }, type: "object" },
      name: "weather.local",
      requiredScopes: [],
    } as const;

    const decoded = decode({
      ...client,
      execution: { timeoutMs: 60_000, type: "client" },
      outputSchema: { properties: { temperature: { type: "number" } }, type: "object" },
    });
    expect(decoded.execution).toEqual({ timeoutMs: 60_000, type: "client" });
    expect(decoded).toMatchObject({ outputSchema: { type: "object" } });
    expect(decode(client).execution).toEqual({ type: "client" });
    for (const timeoutMs of [999, 3_600_001, 1.5]) {
      expect(() => decode({ ...client, execution: { timeoutMs, type: "client" } })).toThrow();
    }
    expect(() => decode({ ...client, outputSchema: { type: "array" } })).toThrow();
    expect(() => decode({ ...client, inputSchema: undefined })).toThrow();
    expect(
      Schema.decodeUnknownSync(ExtensionToolResponse)({
        ...client,
        createdAt: "2026-07-23T12:00:00.000Z",
        hasCallbackAuth: false,
        id: ID,
        outputSchema: { type: "object" },
        status: "active",
        updatedAt: "2026-07-23T12:00:00.000Z",
        version: 1,
      }).execution,
    ).toEqual({ type: "client" });
  });

  test("shows synced vendor MCP tools but never accepts them as extension writes", () => {
    const execution = {
      providerKey: "notion",
      remoteToolName: "notion-search",
      toolHash: `sha256:${"a".repeat(64)}`,
      type: "vendor_mcp",
    } as const;
    const tool = {
      createdAt: NOW,
      defaultPolicyAction: "allow",
      description: "D".repeat(8_192),
      effect: "read",
      execution,
      hasCallbackAuth: false,
      id: ID,
      inputSchema: { type: "object" },
      name: "notion.notion_search",
      providerKey: "notion",
      requiredScopes: ["tools:read"],
      status: "active",
      updatedAt: NOW,
      version: 0,
    } as const;
    expect(Schema.decodeUnknownSync(ExtensionToolResponse)(tool).execution).toEqual(execution);
    expect(() =>
      Schema.decodeUnknownSync(ExtensionToolResponse)({
        ...tool,
        execution: { ...execution, toolHash: "sha256:short" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateExtensionToolRequest)({
        defaultPolicyAction: "allow",
        description: "Search",
        effect: "read",
        execution,
        inputSchema: { type: "object" },
        name: "notion.notion_search",
        requiredScopes: [],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(UpdateExtensionToolRequest)({ execution, expectedVersion: 0 }),
    ).toThrow();
  });
});
