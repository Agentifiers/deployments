import { describe, expect, test } from "bun:test";
import { SYSTEM_OPERATOR_API_ROUTES } from "@deployments-ai/api-contract";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { createSystemOperatorApi } from "./api.ts";
import { fakeService, INSTALLATION, OPERATOR_ID, PERSON_ID } from "./system-operator.fixture.ts";

const ORGANIZATION_ID = "01J0000000000000000000000A";

const REQUEST_BODIES: Readonly<Record<string, unknown>> = {
  placeSystemOrganizationHold: { customerMessage: "Routing check.", reason: "manual" },
  replaceSystemOrganizationEntitlements: {},
  setSystemOrganizationDataBoundary: { operatorNote: "routing check", profile: "phi" },
  clearSystemOrganizationDataBoundary: { operatorNote: "routing check" },
  replaceSystemPrincipalStatus: { reason: "routing check", status: "active" },
  openSystemOrganizationAccess: { reason: "routing check" },
  resendSystemPrincipalVerification: { email: "pending@example.test", reason: "routing check" },
  revokeSystemPrincipalSessions: { reason: "routing check" },
};

const ROUTE_QUERIES: Readonly<Record<string, string>> = {
  findSystemPrincipal: `?email=${PERSON_ID.toLowerCase()}@example.test`,
};

function api(identity: ApiIdentity | null) {
  return createSystemOperatorApi({
    authenticate: async () => identity,
    observers: [],
    requestId: () => "request-1",
    service: fakeService({ installation: INSTALLATION }),
    services: { kind: "configured", principals: [] },
  });
}

function routeRequest(route: (typeof SYSTEM_OPERATOR_API_ROUTES)[number]) {
  const body = REQUEST_BODIES[route.name];
  return new Request(
    `https://api.example${route.path.replace(":organizationId", ORGANIZATION_ID).replace(":holdKey", "routing-check").replace(":principalId", PERSON_ID)}${ROUTE_QUERIES[route.name] ?? ""}`,
    { method: route.method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  );
}

async function send(identity: ApiIdentity | null, request: Request) {
  const response = await api(identity)(request);
  if (!response) throw new Error(`${request.method} ${request.url} was not routed.`);
  return { body: (await response.json()) as Record<string, unknown>, status: response.status };
}

const call = (identity: ApiIdentity | null, path: string) =>
  send(identity, new Request(`https://api.example${path}`));

const human = { authentication: "tenant-jwt", principalId: OPERATOR_ID } as const;

describe("system operator API authorization", () => {
  test.each([
    ["an organization owner", { ...human, organizationIds: "*", scopes: ["tenancy:*"] }],
    ["a human with platform:read", { ...human, scopes: ["platform:read"] }],
    [
      "an API key carrying platform:admin",
      {
        apiCredentialId: "01J0000000000000000000000K",
        authentication: "api-credential",
        opaqueCredential: true,
        principalId: OPERATOR_ID,
        scopes: ["platform:admin", "platform:*"],
      },
    ],
    [
      "an erasure-receipt administrator session",
      { ...human, erasureReceiptOnly: true, platformRole: "administrator", scopes: [] },
    ],
  ] as const)("rejects %s on every system route", async (_label, identity) => {
    for (const route of SYSTEM_OPERATOR_API_ROUTES) {
      const result = await send(identity as ApiIdentity, routeRequest(route));
      expect({ route: route.name, status: result.status, code: result.body.code }).toEqual({
        code: "platform_administrator_required",
        route: route.name,
        status: 403,
      });
    }
  });

  test("requires a bearer credential", async () => {
    expect((await call(null, "/v1/system/installation")).status).toBe(401);
  });

  test.each([
    ["the platform administrator role", { ...human, platformRole: "administrator", scopes: [] }],
    ["the platform:admin scope", { ...human, scopes: ["platform:admin"] }],
  ] as const)("serves every system route to %s", async (_label, identity) => {
    for (const route of SYSTEM_OPERATOR_API_ROUTES) {
      const result = await send(identity, routeRequest(route));
      expect({ route: route.name, status: result.status }).toEqual({
        route: route.name,
        status: 200,
      });
    }
    const installation = await call(identity, "/v1/system/installation");
    expect(installation.body).toMatchObject({
      sourceCommit: INSTALLATION.sourceCommit,
      targetName: "acme-prod",
    });
  });

  test("leaves other paths and methods to the remaining handlers", async () => {
    const handler = api({ ...human, platformRole: "administrator", scopes: [] });
    expect(await handler(new Request("https://api.example/v1/organizations"))).toBeUndefined();
    expect(
      await handler(new Request("https://api.example/v1/system/installation", { method: "POST" })),
    ).toBeUndefined();
    expect(
      await handler(
        new Request(
          `https://api.example/v1/system/organizations/${ORGANIZATION_ID}/standing/extra`,
        ),
      ),
    ).toBeUndefined();
    expect(
      await handler(
        new Request(`https://api.example/v1/system/organizations/${ORGANIZATION_ID}/standing`, {
          method: "PATCH",
        }),
      ),
    ).toBeUndefined();
  });

  test("validates list queries and path parameters before reading", async () => {
    const administrator = { ...human, platformRole: "administrator", scopes: [] } as const;
    expect((await call(administrator, "/v1/system/alarms?state=FIRING")).body.code).toBe(
      "invalid_state",
    );
    expect((await call(administrator, "/v1/system/organizations?limit=101")).status).toBe(400);
    expect(await call(administrator, "/v1/system/organizations/acme/standing")).toMatchObject({
      body: { code: "invalid_organizationId" },
      status: 400,
    });
  });
});
