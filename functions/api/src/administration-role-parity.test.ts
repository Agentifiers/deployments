import {
  ORGANIZATION_ROLES,
  PersistenceError,
  effectiveOrganizationCapabilities,
  makeDynamoDatabase,
  makeTenancyPersistence,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { describe, expect, test } from "bun:test";
import {
  ADMINISTRATION_API_ROUTES,
  administrationRequiredScope,
  isAdministrationMutation,
} from "./administration-api.ts";
import { ORGANIZATION_ID, fixture, request } from "./governance-api.fixture.ts";

const FOUNDER = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const MEMBER_IDS: Readonly<Record<(typeof ORGANIZATION_ROLES)[number], string>> = {
  admin: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  billing: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  member: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  owner: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  viewer: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
};
const ALL_ALLOWED = {
  admin: "allowed",
  billing: "allowed",
  member: "allowed",
  owner: "allowed",
  viewer: "allowed",
};
const OWNERS_AND_ADMINS = {
  admin: "allowed",
  billing: "insufficient_role",
  member: "insufficient_role",
  owner: "allowed",
  viewer: "insufficient_role",
};

let sequence = 0;

async function organizationWithEveryRole() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(tables.control, humanPrincipalRecord(FOUNDER, "founder@example.com"));
  for (const [role, id] of Object.entries(MEMBER_IDS)) {
    fake.put(tables.control, humanPrincipalRecord(id, `${role}@example.com`));
  }
  const tenancy = makeTenancyPersistence({ database: makeDynamoDatabase(fake.client, tables) });
  const founder = { principalId: FOUNDER, scopes: ["platform:*"] };
  const organization = await tenancy.organizations.create({
    body: { name: "Role parity" },
    identity: founder,
    idempotencyKey: `role-parity-${++sequence}`,
    query: {},
    scope: {},
  });
  for (const role of ORGANIZATION_ROLES) {
    await tenancy.organizationMembers.add({
      body: { principalId: MEMBER_IDS[role], role },
      identity: founder,
      idempotencyKey: `role-parity-${++sequence}`,
      query: {},
      scope: { organizationId: organization.id },
    });
  }
  return { organizationId: organization.id, tenancy };
}

describe("organization role parity between whoami and enforcement", () => {
  test("administration routes: tenancy authorize and whoami agree on one read and one mutation per tag", async () => {
    const { organizationId, tenancy } = await organizationWithEveryRole();
    const routes = ADMINISTRATION_API_ROUTES.filter((route) => route.authentication !== "none");
    const byTag = Map.groupBy(routes, (route) => route.tag);
    const enforced: Record<string, Record<string, Record<string, string>>> = {};
    const reported: Record<string, Record<string, Record<string, string>>> = {};
    for (const [tag, tagRoutes] of byTag) {
      const sample = {
        read: tagRoutes.find((route) => route.method === "GET"),
        write: tagRoutes.find(isAdministrationMutation),
      };
      for (const [kind, route] of Object.entries(sample)) {
        if (!route) continue;
        const scope = administrationRequiredScope(route);
        for (const role of ORGANIZATION_ROLES) {
          const outcome = await tenancy
            .authorize(
              {
                body: {},
                identity: {
                  authentication: "tenant-jwt",
                  organizationIds: [organizationId],
                  principalId: MEMBER_IDS[role],
                  scopes: [scope],
                },
                idempotencyKey: `role-parity-${++sequence}`,
                query: {},
                scope: { organizationId },
              },
              route.name,
              isAdministrationMutation(route),
            )
            .then(
              () => "allowed",
              (cause: unknown) => (cause instanceof PersistenceError ? cause.code : String(cause)),
            );
          ((enforced[tag] ??= {})[kind] ??= {})[role] = outcome;
          ((reported[tag] ??= {})[kind] ??= {})[role] = effectiveOrganizationCapabilities(role, [
            scope,
          ]).includes(scope)
            ? "allowed"
            : "insufficient_role";
        }
      }
    }
    const readAndWrite = { read: ALL_ALLOWED, write: OWNERS_AND_ADMINS };
    const expected = {
      Extensions: readAndWrite,
      Models: readAndWrite,
      Providers: readAndWrite,
      Security: { read: ALL_ALLOWED },
      Tools: readAndWrite,
    };
    expect(enforced).toEqual(expected);
    expect(reported).toEqual(expected);
  });

  test("governance mutations: owners do everything, admins everything but erasure, on any path spelling", async () => {
    const bodies: Readonly<Record<string, unknown>> = {
      CreateTenantErasureRequest: { confirmation: "ERASE" },
      UpdateOrganizationRetentionPolicyRequest: { messages: 30 },
    };
    const mutations = {
      createImmutableAuditExport: { method: "POST", path: "/v1/organizations/:id/audit-exports" },
      createTenantDataExport: { method: "POST", path: "/v1/organizations/:id/data-exports" },
      createTenantErasure: { method: "POST", path: "/v1/organizations/:id/erasures" },
      "createTenantErasure double slash": {
        method: "POST",
        path: "/v1/organizations/:id//erasures",
      },
      "createTenantErasure leading double slash": {
        method: "POST",
        path: "//v1/organizations/:id/erasures",
      },
      "createTenantErasure trailing slash": {
        method: "POST",
        path: "/v1/organizations/:id/erasures/",
      },
      updateOrganizationRetentionPolicy: {
        method: "PATCH",
        path: "/v1/organizations/:id/retention-policy",
      },
    } as const;
    const observed: Record<string, Record<string, string | number | undefined>> = {};
    for (const [name, mutation] of Object.entries(mutations)) {
      const body =
        mutation.method === "PATCH"
          ? bodies.UpdateOrganizationRetentionPolicyRequest
          : name.startsWith("createTenantErasure")
            ? bodies.CreateTenantErasureRequest
            : undefined;
      for (const role of ORGANIZATION_ROLES) {
        const response = await fixture().handler(
          request(mutation.path.replace(":id", ORGANIZATION_ID), {
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            headers: {
              "idempotency-key": `${name}-${role}`.replaceAll(" ", "-"),
              "x-test-role": role,
              "x-test-scopes": "governance:write",
            },
            method: mutation.method,
          }),
        );
        const problem =
          response?.status === 403 ? ((await response.json()) as { code?: string }) : undefined;
        (observed[name] ??= {})[role] =
          response && response.status < 300 ? "allowed" : (problem?.code ?? response?.status);
      }
    }
    const ownersOnly = { ...OWNERS_AND_ADMINS, admin: "insufficient_role" };
    expect(observed).toEqual({
      createImmutableAuditExport: OWNERS_AND_ADMINS,
      createTenantDataExport: OWNERS_AND_ADMINS,
      createTenantErasure: ownersOnly,
      "createTenantErasure double slash": ownersOnly,
      "createTenantErasure leading double slash": ownersOnly,
      "createTenantErasure trailing slash": ownersOnly,
      updateOrganizationRetentionPolicy: OWNERS_AND_ADMINS,
    });
  });
});
