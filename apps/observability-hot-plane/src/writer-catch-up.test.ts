import { expect, test } from "bun:test";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { KinesisClient } from "@aws-sdk/client-kinesis";
import { makeObservabilityFact } from "@deployments-ai/observability";
import { createWriterCatchUp, type WriterCatchUp } from "./writer-catch-up.ts";
import { runHotWriter } from "./writer.ts";

const START = Date.parse("2026-10-02T00:00:00.000Z");

function fact() {
  return new TextEncoder().encode(
    JSON.stringify(
      makeObservabilityFact({
        captureMode: "metadata-only",
        factType: "trace.finalized",
        normalizedAt: "2026-10-01T23:59:59.000Z",
        occurredAt: "2026-10-01T23:59:58.000Z",
        payload: { status: "ok" },
        scope: {
          environmentId: "environment",
          organizationId: "organization",
          projectId: "project",
        },
        source: { recordId: "trace-1", recordType: "trace", recordVersion: 1, table: "execution" },
      }),
    ),
  );
}

/**
 * Runs the writer against one shard whose GetRecords responses come from
 * `responses` (by read number); stops after the last response.
 */
async function runWriter(input: {
  readonly catchUp: WriterCatchUp;
  readonly clock: { now: number };
  readonly onInsert?: () => void;
  readonly responses: readonly {
    readonly MillisBehindLatest: number;
    readonly Records: readonly unknown[];
  }[];
}) {
  const controller = new AbortController();
  const readTimes: number[] = [];
  await runHotWriter({
    catchUp: input.catchUp,
    checkpointTable: "checkpoints",
    clickhouse: {
      execute: async () => undefined,
      insert: async () => input.onInsert?.(),
      query: async () => [],
    },
    dynamodb: { send: async () => ({}) } as unknown as DynamoDBClient,
    existingOrganizations: async (organizationIds) => new Set(organizationIds),
    kinesis: {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "ListShardsCommand") {
          return { Shards: [{ ShardId: "shard-1" }] };
        }
        if (command.constructor.name === "GetShardIteratorCommand") {
          return { ShardIterator: "iterator" };
        }
        const response = input.responses[readTimes.length]!;
        readTimes.push(input.clock.now);
        if (readTimes.length === input.responses.length) controller.abort();
        return { ...response, NextShardIterator: "iterator" };
      },
    } as unknown as KinesisClient,
    now: () => input.clock.now,
    quarantine: { put: async () => undefined },
    requireCanonicalSeed: false,
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
    wait: async (milliseconds) => {
      input.clock.now += milliseconds;
    },
  });
  return readTimes;
}

test("an idle stream the writer keeps reading counts as caught up", async () => {
  // Kinesis's stream-level iterator age grows with wall-clock time here
  // because no record arrives; the writer's own reads prove it is current.
  const catchUp = createWriterCatchUp();
  const clock = { now: START };
  const idle = { MillisBehindLatest: 0, Records: [] };

  const readTimes = await runWriter({ catchUp, clock, responses: [idle, idle, idle] });

  expect(readTimes).toHaveLength(3);
  const lastReadStartedAt = readTimes.at(-1)!;
  expect(lastReadStartedAt).toBeGreaterThan(START);
  expect(catchUp.caughtUpThrough(clock.now)).toBe(lastReadStartedAt);
  expect(catchUp.caughtUpThrough(lastReadStartedAt + 30_000)).toBe(lastReadStartedAt);
  expect(catchUp.caughtUpThrough(lastReadStartedAt + 30_001)).toBeUndefined();
});

test("a read counts only after its records are inserted", async () => {
  const catchUp = createWriterCatchUp();
  const clock = { now: START };
  const duringInsert: (number | undefined)[] = [];

  const readTimes = await runWriter({
    catchUp,
    clock,
    onInsert: () => duringInsert.push(catchUp.caughtUpThrough(clock.now)),
    responses: [
      {
        MillisBehindLatest: 1_000,
        Records: [{ Data: fact(), SequenceNumber: "100" }],
      },
    ],
  });

  expect(duringInsert).toEqual([undefined]);
  expect(catchUp.caughtUpThrough(clock.now)).toBe(readTimes[0]! - 1_000);
});

test("a shard read far behind its tip is not caught up", async () => {
  const catchUp = createWriterCatchUp();
  const clock = { now: START };

  await runWriter({
    catchUp,
    clock,
    responses: [{ MillisBehindLatest: 60_000, Records: [] }],
  });

  expect(catchUp.caughtUpThrough(clock.now)).toBeUndefined();
});

test("a newly listed shard blocks catch-up until it is read; closed shards do not", () => {
  const catchUp = createWriterCatchUp();
  catchUp.shardsListed(["parent"]);
  catchUp.shardRead("parent", { millisBehindLatest: 0, readStartedAt: START });
  expect(catchUp.caughtUpThrough(START)).toBe(START);

  catchUp.shardsListed(["parent", "child"]);
  expect(catchUp.caughtUpThrough(START)).toBeUndefined();

  catchUp.shardClosed("parent");
  catchUp.shardRead("child", { millisBehindLatest: 2_000, readStartedAt: START + 60_000 });
  expect(catchUp.caughtUpThrough(START + 60_000)).toBe(START + 58_000);
});
