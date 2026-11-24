import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService, RecordKey } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { RuntimeLeaseRecord } from "../records/coordination.ts";
import { withCanonicalRecordKeys, type PlatformRecord, type TableName } from "../records/index.ts";
import { makeModelGatewayRunLeaseReader } from "./run-lease.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);
const threadId = id("1");

function lease() {
  return Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: "2026-10-02T12:00:00.000Z",
        expiresAt: "2026-10-02T12:05:00.000Z",
        id: threadId,
        leaseKey: `agent-run-thread/${threadId}`,
        owner: "worker-1",
        runId: id("2"),
        threadId,
        version: 3,
      },
      itemType: "runtime-lease" as const,
    }),
  );
}

function fakeDatabase(record: PlatformRecord | undefined) {
  const reads: { consistentRead: boolean | undefined; key: RecordKey; table: TableName }[] = [];
  const database: DynamoDatabaseService = {
    deleteRecord: () => Promise.reject(new Error("unexpected delete")),
    getRecord: async (table, recordKey, consistentRead) => {
      reads.push({ consistentRead, key: recordKey, table });
      return record && record.pk === recordKey.pk && record.sk === recordKey.sk
        ? record
        : undefined;
    },
    putRecord: () => Promise.reject(new Error("unexpected put")),
    queryRecords: () => Promise.reject(new Error("unexpected query")),
    transactWrite: () => Promise.reject(new Error("unexpected transaction")),
  };
  return { database, reads };
}

describe("model gateway run lease reader", () => {
  test("reads the thread execution lease with one consistent GetItem on its canonical key", async () => {
    const record = lease();
    const { database, reads } = fakeDatabase(record);

    expect(
      makeModelGatewayRunLeaseReader(database).getThreadExecutionLease(threadId),
    ).resolves.toEqual(record);
    expect(reads).toEqual([
      {
        consistentRead: true,
        key: {
          pk: key("RUNTIME-LEASE", threadId),
          sk: key("RUNTIME-LEASE", `agent-run-thread/${threadId}`),
        },
        table: "execution",
      },
    ]);
  });

  test("returns undefined when the thread holds no lease", async () => {
    const { database, reads } = fakeDatabase(undefined);

    expect(
      makeModelGatewayRunLeaseReader(database).getThreadExecutionLease(threadId),
    ).resolves.toBeUndefined();
    expect(reads).toHaveLength(1);
  });

  test("rejects an unexpected record under the lease key", async () => {
    const record = { ...lease(), itemType: "run" } as unknown as PlatformRecord;
    const { database } = fakeDatabase(record);

    expect(
      makeModelGatewayRunLeaseReader(database).getThreadExecutionLease(threadId),
    ).rejects.toThrow("unexpected record");
  });
});
