import { describe, expect, test } from "bun:test";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { KinesisClient } from "@aws-sdk/client-kinesis";
import { runHotWriter } from "./writer.ts";
import { allOrganizationsExist } from "./writer-test-support.ts";

const STREAM_ARN = "arn:aws:kinesis:us-east-2:123456789012:stream/facts";
const STREAM_CREATED_AT = new Date("2026-08-03T00:00:00.000Z");
const STREAM_GENERATION = `stream-origin-${STREAM_CREATED_AT.getTime()}`;

interface Scenario {
  readonly checkpoints?: Readonly<Record<string, string>>;
  readonly clickhouseGeneration?: string;
  readonly streamAgeHours: number;
}

async function run(scenario: Scenario) {
  const items = new Map(Object.entries(scenario.checkpoints ?? {}));
  const inserts: Readonly<Record<string, string>>[] = [];
  let generation = scenario.clickhouseGeneration;
  let ready = false;
  let idleLoops = 0;
  const controller = new AbortController();
  await runHotWriter({
    checkpointTable: "checkpoints",
    clickhouse: {
      execute: async (sql, parameters) => {
        expect(sql).toContain("INSERT INTO observability.runtime_generation");
        inserts.push(parameters ?? {});
        generation = parameters?.generation;
      },
      insert: async () => undefined,
      query: async <T extends Readonly<Record<string, unknown>>>() =>
        (generation === undefined ? [] : [{ generation }]) as unknown as readonly T[],
    },
    dynamodb: {
      send: async (command: {
        constructor: { name: string };
        input: {
          Item?: { sequenceNumber: { S: string }; shard: { S: string } };
          Key?: { shard: { S: string } };
        };
      }) => {
        if (command.constructor.name === "GetItemCommand") {
          const sequenceNumber = items.get(command.input.Key!.shard.S);
          return sequenceNumber === undefined
            ? {}
            : { Item: { sequenceNumber: { S: sequenceNumber }, streamArn: { S: STREAM_ARN } } };
        }
        items.set(command.input.Item!.shard.S, command.input.Item!.sequenceNumber.S);
        return {};
      },
    } as unknown as DynamoDBClient,
    existingOrganizations: allOrganizationsExist,
    kinesis: {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "DescribeStreamSummaryCommand") {
          return { StreamDescriptionSummary: { StreamCreationTimestamp: STREAM_CREATED_AT } };
        }
        if (command.constructor.name === "ListShardsCommand") {
          return { Shards: [{ ShardId: "shard-1" }] };
        }
        if (command.constructor.name === "GetShardIteratorCommand") {
          return { ShardIterator: "iterator-1" };
        }
        if (command.constructor.name === "GetRecordsCommand") return { Records: [] };
        throw new Error(`Unexpected ${command.constructor.name}`);
      },
    } as unknown as KinesisClient,
    now: () => STREAM_CREATED_AT.getTime() + scenario.streamAgeHours * 3_600_000,
    onInitialReplayComplete: () => {
      ready = true;
      controller.abort();
    },
    quarantine: { put: async () => undefined },
    signal: controller.signal,
    streamArn: STREAM_ARN,
    streamName: "facts",
    wait: async (milliseconds) => {
      if (milliseconds === 1_000 && ++idleLoops === 3) controller.abort();
    },
  });
  return { inserts, ready, seed: items.get("canonical-seed-complete") };
}

describe("initial canonical seed", () => {
  test("seeds a stream younger than a day that no writer has read", async () => {
    expect(await run({ streamAgeHours: 2 })).toEqual({
      inserts: [{ generation: STREAM_GENERATION }],
      ready: true,
      seed: STREAM_GENERATION,
    });
  });

  test("finishes a seed whose generation reached ClickHouse before the checkpoint", async () => {
    expect(await run({ clickhouseGeneration: STREAM_GENERATION, streamAgeHours: 23.9 })).toEqual({
      inserts: [],
      ready: true,
      seed: STREAM_GENERATION,
    });
  });

  test.each([
    ["the stream is a day old", { streamAgeHours: 24 }],
    ["a shard already has a checkpoint", { checkpoints: { "shard-1": "100" }, streamAgeHours: 1 }],
    [
      "ClickHouse holds another generation",
      { clickhouseGeneration: "rebuild-1", streamAgeHours: 1 },
    ],
  ] as const)("leaves the seed to a rebuild when %s", async (_case, scenario) => {
    expect(await run(scenario)).toEqual({ inserts: [], ready: false, seed: undefined });
  });
});
