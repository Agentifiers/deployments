import type { PlatformRecord } from "@deployments-ai/db";
import { fakeTenantErasure } from "./tenant-erasure-test-support.ts";
import { describe, expect, test } from "bun:test";
import { createGovernanceService } from "./service.ts";
import type {
  ErasureReceipt,
  GovernanceOperation,
  GovernanceServiceOptions,
  GovernanceStore,
  TenantRecord,
} from "./types.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OPERATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PAYROLL_APP = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const ROSTER_APP = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

function record(
  itemType: PlatformRecord["itemType"],
  data: Readonly<Record<string, unknown>>,
  table: TenantRecord["table"],
): TenantRecord {
  return {
    record: {
      data: { organizationId: ORGANIZATION_ID, ...data },
      itemType,
      pk: `${table}#${String(data.id)}`,
      sk: `${itemType}#${String(data.id)}`,
    } as unknown as PlatformRecord,
    table,
  };
}

function harness(eraseApp?: GovernanceServiceOptions["eraseApp"]) {
  const records: TenantRecord[] = [
    record("organization", { id: ORGANIZATION_ID }, "control"),
    record("app", { id: PAYROLL_APP, lifecycle: { state: "active" } }, "control"),
    record("app", { id: ROSTER_APP, lifecycle: { state: "provisioning" } }, "control"),
    record("run", { id: "completed-run", status: "completed" }, "execution"),
  ];
  const operations = new Map<string, GovernanceOperation>();
  const receipts: ErasureReceipt[] = [];
  const events: string[] = [];
  const unused = async () => {
    throw new Error("not used by tenant erasure");
  };
  const store: GovernanceStore = {
    appendImmutableAuditExport: unused,
    beginErasure: async () => {
      events.push("fence");
    },
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
    deleteTenantRecords: async (items) => {
      events.push(`delete:${items.map((item) => item.record.itemType).join(",")}`);
      for (const item of items) records.splice(records.indexOf(item), 1);
    },
    finalizeErasure: async (operation, receipt) => {
      events.push("finalize");
      receipts.push(receipt);
      operations.delete(operation.id);
    },
    getErasureReceipt: async (operationId) => receipts.find(({ id }) => id === operationId),
    getOperation: async (_organizationId, operationId) => operations.get(operationId),
    getRetentionPolicy: async () => undefined,
    listLegacyPrincipalIdempotency: async () => [],
    ...fakeTenantErasure(records, [], (items, deadline) =>
      store.deleteTenantRecords(items, deadline),
    ),
    listLegacyRuntimeLeases: async () => [],
    listOperations: async () => ({ items: [] }),
    listTenantRecords: async () => ({ items: [...records] }),
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
  const serviceWith = (port: GovernanceServiceOptions["eraseApp"]) =>
    createGovernanceService({
      allowedObjectBuckets: ["governance"],
      ...(port ? { eraseApp: port } : {}),
      generateId: async () => OPERATION_ID,
      now: () => new Date("2026-10-09T00:00:00.000Z"),
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
  const erasing =
    (
      port: NonNullable<GovernanceServiceOptions["eraseApp"]>,
    ): GovernanceServiceOptions["eraseApp"] =>
    async (input) => {
      await port(input);
      events.push(`erase-app:${input.app.data.id}`);
      records.splice(
        records.findIndex((item) => item.record === input.app),
        1,
      );
    };
  const service = serviceWith(eraseApp ? erasing(eraseApp) : undefined);
  return {
    events,
    operation: () => operations.get(OPERATION_ID),
    records,
    async requestErasure() {
      await service.requestOperation({
        idempotencyKey: "erase-tenant",
        kind: "tenant-erasure",
        operationId: OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
      });
    },
    rerunWith: (port: NonNullable<GovernanceServiceOptions["eraseApp"]>) =>
      serviceWith(erasing(port)).runOperation(ORGANIZATION_ID, OPERATION_ID),
    service,
  };
}

async function settled(work: Promise<unknown>) {
  return work.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("tenant erasure of agent-built apps", () => {
  test("erases every app, as the erasure, before deleting canonical records", async () => {
    const calls: unknown[] = [];
    const fixture = harness(async ({ app, operationId }) => {
      calls.push({ appId: app.data.id, operationId });
    });
    await fixture.requestErasure();

    const completed = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect({ calls, events: fixture.events, status: completed.status }).toEqual({
      calls: [
        { appId: PAYROLL_APP, operationId: OPERATION_ID },
        { appId: ROSTER_APP, operationId: OPERATION_ID },
      ],
      events: [
        "fence",
        `erase-app:${PAYROLL_APP}`,
        `erase-app:${ROSTER_APP}`,
        "delete:run",
        "finalize",
      ],
      status: "completed",
    });
  });

  test("a failed app erasure keeps the fence and every record, and a retry finishes", async () => {
    const fixture = harness(async ({ app }) => {
      if (app.data.id === ROSTER_APP) {
        throw new Error("The apps-database erase failed with internal_error: timeout");
      }
    });
    await fixture.requestErasure();

    const failure = await settled(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID));
    const afterFailure = {
      error: fixture.operation()?.error,
      events: [...fixture.events],
      remaining: fixture.records.map((item) => item.record.itemType),
      status: fixture.operation()?.status,
    };
    const retried: string[] = [];
    const completed = await fixture.rerunWith(async ({ app }) => {
      retried.push(app.data.id);
    });

    expect({ afterFailure, failure, retried, status: completed.status }).toEqual({
      afterFailure: {
        error: {
          code: "governance_operation_failed",
          message: "The apps-database erase failed with internal_error: timeout",
        },
        events: ["fence", `erase-app:${PAYROLL_APP}`],
        remaining: ["organization", "app", "run"],
        status: "pending",
      },
      failure: "The apps-database erase failed with internal_error: timeout",
      retried: [ROSTER_APP],
      status: "completed",
    });
  });

  test("refuses to delete a tenant's records when it cannot erase the tenant's apps", async () => {
    const fixture = harness();
    await fixture.requestErasure();

    const failure = await settled(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID));

    expect({
      error: fixture.operation()?.error?.code,
      failure,
      remaining: fixture.records.map((item) => item.record.itemType),
      status: fixture.operation()?.status,
    }).toEqual({
      error: "tenant_app_erasure_unavailable",
      failure: "Tenant erasure found agent-built apps but cannot erase their databases.",
      remaining: ["organization", "app", "app", "run"],
      status: "failed",
    });
  });
});
