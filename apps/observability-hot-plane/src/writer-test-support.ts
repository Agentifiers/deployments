import { makeObservabilityFact } from "@deployments-ai/observability";
import type { KinesisClient } from "@aws-sdk/client-kinesis";

export function factData() {
  return new TextEncoder().encode(
    JSON.stringify(
      makeObservabilityFact({
        captureMode: "metadata-only",
        factType: "trace.finalized",
        normalizedAt: "2026-08-03T00:00:01.000Z",
        occurredAt: "2026-08-03T00:00:00.000Z",
        payload: { status: "ok" },
        scope: {
          environmentId: "environment",
          organizationId: "organization",
          projectId: "project",
        },
        source: {
          recordId: "trace-1",
          recordType: "trace",
          recordVersion: 1,
          table: "execution",
        },
      }),
    ),
  );
}

export function kinesisRecord(sequenceNumber: string, data = factData()) {
  return {
    ApproximateArrivalTimestamp: new Date("2026-08-03T00:00:02.000Z"),
    Data: data,
    SequenceNumber: sequenceNumber,
  };
}

export function kinesis(): KinesisClient {
  return {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListShardsCommand")
        return { Shards: [{ ShardId: "shard-1" }] };
      if (command.constructor.name === "GetShardIteratorCommand")
        return { ShardIterator: "iterator-1" };
      if (command.constructor.name === "GetRecordsCommand") {
        return {
          NextShardIterator: undefined,
          Records: [kinesisRecord("100")],
        };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  } as unknown as KinesisClient;
}

export const allOrganizationsExist = async (organizationIds: readonly string[]) =>
  new Set(organizationIds);
