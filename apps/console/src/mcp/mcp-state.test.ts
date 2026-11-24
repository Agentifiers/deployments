import { PublicId } from "@deployments-ai/api-contract/primitives";
import { ConnectionGrantResponse } from "@deployments-ai/api-contract/providers";
import {
  CreateMcpServerRequest,
  McpConnectionResponse,
  McpServerResponse,
  UpdateMcpServerRequest,
} from "@deployments-ai/api-contract/tooling";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { GrantView, PinningDeploymentView } from "../connections/connection-state.ts";
import {
  authChoices,
  authReplacementRequired,
  createServerBody,
  discoveryRows,
  EMPTY_SERVER_DRAFT,
  parseEndpoint,
  parseServerSearch,
  parseToolAllowlist,
  pinning,
  readServerDraft,
  serverActions,
  serverAuth,
  serverChanges,
  serverDraft,
  serverRows,
  serverUsage,
  type McpConnectionSummary,
  type McpServerDraft,
  type McpServerView,
} from "./mcp-state.ts";

const publicId = Schema.decodeUnknownSync(PublicId);
const SERVER = publicId("01K00000000000000000000MS1");
const OTHER_SERVER = publicId("01K00000000000000000000MS2");
const CONNECTION = publicId("01K00000000000000000000MC1");
const NEWER_CONNECTION = publicId("01K00000000000000000000MC2");
const REVOKED_CONNECTION = publicId("01K00000000000000000000MC3");
const OTHER_CONNECTION = publicId("01K00000000000000000000MC4");
const GRANT = publicId("01K00000000000000000000GR1");
const REVOKED_GRANT = publicId("01K00000000000000000000GR2");
const OTHER_GRANT = publicId("01K00000000000000000000GR3");
const DEPLOYMENT = publicId("01K00000000000000000000DP1");
const STOPPED_DEPLOYMENT = publicId("01K00000000000000000000DP2");
const OTHER_DEPLOYMENT = publicId("01K00000000000000000000DP3");

function server(
  overrides: Partial<
    Record<"endpointPath" | "hasAuth" | "id" | "name" | "status" | "toolAllowlist", unknown>
  > = {},
): McpServerView {
  return Schema.decodeUnknownSync(McpServerResponse)({
    createdAt: "2026-09-01T00:00:00.000Z",
    endpointOrigin: "https://mcp.example.com",
    endpointPath: "/mcp",
    hasAuth: true,
    id: SERVER,
    name: "Docs",
    status: "active",
    toolAllowlist: ["search", "fetch"],
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 3,
    ...overrides,
  });
}

function connection(id: PublicId, mcpServerId: PublicId, status: string): McpConnectionSummary {
  return Schema.decodeUnknownSync(McpConnectionResponse)({
    createdAt: "2026-09-01T00:00:00.000Z",
    id,
    mcpServerId,
    status,
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
  });
}

function grant(id: PublicId, connectionId: PublicId, status: "active" | "revoked"): GrantView {
  return Schema.decodeUnknownSync(ConnectionGrantResponse)({
    authorizationVersion: 1,
    connectionId,
    createdAt: "2026-09-02T00:00:00.000Z",
    externalAccountId: SERVER,
    externalResourceConstraints: {},
    id,
    providerKey: "mcp",
    purpose: "agent-runtime",
    scopes: ["docs:read"],
    status,
    updatedAt: "2026-09-02T00:00:00.000Z",
    version: 1,
    workspaceId: "01K00000000000000000000WS1",
  });
}

function deployment(
  id: PublicId,
  pins: Readonly<Record<string, string>>,
  desiredState: PinningDeploymentView["desiredState"] = "running",
): PinningDeploymentView {
  return {
    agentDefinitionId: publicId("01K00000000000000000000DF1"),
    currentState: desiredState === "stopped" ? "stopped" : "ready",
    desiredState,
    id,
    runtimeConfig: {
      apiVersion: "agents.deployments.ai/v1",
      kind: "AgentDeploymentConfig",
      toolAuthorizations: Object.fromEntries(
        Object.entries(pins).map(([tool, authorizationId]) => [tool, { authorizationId }]),
      ),
    },
    version: 2,
  };
}

const draft = (overrides: Partial<McpServerDraft>): McpServerDraft => ({
  auth: "none",
  endpoint: "https://mcp.example.com/mcp",
  name: "Docs",
  secret: "",
  toolAllowlist: "search\nfetch",
  ...overrides,
});

describe("parseEndpoint", () => {
  test("splits one URL into the contract's origin and path, keeping the query", () => {
    expect(parseEndpoint(" https://MCP.example.com:443/v1/mcp?tenant=a ")).toEqual({
      ok: true,
      value: { origin: "https://mcp.example.com", path: "/v1/mcp?tenant=a" },
    });
    expect(parseEndpoint("https://mcp.example.com")).toEqual({
      ok: true,
      value: { origin: "https://mcp.example.com", path: "/" },
    });
  });

  test("names what is wrong with a URL the contract refuses", () => {
    expect(parseEndpoint("mcp.example.com/mcp")).toEqual({
      message: "Enter a full URL, such as https://mcp.example.com/mcp.",
      ok: false,
    });
    expect(parseEndpoint("http://mcp.example.com/mcp")).toEqual({
      message: "The endpoint must use HTTPS.",
      ok: false,
    });
    expect(parseEndpoint("https://user:pass@mcp.example.com/mcp")).toEqual({
      message: "Put credentials under Authentication, not in the URL.",
      ok: false,
    });
    expect(parseEndpoint("https://mcp.example.com/mcp#tools")).toEqual({
      message: "The endpoint cannot have a # fragment.",
      ok: false,
    });
  });
});

describe("parseToolAllowlist", () => {
  test("reads one name per line, keeping spaces and commas inside a name", () => {
    expect(parseToolAllowlist(" search docs \na,b\n\nsearch docs\nfetch")).toEqual({
      ok: true,
      value: ["search docs", "a,b", "fetch"],
    });
  });

  test("requires at least one tool", () => {
    expect(parseToolAllowlist(" \n ")).toEqual({
      message: "List at least one tool. The platform calls only allowlisted tools.",
      ok: false,
    });
  });
});

describe("an edit that leaves a field alone", () => {
  test.each(["/a b", "/mcp?", "/café", "/a/.."])(
    "keeps the stored path %s and the stored secret when only the name changes",
    (endpointPath) => {
      const before = server({ endpointPath, toolAllowlist: ["a,b", "search docs"] });
      const form = readServerDraft({ ...serverDraft(before), name: "Docs v2" }, before);
      expect(form.authChoices).toEqual(["keep", "bearerToken", "authorization"]);
      if (!form.value) throw new Error("expected a valid form");
      expect(serverChanges(before, form.value)).toEqual({ name: "Docs v2" });
    },
  );

  test("a retyped endpoint is read as a new URL", () => {
    const before = server({ endpointPath: "/a b", hasAuth: false });
    const form = readServerDraft(
      { ...serverDraft(before), endpoint: "https://mcp.example.com/a b " },
      before,
    );
    if (!form.value) throw new Error("expected a valid form");
    expect(serverChanges(before, form.value)).toEqual({ endpointPath: "/a%20b" });
  });
});

describe("auth replacement rule", () => {
  const before = server();

  test("an authenticated server that moves to a new origin or path needs new auth", () => {
    expect(
      authReplacementRequired(before, { origin: "https://mcp.example.com", path: "/mcp" }),
    ).toBe(false);
    expect(
      authReplacementRequired(before, { origin: "https://mcp.example.com", path: "/v2" }),
    ).toBe(true);
    expect(
      authReplacementRequired(before, { origin: "https://other.example.com", path: "/mcp" }),
    ).toBe(true);
    expect(
      authReplacementRequired(server({ hasAuth: false }), {
        origin: "https://other.example.com",
        path: "/mcp",
      }),
    ).toBe(false);
  });

  test("offers keep only while the endpoint is unchanged, and never removal", () => {
    expect(authChoices(undefined, undefined)).toEqual(["none", "bearerToken", "authorization"]);
    expect(authChoices(server({ hasAuth: false }), undefined)).toEqual([
      "none",
      "bearerToken",
      "authorization",
    ]);
    expect(authChoices(before, { origin: "https://mcp.example.com", path: "/mcp" })).toEqual([
      "keep",
      "bearerToken",
      "authorization",
    ]);
    expect(authChoices(before, { origin: "https://mcp.example.com", path: "/v2" })).toEqual([
      "bearerToken",
      "authorization",
    ]);
  });

  test("an edit that moves the endpoint while keeping auth cannot be submitted", () => {
    const form = readServerDraft(
      { ...serverDraft(before), endpoint: "https://mcp.example.com/v2" },
      before,
    );
    expect(form.auth).toEqual({
      message:
        "The endpoint changed, so enter new authentication. The platform does not send the stored secret to a different endpoint.",
      ok: false,
    });
    expect(form.value).toBeUndefined();
  });

  test("the same edit with a new token sends the new endpoint and the replacement", () => {
    const form = readServerDraft(
      {
        ...serverDraft(before),
        auth: "bearerToken",
        secret: " new-token ",
        endpoint: "https://mcp.example.com/v2",
      },
      before,
    );
    if (!form.value) throw new Error("expected a valid form");
    const changes = serverChanges(before, form.value);
    expect(changes).toEqual({ auth: { bearerToken: "new-token" }, endpointPath: "/v2" });
    expect(
      Schema.decodeUnknownSync(UpdateMcpServerRequest)({ ...changes, expectedVersion: 3 }),
    ).toEqual({ auth: { bearerToken: "new-token" }, endpointPath: "/v2", expectedVersion: 3 });
  });

  test("removing stored auth is not a choice", () => {
    expect(readServerDraft({ ...serverDraft(before), auth: "none" }, before).auth).toEqual({
      message: "Stored authentication can be replaced but not removed.",
      ok: false,
    });
  });
});

describe("readServerDraft", () => {
  test("the empty create form names every missing field", () => {
    const form = readServerDraft(EMPTY_SERVER_DRAFT);
    expect(form.name).toEqual({ message: "Enter a name of 1 to 120 characters.", ok: false });
    expect(form.endpoint.ok).toBe(false);
    expect(form.toolAllowlist.ok).toBe(false);
    expect(form.auth).toEqual({ ok: true, value: { kind: "none" } });
    expect(form.value).toBeUndefined();
  });

  test("a set secret must be non-empty and free of control characters", () => {
    expect(readServerDraft(draft({ auth: "authorization", secret: "  " })).auth).toEqual({
      message: "Enter the secret value.",
      ok: false,
    });
    expect(readServerDraft(draft({ auth: "authorization", secret: "Basic a\nb" })).auth).toEqual({
      message: "The secret cannot contain control characters or line breaks.",
      ok: false,
    });
  });

  test("a typed secret is ignored unless a secret option is chosen", () => {
    expect(readServerDraft(draft({ auth: "none", secret: "left over" })).value?.auth).toEqual({
      kind: "none",
    });
  });

  test("a new allowlist line with a comma gets a hint and still submits as one name", () => {
    const form = readServerDraft(draft({ toolAllowlist: "search, fetch" }));
    expect(form.toolAllowlistHint).toBe("Put each tool on its own line.");
    expect(form.value?.toolAllowlist).toEqual(["search, fetch"]);
    expect(readServerDraft(draft({ toolAllowlist: "search\nfetch" })).toolAllowlistHint).toBe(
      undefined,
    );
  });

  test("a stored name with a comma gets no hint until a changed line has one", () => {
    const before = server({ toolAllowlist: ["a,b", "search"] });
    expect(readServerDraft(serverDraft(before), before).toolAllowlistHint).toBe(undefined);
    expect(
      readServerDraft({ ...serverDraft(before), toolAllowlist: "a,b\nsearch\nfetch" }, before)
        .toolAllowlistHint,
    ).toBe(undefined);
    expect(
      readServerDraft({ ...serverDraft(before), toolAllowlist: "a,b\nsearch,fetch" }, before)
        .toolAllowlistHint,
    ).toBe("Put each tool on its own line.");
  });
});

describe("createServerBody", () => {
  test.each([
    [{ auth: "none", secret: "" } as const, {}],
    [{ auth: "bearerToken", secret: "tok" } as const, { auth: { bearerToken: "tok" } }],
    [
      { auth: "authorization", secret: "Basic dXNlcjpwYXNz" } as const,
      { auth: { authorization: "Basic dXNlcjpwYXNz" } },
    ],
  ])("auth %o becomes a contract-valid body", (choice, expectedAuth) => {
    const form = readServerDraft(draft(choice));
    if (!form.value) throw new Error("expected a valid form");
    const body = createServerBody(form.value);
    const expected = {
      ...expectedAuth,
      endpointOrigin: "https://mcp.example.com",
      endpointPath: "/mcp",
      name: "Docs",
      toolAllowlist: ["search", "fetch"],
    };
    expect(body).toEqual(expected);
    expect(Schema.decodeUnknownSync(CreateMcpServerRequest)(body)).toEqual(expected);
  });
});

describe("serverChanges", () => {
  const before = server();

  test("an unchanged form saves nothing, and a reordered allowlist is unchanged", () => {
    const form = readServerDraft(
      { ...serverDraft(before), toolAllowlist: "fetch\nsearch" },
      before,
    );
    if (!form.value) throw new Error("expected a valid form");
    expect(serverChanges(before, form.value)).toEqual({});
  });

  test("sends only the changed fields and keeps stored auth out of the body", () => {
    const form = readServerDraft(
      { ...serverDraft(before), name: "Docs v2", toolAllowlist: "search\nfetch\nlist" },
      before,
    );
    if (!form.value) throw new Error("expected a valid form");
    expect(serverChanges(before, form.value)).toEqual({
      name: "Docs v2",
      toolAllowlist: ["search", "fetch", "list"],
    });
  });

  test("an unauthenticated server can move anywhere without auth", () => {
    const open = server({ hasAuth: false });
    const form = readServerDraft(
      { ...serverDraft(open), endpoint: "https://other.example.com/mcp" },
      open,
    );
    if (!form.value) throw new Error("expected a valid form");
    expect(serverChanges(open, form.value)).toEqual({
      endpointOrigin: "https://other.example.com",
    });
  });
});

describe("server list and actions", () => {
  const servers = [
    server({ id: OTHER_SERVER, name: "Archived", status: "archived" }),
    server({ name: "Zeta" }),
  ];
  const connections = [
    connection(CONNECTION, SERVER, "active"),
    connection(REVOKED_CONNECTION, SERVER, "revoked"),
    connection(OTHER_CONNECTION, OTHER_SERVER, "active"),
  ];

  test("the active view hides archived servers and counts active connections", () => {
    expect(serverRows({ complete: true, connections, servers }, "active")).toEqual({
      complete: true,
      hidden: 1,
      rows: [{ activeConnections: 1, server: servers[1]! }],
    });
    expect(
      serverRows({ complete: true, connections, servers }, "all").rows.map((row) => [
        row.server.name,
        row.activeConnections,
      ]),
    ).toEqual([
      ["Zeta", 1],
      ["Archived", 1],
    ]);
  });

  test("a capped directory marks the rows and their counts incomplete", () => {
    expect(serverRows({ complete: false, connections, servers }, "active")).toEqual({
      complete: false,
      hidden: 1,
      rows: [{ activeConnections: 1, server: servers[1]! }],
    });
  });

  test("search keeps only show=all", () => {
    expect(parseServerSearch({ show: "all" })).toEqual({ show: "all" });
    expect(parseServerSearch({ show: "archived" })).toEqual({});
  });

  test("only an active server can be edited, discovered, connected, or archived", () => {
    expect(serverActions({ status: "active" })).toEqual(["edit", "discover", "connect", "archive"]);
    expect(serverActions({ status: "archived" })).toEqual([]);
  });

  test("an archived server's secret reads as deleted, because archiving revokes it", () => {
    expect(serverAuth({ hasAuth: true, status: "active" })).toBe("stored");
    expect(serverAuth({ hasAuth: true, status: "archived" })).toBe("deleted");
    expect(serverAuth({ hasAuth: false, status: "archived" })).toBe("none");
  });
});

describe("discoveryRows", () => {
  test("lists every allowlisted tool and marks the ones the server did not advertise", () => {
    expect(
      discoveryRows(["search", "fetch"], {
        tools: [
          { description: "Search docs", inputSchema: { type: "object" }, remoteName: "search" },
        ],
      }),
    ).toEqual([
      {
        remoteName: "search",
        tool: { description: "Search docs", inputSchema: { type: "object" }, remoteName: "search" },
      },
      { remoteName: "fetch", tool: undefined },
    ]);
  });
});

describe("serverUsage", () => {
  const connections = [
    connection(REVOKED_CONNECTION, SERVER, "revoked"),
    connection(CONNECTION, SERVER, "active"),
    connection(NEWER_CONNECTION, SERVER, "error"),
    connection(OTHER_CONNECTION, OTHER_SERVER, "active"),
  ];
  const grants = [
    grant(GRANT, CONNECTION, "active"),
    grant(REVOKED_GRANT, CONNECTION, "revoked"),
    grant(OTHER_GRANT, OTHER_CONNECTION, "active"),
  ];
  const deployments = [
    deployment(DEPLOYMENT, { "docs.search": GRANT, "docs.old": REVOKED_GRANT }),
    deployment(STOPPED_DEPLOYMENT, { "docs.search": GRANT }, "stopped"),
    deployment(OTHER_DEPLOYMENT, { "other.tool": OTHER_GRANT }),
  ];
  const reads = {
    deployments: { complete: true, items: deployments },
    grants: { complete: true, items: grants },
  };

  test("joins the server's connections, newest current first, to their grants and live pins", () => {
    const usage = serverUsage(SERVER, { complete: true, connections }, reads);
    expect(usage.complete).toBe(true);
    expect(usage.grantCoverage).toBe("complete");
    expect(usage.connections.map(({ connection: { id } }) => id)).toEqual([
      NEWER_CONNECTION,
      CONNECTION,
      REVOKED_CONNECTION,
    ]);
    expect(
      usage.connections[1]?.grants.map(({ grant: { id, status }, uses }) => ({ id, status, uses })),
    ).toEqual([
      {
        id: GRANT,
        status: "active",
        uses: [{ deploymentId: DEPLOYMENT, toolName: "docs.search" }],
      },
      {
        id: REVOKED_GRANT,
        status: "revoked",
        uses: [{ deploymentId: DEPLOYMENT, toolName: "docs.old" }],
      },
    ]);
  });

  test("pinning deployments are the live ones pinning an active grant", () => {
    expect(pinning(serverUsage(SERVER, { complete: true, connections }, reads))).toEqual({
      checked: true,
      complete: true,
      deploymentIds: [DEPLOYMENT],
    });
    expect(pinning(serverUsage(OTHER_SERVER, { complete: true, connections }, reads))).toEqual({
      checked: true,
      complete: true,
      deploymentIds: [OTHER_DEPLOYMENT],
    });
  });

  test("archiving through a capped directory may miss pins on connections it did not read", () => {
    const usage = serverUsage(SERVER, { complete: false, connections }, reads);
    expect(usage.complete).toBe(false);
    expect(pinning(usage)).toEqual({ checked: true, complete: false, deploymentIds: [DEPLOYMENT] });
    expect(pinning(serverUsage(SERVER, { complete: false, connections: [] }, reads))).toEqual({
      checked: true,
      complete: false,
      deploymentIds: [],
    });
  });

  test("revoking one listed connection is complete when grants and deployments were read in full", () => {
    const usage = serverUsage(SERVER, { complete: false, connections }, reads);
    expect(pinning(usage, CONNECTION)).toEqual({
      checked: true,
      complete: true,
      deploymentIds: [DEPLOYMENT],
    });
    expect(pinning(usage, NEWER_CONNECTION)).toEqual({
      checked: true,
      complete: true,
      deploymentIds: [],
    });
  });

  test.each([
    ["grants", { ...reads, grants: { complete: false, items: grants } }],
    ["deployments", { ...reads, deployments: { complete: false, items: deployments } }],
  ])("capped %s make every pin list partial, revoke included", (_capped, cappedReads) => {
    const usage = serverUsage(SERVER, { complete: true, connections }, cappedReads);
    expect(usage.grantCoverage).toBe("partial");
    expect(pinning(usage)).toEqual({ checked: true, complete: false, deploymentIds: [DEPLOYMENT] });
    expect(pinning(usage, CONNECTION)).toEqual({
      checked: true,
      complete: false,
      deploymentIds: [DEPLOYMENT],
    });
  });

  test("without grant reads, pins are unchecked rather than none", () => {
    const usage = serverUsage(SERVER, { complete: true, connections }, undefined);
    expect(usage.grantCoverage).toBe("unread");
    expect(usage.connections.every(({ grants: rows }) => rows.length === 0)).toBe(true);
    expect(pinning(usage)).toEqual({ checked: false });
    expect(pinning(usage, CONNECTION)).toEqual({ checked: false });
  });
});
