import { describe, expect, test } from "bun:test";
import {
  ORGANIZATION_ROLES,
  admittedOrganizationScopes,
  canHoldBrainRoleGrant,
  effectiveOrganizationCapabilities,
  operationRoleAction,
  organizationRoleAllows,
} from "./organization-role-matrix.ts";

const TOKEN = [
  "agents:*",
  "email:admin",
  "governance:write",
  "invitations:accept",
  "invitations:read",
  "managed-skills:install",
  "members:read",
  "members:write",
  "memory:admin",
  "memory:read",
  "organizations:write",
  "projects:read",
  "projects:write",
  "runs:write",
];

describe("organization role matrix", () => {
  test("effective capabilities intersect token scopes with each role's permissions", () => {
    const observed = Object.fromEntries(
      ORGANIZATION_ROLES.map((role) => [
        role,
        [...effectiveOrganizationCapabilities(role, TOKEN)].sort(),
      ]),
    );
    const readOnly = [
      "agents:read",
      "invitations:accept",
      "members:read",
      "memory:read",
      "projects:read",
    ];
    expect(observed).toEqual({
      admin: TOKEN.filter((scope) => scope !== "organizations:write"),
      billing: readOnly,
      member: readOnly,
      owner: TOKEN,
      viewer: readOnly,
    });
  });

  test("a wildcard the role cannot fully use expands to the permitted levels only", () => {
    expect(effectiveOrganizationCapabilities("viewer", ["memory:*", "workflows:*"])).toEqual([
      "memory:read",
      "workflows:read",
    ]);
    expect(effectiveOrganizationCapabilities("admin", ["memory:*"])).toEqual(["memory:*"]);
  });

  test("admission narrows only namespaces enforced at admission", () => {
    expect(
      admittedOrganizationScopes("member", ["agent-email:*", "email:admin", "projects:write"]),
    ).toEqual(["agent-email:read", "agent-email:write", "projects:write"]);
    expect(admittedOrganizationScopes("admin", ["agent-email:*", "email:admin"])).toEqual([
      "agent-email:*",
      "email:admin",
    ]);
  });

  test("no organization role confers platform administration", () => {
    for (const role of ORGANIZATION_ROLES) {
      expect(organizationRoleAllows(role, "platform.administer")).toBe(false);
      expect(effectiveOrganizationCapabilities(role, ["managed-skills:admin"])).toEqual([]);
    }
  });

  test("Brain role grants and erasure receipts follow the matrix", () => {
    expect(ORGANIZATION_ROLES.filter(canHoldBrainRoleGrant)).toEqual(["owner", "admin", "member"]);
    expect(
      ORGANIZATION_ROLES.filter((role) =>
        organizationRoleAllows(role, "brains.erasure-receipts.read-any"),
      ),
    ).toEqual(["owner", "admin"]);
    expect(canHoldBrainRoleGrant(undefined)).toBe(false);
  });

  test("owners, admins, and billing manage budgets; every role reads them", () => {
    expect(
      ORGANIZATION_ROLES.filter((role) => organizationRoleAllows(role, "budgets.manage")),
    ).toEqual(["owner", "admin", "billing"]);
    expect(effectiveOrganizationCapabilities("billing", ["budgets:*"])).toEqual(["budgets:*"]);
    expect(effectiveOrganizationCapabilities("viewer", ["budgets:*"])).toEqual(["budgets:read"]);
  });

  test("only owners and admins write tools and models; every role reads them", () => {
    const observed = Object.fromEntries(
      ORGANIZATION_ROLES.map((role) => [
        role,
        effectiveOrganizationCapabilities(role, ["tools:*", "models:write"]),
      ]),
    );
    expect(observed).toEqual({
      admin: ["tools:*", "models:write"],
      billing: ["tools:read"],
      member: ["tools:read"],
      owner: ["tools:*", "models:write"],
      viewer: ["tools:read"],
    });
  });

  test("owners and admins administer identity federation; only owners require it", () => {
    expect(
      ORGANIZATION_ROLES.filter((role) => organizationRoleAllows(role, "identity.administer")),
    ).toEqual(["owner", "admin"]);
    expect(
      ORGANIZATION_ROLES.filter((role) => organizationRoleAllows(role, "identity.enforce")),
    ).toEqual(["owner"]);
    expect(organizationRoleAllows(undefined, "identity.administer")).toBe(false);
  });

  test("tenant erasure has its own role action, owner only", () => {
    const action = operationRoleAction("createTenantErasure");
    expect(action).toBe("governance.erase");
    expect(
      ORGANIZATION_ROLES.filter((role) => action && organizationRoleAllows(role, action)),
    ).toEqual(["owner"]);
    expect(operationRoleAction("createTenantDataExport")).toBeUndefined();
    expect(operationRoleAction("toString")).toBeUndefined();
  });

  test("admins use identity federation operations, reads included; members do not", () => {
    const allowed = (operation: string) =>
      ORGANIZATION_ROLES.filter((role) => {
        const action = operationRoleAction(operation);
        return action !== undefined && organizationRoleAllows(role, action);
      });
    expect(allowed("listLoginDomains")).toEqual(["owner", "admin"]);
    expect(allowed("setIdentityProviderState")).toEqual(["owner", "admin"]);
  });

  test("only owners and admins use model credential operations, reads included", () => {
    expect(
      [
        "listModelCredentials",
        "getModelCredential",
        "putModelCredential",
        "deleteModelCredential",
      ].map((operation) =>
        ORGANIZATION_ROLES.filter((role) => {
          const action = operationRoleAction(operation);
          return action !== undefined && organizationRoleAllows(role, action);
        }),
      ),
    ).toEqual([
      ["owner", "admin"],
      ["owner", "admin"],
      ["owner", "admin"],
      ["owner", "admin"],
    ]);
  });
});
