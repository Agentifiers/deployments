import { describe, expect, test } from "bun:test";
import { platformToolAdapterDefinitions } from "./catalog.ts";
import {
  SELF_HOSTED_WEB_OPERATION_OPTION_NAMES,
  SELF_HOSTED_WEB_TOOL_NAMES,
  selfHostedWebToolDefinitions,
} from "./web.ts";

describe("self-hosted web tool catalog", () => {
  test("registers the complete Firecrawl and browser capability surface", () => {
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toHaveLength(19);
    expect(new Set(SELF_HOSTED_WEB_TOOL_NAMES).size).toBe(19);
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toContain("web.scrape");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toContain("web.batch_scrape");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toContain("web.crawl");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toContain("web.crawl_params_preview");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toContain("web.map");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toContain("web.search");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toContain("web.extract");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).toContain("web.parse");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).not.toContain("web.crawl_active");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).not.toContain("web.queue_status");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).not.toContain("web.agent");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).not.toContain("browser.session_create");
    expect(SELF_HOSTED_WEB_TOOL_NAMES).not.toContain("web.usage_credits");
  });

  test("publishes every capability as an active builtin adapter", () => {
    expect(selfHostedWebToolDefinitions.map(({ toolName }) => toolName)).toEqual(
      SELF_HOSTED_WEB_TOOL_NAMES,
    );
    for (const definition of selfHostedWebToolDefinitions) {
      expect(definition.status).toBe("active");
      expect(definition.execution).toEqual({
        adapterKey: definition.toolName,
        type: "builtin",
      });
      expect(definition.requiredScopes).toEqual([]);
      expect(definition.inputSchema).toMatchObject({ type: "object" });
      expect(definition.inputSchema).toMatchObject({
        properties: { idempotencyKey: { maxLength: 512, type: "string" } },
      });
    }
    expect(
      platformToolAdapterDefinitions.filter(({ toolName }) => toolName.startsWith("web.")),
    ).toHaveLength(19);
  });

  test("classifies job starts and cancellations as replay-protected mutations", () => {
    const definitions = new Map(
      selfHostedWebToolDefinitions.map((definition) => [definition.toolName, definition]),
    );
    for (const toolName of [
      "web.batch_scrape",
      "web.batch_scrape_cancel",
      "web.crawl",
      "web.crawl_cancel",
      "web.deep_research",
      "web.extract",
      "web.generate_llms_txt",
    ]) {
      expect(definitions.get(toolName)).toMatchObject({
        effect: "execute",
        providerOutboundMutation: true,
      });
    }
  });

  test("bounds public URL arrays in the published schemas", () => {
    const definitions = new Map(
      selfHostedWebToolDefinitions.map((definition) => [definition.toolName, definition]),
    );
    expect(definitions.get("web.batch_scrape")?.inputSchema).toMatchObject({
      properties: {
        urls: {
          items: { maxLength: 4_096, type: "string" },
          maxItems: 100,
          minItems: 1,
          type: "array",
        },
      },
    });
    expect(definitions.get("web.extract")?.inputSchema).toMatchObject({
      properties: {
        urls: {
          items: { maxLength: 4_096, type: "string" },
          maxItems: 10,
          minItems: 1,
          type: "array",
        },
      },
    });
  });

  test("publishes bounded crawl and v2 map schemas", () => {
    const definitions = new Map(
      selfHostedWebToolDefinitions.map((definition) => [definition.toolName, definition]),
    );
    expect(definitions.get("web.crawl")?.inputSchema).toMatchObject({
      properties: {
        limit: { maximum: 100, minimum: 1, type: "integer" },
      },
    });
    expect(definitions.get("web.map")?.inputSchema).toMatchObject({
      properties: {
        sitemap: { enum: ["only", "include", "skip"], type: "string" },
      },
    });
  });

  test("references durable artifacts for document parsing", () => {
    const parse = selfHostedWebToolDefinitions.find(
      (definition) => definition.toolName === "web.parse",
    );
    expect(parse?.inputSchema).toMatchObject({
      properties: { artifactId: { type: "string" } },
      required: ["artifactId"],
    });
    expect(parse?.inputSchema).not.toHaveProperty("properties.fileBase64");
  });

  test("publishes closed operation-specific option schemas", () => {
    const definitions = new Map(
      selfHostedWebToolDefinitions.map((definition) => [definition.toolName, definition]),
    );
    for (const [toolName, names] of Object.entries(SELF_HOSTED_WEB_OPERATION_OPTION_NAMES)) {
      const inputSchema = definitions.get(toolName)?.inputSchema as
        | { properties?: Record<string, Record<string, unknown>> }
        | undefined;
      const options = inputSchema?.properties?.options;
      expect(options?.additionalProperties).toBe(false);
      expect(
        Object.keys((options?.properties as Record<string, unknown>) ?? {}).toSorted(),
      ).toEqual([...names].toSorted());
    }
  });

  test("publishes Firecrawl-compatible search categories", () => {
    const search = selfHostedWebToolDefinitions.find(
      (definition) => definition.toolName === "web.search",
    );
    expect(search?.inputSchema).toMatchObject({
      properties: {
        categories: {
          oneOf: [
            { items: { enum: ["github", "research", "pdf"] }, type: "array" },
            { type: "array" },
          ],
        },
        sources: { oneOf: expect.any(Array) },
        options: {
          properties: {
            enterprise: {
              items: { enum: ["default", "anon", "zdr"], type: "string" },
              type: "array",
            },
            location: { type: "string" },
            sources: { oneOf: expect.any(Array) },
          },
        },
      },
    });
  });

  test("requires approval for browser mutation and cancellation tools", () => {
    const byName = new Map(selfHostedWebToolDefinitions.map((tool) => [tool.toolName, tool]));
    for (const toolName of ["web.batch_scrape_cancel", "web.crawl_cancel"]) {
      expect(byName.get(toolName)?.defaultPolicyAction).toBe("require_approval");
    }
  });
});
