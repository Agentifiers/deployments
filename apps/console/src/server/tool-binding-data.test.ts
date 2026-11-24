import { describe, expect, test } from "bun:test";
import { ExtensionToolResponse, PublicId } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { toolDefinitions, type ToolLookup } from "./tool-binding-data.ts";
import { extensionSummary, type ExtensionSummary } from "./tool-directory.ts";

const id = (label: string) => Schema.decodeUnknownSync(PublicId)(`01K${label.padStart(23, "0")}`);
const SERVER = id("S1");

function mcpExtension(name: string, status = "active") {
  return extensionSummary(
    Schema.decodeUnknownSync(ExtensionToolResponse)({
      createdAt: "2026-10-01T00:00:00.000Z",
      defaultPolicyAction: "require_approval",
      description: "A tool.",
      effect: "read",
      execution: { mcpServerId: SERVER, remoteToolName: "search", type: "mcp" },
      hasCallbackAuth: false,
      id: id("E1"),
      inputSchema: { properties: {}, type: "object" },
      name,
      requiredScopes: ["records:read"],
      status,
      updatedAt: "2026-10-01T00:00:00.000Z",
      version: 1,
    }),
  );
}

function lookup(extensions: readonly ExtensionSummary[]) {
  const extensionReads: string[] = [];
  const tools: ToolLookup = {
    catalog: async () => ({
      defaultPolicyAction: "allow",
      policyBinding: "connection",
      providerKey: "hubspot",
      requiredScopes: ["crm.read"],
      status: "active",
    }),
    extension: async (toolName) => {
      extensionReads.push(toolName);
      return extensions.find(({ name }) => name === toolName);
    },
  };
  return { extensionReads, tools };
}

const CATALOG = {
  defaultPolicyAction: "allow",
  requiredScopes: ["crm.read"],
  route: { kind: "provider", providerKey: "hubspot" },
} as const;
const MCP = {
  defaultPolicyAction: "require_approval",
  requiredScopes: ["records:read"],
  route: { kind: "mcp", mcpServerId: SERVER },
} as const;

describe("toolDefinitions", () => {
  test("an extension past the directory cap shadows the catalog tool of the same name", async () => {
    const { extensionReads, tools } = lookup([mcpExtension("crm.read")]);
    const definitions = await toolDefinitions(
      ["crm.read", "crm.write"],
      { complete: false, extensions: [] },
      tools,
    );
    expect(Object.fromEntries(definitions)).toEqual({ "crm.read": MCP, "crm.write": CATALOG });
    expect(extensionReads).toEqual(["crm.read", "crm.write"]);
  });

  test("a capped directory listing only an archived entry still reads the active extension", async () => {
    const { extensionReads, tools } = lookup([mcpExtension("crm.read")]);
    const definitions = await toolDefinitions(
      ["crm.read"],
      { complete: false, extensions: [mcpExtension("crm.read", "archived")] },
      tools,
    );
    expect(Object.fromEntries(definitions)).toEqual({ "crm.read": MCP });
    expect(extensionReads).toEqual(["crm.read"]);
  });

  test("a complete directory decides alone, and a listed inactive extension falls to the catalog", async () => {
    const { extensionReads, tools } = lookup([mcpExtension("crm.write")]);
    const definitions = await toolDefinitions(
      ["crm.read", "crm.write", "search"],
      {
        complete: true,
        extensions: [mcpExtension("search"), mcpExtension("crm.read", "archived")],
      },
      tools,
    );
    expect(Object.fromEntries(definitions)).toEqual({
      "crm.read": CATALOG,
      "crm.write": CATALOG,
      search: MCP,
    });
    expect(extensionReads).toEqual([]);
  });
});
