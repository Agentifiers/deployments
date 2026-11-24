import { describe, expect, test } from "bun:test";
import { normalizeProviderDefinition } from "./provider-definition-normalization.ts";
import { notionLikeInput } from "./vendor-mcp.fixture.ts";
import {
  vendorMcpResolveToolNames,
  vendorMcpToolEffect,
  vendorMcpToolName,
  vendorMcpToolRequiredScopes,
} from "./vendor-mcp-tools.ts";
import { VendorMcpConfigurationError } from "./vendor-mcp-template.ts";

describe("vendorMcpToolName", () => {
  const cases: readonly (readonly [string, string | undefined])[] = [
    ["getJiraIssue", "jira.get_jira_issue"],
    ["notion-search", "jira.notion_search"],
    ["getHTTPResponse", "jira.get_http_response"],
    ["search_v2", "jira.search_v2"],
    ["  List Items!! ", "jira.list_items"],
    ["__private__tool__", "jira.private_tool"],
    ["2fa-status", "jira.t_2fa_status"],
    ["résumé.parse", "jira.r_sum_parse"],
    ["---", undefined],
    ["", undefined],
    ["日本語", undefined],
    ["a".repeat(124), undefined],
  ];
  for (const [remoteName, expected] of cases) {
    test(`${JSON.stringify(remoteName)} -> ${String(expected)}`, () => {
      expect(vendorMcpToolName("jira", remoteName)).toBe(expected);
    });
  }

  test("accepts names up to 128 characters", () => {
    expect(vendorMcpToolName("jira", "a".repeat(123))?.length).toBe(128);
  });
});

describe("vendorMcpResolveToolNames", () => {
  test("rejects every tool in a normalized-name collision regardless of order", () => {
    const resolved = vendorMcpResolveToolNames("notion", [
      "getPage",
      "notion-search",
      "get_page",
      "get-page",
      "???",
    ]);
    expect(resolved).toEqual([
      { remoteName: "getPage", rejected: "name_collision" },
      { remoteName: "notion-search", toolName: "notion.notion_search" },
      { remoteName: "get_page", rejected: "name_collision" },
      { remoteName: "get-page", rejected: "name_collision" },
      { remoteName: "???", rejected: "invalid_name" },
    ]);
  });
});

describe("vendorMcpToolEffect", () => {
  const definition = normalizeProviderDefinition(notionLikeInput);

  test("uses the code-owned classification", () => {
    expect(vendorMcpToolEffect(definition, "notion-search")).toEqual({
      effect: "read",
      destructive: false,
      classified: true,
    });
    expect(vendorMcpToolEffect(definition, "notion-update-page")).toEqual({
      effect: "write",
      destructive: false,
      classified: true,
    });
    expect(vendorMcpToolEffect(definition, "notion-delete")).toEqual({
      effect: "write",
      destructive: true,
      classified: true,
    });
  });

  test("treats unclassified tools, including prototype keys, as unclassified writes", () => {
    for (const name of ["notion-new-tool", "constructor", "__proto__"]) {
      expect(vendorMcpToolEffect(definition, name)).toEqual({
        effect: "write",
        destructive: false,
        classified: false,
      });
    }
  });

  test("requires a vendor_mcp definition", () => {
    const native = normalizeProviderDefinition({
      key: "plain",
      displayName: "Plain",
      category: "data",
      route: "platform_webhook",
      status: "planned",
      auth: { kind: "none" },
      verification: { method: "none", required: false },
    });
    expect(() => vendorMcpToolEffect(native, "x")).toThrow(VendorMcpConfigurationError);
  });

  test("maps effects to capability scopes", () => {
    expect(vendorMcpToolRequiredScopes("read")).toEqual(["tools:read"]);
    expect(vendorMcpToolRequiredScopes("write")).toEqual(["tools:write"]);
  });
});
