import { describe, expect, it } from "bun:test";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  TransactionOperation,
} from "@deployments-ai/db";
import { ids } from "../../../packages/memory/src/test-fixtures.ts";
import {
  memoryIndexRecoveryMessage,
  reconcileDueMemoryIndexJobs,
  reconcileDueMemorySearchOperations,
} from "./operation-reconciler.ts";

const recoveryEvent = {
  detail: {
    environmentId: ids.environment,
    organizationId: ids.organization,
    payload: {
      idempotencyKey: "target:memory:1:index",
      memoryId: ids.memory,
      targetId: ids.run,
    },
    projectId: ids.project,
  },
};

describe("memory search operation reconciler", () => {
  it("uses message groups only for FIFO index queues", () => {
    expect(
      memoryIndexRecoveryMessage(
        "https://sqs.us-east-1.amazonaws.com/123456789012/memory-index.fifo",
        recoveryEvent,
      ),
    ).toMatchObject({
      MessageGroupId: expect.any(String),
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/memory-index.fifo",
    });
    expect(
      memoryIndexRecoveryMessage("http://localhost:4566/000000000000/memory-index", recoveryEvent),
    ).toEqual({
      MessageBody: JSON.stringify(recoveryEvent),
      QueueUrl: "http://localhost:4566/000000000000/memory-index",
    });
  });

  it("redelivers due queued index jobs after a strong canonical revalidation", async () => {
    const due = {
      data: {
        environmentId: ids.environment,
        createdAt: "2026-07-28T11:55:00.000Z",
        eventVersion: 1,
        idempotencyKey: "target:memory:1:index",
        memoryId: ids.memory,
        nextDueAt: "2026-07-28T11:59:00.000Z",
        organizationId: ids.organization,
        projectId: ids.project,
        status: "queued",
        targetId: ids.run,
        updatedAt: "2026-07-28T11:55:00.000Z",
        version: 0,
      },
      itemType: "memory-index-job",
      pk: "PK#index-job",
      sk: "SK#index-job",
    } as unknown as PlatformRecord;
    const queries: Readonly<Record<string, unknown>>[] = [];
    const reads: boolean[] = [];
    const transactions: unknown[][] = [];
    const database = {
      getRecord: async (_table: string, _key: unknown, consistentRead?: boolean) => {
        reads.push(consistentRead === true);
        return due;
      },
      queryRecords: async (_table: string, input: Readonly<Record<string, unknown>>) => {
        queries.push(input);
        return { items: queries.length === 1 ? [due] : [] };
      },
      transactWrite: async (operations: readonly unknown[]) => {
        transactions.push([...operations]);
      },
    } as unknown as DynamoDatabaseService;
    const dispatched: unknown[] = [];

    expect(
      reconcileDueMemoryIndexJobs({
        database,
        dispatch: async (event) => {
          dispatched.push(event);
        },
        now: new Date("2026-07-28T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ dispatched: 1 });
    expect(queries).toHaveLength(48);
    expect(queries[0]).toMatchObject({
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND gsi1sk <= :due",
      Limit: 25,
    });
    expect(reads).toEqual([true]);
    expect(dispatched).toEqual([
      {
        detail: {
          environmentId: ids.environment,
          organizationId: ids.organization,
          payload: {
            idempotencyKey: "target:memory:1:index",
            memoryId: ids.memory,
            targetId: ids.run,
          },
          projectId: ids.project,
        },
      },
    ]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.[0]).toMatchObject({
      kind: "put",
      record: {
        data: { eventVersion: 1, nextDueAt: "2026-07-28T12:05:00.000Z", version: 1 },
      },
    });
  });

  it("redelivers a running index job after its durable lease expires", async () => {
    const expired = {
      data: {
        environmentId: ids.environment,
        createdAt: "2026-07-28T11:55:00.000Z",
        idempotencyKey: "target:memory:1:index",
        leaseExpiresAt: "2026-07-28T11:59:00.000Z",
        memoryId: ids.memory,
        nextDueAt: "2026-07-28T11:59:00.000Z",
        organizationId: ids.organization,
        projectId: ids.project,
        status: "running",
        targetId: ids.run,
        updatedAt: "2026-07-28T11:55:00.000Z",
        version: 1,
      },
      itemType: "memory-index-job",
      pk: "PK#index-job",
      sk: "SK#index-job",
    } as unknown as PlatformRecord;
    const transactions: TransactionOperation[][] = [];
    let offered = false;
    const database = {
      getRecord: async () => expired,
      queryRecords: async (_table: string, input: Readonly<Record<string, unknown>>) => {
        const running = String(
          (input.ExpressionAttributeValues as Readonly<Record<string, unknown>>)[":pk"],
        ).includes("running");
        if (!offered && running) {
          offered = true;
          return { items: [expired] };
        }
        return { items: [] };
      },
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
      },
    } as unknown as DynamoDatabaseService;
    const dispatched: unknown[] = [];

    expect(
      reconcileDueMemoryIndexJobs({
        database,
        dispatch: async (event) => {
          dispatched.push(event);
        },
        now: new Date("2026-07-28T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ dispatched: 1 });
    expect(dispatched).toHaveLength(1);
    expect(transactions[0]?.[0]).toMatchObject({
      kind: "put",
      record: {
        data: {
          nextDueAt: "2026-07-28T12:05:00.000Z",
          status: "running",
          version: 2,
        },
      },
    });
  });

  it("redelivers a failed index job from its durable retry projection", async () => {
    const failed = {
      data: {
        environmentId: ids.environment,
        createdAt: "2026-07-28T11:55:00.000Z",
        idempotencyKey: "target:memory:1:index",
        memoryId: ids.memory,
        nextDueAt: "2026-07-28T11:59:00.000Z",
        organizationId: ids.organization,
        projectId: ids.project,
        status: "failed",
        targetId: ids.run,
        updatedAt: "2026-07-28T11:55:00.000Z",
        version: 2,
      },
      itemType: "memory-index-job",
      pk: "PK#index-job",
      sk: "SK#index-job",
    } as unknown as PlatformRecord;
    let offered = false;
    const database = {
      getRecord: async () => failed,
      queryRecords: async (_table: string, input: Readonly<Record<string, unknown>>) => {
        const isFailed = String(
          (input.ExpressionAttributeValues as Readonly<Record<string, unknown>>)[":pk"],
        ).includes("failed");
        if (!offered && isFailed) {
          offered = true;
          return { items: [failed] };
        }
        return { items: [] };
      },
      transactWrite: async () => {},
    } as unknown as DynamoDatabaseService;
    const dispatched: unknown[] = [];

    expect(
      reconcileDueMemoryIndexJobs({
        database,
        dispatch: async (event) => {
          dispatched.push(event);
        },
        now: new Date("2026-07-28T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ dispatched: 1 });
    expect(dispatched).toHaveLength(1);
  });

  it("sweeps every due shard and dispatches canonical nonterminal operations", async () => {
    const queries: unknown[] = [];
    const due = {
      data: {
        actionGeneration: 2,
        eventVersion: 6,
        id: ids.toolCall,
        nextAction: "provision-components",
        nextActionAt: "2026-07-28T11:59:00.000Z",
        organizationId: ids.organization,
        status: "running",
      },
      itemType: "memory-search-provisioning",
    } as unknown as PlatformRecord;
    const database = {
      queryRecords: async (_table: string, input: unknown) => {
        queries.push(input);
        return { items: queries.length === 1 ? [due] : [] };
      },
    } as unknown as DynamoDatabaseService;
    const dispatched: PlatformRecord[] = [];

    expect(
      reconcileDueMemorySearchOperations({
        database,
        dispatch: async (operation) => {
          dispatched.push(operation);
        },
        now: new Date("2026-07-28T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ dispatched: 1 });
    expect(queries).toHaveLength(16);
    expect(dispatched).toEqual([due]);
  });

  it("visits every shard before following a hot shard continuation page", async () => {
    const queries: Readonly<Record<string, unknown>>[] = [];
    const database = {
      queryRecords: async (_table: string, input: Readonly<Record<string, unknown>>) => {
        queries.push(input);
        return {
          items: [],
          ...(input.ExclusiveStartKey ? {} : { lastEvaluatedKey: { pk: "next" } }),
        };
      },
    } as unknown as DynamoDatabaseService;

    await reconcileDueMemorySearchOperations({
      database,
      dispatch: async () => {},
      now: new Date("2026-07-28T12:00:00.000Z"),
    });

    expect(queries).toHaveLength(16);
    expect(queries.every((query) => query.Limit === 25)).toBe(true);
  });
});
