import { expect, test } from "bun:test";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { KinesisClient } from "@aws-sdk/client-kinesis";
import type { ClickHouseExecutor } from "./clickhouse.ts";
import { listShardIds, runHotWriter } from "./writer.ts";
import { kinesisRecord, kinesis, allOrganizationsExist } from "./writer-test-support.ts";

test("discovers shards across every ListShards page", async () => {
  const inputs: unknown[] = [];
  const paginatedKinesis = {
    send: async (command: { input?: unknown }) => {
      inputs.push(command.input);
      return inputs.length === 1
        ? { NextToken: "page-2", Shards: [{ ShardId: "shard-1" }] }
        : { Shards: [{ ShardId: "shard-2" }] };
    },
  } as unknown as KinesisClient;

  expect(await listShardIds(paginatedKinesis, "facts")).toEqual(["shard-1", "shard-2"]);
  expect(inputs).toEqual([{ StreamName: "facts" }, { NextToken: "page-2" }]);
});

test("marks readiness only after the initial shard replay completes", async () => {
  const controller = new AbortController();
  const operations: string[] = [];
  const emptyKinesis = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListShardsCommand") {
        return { Shards: [{ ShardId: "shard-1" }] };
      }
      if (command.constructor.name === "GetShardIteratorCommand") {
        return { ShardIterator: "iterator-1" };
      }
      if (command.constructor.name === "GetRecordsCommand") {
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
      send: async (command: {
        constructor: { name: string };
        input?: { Item?: { shard?: { S?: string } } };
      }) => {
        if (command.constructor.name === "GetItemCommand") return {};
        operations.push(`marker:${command.input?.Item?.shard?.S}`);
        return {};
      },
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: emptyKinesis,
    onInitialReplayComplete: () => {
      operations.push("ready");
      controller.abort();
    },
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
  });
  expect(operations).toEqual(["marker:initial-replay-complete", "ready"]);
});

test("keeps readiness closed on a stream older than a day until a rebuild records the seed", async () => {
  const controller = new AbortController();
  const operations: string[] = [];
  let seedAvailable = false;
  const emptyKinesis = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListShardsCommand")
        return { Shards: [{ ShardId: "shard-1" }] };
      if (command.constructor.name === "GetShardIteratorCommand")
        return { ShardIterator: "iterator-1" };
      if (command.constructor.name === "GetRecordsCommand")
        return { MillisBehindLatest: 0, Records: [] };
      if (command.constructor.name === "DescribeStreamSummaryCommand")
        return {
          StreamDescriptionSummary: {
            StreamCreationTimestamp: new Date("2026-08-01T23:59:59.000Z"),
          },
        };
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    now: () => Date.parse("2026-08-03T00:00:00.000Z"),
    clickhouse: {
      execute: async () => undefined,
      insert: async () => undefined,
      query: async <T extends Readonly<Record<string, unknown>>>() =>
        [{ generation: "generation-1" }] as unknown as readonly T[],
    },
    dynamodb: {
      send: async (command: {
        constructor: { name: string };
        input?: {
          Item?: { shard?: { S?: string } };
          Key?: { shard?: { S?: string } };
        };
      }) => {
        if (command.constructor.name === "GetItemCommand") {
          return command.input?.Key?.shard?.S === "canonical-seed-complete" && seedAvailable
            ? {
                Item: {
                  sequenceNumber: { S: "generation-1" },
                  streamArn: {
                    S: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
                  },
                },
              }
            : {};
        }
        operations.push(`marker:${command.input?.Item?.shard?.S}`);
        return {};
      },
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: emptyKinesis,
    onInitialReplayComplete: () => {
      operations.push("ready");
      controller.abort();
    },
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
    wait: async (milliseconds) => {
      if (milliseconds === 1_000) seedAvailable = true;
    },
  });
  expect(operations).toEqual(["marker:initial-replay-complete", "ready"]);
});

test("fails closed before replay when the ClickHouse generation is stale", async () => {
  let kinesisCalled = false;
  expect(
    runHotWriter({
      checkpointTable: "checkpoints",
      clickhouse: {
        execute: async () => undefined,
        insert: async () => undefined,
        query: async <T extends Readonly<Record<string, unknown>>>() =>
          [{ generation: "generation-old" }] as unknown as readonly T[],
      },
      dynamodb: {
        send: async () => ({
          Item: {
            sequenceNumber: { S: "generation-new" },
            streamArn: {
              S: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
            },
          },
        }),
      } as unknown as DynamoDBClient,
      existingOrganizations: allOrganizationsExist,
      kinesis: {
        send: async () => {
          kinesisCalled = true;
          return {};
        },
      } as unknown as KinesisClient,
      quarantine: { put: async () => undefined },
      signal: new AbortController().signal,
      streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
      streamName: "facts",
    }),
  ).rejects.toThrow("ClickHouse generation does not match");
  expect(kinesisCalled).toBe(false);
});

test("consumes independent shards concurrently", async () => {
  const controller = new AbortController();
  const operations: string[] = [];
  let releaseFirst!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const multiShardKinesis = {
    send: async (command: {
      constructor: { name: string };
      input?: { ShardId?: string; ShardIterator?: string };
    }) => {
      if (command.constructor.name === "ListShardsCommand") {
        return { Shards: [{ ShardId: "shard-1" }, { ShardId: "shard-2" }] };
      }
      if (command.constructor.name === "GetShardIteratorCommand") {
        return { ShardIterator: `iterator:${command.input?.ShardId}` };
      }
      if (command.constructor.name === "GetRecordsCommand") {
        if (command.input?.ShardIterator === "iterator:shard-1") {
          await secondStarted;
          return {
            MillisBehindLatest: 0,
            NextShardIterator: undefined,
            Records: [],
          };
        }
        releaseFirst();
        return {
          MillisBehindLatest: 0,
          NextShardIterator: undefined,
          Records: [kinesisRecord("200")],
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
      insert: async () => void operations.push("insert:shard-2"),
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
    kinesis: multiShardKinesis,
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
  expect(operations).toEqual([
    "insert:shard-2",
    "checkpoint:shard-2",
    "checkpoint:initial-replay-complete",
    "ready",
  ]);
});

test("advances a shard checkpoint only after ClickHouse accepts the batch", async () => {
  const controller = new AbortController();
  const operations: string[] = [];
  const clickhouse: ClickHouseExecutor = {
    execute: async () => undefined,
    insert: async () => {
      operations.push("insert");
    },
    query: async () => [],
  };
  const dynamodb = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetItemCommand") return {};
      operations.push("checkpoint");
      controller.abort();
      return {};
    },
  } as unknown as DynamoDBClient;
  await runHotWriter({
    checkpointTable: "checkpoints",
    requireCanonicalSeed: false,
    clickhouse,
    dynamodb,
    existingOrganizations: allOrganizationsExist,
    kinesis: kinesis(),
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
  });
  expect(operations).toEqual(["insert", "checkpoint"]);
});

test("does not checkpoint a rejected ClickHouse batch", async () => {
  const operations: string[] = [];
  const clickhouse: ClickHouseExecutor = {
    execute: async () => undefined,
    insert: async () => {
      throw new Error("ClickHouse unavailable");
    },
    query: async () => [],
  };
  const dynamodb = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetItemCommand") return {};
      operations.push("checkpoint");
      return {};
    },
  } as unknown as DynamoDBClient;
  expect(
    runHotWriter({
      checkpointTable: "checkpoints",
      requireCanonicalSeed: false,
      clickhouse,
      dynamodb,
      existingOrganizations: allOrganizationsExist,
      kinesis: kinesis(),
      quarantine: { put: async () => undefined },
      signal: new AbortController().signal,
      streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
      streamName: "facts",
    }),
  ).rejects.toThrow("ClickHouse unavailable");
  expect(operations).toEqual([]);
});
