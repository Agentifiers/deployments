import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import {
  addScopeSpend,
  makeOrganizationStandingRepository,
  scopeSpendShardCandidates,
  withCanonicalRecordKeys,
  type OrganizationRole,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { makeTenancyTestDatabase } from "@deployments-ai/db/memory-testing";
import { describe, expect, test } from "bun:test";
import { createTenancyApi } from "./api-request-handlers.ts";
import type { ApiIdentity, TenancyApiService } from "./api-service-contracts.ts";
import { createOrganizationSpendApi } from "./organization-spend-api.ts";
import {
  createOperationalReadService,
  makeAesGcmOperationalCursorCodec,
} from "./operational-reads.ts";

const ORGANIZATION_ID = "01J0000000000000000000000A" as Ulid;
const OTHER_ORGANIZATION_ID = "01J0000000000000000000000B" as Ulid;
const NOW = new Date("2026-10-15T09:00:00.000Z");

const member = (organizationRole: OrganizationRole): ApiIdentity => ({
  authentication: "tenant-jwt",
  organizationIds: [ORGANIZATION_ID],
  organizationRole,
  principalId: "01J00000000000000000000MBR",
  scopes: ["organizations:read"],
});

const CALLERS: Readonly<Record<string, ApiIdentity>> = {
  "Bearer api-key": {
    apiCredentialId: "01J00000000000000000000KEY",
    authentication: "api-credential",
    opaqueCredential: true,
    organizationIds: [ORGANIZATION_ID],
    principalId: "01J00000000000000000000SVC",
    scopes: ["organizations:read"],
  },
  "Bearer billing": member("billing"),
  "Bearer operator": {
    authentication: "tenant-jwt",
    operatorAccess: operatorAccessGrant(ORGANIZATION_ID),
    organizationIds: [ORGANIZATION_ID],
    platformRole: "administrator",
    principalId: "01J00000000000000000000OPR",
    scopes: ["organizations:read"],
  },
  "Bearer outsider": {
    authentication: "tenant-jwt",
    organizationIds: [OTHER_ORGANIZATION_ID],
    organizationRole: "owner",
    principalId: "01J00000000000000000000OUT",
    scopes: ["organizations:read"],
  },
  "Bearer viewer": member("viewer"),
};

const SPENDING_PROJECT_ID = "01J0000000000000000000000P" as Ulid;
const IDLE_PROJECT_ID = "01J0000000000000000000000Q" as Ulid;

const projectRecord = (id: Ulid, status: "active" | "archived") =>
  withCanonicalRecordKeys({
    data: {
      createdAt: NOW.toISOString(),
      id,
      name: id,
      organizationId: ORGANIZATION_ID,
      slug: id.toLowerCase(),
      status,
      updatedAt: NOW.toISOString(),
      version: 1,
    },
    itemType: "project",
  } as Parameters<typeof withCanonicalRecordKeys>[0]) as PlatformRecord;

async function install() {
  const { database } = makeTenancyTestDatabase();
  await database.transactWrite(
    [projectRecord(SPENDING_PROJECT_ID, "archived"), projectRecord(IDLE_PROJECT_ID, "active")].map(
      (record) => ({ kind: "put" as const, record }),
    ),
  );
  for (const [shard, funding, spendUsdMicros, occurredAt] of [
    [1, "operator", 3_000_000, "2026-10-02T10:00:00.000Z"],
    [2, "organization", 700_000, "2026-10-03T10:00:00.000Z"],
    [3, "operator", 6_000_000, "2026-09-20T10:00:00.000Z"],
  ] as const) {
    await database.transactWrite(
      scopeSpendShardCandidates({
        occurredAt,
        scope: {
          environmentId: "01J0000000000000000000000E" as Ulid,
          organizationId: ORGANIZATION_ID,
          projectId: SPENDING_PROJECT_ID,
          workspaceId: undefined,
        },
        shard,
        updatedAt: occurredAt,
      }).map((candidate) => ({
        kind: "put" as const,
        record: addScopeSpend(candidate, undefined, spendUsdMicros, funding),
      })),
    );
  }
  const handler = createOrganizationSpendApi({
    authenticate: async (request) => CALLERS[request.headers.get("authorization") ?? ""] ?? null,
    database,
    now: () => NOW,
    requestId: () => "request-1",
    standing: makeOrganizationStandingRepository({
      database,
      installDefaults: {
        operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
        tenantLimits: {
          activeSandboxes: 8,
          apiRequestBurst: 40,
          apiRequestsPerSecond: 20,
          concurrentRuns: 8,
        },
      },
    }),
  });
  return async (
    caller: string,
    query = "",
    organizationId: string = ORGANIZATION_ID,
    suffix = "",
  ) => {
    const response = await handler(
      new Request(
        `https://api.example.test/v1/organizations/${organizationId}/spend${suffix}${query}`,
        {
          headers: { authorization: caller, "x-deployments-organization": organizationId },
        },
      ),
    );
    if (!response) throw new Error("The spend route was not matched.");
    const body = (await response.json()) as Record<string, unknown>;
    return { body: response.ok ? body : body.code, status: response.status };
  };
}

describe("organization spend for members", () => {
  test("shows any member the month split by who paid, with the effective ceiling", async () => {
    const read = await install();

    expect([await read("Bearer viewer"), await read("Bearer billing", "?month=2026-09")]).toEqual([
      {
        body: {
          asOf: "2026-10-15T09:00:00.000Z",
          month: "2026-10",
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
          operatorFundedUsdMicros: 3_000_000,
          organizationFundedUsdMicros: 700_000,
          organizationId: ORGANIZATION_ID,
          periodStart: "2026-10-01T00:00:00.000Z",
          totalUsdMicros: 3_700_000,
        },
        status: 200,
      },
      {
        body: {
          asOf: "2026-10-15T09:00:00.000Z",
          month: "2026-09",
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
          operatorFundedUsdMicros: 6_000_000,
          organizationFundedUsdMicros: 0,
          organizationId: ORGANIZATION_ID,
          periodStart: "2026-09-01T00:00:00.000Z",
          totalUsdMicros: 6_000_000,
        },
        status: 200,
      },
    ]);
  });

  test("lets a platform administrator read without an organization role", async () => {
    const read = await install();

    expect((await read("Bearer operator")).status).toBe(200);
  });

  test("refuses callers that are not members of the organization", async () => {
    const read = await install();

    expect([
      await read("Bearer outsider"),
      await read("Bearer api-key"),
      await read("Bearer nobody"),
    ]).toEqual([
      { body: "organization_scope_violation", status: 403 },
      { body: "insufficient_role", status: 403 },
      { body: "unauthorized", status: 401 },
    ]);
  });

  test("splits a month by project, archived projects and idle ones included", async () => {
    const read = await install();
    const byProject = (caller: string, query: string) =>
      read(caller, query, ORGANIZATION_ID, "/projects");

    expect([
      await byProject("Bearer viewer", ""),
      await byProject("Bearer billing", "?month=2026-09"),
      await byProject("Bearer outsider", ""),
      await byProject("Bearer viewer", "?month=2026-11"),
    ]).toEqual([
      {
        body: {
          asOf: "2026-10-15T09:00:00.000Z",
          items: [
            {
              operatorFundedUsdMicros: 3_000_000,
              organizationFundedUsdMicros: 700_000,
              projectId: SPENDING_PROJECT_ID,
              totalUsdMicros: 3_700_000,
            },
            {
              operatorFundedUsdMicros: 0,
              organizationFundedUsdMicros: 0,
              projectId: IDLE_PROJECT_ID,
              totalUsdMicros: 0,
            },
          ],
          month: "2026-10",
          organizationId: ORGANIZATION_ID,
          periodStart: "2026-10-01T00:00:00.000Z",
        },
        status: 200,
      },
      {
        body: {
          asOf: "2026-10-15T09:00:00.000Z",
          items: [
            {
              operatorFundedUsdMicros: 6_000_000,
              organizationFundedUsdMicros: 0,
              projectId: SPENDING_PROJECT_ID,
              totalUsdMicros: 6_000_000,
            },
            {
              operatorFundedUsdMicros: 0,
              organizationFundedUsdMicros: 0,
              projectId: IDLE_PROJECT_ID,
              totalUsdMicros: 0,
            },
          ],
          month: "2026-09",
          organizationId: ORGANIZATION_ID,
          periodStart: "2026-09-01T00:00:00.000Z",
        },
        status: 200,
      },
      { body: "organization_scope_violation", status: 403 },
      { body: "invalid_month", status: 400 },
    ]);
  });

  test("refuses a malformed or future month", async () => {
    const read = await install();

    expect([
      await read("Bearer viewer", "?month=2026-11"),
      await read("Bearer viewer", "?month=10-2026"),
    ]).toEqual([
      { body: "invalid_month", status: 400 },
      { body: "invalid_month", status: 400 },
    ]);
  });
});

describe("workspace spend", () => {
  const PROJECT_ID = "01J0000000000000000000000P" as Ulid;
  const ENVIRONMENT_ID = "01J0000000000000000000000E" as Ulid;
  const OTHER_ENVIRONMENT_ID = "01J0000000000000000000000F" as Ulid;
  const WORKSPACE_ID = "01J0000000000000000000000W" as Ulid;
  const SIBLING_WORKSPACE_ID = "01J0000000000000000000000X" as Ulid;
  const OTHER_ENVIRONMENT_WORKSPACE_ID = "01J0000000000000000000000Y" as Ulid;

  const key = (scopes: readonly string[]): ApiIdentity => ({
    apiCredentialId: "01J00000000000000000000KEY",
    authentication: "api-credential",
    environmentIds: [ENVIRONMENT_ID],
    opaqueCredential: true,
    organizationIds: [ORGANIZATION_ID],
    principalId: "01J00000000000000000000SVC",
    projectIds: [PROJECT_ID],
    scopes,
  });
  const KEYS: Readonly<Record<string, ApiIdentity>> = {
    "Bearer spend": key(["spend:read"]),
    "Bearer usage": key(["usage:read"]),
  };

  const record = (value: object) =>
    withCanonicalRecordKeys(
      value as Parameters<typeof withCanonicalRecordKeys>[0],
    ) as PlatformRecord;
  const environment = (id: Ulid) =>
    record({
      data: {
        createdAt: NOW.toISOString(),
        id,
        kind: "production",
        name: id,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        slug: id.toLowerCase(),
        status: "active",
        updatedAt: NOW.toISOString(),
        version: 1,
      },
      itemType: "environment",
    });
  const workspace = (id: Ulid, environmentId: Ulid, status: "active" | "archived") =>
    record({
      data: {
        createdAt: NOW.toISOString(),
        environmentId,
        id,
        name: id,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        slug: id.toLowerCase(),
        status,
        updatedAt: NOW.toISOString(),
        version: 1,
      },
      itemType: "workspace",
    });

  async function installWorkspaces() {
    const { database } = makeTenancyTestDatabase();
    for (const item of [
      environment(ENVIRONMENT_ID),
      environment(OTHER_ENVIRONMENT_ID),
      workspace(WORKSPACE_ID, ENVIRONMENT_ID, "archived"),
      workspace(SIBLING_WORKSPACE_ID, ENVIRONMENT_ID, "active"),
      workspace(OTHER_ENVIRONMENT_WORKSPACE_ID, OTHER_ENVIRONMENT_ID, "active"),
    ]) {
      await database.putRecord(item);
    }
    for (const [workspaceId, shard, funding, spendUsdMicros, occurredAt] of [
      [WORKSPACE_ID, 1, "operator", 3_100_000, "2026-10-02T10:00:00.000Z"],
      [WORKSPACE_ID, 2, "organization", 450_000, "2026-10-03T10:00:00.000Z"],
      [WORKSPACE_ID, 3, "operator", 800_000, "2026-09-20T10:00:00.000Z"],
      [SIBLING_WORKSPACE_ID, 4, "operator", 1_200_000, "2026-10-04T10:00:00.000Z"],
    ] as const) {
      await database.transactWrite(
        scopeSpendShardCandidates({
          occurredAt,
          scope: {
            environmentId: ENVIRONMENT_ID,
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            workspaceId,
          },
          shard,
          updatedAt: occurredAt,
        }).map((candidate) => ({
          kind: "put" as const,
          record: addScopeSpend(candidate, undefined, spendUsdMicros, funding),
        })),
      );
    }
    const fetch = createTenancyApi({
      authenticate: async (request) => KEYS[request.headers.get("authorization") ?? ""] ?? null,
      authorize: async () => undefined,
      idempotency: { execute: async (input) => input.operation() },
      operationalReads: createOperationalReadService({
        cursorCodec: makeAesGcmOperationalCursorCodec(Buffer.alloc(32, 7)),
        database,
        now: () => NOW,
      }),
      requestId: () => "request-1",
      service: new Proxy({}, { get: () => ({}) }) as TenancyApiService,
    });
    return async (
      caller: string,
      workspaceId: string,
      query = "",
      environmentId: string = ENVIRONMENT_ID,
    ) => {
      const response = await fetch(
        new Request(`https://api.example.test/v1/workspaces/${workspaceId}/spend${query}`, {
          headers: { authorization: caller, "x-deployments-environment": environmentId },
        }),
      );
      const body = (await response.json()) as Record<string, unknown>;
      return { body: response.ok ? body : body.code, status: response.status };
    };
  }

  const spend = (
    workspaceId: Ulid,
    month: string,
    operatorFundedUsdMicros: number,
    organizationFundedUsdMicros: number,
  ) => ({
    body: {
      asOf: "2026-10-15T09:00:00.000Z",
      environmentId: ENVIRONMENT_ID,
      month,
      operatorFundedUsdMicros,
      organizationFundedUsdMicros,
      periodStart: `${month}-01T00:00:00.000Z`,
      totalUsdMicros: operatorFundedUsdMicros + organizationFundedUsdMicros,
      workspaceId,
    },
    status: 200,
  });

  test("reads an archived workspace's month split by who paid, apart from its sibling", async () => {
    const read = await installWorkspaces();

    expect([
      await read("Bearer spend", WORKSPACE_ID),
      await read("Bearer spend", WORKSPACE_ID, "?month=2026-09"),
      await read("Bearer spend", SIBLING_WORKSPACE_ID),
    ]).toEqual([
      spend(WORKSPACE_ID, "2026-10", 3_100_000, 450_000),
      spend(WORKSPACE_ID, "2026-09", 800_000, 0),
      spend(SIBLING_WORKSPACE_ID, "2026-10", 1_200_000, 0),
    ]);
  });

  test("refuses another environment's workspace, a bad month, and a key without spend:read", async () => {
    const read = await installWorkspaces();

    expect([
      await read("Bearer spend", OTHER_ENVIRONMENT_WORKSPACE_ID),
      await read("Bearer spend", OTHER_ENVIRONMENT_WORKSPACE_ID, "", OTHER_ENVIRONMENT_ID),
      await read("Bearer spend", WORKSPACE_ID, "?month=2026-11"),
      await read("Bearer spend", WORKSPACE_ID, "?month=10-2026"),
      await read("Bearer usage", WORKSPACE_ID),
      await read("Bearer nobody", WORKSPACE_ID),
    ]).toEqual([
      { body: "not_found", status: 404 },
      { body: "environment_scope_violation", status: 403 },
      { body: "invalid_month", status: 400 },
      { body: "invalid_month", status: 400 },
      { body: "insufficient_scope", status: 403 },
      { body: "unauthorized", status: 401 },
    ]);
  });
});
