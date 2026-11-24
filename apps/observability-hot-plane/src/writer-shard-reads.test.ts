import { expect, test } from "bun:test";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { KinesisClient } from "@aws-sdk/client-kinesis";
import { runHotWriter } from "./writer.ts";
import { factData, kinesisRecord, allOrganizationsExist } from "./writer-test-support.ts";

test("paces and retries a throttled shard read without stopping the writer", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  const limits: number[] = [];
  let recordReads = 0;
  const throttledKinesis = {
    send: async (command: { constructor: { name: string }; input?: { Limit?: number } }) => {
      if (command.constructor.name === "ListShardsCommand")
        return { Shards: [{ ShardId: "shard-1" }] };
      if (command.constructor.name === "GetShardIteratorCommand")
        return { ShardIterator: "iterator-1" };
      if (command.constructor.name === "GetRecordsCommand") {
        limits.push(command.input?.Limit ?? 0);
        recordReads += 1;
        if (recordReads === 1) {
          throw Object.assign(new Error("slow down"), {
            name: "ProvisionedThroughputExceededException",
          });
        }
        return {
          NextShardIterator: undefined,
          Records: [kinesisRecord("100")],
        };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
  const dynamodb = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetItemCommand") return {};
      controller.abort();
      return {};
    },
  } as unknown as DynamoDBClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    requireCanonicalSeed: false,
    clickhouse: {
      execute: async () => undefined,
      insert: async () => undefined,
      query: async () => [],
    },
    dynamodb,
    existingOrganizations: allOrganizationsExist,
    kinesis: throttledKinesis,
    now: () => 0,
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  expect(recordReads).toBe(2);
  expect(limits).toEqual([10_000, 10_000]);
  expect(waits).toContain(2_000);
});

test("waits two seconds before polling a caught-up open shard again", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  let reads = 0;
  const idleKinesis = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListShardsCommand")
        return { Shards: [{ ShardId: "shard-1" }] };
      if (command.constructor.name === "GetShardIteratorCommand")
        return { ShardIterator: `iterator-${reads}` };
      if (command.constructor.name === "GetRecordsCommand") {
        reads += 1;
        if (reads === 2) controller.abort();
        return {
          MillisBehindLatest: 0,
          NextShardIterator: `iterator-${reads}`,
          Records: [],
        };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    requireCanonicalSeed: false,
    clickhouse: {
      execute: async () => undefined,
      insert: async () => undefined,
      query: async () => [],
    },
    dynamodb: {
      send: async (command: { constructor: { name: string } }) =>
        command.constructor.name === "GetItemCommand" ? {} : {},
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: idleKinesis,
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  expect(reads).toBe(2);
  expect(waits).toContain(2_000);
});

test("continues through empty Kinesis pages until the shard catches up", async () => {
  const controller = new AbortController();
  const operations: string[] = [];
  let reads = 0;
  const temporarilyEmptyKinesis = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListShardsCommand") {
        return { Shards: [{ ShardId: "shard-1" }] };
      }
      if (command.constructor.name === "GetShardIteratorCommand") {
        return { ShardIterator: "iterator-1" };
      }
      if (command.constructor.name === "GetRecordsCommand") {
        reads += 1;
        return reads === 1
          ? {
              MillisBehindLatest: 10,
              NextShardIterator: "iterator-2",
              Records: [],
            }
          : {
              MillisBehindLatest: 0,
              NextShardIterator: undefined,
              Records: [kinesisRecord("100")],
            };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    requireCanonicalSeed: false,
    clickhouse: {
      execute: async () => undefined,
      insert: async () => void operations.push("insert"),
      query: async () => [],
    },
    dynamodb: {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "GetItemCommand") return {};
        operations.push("checkpoint");
        controller.abort();
        return {};
      },
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: temporarilyEmptyKinesis,
    now: () => 0,
    onInitialReplayComplete: () => operations.push("ready"),
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
    wait: async () => undefined,
  });
  expect(reads).toBe(2);
  expect(operations).toEqual(["insert", "checkpoint"]);
});

test("becomes ready after checkpointing a nonempty zero-lag shard", async () => {
  const controller = new AbortController();
  const operations: string[] = [];
  let recordReads = 0;
  const continuouslyActiveKinesis = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListShardsCommand") {
        return { Shards: [{ ShardId: "shard-1" }] };
      }
      if (command.constructor.name === "GetShardIteratorCommand") {
        return { ShardIterator: "iterator-1" };
      }
      if (command.constructor.name === "GetRecordsCommand") {
        recordReads += 1;
        return {
          MillisBehindLatest: 0,
          NextShardIterator: `iterator-${recordReads + 1}`,
          Records: [kinesisRecord(String(100 + recordReads))],
        };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    requireCanonicalSeed: false,
    clickhouse: {
      execute: async () => undefined,
      insert: async () => undefined,
      query: async () => [],
    },
    dynamodb: {
      send: async (command: {
        constructor: { name: string };
        input?: { Item?: { shard?: { S?: string } } };
      }) => {
        if (command.constructor.name === "GetItemCommand") return {};
        operations.push(`checkpoint:${command.input?.Item?.shard?.S}`);
        return {};
      },
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: continuouslyActiveKinesis,
    onInitialReplayComplete: () => {
      operations.push("ready");
      controller.abort();
    },
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
    wait: async () => undefined,
  });
  expect(recordReads).toBeGreaterThan(0);
  expect(operations).toContain("checkpoint:initial-replay-complete");
  // A batch already in flight at abort may still checkpoint after readiness.
  expect(operations).toContain("ready");
  expect(operations.indexOf("checkpoint:shard-1")).toBeLessThan(operations.indexOf("ready"));
  expect(operations.indexOf("checkpoint:shard-1")).toBeGreaterThanOrEqual(0);
});

test("durably quarantines a poison record before checkpointing past it", async () => {
  const controller = new AbortController();
  const operations: string[] = [];
  let quarantinedRecord: unknown;
  const poisonThenValid = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListShardsCommand")
        return { Shards: [{ ShardId: "shard-1" }] };
      if (command.constructor.name === "GetShardIteratorCommand")
        return { ShardIterator: "iterator-1" };
      if (command.constructor.name === "GetRecordsCommand") {
        return {
          NextShardIterator: undefined,
          Records: [
            kinesisRecord("99", new TextEncoder().encode("not-json")),
            kinesisRecord("100"),
          ],
        };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    requireCanonicalSeed: false,
    clickhouse: {
      execute: async () => undefined,
      insert: async (_table, rows) => {
        operations.push(`insert:${rows.length}`);
      },
      query: async () => [],
    },
    dynamodb: {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "GetItemCommand") return {};
        operations.push("checkpoint");
        controller.abort();
        return {};
      },
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: poisonThenValid,
    quarantine: {
      put: async (record) => {
        quarantinedRecord = record;
        operations.push(`quarantine:${record.sequenceNumber}`);
      },
    },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
  });
  expect(operations).toEqual(["quarantine:99", "insert:1", "checkpoint"]);
  expect(quarantinedRecord).toMatchObject({
    dataBytes: 8,
    errorType: "SyntaxError",
  });
  expect(JSON.stringify(quarantinedRecord)).not.toContain("not-json");
  expect(JSON.stringify(quarantinedRecord)).not.toContain("bm90LWpzb24=");
});

test("quarantines an out-of-range timestamp and checkpoints past it", async () => {
  const controller = new AbortController();
  const invalidFact = JSON.parse(new TextDecoder().decode(factData())) as Record<string, unknown>;
  invalidFact.occurredAt = "9999-12-31T23:59:59.999Z";
  const operations: string[] = [];
  const quarantined: unknown[] = [];
  const invalidKinesis = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListShardsCommand") {
        return { Shards: [{ ShardId: "shard-1" }] };
      }
      if (command.constructor.name === "GetShardIteratorCommand") {
        return { ShardIterator: "iterator-1" };
      }
      if (command.constructor.name === "GetRecordsCommand") {
        return {
          NextShardIterator: undefined,
          Records: [kinesisRecord("101", new TextEncoder().encode(JSON.stringify(invalidFact)))],
        };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    requireCanonicalSeed: false,
    clickhouse: {
      execute: async () => undefined,
      insert: async () => {
        operations.push("insert");
      },
      query: async () => [],
    },
    dynamodb: {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "GetItemCommand") return {};
        operations.push("checkpoint");
        controller.abort();
        return {};
      },
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: invalidKinesis,
    quarantine: {
      put: async (record) => {
        quarantined.push(record);
        operations.push("quarantine");
      },
    },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
  });
  expect(quarantined).toHaveLength(1);
  expect(quarantined[0]).toMatchObject({
    errorType: "TypeError",
    sequenceNumber: "101",
  });
  expect(operations).toEqual(["quarantine", "checkpoint"]);
});

test("ignores a shard checkpoint created for a different Kinesis stream", async () => {
  const controller = new AbortController();
  let iteratorType: string | undefined;
  const streamAwareKinesis = {
    send: async (command: {
      constructor: { name: string };
      input?: { ShardIteratorType?: string };
    }) => {
      if (command.constructor.name === "ListShardsCommand")
        return { Shards: [{ ShardId: "shard-1" }] };
      if (command.constructor.name === "GetShardIteratorCommand") {
        iteratorType = command.input?.ShardIteratorType;
        return { ShardIterator: "iterator-1" };
      }
      if (command.constructor.name === "GetRecordsCommand") {
        controller.abort();
        return { NextShardIterator: undefined, Records: [] };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    requireCanonicalSeed: false,
    clickhouse: {
      execute: async () => undefined,
      insert: async () => undefined,
      query: async () => [],
    },
    dynamodb: {
      send: async (command: { constructor: { name: string } }) =>
        command.constructor.name === "GetItemCommand"
          ? {
              Item: {
                sequenceNumber: { S: "100" },
                streamArn: {
                  S: "arn:aws:kinesis:us-east-2:123456789012:stream/old",
                },
              },
            }
          : {},
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: streamAwareKinesis,
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
  });
  expect(iteratorType).toBe("TRIM_HORIZON");
});
