/* eslint-disable no-await-in-loop -- Firehose batches preserve fact-family order across requests. */

import { FirehoseClient, PutRecordBatchCommand } from "@aws-sdk/client-firehose";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { observabilityCheckpointPersistence } from "@deployments-ai/db";
import { emitObservabilityFailedRecordsMetric } from "./observability-failure-metrics.ts";
import { observabilityIcebergProjection } from "./observability-projector.ts";
import type { ObservabilityIcebergDestination } from "./observability-projector.ts";
import type { ObservabilityProjectionSource } from "./observability-projector.ts";

const STREAMS_ENV = "DEPLOYMENTS_AI_OBSERVABILITY_FIREHOSE_STREAMS";
const CHECKPOINT_TABLE_ENV = "DEPLOYMENTS_AI_OBSERVABILITY_PROJECTOR_CHECKPOINT_TABLE";
const MAX_FIREHOSE_BATCH_BYTES = 3_500_000;
const MAX_FIREHOSE_BATCH_RECORDS = 500;
const DESTINATIONS = [
  "model-invocations",
  "spans",
  "tombstones",
  "traces",
  "usage",
] as const satisfies readonly ObservabilityIcebergDestination[];

export interface ObservabilityKinesisRecord {
  readonly eventID?: string;
  readonly eventSourceARN?: string;
  readonly kinesis?: {
    readonly data?: string;
    readonly sequenceNumber?: string;
  };
}

export interface ObservabilityKinesisEvent {
  readonly Records?: readonly ObservabilityKinesisRecord[];
}

interface ProjectedRecord {
  readonly data: Uint8Array;
  readonly sourceIdentifier: string;
}

export interface ObservabilityProjectorDependencies {
  readonly checkpoint?: (source: ObservabilityProjectionSource) => Promise<void>;
  readonly now?: () => Date;
  readonly write: (
    destination: ObservabilityIcebergDestination,
    records: readonly ProjectedRecord[],
  ) => Promise<readonly number[]>;
}

const firehose = new FirehoseClient({});
const dynamodb = new DynamoDBClient({});

function checkpointTable() {
  const value = process.env[CHECKPOINT_TABLE_ENV]?.trim();
  if (!value) throw new Error(`${CHECKPOINT_TABLE_ENV} is required.`);
  return value;
}

async function persistCheckpoint(source: ObservabilityProjectionSource) {
  await observabilityCheckpointPersistence.write(dynamodb, {
    Item: {
      sequenceNumber: { S: source.sequenceNumber },
      shardId: { S: source.shardId },
      streamArn: { S: source.streamArn },
      updatedAt: { S: new Date().toISOString() },
    },
    TableName: checkpointTable(),
  });
}

function streamNames(): Record<ObservabilityIcebergDestination, string> {
  const raw = process.env[STREAMS_ENV]?.trim();
  if (!raw) throw new Error(`${STREAMS_ENV} is required.`);
  const parsed = JSON.parse(raw) as Partial<Record<ObservabilityIcebergDestination, unknown>>;
  const result = {} as Record<ObservabilityIcebergDestination, string>;
  for (const destination of DESTINATIONS) {
    const name = parsed[destination];
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`${STREAMS_ENV} is missing ${destination}.`);
    }
    result[destination] = name;
  }
  return result;
}

async function checkpoint(source: ObservabilityProjectionSource) {
  // This records projector ingestion progress only. Firehose DirectPut
  // acceptance is asynchronous and must never be treated as Iceberg commit
  // evidence; rebuilds use actual table watermarks plus failure fences.
  await persistCheckpoint(source);
}

async function write(
  destination: ObservabilityIcebergDestination,
  records: readonly ProjectedRecord[],
) {
  const failedIndexes: number[] = [];
  let start = 0;
  while (start < records.length) {
    let bytes = 0;
    let end = start;
    while (
      end < records.length &&
      end - start < MAX_FIREHOSE_BATCH_RECORDS &&
      bytes + records[end]!.data.byteLength <= MAX_FIREHOSE_BATCH_BYTES
    ) {
      bytes += records[end]!.data.byteLength;
      end += 1;
    }
    const batch = records.slice(start, end);
    const output = await firehose.send(
      new PutRecordBatchCommand({
        DeliveryStreamName: streamNames()[destination],
        Records: batch.map((record) => ({ Data: record.data })),
      }),
    );
    failedIndexes.push(
      ...(output.RequestResponses ?? []).flatMap((response, index) =>
        response.ErrorCode || response.ErrorMessage ? [start + index] : [],
      ),
    );
    start = end;
  }
  return failedIndexes;
}

function identifier(record: ObservabilityKinesisRecord) {
  const value = record.kinesis?.sequenceNumber?.trim();
  if (!value) throw new Error("Observability Kinesis record has no sequence number.");
  return value;
}

function projectionSource(record: ObservabilityKinesisRecord, sequenceNumber: string) {
  const streamArn = record.eventSourceARN?.trim();
  if (!streamArn) throw new Error("Observability Kinesis record has no source ARN.");
  const suffix = `:${sequenceNumber}`;
  const eventId = record.eventID?.trim();
  if (!eventId?.endsWith(suffix)) {
    throw new Error("Observability Kinesis record has no shard-qualified event ID.");
  }
  const shardId = eventId.slice(0, -suffix.length);
  if (!shardId) throw new Error("Observability Kinesis record has no shard ID.");
  return { sequenceNumber, shardId, streamArn };
}

export async function processObservabilityKinesis(
  event: ObservabilityKinesisEvent,
  dependencies: ObservabilityProjectorDependencies,
) {
  const failures = new Set<string>();
  const grouped = new Map<ObservabilityIcebergDestination, ProjectedRecord[]>();
  const sources: (ObservabilityProjectionSource & {
    readonly sourceIdentifier: string;
  })[] = [];
  let checkpointSafe = true;
  for (const source of event.Records ?? []) {
    let sourceIdentifier: string;
    try {
      sourceIdentifier = identifier(source);
    } catch {
      checkpointSafe = false;
      continue;
    }
    let projectionLocation: ObservabilityProjectionSource;
    try {
      projectionLocation = projectionSource(source, sourceIdentifier);
      sources.push({ ...projectionLocation, sourceIdentifier });
    } catch {
      checkpointSafe = false;
      failures.add(sourceIdentifier);
      continue;
    }
    try {
      const encoded = source.kinesis?.data;
      if (!encoded) throw new Error("Observability Kinesis record has no data.");
      const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const projection = observabilityIcebergProjection(
        value,
        (dependencies.now?.() ?? new Date()).toISOString(),
        projectionLocation,
      );
      const records = grouped.get(projection.destination) ?? [];
      records.push({
        data: Buffer.from(`${JSON.stringify(projection.record)}\n`),
        sourceIdentifier,
      });
      grouped.set(projection.destination, records);
    } catch {
      failures.add(sourceIdentifier);
    }
  }
  await Promise.all(
    [...grouped.entries()].map(async ([destination, records]) => {
      try {
        const failedIndexes = await dependencies.write(destination, records);
        for (const index of failedIndexes) {
          const sourceIdentifier = records[index]?.sourceIdentifier;
          if (sourceIdentifier) failures.add(sourceIdentifier);
        }
      } catch {
        for (const record of records) failures.add(record.sourceIdentifier);
      }
    }),
  );
  if (dependencies.checkpoint && checkpointSafe) {
    const byShard = new Map<string, typeof sources>();
    for (const source of sources) {
      const records = byShard.get(source.shardId) ?? [];
      records.push(source);
      byShard.set(source.shardId, records);
    }
    for (const records of byShard.values()) {
      let contiguous: (typeof records)[number] | undefined;
      for (const source of records) {
        if (failures.has(source.sourceIdentifier)) break;
        contiguous = source;
      }
      if (contiguous) {
        const { sourceIdentifier: _identifier, ...checkpointSource } = contiguous;
        await dependencies.checkpoint(checkpointSource);
      }
    }
  }
  return {
    batchItemFailures: [...failures].map((itemIdentifier) => ({
      itemIdentifier,
    })),
  };
}

export const handler = async (event: ObservabilityKinesisEvent) => {
  const result = await processObservabilityKinesis(event, {
    checkpoint,
    write,
  });
  emitObservabilityFailedRecordsMetric("projector", result.batchItemFailures.length);
  return result;
};
