import {
  AppSlug,
  ErasureFenceRecord,
  Ulid,
  makeAppPersistence,
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type AppPersistence,
  type AppRecord,
  type PlatformRecord,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import {
  createGovernanceService,
  type ErasureReceipt,
  type GovernanceOperation,
  type GovernanceServiceOptions,
  type GovernanceStore,
} from "@deployments-ai/governance";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, spyOn, test } from "bun:test";
import { Schema } from "effect";
import { eraseAgentBuiltApp } from "./app-erasure.ts";
import { governanceAppPorts } from "./app-governance.ts";
import { processGovernanceQueueRecords } from "./governance-worker-main.ts";
import { APP_ID, appRecord } from "./app-record.fixture.ts";
import type { AppsDatabase } from "./apps-database-client.ts";

const noRestamp = async () => ({ outcome: "none" as const, restamped: 0 });

const ulid = Schema.decodeUnknownSync(Ulid);
const ORGANIZATION = ulid("01ARZ3NDEKTSV4RRFFQ69G5FE0");
const OPERATION = "01ARZ3NDEKTSV4RRFFQ69G5FD0";
const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FD1";
const START = "2026-10-09T00:00:00.000Z";

function recordingAppsDatabase() {
  const calls: unknown[] = [];
  const appsDatabase: Pick<AppsDatabase, "erase" | "exportTables"> = {
    erase: async (app) => {
      calls.push({ appId: app.data.id, op: "erase" });
    },
    exportTables: async ({ app, exportId }) => {
      calls.push({ appId: app.data.id, exportId, op: "export" });
      return {
        objects: [
          { key: `apps/${app.data.id}/exports/${exportId}/orders.csv`, rows: 2, table: "orders" },
        ],
      };
    },
  };
  return { appsDatabase, calls };
}

async function fencedOrganization() {
  let clock = Date.parse(START);
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(
    tables.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: START,
        id: ORGANIZATION,
        name: "Acme",
        slug: "acme",
        status: "active",
        updatedAt: START,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  const apps = makeAppPersistence({
    database: makeDynamoDatabase(fake.client, tables),
    generateId: makeIdGenerator().generate,
    now: () => new Date(clock),
  });
  const app = await apps.createApp({
    actor: { type: "system" },
    agentDefinitionId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE1"),
    clusterKey: "default",
    createdBy: { principalId: null, runId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE2") },
    databaseLayout: 1,
    environmentId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE3"),
    name: "Payroll",
    organizationId: ORGANIZATION,
    projectId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE4"),
    slug: Schema.decodeUnknownSync(AppSlug)("payroll"),
    workspaceId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE5"),
  });
  fake.put(
    tables.control,
    Schema.decodeUnknownSync(ErasureFenceRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: START,
          id: ORGANIZATION,
          operationId: OPERATION,
          organizationId: ORGANIZATION,
        },
        itemType: "erasure-fence" as const,
      }),
    ),
  );
  return {
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    app,
    apps,
    now: () => new Date(clock),
  };
}

function tenantErasureGovernance(input: {
  readonly apps: AppPersistence;
  readonly appId: AppRecord["data"]["id"];
  readonly eraseApp: NonNullable<GovernanceServiceOptions["eraseApp"]>;
  readonly now: () => Date;
}) {
  const operations = new Map<string, GovernanceOperation>();
  const receipts: ErasureReceipt[] = [];
  const organization = {
    data: { id: ORGANIZATION, organizationId: ORGANIZATION },
    itemType: "organization",
    pk: `ORG#${ORGANIZATION}`,
    sk: `ORG#${ORGANIZATION}`,
  } as unknown as PlatformRecord;
  const unused = async () => {
    throw new Error("not used by tenant erasure");
  };
  const store: GovernanceStore = {
    appendImmutableAuditExport: unused,
    beginErasure: async () => {},
    cancelOperationForErasure: unused,
    claimOperation: async (operation) => {
      operations.set(operation.id, operation);
      return operation;
    },
    completeRetentionCleanup: unused,
    createOperation: async (operation) => {
      operations.set(operation.id, operation);
      return operation;
    },
    deleteTenantRecords: async () => {},
    eraseTenantRecords: async () => {},
    finalizeErasure: async (operation, receipt) => {
      receipts.push(receipt);
      operations.delete(operation.id);
    },
    getErasureReceipt: async (operationId) => receipts.find(({ id }) => id === operationId),
    getOperation: async (_organizationId, operationId) => operations.get(operationId),
    getRetentionPolicy: async () => undefined,
    listLegacyPrincipalIdempotency: async () => [],
    listLegacyRuntimeLeases: async () => [],
    listOperations: async () => ({ items: [] }),
    listTenantRecords: async () => {
      const app = await input.apps.getApp(input.appId);
      return {
        items: [
          { record: organization, table: "control" as const },
          ...(app ? [{ record: app, table: "control" as const }] : []),
        ],
      };
    },
    listTenantErasurePage: async () => ({
      records: (await store.listTenantRecords(ORGANIZATION)).items,
      staleLocators: [],
    }),
    listTenantGovernanceRecords: async () => [],
    organizationExists: async () => true,
    putRetentionPolicy: unused,
    releaseErasureFence: unused,
    scopeLegacyRuntimeLeases: unused,
    stageErasureRetentionCleanup: unused,
    stageRetentionCleanup: unused,
    updateOperation: async (operation) => {
      operations.set(operation.id, operation);
      return operation;
    },
  };
  const service = createGovernanceService({
    allowedObjectBuckets: ["governance"],
    eraseApp: input.eraseApp,
    generateId: async () => OPERATION,
    now: input.now,
    objectStore: {
      blockWrites: unused,
      delete: unused,
      deleteAllVersions: unused,
      find: async () => undefined,
      put: unused,
      read: unused,
      size: unused,
    },
    signer: { keyId: "key", publicKey: async () => "public", sign: async () => "signature" },
    store,
  });
  return { operations, receipts, service };
}

describe("governance ports for agent-built apps", () => {
  test("erase an app through the organization's erasure fence, which refuses an ordinary erase", async () => {
    const { advance, app, apps } = await fencedOrganization();
    const { appsDatabase, calls } = recordingAppsDatabase();
    const ports = governanceAppPorts({ apps, appsDatabase, bucket: "apps-bucket" });

    const early = await ports
      .eraseApp({ app, operationId: OPERATION })
      .catch((error: unknown) => error);
    const callsWhileEarly = [...calls];
    advance(11 * 60_000);
    const ordinary = await eraseAgentBuiltApp(
      { apps, appsDatabase },
      { actor: { type: "system" }, app },
    ).then(
      () => "erased",
      () => "refused",
    );
    const stateAfterRefusal = (await apps.getApp(app.data.id))?.data.lifecycle.state;
    await ports.eraseApp({ app, operationId: OPERATION });

    expect(early).toMatchObject({
      code: "tenant_app_provisioning_pending",
      message: `App ${app.data.id} may still be provisioning; erasure becomes possible after 2026-10-09T00:10:00.000Z.`,
    });
    expect({
      calls,
      callsWhileEarly,
      ordinary,
      remaining: await apps.getApp(app.data.id),
      stateAfterRefusal,
    }).toEqual({
      calls: [{ appId: app.data.id, op: "erase" }],
      callsWhileEarly: [],
      ordinary: "refused",
      remaining: undefined,
      stateAfterRefusal: "provisioning",
    });
  });

  test("acknowledges a tenant erasure that waits out an app's provisioning window", async () => {
    const { advance, app, apps, now } = await fencedOrganization();
    const { appsDatabase, calls } = recordingAppsDatabase();
    const governance = tenantErasureGovernance({
      apps,
      appId: app.data.id,
      eraseApp: governanceAppPorts({ apps, appsDatabase, bucket: "apps-bucket" }).eraseApp,
      now,
    });
    await governance.service.requestOperation({
      idempotencyKey: "erase-tenant",
      kind: "tenant-erasure",
      operationId: OPERATION,
      organizationId: ORGANIZATION,
      principalId: PRINCIPAL,
    });
    const delivery = [
      {
        body: JSON.stringify({ operationId: OPERATION, organizationId: ORGANIZATION }),
        messageId: "message-1",
      },
    ];
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const standing = standingInstallation().repository;
      const waiting = await processGovernanceQueueRecords(
        governance.service,
        delivery,
        standing,
        noRestamp,
      );
      const whileWaiting = governance.operations.get(OPERATION);
      advance(11 * 60_000);
      const finished = await processGovernanceQueueRecords(
        governance.service,
        delivery,
        standing,
        noRestamp,
      );

      expect({
        calls,
        failureLogs: consoleError.mock.calls,
        finished,
        receipts: governance.receipts.map(({ id }) => id),
        waiting,
        whileWaiting: { error: whileWaiting?.error, status: whileWaiting?.status },
      }).toEqual({
        calls: [{ appId: app.data.id, op: "erase" }],
        failureLogs: [],
        finished: { batchItemFailures: [] },
        receipts: [OPERATION],
        waiting: { batchItemFailures: [] },
        whileWaiting: {
          error: {
            code: "tenant_app_provisioning_pending",
            message: `App ${app.data.id} may still be provisioning; erasure becomes possible after 2026-10-09T00:10:00.000Z.`,
          },
          status: "pending",
        },
      });
    } finally {
      consoleError.mockRestore();
      stderr.mockRestore();
    }
  });

  test("export tables only for apps that have held data, under one export id per operation", async () => {
    const { appsDatabase, calls } = recordingAppsDatabase();
    const ports = governanceAppPorts({
      apps: {} as never,
      appsDatabase,
      bucket: "apps-bucket",
    });
    const exported = (app: AppRecord) => ports.exportAppTables({ app, operationId: OPERATION });

    const results = {
      archived: await exported(
        appRecord({ lifecycle: { archivedAt: START, liveReleaseId: null, state: "archived" } }),
      ),
      provisioning: await exported(
        appRecord({ lifecycle: { requestedAt: START, state: "provisioning" } }),
      ),
    };

    expect({ calls, results }).toEqual({
      calls: [{ appId: APP_ID, exportId: "7MTVTXDTX5J5AF9ZBT598X6MAD", op: "export" }],
      results: {
        archived: [
          {
            bucket: "apps-bucket",
            contentType: "text/csv; charset=utf-8",
            key: `apps/${APP_ID}/exports/7MTVTXDTX5J5AF9ZBT598X6MAD/orders.csv`,
          },
        ],
        provisioning: [],
      },
    });
  });
});
