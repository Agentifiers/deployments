/* eslint-disable no-await-in-loop -- checkpoint cleanup and stream reads are ordered. */
import { checked, command, json, safe } from "./observability-clickhouse-rebuild-support.ts";

const CHECKPOINT_CONSUMER = "observability-hot-writer-v1";
const INITIAL_REPLAY_SHARD = "initial-replay-complete";
const CANONICAL_SEED_SHARD = "canonical-seed-complete";

export function checkpointDeleteKey(item: {
  readonly consumer?: { readonly S?: string };
  readonly shard?: { readonly S?: string };
}) {
  const consumer = item.consumer?.S;
  const shard = item.shard?.S;
  if (consumer !== CHECKPOINT_CONSUMER || !shard) {
    throw new Error("DynamoDB returned a malformed observability checkpoint key.");
  }
  safe(shard, "Kinesis shard");
  return { consumer: { S: consumer }, shard: { S: shard } } as const;
}

export async function clearCheckpoints(table: string) {
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  do {
    const arguments_ = [
      "dynamodb",
      "query",
      "--table-name",
      table,
      "--consistent-read",
      "--key-condition-expression",
      "#consumer = :consumer",
      "--expression-attribute-names",
      JSON.stringify({ "#consumer": "consumer", "#shard": "shard" }),
      "--expression-attribute-values",
      JSON.stringify({ ":consumer": { S: CHECKPOINT_CONSUMER } }),
      "--projection-expression",
      "#consumer, #shard",
      "--output",
      "json",
      ...(exclusiveStartKey ? ["--exclusive-start-key", JSON.stringify(exclusiveStartKey)] : []),
    ];
    const page = json<{
      Items?: readonly { consumer?: { S?: string }; shard?: { S?: string } }[];
      LastEvaluatedKey?: Readonly<Record<string, unknown>>;
    }>(await checked("aws", arguments_), "DynamoDB checkpoint query");
    for (const item of page.Items ?? []) {
      await checked("aws", [
        "dynamodb",
        "delete-item",
        "--table-name",
        table,
        "--key",
        JSON.stringify(checkpointDeleteKey(item)),
      ]);
    }
    exclusiveStartKey =
      page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length > 0
        ? page.LastEvaluatedKey
        : undefined;
  } while (exclusiveStartKey);
}

export interface WriterCheckpoint {
  readonly sequenceNumber: string;
  readonly shardId: string;
  readonly streamArn: string;
  readonly updatedAt?: string;
}

export async function readCheckpoints(table: string): Promise<readonly WriterCheckpoint[]> {
  const checkpoints: WriterCheckpoint[] = [];
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = json<{
      Items?: readonly {
        sequenceNumber?: { S?: string };
        shard?: { S?: string };
        streamArn?: { S?: string };
        updatedAt?: { S?: string };
      }[];
      LastEvaluatedKey?: Readonly<Record<string, unknown>>;
    }>(
      await checked("aws", [
        "dynamodb",
        "query",
        "--table-name",
        table,
        "--consistent-read",
        "--key-condition-expression",
        "#consumer = :consumer",
        "--expression-attribute-names",
        JSON.stringify({ "#consumer": "consumer", "#shard": "shard" }),
        "--expression-attribute-values",
        JSON.stringify({ ":consumer": { S: CHECKPOINT_CONSUMER } }),
        "--projection-expression",
        "#shard, sequenceNumber, streamArn, updatedAt",
        "--output",
        "json",
        ...(exclusiveStartKey ? ["--exclusive-start-key", JSON.stringify(exclusiveStartKey)] : []),
      ]),
      "DynamoDB checkpoint query",
    );
    for (const item of page.Items ?? []) {
      const checkpoint = {
        sequenceNumber: item.sequenceNumber?.S,
        shardId: item.shard?.S,
        streamArn: item.streamArn?.S,
        updatedAt: item.updatedAt?.S,
      };
      if (!checkpoint.sequenceNumber || !checkpoint.shardId || !checkpoint.streamArn) {
        throw new Error("DynamoDB returned a malformed observability checkpoint.");
      }
      checkpoints.push({
        sequenceNumber: checkpoint.sequenceNumber,
        shardId: checkpoint.shardId,
        streamArn: checkpoint.streamArn,
        ...(checkpoint.updatedAt ? { updatedAt: checkpoint.updatedAt } : {}),
      });
    }
    exclusiveStartKey =
      page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length > 0
        ? page.LastEvaluatedKey
        : undefined;
  } while (exclusiveStartKey);
  return checkpoints;
}

export async function markCanonicalSeed(table: string, streamArn: string, generation: string) {
  safe(streamArn, "Kinesis stream ARN");
  safe(generation, "ClickHouse generation");
  await checked("aws", [
    "dynamodb",
    "put-item",
    "--table-name",
    table,
    "--item",
    JSON.stringify({
      consumer: { S: CHECKPOINT_CONSUMER },
      sequenceNumber: { S: generation },
      shard: { S: CANONICAL_SEED_SHARD },
      streamArn: { S: streamArn },
      updatedAt: { S: new Date().toISOString() },
    }),
  ]);
}

function sequenceAtLeast(current: string, target: string) {
  if (!/^\d+$/u.test(current) || !/^\d+$/u.test(target)) return false;
  const normalizedCurrent = current.replace(/^0+(?=\d)/u, "");
  const normalizedTarget = target.replace(/^0+(?=\d)/u, "");
  return (
    normalizedCurrent.length > normalizedTarget.length ||
    (normalizedCurrent.length === normalizedTarget.length && normalizedCurrent >= normalizedTarget)
  );
}

type ObservabilityFactFamily = "model-invocations" | "spans" | "tombstones" | "traces" | "usage";

export interface RetainedFactStart {
  readonly factFamily: ObservabilityFactFamily;
  readonly sequenceNumber: string;
  readonly shardId: string;
}

export interface RetainedShardBoundary {
  readonly sequenceNumber?: string;
  readonly shardId: string;
}

export interface RetainedStreamWindow {
  readonly factStarts: readonly RetainedFactStart[];
  readonly shardBoundaries: readonly RetainedShardBoundary[];
}

function retainedFactFamily(data: string): ObservabilityFactFamily {
  const value = json<{ factType?: string }>(
    Buffer.from(data, "base64").toString("utf8"),
    "Retained Kinesis fact",
  );
  switch (value.factType) {
    case "model-invocation.recorded":
      return "model-invocations";
    case "record.deleted":
      return "tombstones";
    case "span.finalized":
      return "spans";
    case "trace.finalized":
      return "traces";
    case "usage.recorded":
      return "usage";
    default:
      throw new Error(
        `Retained Kinesis fact has unsupported fact type ${value.factType ?? "unknown"}.`,
      );
  }
}

export function coldHistoryOverlapsRetainedStream(
  watermarkRows: readonly (readonly string[])[],
  retainedStarts: readonly RetainedFactStart[],
  streamArn: string,
) {
  const header = watermarkRows[0];
  const familyIndex = header?.indexOf("fact_family") ?? -1;
  const streamIndex = header?.indexOf("projection_stream_arn") ?? -1;
  const shardIndex = header?.indexOf("projection_shard_id") ?? -1;
  const sequenceIndex = header?.indexOf("projection_sequence_watermark") ?? -1;
  if (familyIndex < 0 || streamIndex < 0 || shardIndex < 0 || sequenceIndex < 0) {
    throw new Error("Cold watermark query returned an unexpected result shape.");
  }
  const coldByFamilyAndShard = new Map<string, string>();
  for (const row of watermarkRows.slice(1)) {
    if (row[streamIndex] !== streamArn) continue;
    const factFamily = row[familyIndex];
    const shardId = row[shardIndex];
    const sequenceNumber = row[sequenceIndex];
    if (!factFamily || !shardId || !sequenceNumber) continue;
    const key = `${factFamily}\0${shardId}`;
    const previous = coldByFamilyAndShard.get(key);
    if (!previous || sequenceAtLeast(sequenceNumber, previous)) {
      coldByFamilyAndShard.set(key, sequenceNumber);
    }
  }
  return retainedStarts.every((start) => {
    const cold = coldByFamilyAndShard.get(`${start.factFamily}\0${start.shardId}`);
    return Boolean(cold && sequenceAtLeast(cold, start.sequenceNumber));
  });
}

async function listKinesisShardIds(streamName: string) {
  const shardIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const listed = json<{
      NextToken?: string;
      Shards?: readonly { ShardId?: string }[];
    }>(
      await checked("aws", [
        "kinesis",
        "list-shards",
        ...(nextToken ? ["--next-token", nextToken] : ["--stream-name", streamName]),
        "--output",
        "json",
      ]),
      "Kinesis list-shards",
    );
    for (const shard of listed.Shards ?? []) {
      if (!shard.ShardId) throw new Error("Kinesis returned a shard without an ID.");
      safe(shard.ShardId, "Kinesis shard");
      shardIds.push(shard.ShardId);
    }
    nextToken = listed.NextToken;
  } while (nextToken);
  return shardIds;
}

interface RetainedKinesisPage {
  readonly MillisBehindLatest?: number;
  readonly NextShardIterator?: string;
  readonly Records?: readonly { Data?: string; SequenceNumber?: string }[];
}

async function retainedKinesisPage(iterator: string, deadline: number) {
  let backoff = 2_000;
  while (Date.now() < deadline) {
    const result = await command("aws", [
      "kinesis",
      "get-records",
      "--shard-iterator",
      iterator,
      "--limit",
      "10000",
      "--output",
      "json",
    ]);
    if (result.code === 0) {
      return json<RetainedKinesisPage>(result.stdout, "Kinesis get-records");
    }
    if (
      !result.stderr.includes("ProvisionedThroughputExceededException") &&
      !result.stderr.includes("ThrottlingException")
    ) {
      throw new Error(
        `Kinesis get-records failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    await Bun.sleep(backoff);
    backoff = Math.min(8_000, backoff * 2);
  }
  throw new Error("Kinesis retained-stream read remained throttled.");
}

export async function retainedStreamWindow(
  streamArn: string,
  timeoutSeconds: number,
): Promise<RetainedStreamWindow> {
  const streamName = streamArn.split("/").at(-1);
  if (!streamName) throw new Error("Kinesis stream ARN has no stream name.");
  const shardIds = await listKinesisShardIds(streamName);
  const shardWindows = await Promise.all(
    shardIds.map(
      async (
        shardId,
      ): Promise<{
        readonly boundary: RetainedShardBoundary;
        readonly factStarts: readonly RetainedFactStart[];
      }> => {
        const starts = new Map<ObservabilityFactFamily, RetainedFactStart>();
        let firstSequenceNumber: string | undefined;
        const iteratorResponse = json<{ ShardIterator?: string }>(
          await checked("aws", [
            "kinesis",
            "get-shard-iterator",
            "--stream-name",
            streamName,
            "--shard-id",
            shardId,
            "--shard-iterator-type",
            "TRIM_HORIZON",
            "--output",
            "json",
          ]),
          "Kinesis get-shard-iterator",
        );
        let iterator = iteratorResponse.ShardIterator;
        const deadline = Date.now() + timeoutSeconds * 1_000;
        while (iterator && Date.now() < deadline) {
          const records = await retainedKinesisPage(iterator, deadline);
          for (const record of records.Records ?? []) {
            if (!record.Data || !record.SequenceNumber) {
              throw new Error("Kinesis returned an incomplete retained fact.");
            }
            firstSequenceNumber ??= record.SequenceNumber;
            const factFamily = retainedFactFamily(record.Data);
            if (!starts.has(factFamily)) {
              starts.set(factFamily, {
                factFamily,
                sequenceNumber: record.SequenceNumber,
                shardId,
              });
            }
          }
          iterator = records.NextShardIterator;
          if (!iterator || records.MillisBehindLatest === 0) {
            return {
              boundary: {
                shardId,
                ...(firstSequenceNumber ? { sequenceNumber: firstSequenceNumber } : {}),
              },
              factStarts: [...starts.values()],
            };
          }
          // Lambda polls at roughly one read/second and the hot writer at one
          // read/two seconds. Stay below the shard's shared five-read quota.
          await Bun.sleep(2_000);
        }
        throw new Error(`Could not scan the retained records of Kinesis shard ${shardId}.`);
      },
    ),
  );
  return {
    factStarts: shardWindows.flatMap((window) => window.factStarts),
    shardBoundaries: shardWindows.map((window) => window.boundary),
  };
}

export async function readProjectorCheckpoints(
  table: string,
  streamArn: string,
): Promise<readonly WriterCheckpoint[]> {
  const checkpoints: WriterCheckpoint[] = [];
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = json<{
      Items?: readonly {
        sequenceNumber?: { S?: string };
        shardId?: { S?: string };
        streamArn?: { S?: string };
        updatedAt?: { S?: string };
      }[];
      LastEvaluatedKey?: Readonly<Record<string, unknown>>;
    }>(
      await checked("aws", [
        "dynamodb",
        "query",
        "--table-name",
        table,
        "--consistent-read",
        "--key-condition-expression",
        "#stream = :stream",
        "--expression-attribute-names",
        JSON.stringify({ "#stream": "streamArn" }),
        "--expression-attribute-values",
        JSON.stringify({ ":stream": { S: streamArn } }),
        "--projection-expression",
        "shardId, sequenceNumber, streamArn, updatedAt",
        "--output",
        "json",
        ...(exclusiveStartKey ? ["--exclusive-start-key", JSON.stringify(exclusiveStartKey)] : []),
      ]),
      "DynamoDB projector checkpoint query",
    );
    for (const item of page.Items ?? []) {
      if (!item.sequenceNumber?.S || !item.shardId?.S || !item.streamArn?.S) {
        throw new Error("DynamoDB returned a malformed projector checkpoint.");
      }
      checkpoints.push({
        sequenceNumber: item.sequenceNumber.S,
        shardId: item.shardId.S,
        streamArn: item.streamArn.S,
        ...(item.updatedAt?.S ? { updatedAt: item.updatedAt.S } : {}),
      });
    }
    exclusiveStartKey =
      page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length > 0
        ? page.LastEvaluatedKey
        : undefined;
  } while (exclusiveStartKey);
  return checkpoints;
}

export function projectorCheckpointBootstrapTargets(
  watermarkRows: readonly (readonly string[])[],
  existing: readonly WriterCheckpoint[],
  streamArn: string,
) {
  const header = watermarkRows[0];
  const streamIndex = header?.indexOf("projection_stream_arn") ?? -1;
  const shardIndex = header?.indexOf("projection_shard_id") ?? -1;
  const sequenceIndex = header?.indexOf("projection_sequence_watermark") ?? -1;
  if (streamIndex < 0 || shardIndex < 0 || sequenceIndex < 0) {
    throw new Error(
      "Cold watermark query returned an unexpected result shape for checkpoint bootstrap.",
    );
  }
  const existingShards = new Set(
    existing
      .filter((checkpoint) => checkpoint.streamArn === streamArn)
      .map((checkpoint) => checkpoint.shardId),
  );
  const maximumByShard = new Map<string, string>();
  for (const row of watermarkRows.slice(1)) {
    if (row[streamIndex] !== streamArn) continue;
    const shardId = row[shardIndex];
    const sequenceNumber = row[sequenceIndex];
    if (!shardId || !sequenceNumber || existingShards.has(shardId)) continue;
    const previous = maximumByShard.get(shardId);
    if (!previous || sequenceAtLeast(sequenceNumber, previous)) {
      maximumByShard.set(shardId, sequenceNumber);
    }
  }
  return [...maximumByShard].map(([shardId, sequenceNumber]) => ({
    sequenceNumber,
    shardId,
    streamArn,
  }));
}

export async function seedProjectorCheckpoints(
  table: string,
  watermarkRows: readonly (readonly string[])[],
  existing: readonly WriterCheckpoint[],
  streamArn: string,
) {
  const targets = projectorCheckpointBootstrapTargets(watermarkRows, existing, streamArn);
  for (const target of targets) {
    await checked("aws", [
      "dynamodb",
      "put-item",
      "--table-name",
      table,
      "--item",
      JSON.stringify({
        sequenceNumber: { S: target.sequenceNumber },
        shardId: { S: target.shardId },
        streamArn: { S: target.streamArn },
        updatedAt: { S: new Date().toISOString() },
      }),
      "--condition-expression",
      "attribute_not_exists(streamArn) AND attribute_not_exists(shardId)",
    ]);
  }
  return targets.length;
}

export function projectorCoversRetainedStream(
  projectorCheckpoints: readonly WriterCheckpoint[],
  shardBoundaries: readonly RetainedShardBoundary[],
  hotCheckpoints: readonly WriterCheckpoint[],
  streamArn: string,
) {
  const projectorByShard = new Map(
    projectorCheckpoints
      .filter((checkpoint) => checkpoint.streamArn === streamArn)
      .map((checkpoint) => [checkpoint.shardId, checkpoint] as const),
  );
  const boundaryByShard = new Map(
    shardBoundaries.map((boundary) => [boundary.shardId, boundary] as const),
  );
  for (const boundary of shardBoundaries) {
    if (!boundary.sequenceNumber) continue;
    const checkpoint = projectorByShard.get(boundary.shardId);
    if (!checkpoint || !sequenceAtLeast(checkpoint.sequenceNumber, boundary.sequenceNumber)) {
      return false;
    }
  }
  for (const checkpoint of hotCheckpoints) {
    if (
      checkpoint.streamArn !== streamArn ||
      checkpoint.shardId === INITIAL_REPLAY_SHARD ||
      checkpoint.shardId === CANONICAL_SEED_SHARD ||
      boundaryByShard.get(checkpoint.shardId)?.sequenceNumber
    ) {
      continue;
    }
    const projector = projectorByShard.get(checkpoint.shardId);
    if (!projector || !sequenceAtLeast(projector.sequenceNumber, checkpoint.sequenceNumber)) {
      return false;
    }
  }
  return true;
}

export function replayTargetsForRetainedShards(
  checkpoints: readonly WriterCheckpoint[],
  retainedStarts: readonly RetainedFactStart[],
  streamArn: string,
) {
  const retainedShardIds = new Set(retainedStarts.map((start) => start.shardId));
  return checkpoints.filter(
    (checkpoint) =>
      checkpoint.shardId !== INITIAL_REPLAY_SHARD &&
      checkpoint.shardId !== CANONICAL_SEED_SHARD &&
      checkpoint.streamArn === streamArn &&
      retainedShardIds.has(checkpoint.shardId),
  );
}

export function replayGateSatisfied(
  checkpoints: readonly WriterCheckpoint[],
  targets: readonly WriterCheckpoint[],
  streamArn: string,
  requireReady = true,
) {
  if (
    requireReady &&
    !checkpoints.some(
      (checkpoint) =>
        checkpoint.shardId === INITIAL_REPLAY_SHARD && checkpoint.streamArn === streamArn,
    )
  ) {
    return false;
  }
  const byShard = new Map(
    checkpoints
      .filter((checkpoint) => checkpoint.streamArn === streamArn)
      .map((checkpoint) => [checkpoint.shardId, checkpoint] as const),
  );
  return targets.every((target) => {
    const current = byShard.get(target.shardId);
    return Boolean(current && sequenceAtLeast(current.sequenceNumber, target.sequenceNumber));
  });
}

export async function waitForReplay(
  table: string,
  targets: readonly WriterCheckpoint[],
  streamArn: string,
  timeoutSeconds: number,
  requireReady = true,
) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    if (replayGateSatisfied(await readCheckpoints(table), targets, streamArn, requireReady)) {
      return;
    }
    await Bun.sleep(2_000);
  }
  throw new Error("Hot-writer replay did not reach its captured checkpoint watermarks in time.");
}
