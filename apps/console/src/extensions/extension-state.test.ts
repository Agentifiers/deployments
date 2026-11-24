import { describe, expect, test } from "bun:test";
import { PublicId } from "@deployments-ai/api-contract/primitives";
import { Schema } from "effect";
import type { ExtensionSummary } from "../server/tool-directory.ts";
import {
  extensionPage,
  mcpServerOptions,
  parseExtensionLocator,
  parseExtensionSearch,
  parseNewExtensionSearch,
  serverChoices,
  syncDefaultAction,
  syncGroups,
  syncProblem,
} from "./extension-state.ts";

function summary(
  name: string,
  status: string,
  execution: ExtensionSummary["execution"] = { type: "client" },
): ExtensionSummary {
  return {
    defaultPolicyAction: "allow",
    effect: "read",
    execution,
    id: Schema.decodeUnknownSync(PublicId)(`01K${String(name.charCodeAt(0)).padStart(23, "0")}`),
    name,
    requiredScopes: [],
    status,
    version: 0,
  };
}

const extensions = [
  summary("zeta", "active"),
  summary("alpha", "archived"),
  summary("beta", "active", {
    contentHash: `sha256:${"a".repeat(64)}`,
    secretNames: [],
    type: "hosted_code",
  }),
  summary("gamma", "archived", {
    contentHash: `sha256:${"a".repeat(64)}`,
    secretNames: [],
    type: "hosted_code",
  }),
];

describe("extensionPage", () => {
  const complete = { complete: true, extensions };

  test("the active view hides archived extensions and counts them", () => {
    const page = extensionPage(complete, { offset: 0, pageSize: 25, search: {} });
    expect(page.extensions.map(({ name }) => name)).toEqual(["beta", "zeta"]);
    expect(page.hidden).toBe(2);
    expect(page.nextOffset).toBeUndefined();
  });

  test("the all view lists active extensions before archived ones", () => {
    const page = extensionPage(complete, { offset: 0, pageSize: 3, search: { show: "all" } });
    expect(page.extensions.map(({ name }) => name)).toEqual(["beta", "zeta", "alpha"]);
    expect(page.hidden).toBe(0);
    expect(page.nextOffset).toBe(3);
  });

  test("a type filter applies before the hidden count", () => {
    const page = extensionPage(complete, {
      offset: 0,
      pageSize: 25,
      search: { type: "hosted_code" },
    });
    expect(page.extensions.map(({ name }) => name)).toEqual(["beta"]);
    expect(page.hidden).toBe(1);
  });

  test("a capped directory marks every page with the number of extensions read", () => {
    const capped = { complete: false, extensions };
    expect(
      [0, 1].map((offset) => extensionPage(capped, { offset, pageSize: 1, search: {} }).cappedAt),
    ).toEqual([4, 4]);
    expect(extensionPage(complete, { offset: 0, pageSize: 1, search: {} }).cappedAt).toBe(
      undefined,
    );
  });
});

describe("parseExtensionLocator", () => {
  test("keeps a well-formed tool name and drops anything else", () => {
    expect(parseExtensionLocator({ name: "acme.lookup/v2" })).toEqual({ name: "acme.lookup/v2" });
    expect(parseExtensionLocator({ name: "-bad" })).toEqual({});
    expect(parseExtensionLocator({ name: 7 })).toEqual({});
  });
});

describe("syncProblem", () => {
  const problem = {
    code: "connection_not_verified",
    detail: "Tool sync requires an active, verified vendor MCP connection.",
    requestId: "req_1",
    status: 422,
    title: "Unprocessable",
  };

  test("an unverified connection gets sync advice after the server's message", () => {
    expect(syncProblem(problem)).toEqual({
      detail:
        "Tool sync requires an active, verified vendor MCP connection. Verify the connection, then sync again.",
      requestId: "req_1",
      status: 422,
      title: "Connection not verified",
    });
  });

  test("other problems pass through", () => {
    const other = { ...problem, code: "connection_not_vendor_mcp" };
    expect(syncProblem(other)).toBe(other);
  });
});

describe("serverChoices", () => {
  const listed = { id: "01M4CGXP4MSH02TQKZC4HB0CET", name: "Docs", toolAllowlist: ["search"] };
  const beyond = { id: "01M4CGXP4MSH02TQKZC4HB0CEV", name: "Wiki", toolAllowlist: [] };

  test("a server read beyond the capped list joins the choices once", () => {
    expect(serverChoices([listed], beyond)).toEqual([listed, beyond]);
    expect(serverChoices([listed, beyond], beyond)).toEqual([listed, beyond]);
    expect(serverChoices([listed], undefined)).toEqual([listed]);
  });
});

describe("mcpServerOptions", () => {
  const server = (id: string, name: string, status: string) => ({
    endpointOrigin: "https://mcp.example.com",
    hasAuth: false,
    id: Schema.decodeUnknownSync(PublicId)(id),
    name,
    status,
    toolAllowlist: ["search"],
    version: 1,
  });
  const servers = [
    server("01K0000000000000000000000S", "Docs", "active"),
    server("01K0000000000000000000000T", "Old", "archived"),
  ];

  test("offers the directory's active servers and whether either read hit its cap", () => {
    const docs = { id: "01K0000000000000000000000S", name: "Docs", toolAllowlist: ["search"] };
    expect(mcpServerOptions({ complete: false, connections: [], servers })).toEqual({
      capped: true,
      servers: [docs],
    });
    expect(mcpServerOptions({ complete: true, connections: [], servers })).toEqual({
      capped: false,
      servers: [docs],
    });
  });
});

describe("syncDefaultAction", () => {
  test("only a classified read is allowed by default; every other tool needs approval", () => {
    expect(
      (
        [
          { classified: true, effect: "read" },
          { classified: true, effect: "write" },
          { classified: false, effect: "read" },
          { classified: false, effect: "write" },
        ] as const
      ).map((tool) => syncDefaultAction(tool)),
    ).toEqual(["allow", "require_approval", "require_approval", "require_approval"]);
  });
});

describe("search parsing", () => {
  test("keeps only known views and kinds", () => {
    expect(parseExtensionSearch({ show: "all", type: "vendor_mcp" })).toEqual({
      show: "all",
      type: "vendor_mcp",
    });
    expect(parseExtensionSearch({ show: "archived", type: "builtin" })).toEqual({});
  });

  test("a discovered MCP tool prefills the new form; a malformed server ID is dropped", () => {
    expect(
      parseNewExtensionSearch({
        remote: "search",
        server: "01M4CGXP4MSH02TQKZC4HB0CET",
        type: "mcp",
      }),
    ).toEqual({ remote: "search", server: "01M4CGXP4MSH02TQKZC4HB0CET", type: "mcp" });
    expect(parseNewExtensionSearch({ remote: "", server: "nope", type: "vendor_mcp" })).toEqual({});
  });
});

describe("syncGroups", () => {
  test("groups changes with rejections first and drops empty groups", () => {
    const change = (remoteName: string, kind: "created" | "rejected" | "unchanged") => ({
      change: kind,
      classified: true,
      destructive: false,
      effect: "read" as const,
      remoteName,
    });
    const groups = syncGroups([
      change("list_issues", "unchanged"),
      change("bad tool", "rejected"),
      change("create_issue", "created"),
      change("get_issue", "unchanged"),
    ]);
    expect(
      groups.map(({ change: kind, tools }) => [kind, tools.map(({ remoteName }) => remoteName)]),
    ).toEqual([
      ["rejected", ["bad tool"]],
      ["created", ["create_issue"]],
      ["unchanged", ["list_issues", "get_issue"]],
    ]);
  });
});
