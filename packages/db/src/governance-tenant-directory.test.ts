import { describe, expect, test } from "bun:test";
import {
  governanceLegacyDirectoryRecord,
  MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION,
  governanceTenantDirectoryRecord,
  withGovernanceTenantDirectory,
} from "./governance-tenant-directory.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import { makeDynamoDatabase, prepareDynamoTransactionOperations } from "./dynamo-database.ts";
import { recordingClient } from "./database-write-test-support.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function organization() {
  return withCanonicalRecordKeys({
    data: { id: ORGANIZATION_ID },
    itemType: "organization" as const,
  }) as unknown as PlatformRecord;
}

function idempotency(organizationId?: string) {
  return withCanonicalRecordKeys({
    data: {
      idempotencyKey: "legacy-request",
      ...(organizationId ? { organizationId } : {}),
      principalId: PRINCIPAL_ID,
    },
    itemType: "idempotency" as const,
  }) as unknown as Extract<PlatformRecord, { readonly itemType: "idempotency" }>;
}

describe("governance tenant directory", () => {
  test("atomically adds and removes the deterministic tenant pointer", () => {
    const record = organization();
    const directory = governanceTenantDirectoryRecord(record);
    if (!directory) throw new Error("Expected an organization directory record.");

    expect(withGovernanceTenantDirectory([{ kind: "put", record }])).toMatchObject([
      { kind: "put", record },
      {
        allowExisting: true,
        kind: "put",
        record: {
          data: {
            organizationId: ORGANIZATION_ID,
            recordItemType: "organization",
            recordPk: record.pk,
            recordSk: record.sk,
            recordTable: "control",
          },
          itemType: "governance-tenant-record",
          pk: `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY#SHARD#10`,
          sk: directory.sk,
        },
      },
    ]);
    expect(withGovernanceTenantDirectory([{ kind: "delete", record }])).toEqual([
      { kind: "delete", record },
      { allowMissing: true, kind: "delete", record: directory },
    ]);
  });

  test("replaces a legacy idempotency pointer when tenant ownership becomes known", () => {
    const previousRecord = idempotency();
    const record = idempotency(ORGANIZATION_ID);
    const previousDirectory = governanceLegacyDirectoryRecord(previousRecord);
    const directory = governanceTenantDirectoryRecord(record);
    if (!previousDirectory || !directory) throw new Error("Expected both directory records.");

    expect(withGovernanceTenantDirectory([{ kind: "put", previousRecord, record }])).toMatchObject([
      { kind: "put", previousRecord, record },
      { allowMissing: true, kind: "delete", record: previousDirectory },
      { allowExisting: true, kind: "put", record: directory },
    ]);
  });

  test("allows a legacy tenant rate counter to acquire explicit organization scope", async () => {
    const previousRecord = withCanonicalRecordKeys({
      data: {
        count: 1,
        expiresAt: "2026-08-22T00:00:00.000Z",
        limitKey: "brain-upload.issuance.organization",
        scopeId: ORGANIZATION_ID,
        version: 1,
        window: "2026-08-21T00",
      },
      itemType: "rate-limit-counter" as const,
      ttl: Math.floor(Date.parse("2026-08-22T00:00:00.000Z") / 1_000),
    });
    const record = withCanonicalRecordKeys({
      ...previousRecord,
      data: {
        ...previousRecord.data,
        count: 2,
        organizationId: ORGANIZATION_ID,
        version: 2,
      },
    });
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.transactWrite([
      {
        kind: "put",
        previousRecord: previousRecord as never,
        record: record as never,
      },
    ]);

    expect(transactions[0]?.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({ itemType: "governance-tenant-record" }),
        }),
      }),
    );
  });

  test("reserves invariant slots when batching tenant mutations", async () => {
    const operations = Array.from(
      { length: MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION },
      (_, index) => ({
        kind: "put" as const,
        record: withCanonicalRecordKeys({
          data: {
            count: index,
            expiresAt: "2026-08-22T00:00:00.000Z",
            limitKey: "brain-upload.issuance.organization",
            organizationId: ORGANIZATION_ID,
            scopeId: ORGANIZATION_ID,
            version: 1,
            window: `2026-08-21T${String(index).padStart(2, "0")}`,
          },
          itemType: "rate-limit-counter" as const,
          ttl: Math.floor(Date.parse("2026-08-22T00:00:00.000Z") / 1_000),
        }) as never,
      }),
    );

    const prepared = await prepareDynamoTransactionOperations(operations);
    expect(prepared).toHaveLength(99);
    expect(
      prepareDynamoTransactionOperations([...operations, { ...operations[0]! }]),
    ).rejects.toMatchObject({ operation: "transact-write" });
  });
});
