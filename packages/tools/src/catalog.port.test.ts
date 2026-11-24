import { describe, expect, test } from "bun:test";

import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";
import { ToolAdapterRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import type { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";

import {
  findPlatformToolAdapterDefinition,
  makeToolAdapterRecord,
  platformToolAdapterDefinitions,
  providerNativeHttpToolDefinitions,
  toolAdapterDefinitionFromRecord,
} from "./index.ts";

const ID = "01J00000000000000000000000" as Ulid;

describe("ported tool catalog", () => {
  test("includes the full provider-native tool set and no vendor-hosted MCP provider tools", () => {
    expect(providerNativeHttpToolDefinitions.length).toBe(102);
    expect(platformToolAdapterDefinitions.length).toBe(179);
    const registry = codeProviderDefinitionRegistry();
    expect(
      providerNativeHttpToolDefinitions
        .filter((tool) => registry.resolve(tool.provider)?.route === "vendor_mcp")
        .map((tool) => tool.toolName),
    ).toEqual([]);
    expect(
      platformToolAdapterDefinitions.find((tool) => tool.toolName === "provider.api.read"),
    ).toMatchObject({ defaultPolicyAction: "deny", status: "archived" });
    expect(findPlatformToolAdapterDefinition("agent.registry.search")?.inputSchema).toMatchObject({
      properties: { limit: { maximum: 100, minimum: 1, type: "integer" } },
    });
  });

  test("activates Microsoft Teams Graph tools with an approval-gated handoff write", () => {
    const teamsTools = platformToolAdapterDefinitions.filter((tool) =>
      tool.toolName.startsWith("microsoft_teams."),
    );
    expect(
      teamsTools
        .map((tool) => [tool.toolName, tool.status, tool.provider, tool.effect])
        .toSorted((left, right) => left[0]!.localeCompare(right[0]!)),
    ).toEqual([
      ["microsoft_teams.channels.list", "active", "microsoft_teams", "read"],
      ["microsoft_teams.messages.list", "active", "microsoft_teams", "read"],
      ["microsoft_teams.messages.replies", "active", "microsoft_teams", "read"],
      ["microsoft_teams.post_message", "active", "microsoft_teams", "write"],
      ["microsoft_teams.teams.list", "active", "microsoft_teams", "read"],
      ["microsoft_teams.users.lookup", "active", "microsoft_teams", "read"],
    ]);
    const post = findPlatformToolAdapterDefinition("microsoft_teams.post_message");
    expect(post).toMatchObject({
      defaultPolicyAction: "require_approval",
      providerOutboundMutation: true,
    });
    expect(post?.inputSchema).toMatchObject({
      properties: {
        _artifactHandoff: { additionalProperties: false, type: "object" },
        dataVisualizations: { type: "array" },
      },
    });
  });

  test("every provider-native tool resolves to a code-owned provider", () => {
    const registry = codeProviderDefinitionRegistry();
    const missing = providerNativeHttpToolDefinitions
      .filter((tool) => !registry.resolve(tool.provider))
      .map((tool) => tool.provider);
    expect([...new Set(missing)]).toEqual([]);
  });

  test("every active tool exposes a model-compatible object input schema", () => {
    expect(
      platformToolAdapterDefinitions
        .filter((tool) => tool.status === "active")
        .filter(
          (tool) =>
            !tool.inputSchema ||
            typeof tool.inputSchema !== "object" ||
            Array.isArray(tool.inputSchema) ||
            (tool.inputSchema as Readonly<Record<string, unknown>>).type !== "object",
        )
        .map((tool) => tool.toolName),
    ).toEqual([]);
  });

  test("accepts the reserved artifact handoff envelope only on approval-gated writes", () => {
    const write = findPlatformToolAdapterDefinition("sendgrid.email.send");
    const read = findPlatformToolAdapterDefinition("sendgrid.stats.read");
    const execute = findPlatformToolAdapterDefinition("snowflake.query.execute");
    const writeSchema = write?.inputSchema as
      | { readonly properties?: Readonly<Record<string, unknown>> }
      | undefined;
    const readSchema = read?.inputSchema as
      | { readonly properties?: Readonly<Record<string, unknown>> }
      | undefined;
    const executeSchema = execute?.inputSchema as
      | { readonly properties?: Readonly<Record<string, unknown>> }
      | undefined;
    expect(writeSchema?.properties?._artifactHandoff).toMatchObject({
      additionalProperties: false,
      type: "object",
    });
    expect(readSchema?.properties?._artifactHandoff).toBeUndefined();
    expect(executeSchema?.properties?._artifactHandoff).toBeUndefined();
  });

  test("publishes handoff schemas that match lifecycle executor requirements", () => {
    const schema = (toolName: string) =>
      findPlatformToolAdapterDefinition(toolName)?.inputSchema as {
        readonly properties?: Readonly<Record<string, unknown>>;
        readonly required?: readonly string[];
      };
    expect(schema("artifact.provider_handoffs.prepare").required).toEqual(["artifactId"]);
    expect(schema("artifact.provider_handoffs.plan_write").required).toEqual([
      "artifactId",
      "provider",
      "providerInput",
      "toolName",
    ]);
    expect(
      findPlatformToolAdapterDefinition("artifact.provider_handoffs.plan_write"),
    ).toMatchObject({ effect: "write", providerOutboundMutation: true });
    const recordResult = schema("artifact.provider_handoffs.record_result");
    expect(recordResult.required).toContain("handoffIntentId");
    expect(recordResult.properties).toHaveProperty("handoffIntentId");
  });

  test("publishes the runtime access URL expiration range", () => {
    for (const toolName of [
      "artifact.inspect",
      "artifact.share",
      "artifact.provider_handoffs.prepare",
      "artifact.provider_handoffs.plan_write",
    ]) {
      expect(
        (
          platformToolAdapterDefinitions.find((tool) => tool.toolName === toolName)
            ?.inputSchema as {
            readonly properties?: Readonly<Record<string, unknown>>;
          }
        )?.properties?.expiresInSeconds,
      ).toEqual({ maximum: 3_600, minimum: 60, type: "integer" });
    }
  });

  test("projects tool definitions into canonical DynamoDB records", () => {
    const definition = platformToolAdapterDefinitions.find(
      (tool) => tool.toolName === "shopify.fulfillments.create",
    );
    expect(definition).toBeDefined();
    const record = makeToolAdapterRecord({
      definition: definition!,
      environmentId: ID,
      id: ID,
      occurredAt: "2026-07-21T00:00:00.000Z",
      organizationId: ID,
      projectId: ID,
    });
    expect(record.data.effect).toBe("write");
    expect(record.data.providerKey).toBe("shopify");
    expect(record.data.execution).toMatchObject({
      authorizationScopes: [],
      auditMetadata: null,
    });
  });

  test("round-trips persisted synchronous callback execution without treating it as a builtin", () => {
    const record = makeToolAdapterRecord({
      definition: {
        defaultPolicyAction: "allow",
        description: "Read a vertical callback.",
        effect: "read",
        execution: {
          completionMode: "sync",
          endpointOrigin: "https://callbacks.example.com",
          endpointPath: "/v1/read",
          type: "http_callback",
        },
        inputSchema: {
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
        requiredScopes: ["callback:read"],
        status: "active",
        toolName: "vertical.callback.read",
      },
      environmentId: ID,
      id: ID,
      occurredAt: "2026-07-21T00:00:00.000Z",
      organizationId: ID,
      projectId: ID,
    });

    expect(toolAdapterDefinitionFromRecord(record)).toMatchObject({
      auditMetadata: {
        persistedAdapter: {
          id: ID,
          version: 1,
        },
      },
      execution: {
        completionMode: "sync",
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/read",
        type: "http_callback",
      },
      toolAdapterId: ID,
      inputSchema: {
        additionalProperties: false,
        required: ["query"],
        type: "object",
      },
      toolName: "vertical.callback.read",
    });
  });

  test("round-trips callback workspace file patterns and run context and omits them when absent", () => {
    const record = (
      workspaceFiles?: { readonly include: readonly string[] },
      runContext?: readonly "origin"[],
    ) =>
      makeToolAdapterRecord({
        definition: {
          defaultPolicyAction: "allow",
          description: "Publish sandbox files.",
          effect: "write",
          execution: {
            completionMode: "sync",
            endpointOrigin: "https://callbacks.example.com",
            endpointPath: "/v1/publish",
            ...(runContext ? { runContext } : {}),
            type: "http_callback",
            ...(workspaceFiles ? { workspaceFiles } : {}),
          },
          inputSchema: { type: "object" },
          requiredScopes: [],
          status: "active",
          toolName: "vertical.callback.publish",
        },
        environmentId: ID,
        id: ID,
        occurredAt: "2026-07-21T00:00:00.000Z",
        organizationId: ID,
        projectId: ID,
      });

    expect(
      toolAdapterDefinitionFromRecord(
        record({ include: ["site/*.html", "site/**/*.css"] }, ["origin"]),
      ).execution,
    ).toEqual({
      completionMode: "sync",
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/v1/publish",
      runContext: ["origin"],
      type: "http_callback",
      workspaceFiles: { include: ["site/*.html", "site/**/*.css"] },
    });
    expect(toolAdapterDefinitionFromRecord(record()).execution).toEqual({
      completionMode: "sync",
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/v1/publish",
      type: "http_callback",
    });
  });

  test("round-trips persisted MCP routing as a data-owned execution binding", () => {
    const record = makeToolAdapterRecord({
      definition: {
        defaultPolicyAction: "allow",
        description: "Search a vertical MCP server.",
        effect: "read",
        execution: {
          mcpServerId: ID,
          remoteToolName: "search-records",
          type: "mcp",
        },
        inputSchema: {
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
        provider: "mcp",
        requiredScopes: ["records:read"],
        status: "active",
        toolName: "vertical.records.search",
      },
      environmentId: ID,
      id: ID,
      occurredAt: "2026-07-21T00:00:00.000Z",
      organizationId: ID,
      projectId: ID,
    });

    expect(toolAdapterDefinitionFromRecord(record)).toMatchObject({
      execution: {
        mcpServerId: ID,
        remoteToolName: "search-records",
        type: "mcp",
      },
      toolName: "vertical.records.search",
    });
  });

  test("round-trips synced vendor MCP adapters as provider-bound outbound tools", () => {
    const execution = {
      providerKey: "docs",
      remoteToolName: "docs-update",
      toolHash: `sha256:${"c".repeat(64)}`,
      type: "vendor_mcp",
    } as const;
    const synced = (effect: "read" | "write") =>
      Schema.decodeUnknownSync(ToolAdapterRecord)(
        withCanonicalRecordKeys({
          itemType: "tool-adapter",
          data: {
            createdAt: "2026-10-01T00:00:00.000Z",
            defaultPolicyAction: effect === "read" ? "allow" : "require_approval",
            description: "Update a docs page.",
            effect,
            environmentId: ID,
            execution,
            id: ID,
            inputSchema: { type: "object" },
            name: "docs.docs_update",
            organizationId: ID,
            projectId: ID,
            providerKey: "docs",
            requiredScopes: [effect === "read" ? "tools:read" : "tools:write"],
            status: "active",
            updatedAt: "2026-10-01T00:00:00.000Z",
            version: 3,
          },
        }),
      );

    const write = toolAdapterDefinitionFromRecord(synced("write"));
    expect(write).toMatchObject({
      defaultPolicyAction: "require_approval",
      effect: "write",
      provider: "docs",
      providerOutboundMutation: true,
      requiredScopes: ["tools:write"],
      toolAdapterId: ID,
    });
    expect(write.execution).toEqual(execution);
    expect(toolAdapterDefinitionFromRecord(synced("read"))).toMatchObject({
      provider: "docs",
      providerOutboundMutation: false,
    });
  });

  test("archives unsupported providers and preserves execute mutation claims", () => {
    expect(
      platformToolAdapterDefinitions.find((tool) => tool.toolName === "code.execute"),
    ).toMatchObject({ effect: "execute", providerOutboundMutation: true });
    expect(
      platformToolAdapterDefinitions.find(
        (tool) => tool.toolName === "linkedin_ads.campaigns.create",
      ),
    ).toMatchObject({ defaultPolicyAction: "deny", status: "archived" });
    expect(
      platformToolAdapterDefinitions.find((tool) => tool.toolName === "web.batch_scrape"),
    ).toMatchObject({ effect: "execute", providerOutboundMutation: true });
    expect(
      platformToolAdapterDefinitions.find((tool) => tool.toolName === "snowflake.query.execute"),
    ).toMatchObject({ effect: "execute", providerOutboundMutation: true });
    expect(
      platformToolAdapterDefinitions.find((tool) => tool.toolName === "zendesk.tickets.update"),
    ).toMatchObject({ defaultPolicyAction: "deny", status: "archived" });
    expect(
      platformToolAdapterDefinitions.find(
        (tool) => tool.toolName === "google_search_console.sites.list",
      )?.provider,
    ).toBe("google_search_console");
    expect(
      platformToolAdapterDefinitions.find((tool) => tool.toolName === "sendgrid.email.send"),
    ).toMatchObject({ providerOutboundMutation: true });
    expect(
      platformToolAdapterDefinitions.find(
        (tool) => tool.toolName === "artifact.provider_handoffs.record_result",
      ),
    ).toMatchObject({ providerOutboundMutation: true });
    expect(
      platformToolAdapterDefinitions.find(
        (tool) => tool.toolName === "artifact.provider_handoffs.list",
      )?.providerOutboundMutation,
    ).toBeUndefined();
    expect(
      platformToolAdapterDefinitions.find((tool) => tool.toolName === "onedrive.files.upload"),
    ).toMatchObject({
      defaultPolicyAction: "deny",
      provider: "onedrive",
      providerOutboundMutation: true,
      status: "archived",
    });
  });
});
