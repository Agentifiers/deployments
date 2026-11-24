import { ExtensionToolResponse, ListExtensionToolsResponse } from "@deployments-ai/api-contract";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { invocation } from "./vendor-mcp-authorization.fixture.ts";
import { toolSyncFixture, vendorAdapterRecord } from "./vendor-mcp-tool-sync.fixture.ts";

const TOOL_HASH = `sha256:${"b".repeat(64)}`;

function seeded() {
  const fixture = toolSyncFixture();
  fixture.put(
    vendorAdapterRecord({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FD0",
      name: "docs.docs_search",
      remoteToolName: "docs-search",
      toolHash: TOOL_HASH,
    }),
  );
  return fixture;
}

describe("extensions API with synced vendor MCP tools", () => {
  test("lists and reads synced vendor tools through the public projection", async () => {
    const fixture = seeded();

    const listed = Schema.decodeUnknownSync(ListExtensionToolsResponse)(
      await fixture.service.invoke("listExtensionTools", invocation(undefined)),
    );
    const shown = Schema.decodeUnknownSync(ExtensionToolResponse)(
      await fixture.service.invoke("getExtensionTool", {
        ...invocation(undefined),
        id: "docs.docs_search",
        params: { toolName: "docs.docs_search" },
      }),
    );

    expect(listed.items).toHaveLength(1);
    for (const tool of [listed.items[0], shown]) {
      expect(tool).toMatchObject({
        effect: "read",
        execution: {
          providerKey: "docs",
          remoteToolName: "docs-search",
          toolHash: TOOL_HASH,
          type: "vendor_mcp",
        },
        hasCallbackAuth: false,
        name: "docs.docs_search",
        providerKey: "docs",
      });
    }
  });

  test("rejects creating vendor MCP extensions directly", async () => {
    const fixture = toolSyncFixture();
    expect(
      fixture.service.invoke(
        "createExtensionTool",
        invocation({
          defaultPolicyAction: "allow",
          description: "Search docs",
          effect: "read",
          execution: {
            providerKey: "docs",
            remoteToolName: "docs-search",
            toolHash: TOOL_HASH,
            type: "vendor_mcp",
          },
          inputSchema: { type: "object" },
          name: "docs.search_copy",
          requiredScopes: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "vendor_mcp_tools_are_synced", kind: "invalid-input" });
    expect(fixture.recordsOf("tool-adapter")).toEqual([]);
  });

  test("rejects updating a synced vendor MCP tool", async () => {
    const fixture = seeded();
    expect(
      fixture.service.invoke("updateExtensionTool", {
        ...invocation({ defaultPolicyAction: "allow", description: "Edited", expectedVersion: 0 }),
        id: "docs.docs_search",
        params: { toolName: "docs.docs_search" },
      }),
    ).rejects.toMatchObject({ code: "vendor_mcp_tools_are_synced" });
    expect(fixture.recordsOf("tool-adapter")[0]?.data).toMatchObject({
      description: "Search docs",
      version: 0,
    });
  });
});
