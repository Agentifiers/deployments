import { expect, test } from "bun:test";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { KinesisClient } from "@aws-sdk/client-kinesis";
import { makeObservabilityFact } from "@deployments-ai/observability";
import type { ClickHouseExecutor } from "./clickhouse.ts";
import { cachedOrganizationPresence } from "./organization-presence.ts";
import { runHotWriter } from "./writer.ts";

function factData(organizationId: string, recordId: string) {
  return new TextEncoder().encode(
    JSON.stringify(
      makeObservabilityFact({
        captureMode: "metadata-only",
        factType: "trace.finalized",
        normalizedAt: "2026-08-03T00:00:01.000Z",
        occurredAt: "2026-08-03T00:00:00.000Z",
        payload: { status: "ok" },
        scope: { environmentId: "environment", organizationId, projectId: "project" },
        source: { recordId, recordType: "trace", recordVersion: 1, table: "execution" },
      }),
    ),
  );
}

async function writeBatch(
  facts: readonly { readonly organizationId: string; readonly recordId: string }[],
  existing: ReadonlySet<string>,
) {
  const controller = new AbortController();
  const inserted: Readonly<Record<string, unknown>>[] = [];
  const lookups: (readonly string[])[] = [];
  const checkpoints: (string | undefined)[] = [];
  const clickhouse: ClickHouseExecutor = {
    execute: async () => undefined,
    insert: async (_table, rows) => {
      inserted.push(...rows);
    },
    query: async () => [],
  };
  await runHotWriter({
    checkpointTable: "checkpoints",
    clickhouse,
    dynamodb: {
      send: async (command: {
        constructor: { name: string };
        input?: { Item?: { sequenceNumber?: { S?: string } } };
      }) => {
        if (command.constructor.name === "GetItemCommand") return {};
        checkpoints.push(command.input?.Item?.sequenceNumber?.S);
        controller.abort();
        return {};
      },
    } as unknown as DynamoDBClient,
    existingOrganizations: async (organizationIds) => {
      lookups.push(organizationIds);
      return new Set(organizationIds.filter((organizationId) => existing.has(organizationId)));
    },
    kinesis: {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "ListShardsCommand")
          return { Shards: [{ ShardId: "shard-1" }] };
        if (command.constructor.name === "GetShardIteratorCommand")
          return { ShardIterator: "iterator-1" };
        return {
          NextShardIterator: undefined,
          Records: facts.map((fact, index) => ({
            Data: factData(fact.organizationId, fact.recordId),
            SequenceNumber: String(100 + index),
          })),
        };
      },
    } as unknown as KinesisClient,
    quarantine: { put: async () => undefined },
    requireCanonicalSeed: false,
    signal: controller.signal,
    streamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/facts",
    streamName: "facts",
  });
  return { checkpoints, inserted, lookups };
}

test("drops facts for erased organizations and inserts the rest of the batch", async () => {
  const result = await writeBatch(
    [
      { organizationId: "organization-erased", recordId: "trace-erased-1" },
      { organizationId: "organization-live", recordId: "trace-live" },
      { organizationId: "organization-erased", recordId: "trace-erased-2" },
    ],
    new Set(["organization-live"]),
  );

  expect(result.inserted.map((row) => row.source_record_id)).toEqual(["trace-live"]);
  expect(result.lookups).toHaveLength(1);
  expect(new Set(result.lookups[0])).toEqual(new Set(["organization-erased", "organization-live"]));
  expect(result.checkpoints).toEqual(["102"]);
});

test("acknowledges a batch whose facts all belong to an erased organization", async () => {
  const result = await writeBatch(
    [{ organizationId: "organization-erased", recordId: "trace-erased" }],
    new Set(),
  );

  expect(result.inserted).toEqual([]);
  expect(result.checkpoints).toEqual(["100"]);
});

test("re-reads organization presence once the cached answer is older than sixty seconds", async () => {
  let now = 0;
  let exists = true;
  const lookups: (readonly string[])[] = [];
  const presence = cachedOrganizationPresence(
    async (organizationIds) => {
      lookups.push(organizationIds);
      return new Set(exists ? organizationIds : []);
    },
    () => now,
  );

  expect([...(await presence(["organization", "organization"]))]).toEqual(["organization"]);
  exists = false;
  now = 59_999;
  expect([...(await presence(["organization"]))]).toEqual(["organization"]);
  now = 60_000;
  expect([...(await presence(["organization"]))]).toEqual([]);
  expect(lookups).toEqual([["organization"], ["organization"]]);
});
