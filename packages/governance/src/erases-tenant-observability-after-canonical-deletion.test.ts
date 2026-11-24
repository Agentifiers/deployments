import type { PlatformRecord } from "@deployments-ai/db";
import { fakeTenantErasure } from "./tenant-erasure-test-support.ts";
import { describe, expect, test } from "bun:test";
import { sha256 } from "./canonical.ts";
import { decodeMemorySearchErasureReceipt } from "./governance-memory-search-erasure.ts";
import type { ObservabilityErasureRequest } from "./governance-observability-erasure.ts";
import { createGovernanceService } from "./service.ts";
import {
  GovernanceError,
  type ErasureReceipt,
  type GovernanceOperation,
  type GovernanceServiceOptions,
  type GovernanceStore,
  type TenantRecord,
} from "./types.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OPERATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

const completeReceipt = {
  clickhouse: { absenceVerifiedAt: "2026-07-25T00:20:00.000Z", rowsDeleted: 7 },
  clickhouseBackupsExpireBy: "2026-08-24T00:20:00.000Z",
  iceberg: {
    absenceVerifiedAt: "2026-07-25T00:25:00.000Z",
    physicalRemovalBy: "2026-07-28T00:25:00.000Z",
    rowsDeleted: 5,
    tables: [
      { rowsDeleted: 3, table: "spans" },
      { rowsDeleted: 2, table: "traces" },
    ],
  },
  operationId: OPERATION_ID,
};

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

function harness(
  purgeObservability?: GovernanceServiceOptions["purgeObservability"],
  purgeMemorySearch?: GovernanceServiceOptions["purgeMemorySearch"],
) {
  const records: TenantRecord[] = [
    record("organization", { id: ORGANIZATION_ID }, "control"),
    record("run", { id: "completed-run", status: "completed" }, "execution"),
  ];
  const operations = new Map<string, GovernanceOperation>();
  const receipts: ErasureReceipt[] = [];
  const events: string[] = [];
  let currentTime = new Date("2026-07-25T00:00:00.000Z");
  const unused = async () => {
    throw new Error("not used by tenant erasure");
  };
  const store: GovernanceStore = {
    appendImmutableAuditExport: unused,
    beginErasure: async (fence) => {
      events.push("fence");
      records.push(
        record(
          "erasure-fence",
          { createdAt: fence.createdAt, id: ORGANIZATION_ID, operationId: fence.operationId },
          "control",
        ),
      );
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
      records.length = 0;
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
    listTenantRecords: async () => {
      events.push("list");
      return { items: [...records] };
    },
    organizationExists: async () => records.some((item) => item.record.itemType === "organization"),
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
    generateId: async () => OPERATION_ID,
    now: () => currentTime,
    objectStore: {
      blockWrites: unused,
      delete: unused,
      deleteAllVersions: unused,
      find: async () => undefined,
      put: unused,
      read: unused,
      size: unused,
    },
    ...(purgeMemorySearch ? { purgeMemorySearch } : {}),
    ...(purgeObservability
      ? {
          purgeObservability: async (request: ObservabilityErasureRequest) => {
            events.push("observability");
            return purgeObservability(request);
          },
        }
      : {}),
    signer: { keyId: "key", publicKey: async () => "public", sign: async () => "signature" },
    store,
  });
  return {
    events,
    operations,
    receipts,
    async requestErasure() {
      await service.requestOperation({
        idempotencyKey: "erase-observability",
        kind: "tenant-erasure",
        operationId: OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
      });
    },
    service,
    setNow(value: string) {
      currentTime = new Date(value);
    },
  };
}

describe("tenant observability erasure", () => {
  test("purges observability after canonical deletion and before finalization", async () => {
    const requests: ObservabilityErasureRequest[] = [];
    const fixture = harness(async (request) => {
      requests.push(request);
      return { receipt: completeReceipt, status: "complete" };
    });
    await fixture.requestErasure();

    const completed = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect(fixture.events.filter((event) => event !== "list")).toEqual([
      "fence",
      "delete:run",
      "observability",
      "finalize",
    ]);
    expect(requests).toEqual([
      {
        drainAnchorAt: "2026-07-25T00:00:00.000Z",
        operationId: OPERATION_ID,
        organizationId: ORGANIZATION_ID,
      },
    ]);
    const observability = {
      backupsExpireBy: "2026-08-24T00:20:00.000Z",
      clickhouseRowsDeleted: 7,
      icebergRowsDeleted: 5,
      physicalRemovalBy: "2026-07-28T00:25:00.000Z",
    };
    expect(fixture.receipts[0]).toMatchObject({
      observability,
      organizationHash: sha256(ORGANIZATION_ID),
    });
    expect(completed.summary).toMatchObject({ observability, recordsDeleted: 2 });
    expect(fixture.service.getOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      status: "completed",
      summary: { observability },
    });
  });

  test("checkpoints pending purge progress and resumes without repeating canonical deletion", async () => {
    const requests: ObservabilityErasureRequest[] = [];
    const responses = [
      { progress: { phase: "drain" }, reason: "pipeline_draining", status: "pending" },
      {
        progress: { clickhouseRowsDeleted: 7, phase: "iceberg" },
        reason: "iceberg_purge_running",
        status: "pending",
      },
      { receipt: completeReceipt, status: "complete" },
    ] as const;
    const fixture = harness(async (request) => {
      requests.push(request);
      return responses[requests.length - 1]!;
    });
    await fixture.requestErasure();

    const waiting = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);
    expect(waiting).toMatchObject({
      canonicalDeletedAt: "2026-07-25T00:00:00.000Z",
      error: { code: "observability_erasure_pending" },
      observabilityErasureProgress: { phase: "drain" },
      status: "pending",
    });
    expect(waiting.leaseExpiresAt).toBeUndefined();

    fixture.setNow("2026-07-25T00:11:00.000Z");
    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      error: { code: "observability_erasure_pending" },
      observabilityErasureProgress: { clickhouseRowsDeleted: 7, phase: "iceberg" },
      status: "pending",
    });
    fixture.setNow("2026-07-25T00:26:00.000Z");
    const completed = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect(completed.status).toBe("completed");
    expect(requests.map(({ drainAnchorAt, progress }) => ({ drainAnchorAt, progress }))).toEqual([
      { drainAnchorAt: "2026-07-25T00:00:00.000Z", progress: undefined },
      { drainAnchorAt: "2026-07-25T00:00:00.000Z", progress: { phase: "drain" } },
      {
        drainAnchorAt: "2026-07-25T00:00:00.000Z",
        progress: { clickhouseRowsDeleted: 7, phase: "iceberg" },
      },
    ]);
    expect(fixture.events.filter((event) => event.startsWith("delete"))).toEqual(["delete:run"]);
    expect(fixture.events.filter((event) => event === "fence")).toHaveLength(1);
    expect(fixture.receipts[0]?.observability).toMatchObject({ clickhouseRowsDeleted: 7 });
  });

  test("retries a failed purge from the canonical deletion checkpoint", async () => {
    let attempts = 0;
    const fixture = harness(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Observability erasure failed: Athena throttled");
      return { receipt: completeReceipt, status: "complete" };
    });
    await fixture.requestErasure();

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).rejects.toThrow(
      "Athena throttled",
    );
    expect(fixture.operations.get(OPERATION_ID)).toMatchObject({
      canonicalDeletedAt: "2026-07-25T00:00:00.000Z",
      status: "failed",
    });

    fixture.setNow("2026-07-25T00:05:00.000Z");
    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      status: "completed",
    });
    expect(fixture.events.filter((event) => event.startsWith("delete"))).toEqual(["delete:run"]);
  });

  test("resumes a surveyed erasure without surveying again", async () => {
    let memoryPurges = 0;
    const fixture = harness(undefined, async () => {
      memoryPurges += 1;
      if (memoryPurges === 1) {
        throw new GovernanceError("memory_search_drain_pending", "Memory mutations are draining.");
      }
      return decodeMemorySearchErasureReceipt(
        { operationId: OPERATION_ID, targets: [] },
        OPERATION_ID,
      );
    });
    await fixture.requestErasure();

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      error: { code: "memory_search_drain_pending" },
    });
    expect(fixture.events).toEqual(["fence", "list"]);
    expect(fixture.operations.get(OPERATION_ID)?.erasureProgress).toEqual({
      pass: 1,
      passChanged: false,
      phase: "delete",
      recordsDeleted: 0,
    });

    fixture.events.length = 0;
    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      status: "completed",
    });
    expect(fixture.events).toEqual(["fence", "delete:run", "finalize"]);
  });

  test("keeps the memory search backup expiry across an observability wait", async () => {
    const memoryBackupsExpireBy = "2026-08-08T01:00:00.000Z";
    const observabilityResponses = [
      { progress: { phase: "drain" }, reason: "pipeline_draining", status: "pending" },
      { receipt: completeReceipt, status: "complete" },
    ] as const;
    let observabilityCalls = 0;
    let memoryPurges = 0;
    const fixture = harness(
      async () => observabilityResponses[observabilityCalls++]!,
      async () => {
        memoryPurges += 1;
        return decodeMemorySearchErasureReceipt(
          {
            operationId: OPERATION_ID,
            targets: [
              {
                backupErasureEligibleAt: memoryBackupsExpireBy,
                componentReceipts: [
                  {
                    componentId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
                    generationId: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
                    providerReceipt: { absenceVerified: true, receiptDigest: "proof" },
                  },
                ],
                providerId: "aws-native",
                targetDigest: "target",
              },
            ],
          },
          OPERATION_ID,
        );
      },
    );
    await fixture.requestErasure();

    expect(await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).toMatchObject({
      error: { code: "observability_erasure_pending" },
      status: "pending",
    });
    fixture.setNow("2026-07-25T00:11:00.000Z");
    const completed = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect(memoryPurges).toBe(1);
    expect(completed.summary).toMatchObject({
      memorySearch: { backupsExpireBy: memoryBackupsExpireBy },
      observability: { backupsExpireBy: "2026-08-24T00:20:00.000Z" },
    });
    expect(fixture.receipts[0]?.memorySearch).toEqual({ backupsExpireBy: memoryBackupsExpireBy });
  });

  test("finalizes without an observability summary when the purge is not deployed", async () => {
    const fixture = harness();
    await fixture.requestErasure();

    const completed = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect(fixture.events).not.toContain("observability");
    expect(fixture.receipts[0]?.observability).toBeUndefined();
    expect(completed.summary).toEqual({
      auditRootHash: expect.any(String),
      recordsDeleted: 2,
    });
  });
});
