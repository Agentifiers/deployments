import { describe, expect, test } from "bun:test";
import {
  makeDynamoDatabase,
  makeOrganizationStandingRepository,
  makeTenancyPersistence,
  StandingActor,
  tableNamesFromEnvironment,
  Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { Schema } from "effect";
import {
  createTenancyApi,
  type ApiIdentity,
  type OrganizationLimitsApiService,
  type TenancyApiService,
} from "./index.ts";
import { makeOrganizationLimitsApiService } from "./organization-limits-api.ts";

const FOUNDER = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const VIEWER = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const OUTSIDER = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const ENVIRONMENT = {
  DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
    active_sandboxes: 8,
    api_request_burst: 40,
    api_requests_per_second: 20,
    concurrent_runs: 8,
  }),
};

function human(principalId: string): ApiIdentity {
  return { authentication: "tenant-jwt", principalId, scopes: ["organizations:read"] };
}

const unexpectedOperations = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error("Unexpected service operation.");
    },
  },
);

function limitsOnlyService(organizationLimits: OrganizationLimitsApiService) {
  return new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "organizationLimits" ? organizationLimits : unexpectedOperations,
    },
  ) as TenancyApiService;
}

async function harness() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const [id, email] of [
    [FOUNDER, "founder@example.com"],
    [VIEWER, "viewer@example.com"],
    [OUTSIDER, "outsider@example.com"],
  ] as const) {
    fake.put(tables.control, humanPrincipalRecord(id, email));
  }
  const database = makeDynamoDatabase(fake.client, tables);
  const persistence = makeTenancyPersistence({ database });
  const founder = { principalId: FOUNDER, scopes: ["platform:*"] };
  const organization = await persistence.organizations.create({
    body: { name: "Limits" },
    identity: founder,
    idempotencyKey: "create-organization",
    query: {},
    scope: {},
  });
  await persistence.organizationMembers.add({
    body: { principalId: VIEWER, role: "viewer" },
    identity: founder,
    idempotencyKey: "add-viewer",
    query: {},
    scope: { organizationId: organization.id },
  });
  const standing = makeOrganizationStandingRepository({
    database,
    installDefaults: {
      operatorFundedModelSpendCeiling: "unlimited",
      tenantLimits: {
        activeSandboxes: 8,
        apiRequestBurst: 40,
        apiRequestsPerSecond: 20,
        concurrentRuns: 8,
      },
    },
  });
  const organizationId = Schema.decodeUnknownSync(Ulid)(organization.id);
  await standing.setGrant({
    actor: Schema.decodeUnknownSync(StandingActor)({ kind: "service", service: "billing" }),
    entitlements: { tenantLimits: { activeSandboxes: 4, concurrentRuns: 16 } },
    organizationId,
  });
  await standing.setGrant({
    actor: Schema.decodeUnknownSync(StandingActor)({ kind: "operator", principalId: FOUNDER }),
    entitlements: { tenantLimits: { concurrentRuns: 32 } },
    organizationId,
  });
  let caller: ApiIdentity = human(VIEWER);
  const fetch = createTenancyApi({
    authenticate: async () => caller,
    authorize: (invocation, operationName, mutation) =>
      persistence.authorize(invocation, operationName, mutation),
    idempotency: { execute: async (input) => input.operation() },
    service: limitsOnlyService(
      makeOrganizationLimitsApiService({ database, environment: ENVIRONMENT }),
    ),
  });
  const read = async (identity: ApiIdentity, path: string, header = organization.id) => {
    caller = identity;
    const response = await fetch(
      new Request(`https://api.example${path}`, {
        headers: { authorization: "Bearer a.b.c", "x-deployments-organization": header },
      }),
    );
    return { body: (await response.json()) as Record<string, unknown>, status: response.status };
  };
  return { organizationId: organization.id, read };
}

describe("GET /v1/organizations/:id/limits", () => {
  test("marks a limit the operator grant sets as override and one only the service grant sets as plan", async () => {
    const { organizationId, read } = await harness();

    const result = await read(human(VIEWER), `/v1/organizations/${organizationId}/limits`);

    expect(result).toEqual({
      body: {
        effective: {
          activeSandboxes: { source: "plan", value: 4 },
          apiRequestBurst: { source: "default", value: 40 },
          apiRequestsPerSecond: { source: "default", value: 20 },
          concurrentRuns: { source: "override", value: 32 },
        },
        organizationId,
      },
      status: 200,
    });
  });

  test("denies a principal that is not a member", async () => {
    const { organizationId, read } = await harness();

    const result = await read(human(OUTSIDER), `/v1/organizations/${organizationId}/limits`);

    expect({ code: result.body.code, status: result.status }).toEqual({
      code: "organization_scope_violation",
      status: 403,
    });
  });

  test("denies a path organization other than the selected one", async () => {
    const { read } = await harness();

    const result = await read(human(VIEWER), `/v1/organizations/${OUTSIDER}/limits`);

    expect({ code: result.body.code, status: result.status }).toEqual({
      code: "organization_scope_violation",
      status: 403,
    });
  });

  test("requires the capability to read organizations", async () => {
    const { organizationId, read } = await harness();

    const result = await read(
      { ...human(VIEWER), scopes: ["projects:read"] },
      `/v1/organizations/${organizationId}/limits`,
    );

    expect({ code: result.body.code, status: result.status }).toEqual({
      code: "insufficient_scope",
      status: 403,
    });
  });
});
