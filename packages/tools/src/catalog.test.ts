import { describe, expect, test } from "bun:test";
import {
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SESSION_EXECUTE_TOOL_NAME,
  CODE_EXECUTE_TOOL_NAME,
  SANDBOX_FILE_TOOL_NAMES,
  SANDBOX_FILES_LIST_TOOL_NAME,
  SANDBOX_FILES_READ_TOOL_NAME,
  SANDBOX_FILES_WRITE_TOOL_NAME,
  findPlatformToolAdapterDefinition,
  platformToolAdapterDefinitions,
  toolEgress,
} from "./index.ts";

describe("platform tool catalog", () => {
  test("allows only the bounded one-shot reminder mutation without approval", () => {
    expect(findPlatformToolAdapterDefinition("agent.schedule.remind")).toMatchObject({
      defaultPolicyAction: "allow",
      effect: "write",
      status: "active",
    });
    expect(findPlatformToolAdapterDefinition("agent.schedule.create")).toMatchObject({
      defaultPolicyAction: "require_approval",
    });
  });
  test("registers the Mermaid-to-diagram artifact builder", () => {
    expect(findPlatformToolAdapterDefinition("artifact.mermaid_to_diagram")).toMatchObject({
      defaultPolicyAction: "allow",
      effect: "write",
      execution: {
        adapterKey: "artifact.mermaid_to_diagram",
        type: "builtin",
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          definition: { maxLength: 50_000, minLength: 1, type: "string" },
          fontSize: { maximum: 48, minimum: 12, type: "integer" },
          style: { enum: ["clean", "sketchy"], type: "string" },
          theme: { enum: ["light", "dark"], type: "string" },
          title: { maxLength: 200, minLength: 1, pattern: "\\S", type: "string" },
        },
        required: ["definition"],
        type: "object",
      },
      status: "active",
    });
  });

  test("registers the browser screenshot built-in", () => {
    expect(platformToolAdapterDefinitions.map(({ toolName }) => toolName)).toContain(
      BROWSER_SCREENSHOT_TOOL_NAME,
    );
    expect(findPlatformToolAdapterDefinition(BROWSER_SCREENSHOT_TOOL_NAME)).toMatchObject({
      defaultPolicyAction: "allow",
      effect: "read",
      execution: {
        adapterKey: BROWSER_SCREENSHOT_TOOL_NAME,
        type: "builtin",
      },
      status: "active",
    });
  });

  test("registers bounded sandboxed code execution", () => {
    expect(findPlatformToolAdapterDefinition(CODE_EXECUTE_TOOL_NAME)).toMatchObject({
      defaultPolicyAction: "allow",
      effect: "execute",
      execution: { adapterKey: CODE_EXECUTE_TOOL_NAME, type: "builtin" },
      inputSchema: {
        additionalProperties: false,
        properties: {
          code: { maxLength: 20_480, minLength: 1, type: "string" },
          language: { enum: ["bash", "javascript", "python"], type: "string" },
          timeoutMs: { maximum: 50_000, minimum: 100, type: "integer" },
        },
        required: ["code", "language"],
        type: "object",
      },
      providerOutboundMutation: true,
      status: "active",
    });
    const maximumEscapedInput = {
      code: "\0".repeat(20_480),
      language: "javascript",
      timeoutMs: 50_000,
    };
    expect(
      new TextEncoder().encode(JSON.stringify(maximumEscapedInput)).byteLength,
    ).toBeLessThanOrEqual(128 * 1024);
  });

  test("registers bounded thread sandbox file tools", () => {
    expect(findPlatformToolAdapterDefinition(SANDBOX_FILES_READ_TOOL_NAME)).toMatchObject({
      defaultPolicyAction: "allow",
      effect: "read",
      execution: { adapterKey: SANDBOX_FILES_READ_TOOL_NAME, type: "builtin" },
      inputSchema: {
        additionalProperties: false,
        properties: {
          maxBytes: { maximum: 65_536, minimum: 1, type: "integer" },
          path: { maxLength: 1024, minLength: 1, type: "string" },
        },
        required: ["path"],
      },
      status: "active",
    });
    expect(findPlatformToolAdapterDefinition(SANDBOX_FILES_WRITE_TOOL_NAME)).toMatchObject({
      effect: "write",
      inputSchema: {
        additionalProperties: false,
        properties: { content: { maxLength: 98_304, type: "string" } },
        required: ["path", "content"],
      },
      providerOutboundMutation: true,
    });
    expect(findPlatformToolAdapterDefinition(SANDBOX_FILES_LIST_TOOL_NAME)).toMatchObject({
      effect: "read",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { maximum: 500, minimum: 1, type: "integer" },
          recursive: { type: "boolean" },
        },
      },
    });
    for (const toolName of SANDBOX_FILE_TOOL_NAMES) {
      const definition = findPlatformToolAdapterDefinition(toolName);
      expect(definition?.requiredScopes).toEqual([]);
      expect(definition?.providerOutboundMutation === true).toBe(
        toolName === SANDBOX_FILES_WRITE_TOOL_NAME,
      );
    }
    const maximumWriteInput = { content: "x".repeat(98_304), path: "x".repeat(1024) };
    expect(
      new TextEncoder().encode(JSON.stringify(maximumWriteInput)).byteLength,
    ).toBeLessThanOrEqual(128 * 1024);
  });

  test("registers approval-gated browser interaction without arbitrary scripts", () => {
    const definition = findPlatformToolAdapterDefinition(BROWSER_SESSION_EXECUTE_TOOL_NAME);
    expect(definition).toMatchObject({
      defaultPolicyAction: "require_approval",
      effect: "write",
      execution: { adapterKey: BROWSER_SESSION_EXECUTE_TOOL_NAME, type: "builtin" },
      providerOutboundMutation: true,
      status: "active",
    });
    expect(definition?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        actions: { maxItems: 16, minItems: 1, type: "array" },
        sessionPlanId: { maxLength: 26, minLength: 26, type: "string" },
        timeoutMs: { maximum: 60_000, minimum: 1_000, type: "integer" },
        url: { maxLength: 1_024, type: "string" },
      },
      required: ["actions", "sessionPlanId", "url"],
      type: "object",
    });
    expect(JSON.stringify(definition?.inputSchema)).not.toContain("evaluate");
    expect(JSON.stringify(definition?.inputSchema)).not.toContain("script");
  });

  test("keeps the largest browser-session input within the runtime persistence boundary", () => {
    const definition = findPlatformToolAdapterDefinition(BROWSER_SESSION_EXECUTE_TOOL_NAME);
    const schema = definition?.inputSchema as {
      properties: {
        actions: {
          items: {
            oneOf: readonly {
              properties: Readonly<Record<string, { maxItems?: number; maxLength?: number }>>;
            }[];
          };
          maxItems: number;
        };
        url: { maxLength: number };
      };
    };
    const typeAction = schema.properties.actions.items.oneOf.find(
      (action) => "text" in action.properties,
    )!;
    const selectorLength = typeAction.properties.selector!.maxLength!;
    const textLength = typeAction.properties.text!.maxLength!;
    for (const action of [
      {
        selector: "\0".repeat(selectorLength),
        text: "\0".repeat(textLength),
        type: "type",
      },
      {
        type: "navigate",
        url: "\0".repeat(schema.properties.url.maxLength),
      },
    ]) {
      const input = {
        actions: Array.from({ length: schema.properties.actions.maxItems }, () => action),
        sessionPlanId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        url: "\0".repeat(schema.properties.url.maxLength),
      };
      expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThanOrEqual(
        128 * 1024,
      );
    }
  });

  test("publishes the complete screenshot input contract", () => {
    expect(findPlatformToolAdapterDefinition(BROWSER_SCREENSHOT_TOOL_NAME)?.inputSchema).toEqual({
      additionalProperties: false,
      properties: {
        format: { enum: ["png", "jpeg", "webp"], type: "string" },
        fullPage: { type: "boolean" },
        selector: { type: "string" },
        timeoutMs: { type: "number" },
        url: { maxLength: 8192, type: "string" },
        viewport: {
          enum: ["mobile", "tablet", "desktop", "wide"],
          type: "string",
        },
        viewportSize: {
          additionalProperties: false,
          properties: {
            height: { type: "number" },
            width: { type: "number" },
          },
          type: "object",
        },
        waitForSelector: { type: "string" },
      },
      required: ["url"],
      type: "object",
    });
  });
});

describe("platform tool egress", () => {
  const active = platformToolAdapterDefinitions.filter(({ status }) => status === "active");

  test("every active builtin classifies its egress explicitly", () => {
    expect(
      active
        .filter((definition) => definition.execution?.type === "builtin" && !definition.egress)
        .map(({ toolName }) => toolName),
    ).toEqual([]);
  });

  test("pins the active tools a data boundary must refuse as public egress", () => {
    expect(
      active
        .filter((definition) => toolEgress(definition) === "public")
        .map(({ toolName }) => toolName)
        .sort(),
    ).toEqual([
      "app.create",
      "app.describe",
      "app.dev_token",
      "app.list",
      "app.migrate",
      "app.promote",
      "app.query",
      "app.release",
      "app.set_publication",
      "artifact.share",
      "browser.capture_screenshot",
      "browser.dom_snapshot.capture",
      "browser.screenshot.capture",
      "browser.session.execute",
      "browser.session.plan",
      "code.execute",
      "computer.action",
      "computer.screenshot",
      "demio.event.registration.create",
      "firecrawl.page.scrape",
      "plivo.messages.send",
      "postmark.email.send",
      "sandbox.files.list",
      "sandbox.files.read",
      "sandbox.files.write",
      "sendgrid.email.send",
      "twilio.messages.send",
      "web.batch_scrape",
      "web.crawl",
      "web.crawl_params_preview",
      "web.deep_research",
      "web.extract",
      "web.generate_llms_txt",
      "web.map",
      "web.parse",
      "web.scrape",
      "web.search",
    ]);
  });

  test("a platform or configured tool takes no URL input it does not gate", () => {
    const GATED_URL_FIELDS: Readonly<Record<string, string>> = {
      "artifact.pdf_report:assets[].sourceUrl":
        "sourceUrl gated at execution by the data boundary.",
      "artifact.pdf_report:citations[].url": "Printed as citation text; never fetched.",
      "strapi.documents.create:baseUrl": "Executor pins requests to the credential's origin.",
      "strapi.documents.list:baseUrl": "Executor pins requests to the credential's origin.",
    };
    const isUrlField = (name: string) =>
      /url$/i.test(name) || /^(?:source)?url/i.test(name) || name === "href";
    const urlFields = (schema: unknown, path = ""): string[] => {
      if (!schema || typeof schema !== "object") return [];
      const { items, properties } = schema as { items?: unknown; properties?: unknown };
      return [
        ...Object.entries(properties && typeof properties === "object" ? properties : {}).flatMap(
          ([name, property]) => [
            ...(isUrlField(name) ? [`${path}${name}`] : []),
            ...urlFields(property, `${path}${name}.`),
          ],
        ),
        ...urlFields(items, path.replace(/\.$/, "[].")),
      ];
    };
    expect(
      active
        .filter((definition) => toolEgress(definition) !== "public")
        .flatMap(({ inputSchema, toolName }) =>
          urlFields(inputSchema).map((field) => `${toolName}:${field}`),
        )
        .filter((field) => !(field in GATED_URL_FIELDS)),
    ).toEqual([]);
  });
});

describe("model-facing input schemas", () => {
  test("every tool's input schema is a plain object schema that every gateway provider accepts", () => {
    const rejected = platformToolAdapterDefinitions.flatMap(({ inputSchema, toolName }) => {
      const schema = inputSchema && typeof inputSchema === "object" ? inputSchema : {};
      const problems = [
        ...("type" in schema && schema.type === "object" ? [] : ['type is not "object"']),
        ...["allOf", "anyOf", "const", "enum", "not", "oneOf"].filter(
          (keyword) => keyword in schema,
        ),
      ];
      return problems.length === 0 ? [] : [{ problems, toolName }];
    });

    expect(platformToolAdapterDefinitions.map(({ toolName }) => toolName)).toContain(
      "app.set_publication",
    );
    expect(rejected).toEqual([]);
  });
});
