import {
  governanceTenantDirectoryRecord,
  tableForItemType,
  type PlatformRecord,
  type TenantRecordLocator,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { createGovernanceService } from "./service.ts";
import type { GovernanceStore, TenantRecord } from "./types.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OLD = "2025-01-01T00:00:00.000Z";
const RECENT = "2026-07-20T00:00:00.000Z";
const SHARED_OBJECT = {
  bucket: "artifacts",
  key: `organizations/${ORGANIZATION_ID}/artifacts/shared.bin`,
};

function record(itemType: PlatformRecord["itemType"], data: Readonly<Record<string, unknown>>) {
  return {
    record: {
      data: { organizationId: ORGANIZATION_ID, ...data },
      itemType,
      pk: `${itemType}#${String(data.id)}`,
      sk: `${itemType}#${String(data.id)}`,
    } as unknown as PlatformRecord,
    table: tableForItemType(itemType),
  } as TenantRecord;
}

/** Applies inventory selections to locators built by the real locator writer. */
function harness(locatorsPredateRetentionFields = false) {
  const records: TenantRecord[] = [
    record("run", { id: "run", status: "completed", threadId: "thread", updatedAt: RECENT }),
    record("message", { id: "old-message", threadId: "old-thread", updatedAt: OLD, version: 1 }),
    record("message", { id: "recent-message", threadId: "thread", updatedAt: RECENT, version: 1 }),
    record("meter-event", { id: "meter", occurredAt: OLD }),
    record("artifact", { id: "artifact", storage: SHARED_OBJECT, updatedAt: OLD, version: 1 }),
    record("agent-release", { artifact: SHARED_OBJECT, id: "release", updatedAt: OLD }),
  ];
  const walks: string[][] = [];
  const deletedObjects: string[] = [];
  let fenced = false;
  const unused = async (): Promise<never> => {
    throw new Error("not used by retention");
  };
  const locator = (item: TenantRecord): TenantRecordLocator => {
    const data = governanceTenantDirectoryRecord(item.record)!.data;
    if (!locatorsPredateRetentionFields) return data;
    const { recordObjectDigests: _digests, recordTimestamp: _timestamp, ...legacy } = data;
    return legacy;
  };
  const store: GovernanceStore = {
    appendImmutableAuditExport: unused,
    beginErasure: async () => {
      fenced = true;
    },
    cancelOperationForErasure: unused,
    claimOperation: unused,
    completeRetentionCleanup: async (cleanup) => {
      records.splice(
        records.findIndex(
          (item) =>
            item.record.itemType === "retention-cleanup" && item.record.data.id === cleanup.id,
        ),
        1,
      );
    },
    createOperation: unused,
    deleteTenantRecords: unused,
    finalizeErasure: unused,
    getErasureReceipt: unused,
    getOperation: unused,
    getRetentionPolicy: async () => undefined,
    listLegacyPrincipalIdempotency: unused,
    eraseTenantRecords: unused,
    listTenantErasurePage: unused,
    listTenantGovernanceRecords: unused,
    listLegacyRuntimeLeases: async () => [],
    listOperations: unused,
    listTenantRecords: async (_organizationId, _cursor, selection) => {
      expect(fenced).toBe(true);
      const walk: string[] = [];
      walks.push(walk);
      const items = records.filter((item) => {
        const read = selection?.select(locator(item));
        const { data } = item.record;
        if (read) walk.push(`${read}:${"id" in data ? String(data.id) : ""}`);
        return read !== undefined;
      });
      return { items };
    },
    organizationExists: async () => true,
    putRetentionPolicy: unused,
    releaseErasureFence: async () => {
      fenced = false;
    },
    scopeLegacyRuntimeLeases: unused,
    stageErasureRetentionCleanup: unused,
    stageRetentionCleanup: async (item, cleanup) => {
      records.splice(records.indexOf(item), 1);
      records.push(record("retention-cleanup", { ...cleanup }));
      return true;
    },
    updateOperation: unused,
  };
  const service = createGovernanceService({
    allowedObjectBuckets: ["artifacts"],
    generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    now: () => new Date("2026-07-25T00:00:00.000Z"),
    objectStore: {
      blockWrites: unused,
      delete: async (reference) => {
        deletedObjects.push(reference.key);
      },
      deleteAllVersions: async (reference) => {
        deletedObjects.push(reference.key);
      },
      find: async () => undefined,
      put: unused,
      read: unused,
      size: unused,
    },
    signer: { keyId: "key", publicKey: async () => "public", sign: async () => "signature" },
    store,
  });
  return { deletedObjects, records, service, walks };
}

describe("retention inventory reads", () => {
  test("reads due candidates eventually and re-reads only live holders of deleted objects", async () => {
    const fixture = harness();

    expect(fixture.service.runRetention(ORGANIZATION_ID)).resolves.toMatchObject({
      recordsDeleted: 2,
    });

    expect(fixture.walks).toEqual([
      ["consistent:run", "eventual:old-message", "eventual:artifact"],
      ["consistent:release"],
    ]);
    // The release still references the expired artifact's object, so the object survives.
    expect(fixture.deletedObjects).toEqual([]);
    expect(
      fixture.records.map(({ record: { data } }) => ("id" in data ? data.id : undefined)),
    ).toEqual(["run", "recent-message", "meter", "release"]);
  });

  test("reads locators without retention fields as possibly due object holders", async () => {
    const fixture = harness(true);

    expect(fixture.service.runRetention(ORGANIZATION_ID)).resolves.toMatchObject({
      recordsDeleted: 2,
    });

    expect(fixture.walks).toEqual([
      ["consistent:run", "eventual:old-message", "eventual:recent-message", "eventual:artifact"],
      ["consistent:recent-message", "consistent:release"],
    ]);
    expect(fixture.deletedObjects).toEqual([]);
  });
});
