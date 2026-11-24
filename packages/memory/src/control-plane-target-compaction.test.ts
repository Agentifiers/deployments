import { describe, expect, it } from "bun:test";
import {
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type TransactionOperation,
} from "@deployments-ai/db";
import { memorySearchTargetCompactionOperations } from "./control-plane-target-compaction.ts";
import { ids } from "./test-fixtures.ts";

function record(itemType: string, data: Readonly<Record<string, unknown>>) {
  return {
    data,
    itemType,
    pk: `PK#${itemType}`,
    sk: `SK#${itemType}`,
  } as unknown as PlatformRecord;
}

const timestamp = "2026-07-28T12:00:00.000Z";
const common = {
  createdAt: timestamp,
  organizationId: ids.organization,
  targetId: ids.run,
  updatedAt: timestamp,
  version: 1,
};

function directoryRecord(actual: PlatformRecord) {
  return record("memory-search-target-record", {
    ...common,
    recordItemType: actual.itemType,
    recordPk: actual.pk,
    recordSk: actual.sk,
    recordTable:
      actual.itemType === "memory-index-job" || actual.itemType === "memory-shadow-job"
        ? "execution"
        : "control",
  });
}

function databaseFixture(args: {
  readonly actualRecords?: readonly PlatformRecord[];
  readonly pages: readonly QueryRecordsResult[];
}) {
  const actualRecords = new Map(
    (args.actualRecords ?? []).map((actual) => [
      `${actual.itemType === "memory-index-job" || actual.itemType === "memory-shadow-job" ? "execution" : "control"}:${actual.pk}:${actual.sk}`,
      actual,
    ]),
  );
  const queries: { readonly input: Readonly<Record<string, unknown>>; readonly table: string }[] =
    [];
  const reads: { readonly consistentRead?: boolean; readonly table: string }[] = [];
  const transactions: TransactionOperation[][] = [];
  let pageIndex = 0;
  return {
    database: {
      getRecord: async (
        table: string,
        key: { readonly pk: string; readonly sk: string },
        consistentRead?: boolean,
      ) => {
        reads.push({ ...(consistentRead === undefined ? {} : { consistentRead }), table });
        const value = actualRecords.get(`${table}:${key.pk}:${key.sk}`);
        return value;
      },
      queryRecords: async (table: string, input: Readonly<Record<string, unknown>>) => {
        queries.push({ input, table });
        const page = args.pages[Math.min(pageIndex, args.pages.length - 1)];
        pageIndex += 1;
        if (!page) throw new Error("Target compaction fixture requires a page.");
        return page;
      },
      transactWrite: async (operations: readonly TransactionOperation[]) =>
        transactions.push([...operations]),
    } as unknown as DynamoDatabaseService,
    queries,
    reads,
    transactions,
  };
}

const untilDone = { deadline: Number.MAX_SAFE_INTEGER, now: () => new Date(timestamp) };

describe("memory search target compaction", () => {
  it("commits terminal referenced records and leaves the closed gate for the final commit", async () => {
    const actual = [
      record("memory-index-state", { ...common, status: "ready" }),
      record("memory-provider-mutation-claim", { ...common, status: "applied" }),
      record("memory-provider-mutation-gate", { ...common, status: "closed" }),
      record("memory-index-job", { ...common, status: "succeeded" }),
      record("memory-shadow-job", { ...common }),
    ];
    const gate = actual[2]!;
    const fixture = databaseFixture({
      actualRecords: actual,
      pages: [{ items: actual.map(directoryRecord) }, { items: [directoryRecord(gate)] }],
    });

    const compaction = await memorySearchTargetCompactionOperations({
      ...untilDone,
      database: fixture.database,
      organizationId: ids.organization,
      targetId: ids.run,
    });

    expect(compaction).toEqual({
      operations: [{ kind: "delete", record: gate }],
      status: "ready",
    });
    expect(fixture.transactions).toEqual([
      actual.filter((value) => value !== gate).map((value) => ({ kind: "delete", record: value })),
    ]);
    expect(fixture.queries).toHaveLength(2);
    expect(fixture.queries[0]).toMatchObject({
      input: {
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk",
      },
      table: "control",
    });
    expect(fixture.queries[0]?.input).not.toHaveProperty("IndexName");
    expect(fixture.reads).toEqual([
      { consistentRead: true, table: "control" },
      { consistentRead: true, table: "control" },
      { consistentRead: true, table: "execution" },
      { consistentRead: true, table: "execution" },
      { consistentRead: true, table: "control" },
    ]);
  });

  it("rejects a nonterminal record referenced by the authoritative directory", async () => {
    const running = record("memory-index-job", { ...common, status: "running" });
    const fixture = databaseFixture({
      actualRecords: [running],
      pages: [{ items: [directoryRecord(running)] }],
    });

    expect(
      memorySearchTargetCompactionOperations({
        ...untilDone,
        database: fixture.database,
        organizationId: ids.organization,
        targetId: ids.run,
      }),
    ).rejects.toThrow("nonterminal index job");
    expect(fixture.transactions).toHaveLength(0);
  });

  it("removes stale directory entries and continues compacting in one attempt", async () => {
    const missing = record("memory-index-job", { ...common, status: "failed" });
    const directory = directoryRecord(missing);
    const fixture = databaseFixture({
      pages: [
        { items: [directory], lastEvaluatedKey: { pk: directory.pk, sk: directory.sk } },
        { items: [] },
      ],
    });

    expect(
      await memorySearchTargetCompactionOperations({
        ...untilDone,
        database: fixture.database,
        organizationId: ids.organization,
        targetId: ids.run,
      }),
    ).toEqual({ operations: [], status: "ready" });
    expect(fixture.queries).toHaveLength(2);
    expect(fixture.transactions).toEqual([
      [{ allowMissing: true, kind: "delete", record: directory }],
    ]);
  });

  it("uses the erasure-owned transaction for incremental compaction", async () => {
    const terminal = record("memory-index-job", { ...common, status: "failed" });
    const directory = directoryRecord(terminal);
    const transactions: TransactionOperation[][] = [];
    const database = {
      getRecord: async () => terminal,
      queryRecords: async () =>
        transactions.length === 0
          ? {
              items: [directory],
              lastEvaluatedKey: { pk: directory.pk, sk: directory.sk },
            }
          : { items: [] },
      transactWriteForErasure: async (operations: readonly TransactionOperation[]) =>
        transactions.push([...operations]),
    } as unknown as DynamoDatabaseService;

    expect(
      await memorySearchTargetCompactionOperations({
        ...untilDone,
        database,
        erasureOwner: { operationId: ids.project, organizationId: ids.organization },
        organizationId: ids.organization,
        targetId: ids.run,
      }),
    ).toEqual({ operations: [], status: "ready" });
    expect(transactions).toEqual([[{ kind: "delete", record: terminal }]]);
  });

  it("stops at its deadline and resumes on the next call", async () => {
    let clock = Date.parse(timestamp);
    const directory = pagedDirectory(400, () => {
      clock += 20_000;
    });
    const compact = () =>
      memorySearchTargetCompactionOperations({
        database: directory.database,
        deadline: clock + 300_000,
        now: () => new Date(clock),
        organizationId: ids.organization,
        targetId: ids.run,
      });

    expect(await compact()).toEqual({ status: "pending" });
    expect({ committed: directory.committed, remaining: directory.remaining.size }).toEqual({
      committed: [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15],
      remaining: 175,
    });
    expect(await compact()).toEqual({ operations: [], status: "ready" });
    expect(directory.remaining.size).toBe(0);
  });

  it("ends a throttled call pending, keeps what it committed, and finishes on the next call", async () => {
    const throttled = Object.assign(new Error("Transaction cancelled"), {
      CancellationReasons: [{ Code: "ThrottlingError" }, { Code: "None" }],
      name: "TransactionCanceledException",
    });
    let failures = 1;
    const directory = pagedDirectory(40, (remaining) => {
      if (remaining === 25 && failures > 0) {
        failures -= 1;
        throw throttled;
      }
    });
    const compact = () =>
      memorySearchTargetCompactionOperations({
        ...untilDone,
        database: directory.database,
        organizationId: ids.organization,
        targetId: ids.run,
      });

    expect(await compact()).toEqual({ status: "pending" });
    expect(directory.remaining.size).toBe(25);
    expect(await compact()).toEqual({ operations: [], status: "ready" });
    expect(directory.remaining.size).toBe(0);
  });

  it("fails a call whose transaction condition failed", async () => {
    const directory = pagedDirectory(40, () => {
      throw Object.assign(new Error("Transaction cancelled"), {
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
        name: "TransactionCanceledException",
      });
    });

    expect(
      memorySearchTargetCompactionOperations({
        ...untilDone,
        database: directory.database,
        organizationId: ids.organization,
        targetId: ids.run,
      }),
    ).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });
});

function pagedDirectory(count: number, beforeCommit: (remaining: number) => void) {
  const directories = Array.from({ length: count }, (_, index) => ({
    ...directoryRecord(record("memory-index-job", { ...common, status: "failed" })),
    sk: `RECORD#${String(index).padStart(3, "0")}`,
  }));
  const remaining = new Set(directories.map((directory) => directory.sk));
  const committed: number[] = [];
  const database = {
    getRecord: async () => undefined,
    queryRecords: async (_table: string, input: { readonly Limit?: number }) => {
      const items = directories.filter((directory) => remaining.has(directory.sk));
      const page = items.slice(0, input.Limit);
      return page.length < items.length
        ? { items: page, lastEvaluatedKey: { pk: page.at(-1)!.pk, sk: page.at(-1)!.sk } }
        : { items: page };
    },
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      beforeCommit(remaining.size);
      for (const operation of operations) {
        if (operation.kind === "delete") remaining.delete(operation.record.sk);
      }
      committed.push(operations.length);
    },
  } as unknown as DynamoDatabaseService;
  return { committed, database, remaining };
}
