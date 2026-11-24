import {
  governanceTenantDirectoryRecord,
  tableForItemType,
  type PlatformRecord,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { createGovernanceService } from "./service.ts";
import type { GovernanceStore, TenantRecord } from "./types.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = "2026-07-25T00:00:00.000Z";
const DAY_SECONDS = 86_400;

function record(
  itemType: PlatformRecord["itemType"],
  id: string,
  timestamp: Readonly<Record<string, string>>,
  ttlDays?: number,
) {
  const at = Object.values(timestamp)[0]!;
  return {
    record: {
      data: { id, organizationId: ORGANIZATION_ID, version: 1, ...timestamp },
      itemType,
      pk: `${itemType}#${id}`,
      sk: `${itemType}#${id}`,
      ...(ttlDays === undefined ? {} : { ttl: Date.parse(at) / 1_000 + ttlDays * DAY_SECONDS }),
    } as unknown as PlatformRecord,
    table: tableForItemType(itemType),
  } as TenantRecord;
}

const idOf = ({ record: { data } }: TenantRecord) => ("id" in data ? String(data.id) : "");

function harness(records: TenantRecord[]) {
  const walks: string[] = [];
  const staged: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("not used by retention");
  };
  const store: GovernanceStore = {
    appendImmutableAuditExport: unused,
    beginErasure: async () => undefined,
    cancelOperationForErasure: unused,
    claimOperation: unused,
    completeRetentionCleanup: async () => undefined,
    createOperation: unused,
    deleteTenantRecords: unused,
    eraseTenantRecords: unused,
    finalizeErasure: unused,
    getErasureReceipt: unused,
    getOperation: unused,
    getRetentionPolicy: async () => ({
      artifacts: 365,
      audit: 2_555,
      createdAt: NOW,
      events: 30,
      messages: 365,
      organizationId: ORGANIZATION_ID,
      runs: 365,
      threads: 365,
      updatedAt: NOW,
      updatedByPrincipalId: ORGANIZATION_ID,
      version: 2,
    }),
    listLegacyPrincipalIdempotency: unused,
    listTenantErasurePage: unused,
    listTenantGovernanceRecords: unused,
    listLegacyRuntimeLeases: async () => [],
    listOperations: unused,
    listTenantRecords: async (_organizationId, _cursor, selection) => ({
      items: records.filter((item) => {
        const read = selection?.select(governanceTenantDirectoryRecord(item.record)!.data);
        if (read) walks.push(`${read}:${idOf(item)}`);
        return read !== undefined;
      }),
    }),
    organizationExists: async () => true,
    putRetentionPolicy: unused,
    releaseErasureFence: async () => undefined,
    scopeLegacyRuntimeLeases: unused,
    stageErasureRetentionCleanup: unused,
    stageRetentionCleanup: async (item) => {
      staged.push(idOf(item));
      return true;
    },
    updateOperation: unused,
  };
  const service = createGovernanceService({
    allowedObjectBuckets: [],
    generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    now: () => new Date(NOW),
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
  return { service, staged, walks };
}

describe("retention of item TTL records", () => {
  test("leaves records to DynamoDB TTL unless the policy shortened past their ttl", async () => {
    const fixture = harness([
      record("memory-retrieval", "ttl-covered", { createdAt: "2025-01-01T00:00:00.000Z" }, 365),
      record("brain-query-attempt", "pre-ttl", { createdAt: "2025-01-01T00:00:00.000Z" }),
      record("semantic-event", "shortened", { occurredAt: "2026-06-01T00:00:00.000Z" }, 365),
      record("semantic-event", "covered", { occurredAt: "2026-06-01T00:00:00.000Z" }, 30),
      record("brain-retrieval", "not-due", { createdAt: "2026-06-01T00:00:00.000Z" }, 365),
    ]);

    expect(fixture.service.runRetention(ORGANIZATION_ID)).resolves.toMatchObject({
      deletedByClass: { events: 1, runs: 1 },
      recordsDeleted: 2,
    });
    expect(fixture.walks).toEqual(["eventual:pre-ttl", "eventual:shortened"]);
    expect(fixture.staged.toSorted()).toEqual(["pre-ttl", "shortened"]);
  });
});
