import { PublicId } from "@deployments-ai/api-contract/primitives";
import {
  ConnectionCapabilityResponse,
  ConnectionGrantResponse,
  ConnectionVerificationResponse,
  ProviderConnectionResponse,
} from "@deployments-ai/api-contract/providers";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { OperationAccess } from "../access.ts";
import {
  grantImpact,
  connectionActions,
  deniedToolsRemedy,
  connectionPage,
  grantableScopes,
  grantRows,
  parseConnectionSearch,
  parseGrantConstraints,
  verificationOutcome,
  type CapabilityView,
  type ConnectionView,
  type GrantView,
  type PinningDeploymentView,
  type VerificationView,
} from "./connection-state.ts";

const publicId = (label: string) =>
  Schema.decodeUnknownSync(PublicId)(`01K${label.padStart(23, "0")}`);

const X = publicId("X");
const C1 = publicId("C1");
const C2 = publicId("C2");
const C3 = publicId("C3");
const C4 = publicId("C4");
const C5 = publicId("C5");
const CAP1 = publicId("CAP1");
const CAP2 = publicId("CAP2");
const G1 = publicId("G1");
const G2 = publicId("G2");
const G3 = publicId("G3");
const D1 = publicId("D1");
const D2 = publicId("D2");
const D3 = publicId("D3");

function connection(
  id: string,
  status: string,
  overrides: Partial<ConnectionView> = {},
): ConnectionView {
  return Schema.decodeUnknownSync(ProviderConnectionResponse)({
    authMethod: "static",
    createdAt: "2026-09-01T00:00:00.000Z",
    displayName: id,
    hasCredential: true,
    id,
    providerKey: "demio",
    scopes: ["account:read"],
    status,
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  });
}

function capability(id: string, status: string, scopes: readonly string[]): CapabilityView {
  return Schema.decodeUnknownSync(ConnectionCapabilityResponse)({
    connectionId: X,
    id,
    providerKey: "demio",
    scopes,
    status,
    verificationVersion: 1,
  });
}

function grant(
  id: string,
  status: "active" | "revoked",
  connectionId = X,
  createdAt = "2026-09-02T00:00:00.000Z",
): GrantView {
  return Schema.decodeUnknownSync(ConnectionGrantResponse)({
    authorizationVersion: 1,
    connectionId,
    createdAt,
    externalAccountId: "acct",
    externalResourceConstraints: {},
    id,
    providerKey: "demio",
    purpose: "agent-runtime",
    scopes: ["account:read"],
    status,
    updatedAt: createdAt,
    version: 1,
    workspaceId: publicId("WS"),
  });
}

function deployment(
  id: PublicId,
  desiredState: PinningDeploymentView["desiredState"],
  pins: Readonly<Record<string, string>>,
): PinningDeploymentView {
  return {
    agentDefinitionId: publicId("DEF"),
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
    version: 3,
  };
}

const MANAGER = {
  beginProviderAuthorization: true,
  createConnectionGrant: true,
  requestConnectionVerification: true,
  revokeProviderConnection: true,
  rotateProviderCredential: true,
} satisfies Partial<OperationAccess>;

describe("connectionPage", () => {
  const all = [
    connection(C1, "active", { updatedAt: "2026-09-01T00:00:01.000Z" }),
    connection(C2, "active", { updatedAt: "2026-09-01T00:00:02.000Z" }),
    connection(C3, "error", { updatedAt: "2026-09-01T00:00:05.000Z" }),
    connection(C4, "reauthorization-required", { updatedAt: "2026-09-01T00:00:04.000Z" }),
    connection(C5, "disconnected", { updatedAt: "2026-09-01T00:00:03.000Z" }),
  ];
  const ids = (page: { readonly items: readonly ConnectionView[] }) =>
    page.items.map((item) => item.id);

  test("shows what the overview counts under attention", () => {
    expect(
      ids(connectionPage(all, { complete: true, filter: "attention", offset: 0, pageSize: 10 })),
    ).toEqual([C3, C4]);
  });

  test("hides disconnected connections by default, newest first", () => {
    expect(
      ids(connectionPage(all, { complete: true, filter: "current", offset: 0, pageSize: 10 })),
    ).toEqual([C3, C4, C2, C1]);
  });

  test("pages by offset", () => {
    expect(connectionPage(all, { complete: false, filter: "all", offset: 2, pageSize: 2 })).toEqual(
      {
        complete: false,
        items: [all[4]!, all[1]!],
        nextOffset: 4,
      },
    );
  });

  test("keeps the latest copy of a connection the walk saw twice", () => {
    const moved = connection(C1, "error", { updatedAt: "2026-09-01T00:00:09.000Z", version: 2 });
    expect(
      connectionPage([moved, all[0]!], { complete: true, filter: "all", offset: 0, pageSize: 10 })
        .items,
    ).toEqual([moved]);
  });
});

describe("parseConnectionSearch", () => {
  test("keeps known filters and drops the default and unknown values", () => {
    expect(parseConnectionSearch({ status: "attention" })).toEqual({ status: "attention" });
    expect(parseConnectionSearch({ status: "current" })).toEqual({});
    expect(parseConnectionSearch({ status: "bogus" })).toEqual({});
  });
});

describe("grantableScopes", () => {
  test("intersects active capability scopes with the connection's scopes", () => {
    expect(
      grantableScopes({ scopes: ["a:read"] }, [
        capability(CAP1, "active", ["a:write", "a:read"]),
        capability(CAP2, "stale", ["b:read"]),
      ]),
    ).toEqual(["a:read"]);
  });

  test("is undefined until a capability is active", () => {
    expect(grantableScopes({ scopes: ["a:read"] }, [capability(CAP2, "stale", ["a:read"])])).toBe(
      undefined,
    );
  });
});

describe("connectionActions", () => {
  test("offers every action on an active static connection", () => {
    expect(connectionActions(connection(X, "active"), MANAGER)).toEqual([
      "verify",
      "rotate",
      "grant",
      "revoke",
    ]);
  });

  test("offers only grant and revoke on a credentialless connection", () => {
    expect(
      connectionActions(
        connection(X, "active", { authMethod: "none", hasCredential: false }),
        MANAGER,
      ),
    ).toEqual(["grant", "revoke"]);
  });

  test("offers reauthorize and revoke on an OAuth connection that needs reauthorization", () => {
    expect(
      connectionActions(
        connection(X, "reauthorization-required", { authMethod: "oauth" }),
        MANAGER,
      ),
    ).toEqual(["reauthorize", "revoke"]);
  });

  test("lets a static connection that needs reauthorization verify and rotate again", () => {
    expect(connectionActions(connection(X, "reauthorization-required"), MANAGER)).toEqual([
      "verify",
      "rotate",
      "revoke",
    ]);
  });

  test("leaves a disconnected connection only reauthorization, and a reader nothing", () => {
    expect(connectionActions(connection(X, "disconnected"), MANAGER)).toEqual([]);
    expect(
      connectionActions(connection(X, "disconnected", { authMethod: "oauth" }), MANAGER),
    ).toEqual(["reauthorize"]);
    expect(
      connectionActions(connection(X, "active"), {
        beginProviderAuthorization: false,
        createConnectionGrant: false,
        requestConnectionVerification: false,
        revokeProviderConnection: false,
        rotateProviderCredential: false,
      }),
    ).toEqual([]);
  });
});

describe("deniedToolsRemedy", () => {
  test("restores in place unless an OAuth connection needs a new authorization", () => {
    expect(
      [
        { authMethod: "oauth", status: "active" },
        { authMethod: "oauth", status: "reauthorization-required" },
        { authMethod: "oauth", status: "disconnected" },
        { authMethod: "static", status: "reauthorization-required" },
        { authMethod: "static", status: "disconnected" },
      ].map(deniedToolsRemedy),
    ).toEqual(["restore", "reauthorize", "reauthorize", "restore", undefined]);
  });
});

describe("grantRows", () => {
  test("lists the connection's grants, active first, with the live tools pinning them", () => {
    const rows = grantRows(
      X,
      [
        grant(G1, "revoked", X, "2026-09-03T00:00:00.000Z"),
        grant(G2, "active"),
        grant(G3, "active", publicId("Y")),
      ],
      [
        deployment(D1, "running", { search: G2, lookup: G1 }),
        deployment(D2, "stopped", { search: G2 }),
      ],
    );
    expect(rows.map((row) => [row.grant.id, row.uses])).toEqual([
      [G2, [{ deploymentId: D1, toolName: "search" }]],
      [G1, [{ deploymentId: D1, toolName: "lookup" }]],
    ]);
  });
});

describe("grantImpact", () => {
  const grants = [grant(G1, "active"), grant(G2, "active"), grant(G3, "revoked")];
  const deployments = [
    deployment(D1, "running", { search: G1, lookup: G3 }),
    deployment(D2, "paused", { search: G1 }),
    deployment(D3, "stopped", { search: G2 }),
  ];

  test("counts grants in a status and the live deployments that pin them", () => {
    expect(grantImpact(X, grants, deployments, "active")).toEqual({ deployments: 2, grants: 2 });
    expect(grantImpact(X, grants, deployments, "revoked")).toEqual({ deployments: 1, grants: 1 });
  });
});

describe("parseGrantConstraints", () => {
  test("reads a JSON object and treats blank or empty as no constraints", () => {
    expect(parseGrantConstraints(' {"siteId": "s-1"} ')).toEqual({
      ok: true,
      value: { siteId: "s-1" },
    });
    expect(parseGrantConstraints("")).toEqual({ ok: true });
    expect(parseGrantConstraints("{}")).toEqual({ ok: true });
  });

  test("rejects anything but a JSON object", () => {
    expect(parseGrantConstraints("[1]")).toEqual({
      message: "Constraints must be a JSON object.",
      ok: false,
    });
    expect(parseGrantConstraints("{site")).toEqual({
      message: "Constraints must be valid JSON.",
      ok: false,
    });
  });
});

describe("verificationOutcome", () => {
  const verification = (outcome: Partial<VerificationView>) =>
    Schema.decodeUnknownSync(ConnectionVerificationResponse)({
      connectionId: X,
      createdAt: "2026-09-01T00:00:00.000Z",
      id: publicId("V1"),
      providerKey: "demio",
      updatedAt: "2026-09-01T00:00:00.000Z",
      version: 2,
      ...outcome,
    });

  test("reads the method and scopes of a verified check", () => {
    expect(
      verificationOutcome(
        verification({
          result: { method: "api_probe", responseStatus: 200, scopes: ["account:read", 7] },
          status: "verified",
        }),
      ),
    ).toEqual({ method: "api_probe", scopes: ["account:read"] });
  });

  test("prefers the error message to its code", () => {
    expect(
      verificationOutcome(
        verification({
          error: { code: "provider_verification_failed", message: "Demio answered 401." },
          status: "failed",
        }),
      ),
    ).toEqual({ problem: "Demio answered 401.", scopes: [] });
    expect(
      verificationOutcome(
        verification({
          error: { code: "provider_verification_failed" },
          status: "failed",
        }),
      ),
    ).toEqual({ problem: "provider_verification_failed", scopes: [] });
  });
});
