import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DescribeStreamSummaryCommand,
  GetRecordsCommand,
  GetShardIteratorCommand,
  ListShardsCommand,
  type KinesisClient,
} from "@aws-sdk/client-kinesis";
import { observabilityCheckpointPersistence } from "@deployments-ai/db/observability-checkpoints";
import type { ClickHouseExecutor } from "./clickhouse.ts";
import { decodeKinesisFact, hotFactRow } from "./facts.ts";
import type { ExistingOrganizations } from "./organization-presence.ts";
import type { WriterCatchUp } from "./writer-catch-up.ts";

const CHECKPOINT_PARTITION = "observability-hot-writer-v1";
const INITIAL_REPLAY_SHARD = "initial-replay-complete";
const CANONICAL_SEED_SHARD = "canonical-seed-complete";
// The canonical Iceberg projector is also a standard Kinesis consumer. Keep
// this lightweight hot projection below one GetRecords call per second so the
// two consumers remain inside the shard's shared five-call quota.
const KINESIS_READ_INTERVAL_MS = 2_000;
const KINESIS_RECORD_LIMIT = 10_000;
const MAX_THROTTLE_BACKOFF_MS = 5_000;
// Kinesis never trims a record younger than 24 hours, whatever the stream's retention period.
const KINESIS_MINIMUM_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface WriterDependencies {
  /** Receives per-shard read progress so erasure can prove the writer caught up. */
  readonly catchUp?: WriterCatchUp;
  readonly checkpointTable: string;
  readonly clickhouse: ClickHouseExecutor;
  readonly dynamodb: DynamoDBClient;
  /** Returns the subset of organization ids whose control-table organization row still exists. */
  readonly existingOrganizations: ExistingOrganizations;
  readonly kinesis: KinesisClient;
  readonly now?: () => number;
  readonly onInitialReplayComplete?: () => void;
  readonly quarantine: {
    readonly put: (record: PoisonRecord) => Promise<void>;
  };
  readonly requireCanonicalSeed?: boolean;
  readonly signal: AbortSignal;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly streamArn: string;
  readonly streamName: string;
}

interface PoisonRecord {
  readonly dataBytes: number;
  readonly errorType: string;
  readonly observedAt: string;
  readonly sequenceNumber: string;
  readonly shardId: string;
  readonly streamArn: string;
}

async function checkpoint(dependencies: WriterDependencies, shardId: string) {
  const result = await observabilityCheckpointPersistence.read(dependencies.dynamodb, {
    ConsistentRead: true,
    Key: { consumer: { S: CHECKPOINT_PARTITION }, shard: { S: shardId } },
    ProjectionExpression: "sequenceNumber, streamArn",
    TableName: dependencies.checkpointTable,
  });
  return result.Item?.streamArn?.S === dependencies.streamArn
    ? result.Item.sequenceNumber?.S
    : undefined;
}

async function clickhouseGeneration(dependencies: WriterDependencies) {
  const rows = await dependencies.clickhouse.query<{ generation?: unknown }>(
    "SELECT generation FROM observability.runtime_generation ORDER BY established_at DESC LIMIT 1",
  );
  const generation = rows[0]?.generation;
  return typeof generation === "string" ? generation : undefined;
}

async function canonicalSeedReady(dependencies: WriterDependencies) {
  const generation = await checkpoint(dependencies, CANONICAL_SEED_SHARD);
  return Boolean(generation && (await clickhouseGeneration(dependencies)) === generation);
}

/**
 * Records the first canonical seed without a rebuild while the stream still holds every fact it
 * has ever carried: the stream is younger than Kinesis's minimum retention, no shard has a writer
 * checkpoint, and ClickHouse has no other generation. Observability history is projected from
 * the same stream, so replaying it from TRIM_HORIZON yields what a rebuild would load. The
 * generation derives from the stream's creation time, so a retry after a crash between the two
 * writes converges on the same seed.
 */
async function seedNewStream(dependencies: WriterDependencies) {
  const { StreamDescriptionSummary: summary } = await dependencies.kinesis.send(
    new DescribeStreamSummaryCommand({ StreamName: dependencies.streamName }),
  );
  const createdAt = summary?.StreamCreationTimestamp?.getTime();
  const now = (dependencies.now ?? Date.now)();
  if (createdAt === undefined || now - createdAt >= KINESIS_MINIMUM_RETENTION_MS) return undefined;
  const generation = `stream-origin-${createdAt}`;
  const established = await clickhouseGeneration(dependencies);
  if (established !== undefined && established !== generation) return undefined;
  for (const shard of await listShards(dependencies.kinesis, dependencies.streamName)) {
    if (await checkpoint(dependencies, shard.shardId)) return undefined;
  }
  if (established === undefined) {
    await dependencies.clickhouse.execute(
      "INSERT INTO observability.runtime_generation (generation, established_at) VALUES ({generation:String}, now64(3))",
      { generation },
    );
  }
  await saveCheckpoint(dependencies, CANONICAL_SEED_SHARD, generation);
  return generation;
}

async function saveCheckpoint(
  dependencies: WriterDependencies,
  shardId: string,
  sequenceNumber: string,
) {
  await observabilityCheckpointPersistence.write(dependencies.dynamodb, {
    Item: {
      consumer: { S: CHECKPOINT_PARTITION },
      sequenceNumber: { S: sequenceNumber },
      shard: { S: shardId },
      streamArn: { S: dependencies.streamArn },
      updatedAt: { S: new Date().toISOString() },
    },
    TableName: dependencies.checkpointTable,
  });
}

async function shardIterator(dependencies: WriterDependencies, shardId: string) {
  const sequenceNumber = await checkpoint(dependencies, shardId);
  const result = await dependencies.kinesis.send(
    new GetShardIteratorCommand({
      ShardId: shardId,
      ShardIteratorType: sequenceNumber ? "AFTER_SEQUENCE_NUMBER" : "TRIM_HORIZON",
      StreamName: dependencies.streamName,
      ...(sequenceNumber ? { StartingSequenceNumber: sequenceNumber } : {}),
    }),
  );
  return result.ShardIterator;
}

async function processShard(
  dependencies: WriterDependencies,
  shardId: string,
  onCaughtUp?: () => void,
) {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? delay;
  let iterator = await shardIterator(dependencies, shardId);
  let nextReadAt = 0;
  let throttleAttempts = 0;
  while (iterator && !dependencies.signal.aborted) {
    const pacingDelay = Math.max(0, nextReadAt - now());
    if (pacingDelay > 0) await wait(pacingDelay, dependencies.signal);
    if (dependencies.signal.aborted) break;
    const readStartedAt = now();
    nextReadAt = readStartedAt + KINESIS_READ_INTERVAL_MS;
    let result;
    try {
      result = await dependencies.kinesis.send(
        new GetRecordsCommand({
          Limit: KINESIS_RECORD_LIMIT,
          ShardIterator: iterator,
        }),
      );
      throttleAttempts = 0;
    } catch (cause) {
      if (!isKinesisThrottle(cause)) throw cause;
      const backoff = Math.min(
        MAX_THROTTLE_BACKOFF_MS,
        KINESIS_READ_INTERVAL_MS * 2 ** Math.min(throttleAttempts, 4),
      );
      throttleAttempts += 1;
      nextReadAt = Math.max(nextReadAt, now() + backoff);
      continue;
    }
    iterator = result.NextShardIterator;
    const records = result.Records ?? [];
    // Reported only once the read's records are inserted and checkpointed.
    const read =
      result.MillisBehindLatest === undefined
        ? undefined
        : { millisBehindLatest: result.MillisBehindLatest, readStartedAt };
    if (records.length === 0) {
      if (read) dependencies.catchUp?.shardRead(shardId, read);
      if (iterator && (result.MillisBehindLatest === undefined || result.MillisBehindLatest > 0)) {
        continue;
      }
      break;
    }
    const rows: ReturnType<typeof hotFactRow>[] = [];
    const ingestedAt = new Date();
    for (const record of records) {
      if (!record.Data || !record.SequenceNumber)
        throw new Error("Kinesis returned an incomplete record.");
      try {
        rows.push(
          hotFactRow(
            decodeKinesisFact(record.Data),
            {
              sequenceNumber: record.SequenceNumber,
              shardId,
            },
            ingestedAt,
          ),
        );
      } catch (cause) {
        await dependencies.quarantine.put({
          dataBytes: record.Data.byteLength,
          errorType: cause instanceof Error ? cause.name : "UnknownError",
          observedAt: new Date().toISOString(),
          sequenceNumber: record.SequenceNumber,
          shardId,
          streamArn: dependencies.streamArn,
        });
      }
    }
    if (rows.length > 0) {
      // Replays and rebuilds must not resurrect an erased organization's facts.
      const organizations = await dependencies.existingOrganizations(
        rows.map((row) => row.organization_id),
      );
      const retained = rows.filter((row) => organizations.has(row.organization_id));
      if (retained.length < rows.length) {
        console.warn("Observability hot writer dropped facts for erased organizations.", {
          droppedFacts: rows.length - retained.length,
          shardId,
        });
      }
      if (retained.length > 0)
        await dependencies.clickhouse.insert("observability.facts", retained);
    }
    await saveCheckpoint(dependencies, shardId, records.at(-1)!.SequenceNumber!);
    if (read) dependencies.catchUp?.shardRead(shardId, read);
    if (result.MillisBehindLatest === 0) onCaughtUp?.();
  }
  return { closed: iterator === undefined };
}

function isKinesisThrottle(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const name = "name" in cause && typeof cause.name === "string" ? cause.name : "";
  return name === "ProvisionedThroughputExceededException" || name === "ThrottlingException";
}

function delay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

interface DiscoveredShard {
  readonly parentShardIds: readonly string[];
  readonly shardId: string;
}

async function listShards(kinesis: KinesisClient, streamName: string) {
  const shards: DiscoveredShard[] = [];
  let nextToken: string | undefined;
  do {
    const result = await kinesis.send(
      new ListShardsCommand(nextToken ? { NextToken: nextToken } : { StreamName: streamName }),
    );
    for (const shard of result.Shards ?? []) {
      if (shard.ShardId) {
        shards.push({
          parentShardIds: [shard.ParentShardId, shard.AdjacentParentShardId].filter(
            (parent): parent is string => Boolean(parent),
          ),
          shardId: shard.ShardId,
        });
      }
    }
    nextToken = result.NextToken;
  } while (nextToken);
  return shards;
}

export async function listShardIds(kinesis: KinesisClient, streamName: string) {
  return (await listShards(kinesis, streamName)).map((shard) => shard.shardId);
}

export async function runHotWriter(dependencies: WriterDependencies) {
  if (dependencies.requireCanonicalSeed !== false) {
    const durableGeneration =
      (await checkpoint(dependencies, CANONICAL_SEED_SHARD)) ?? (await seedNewStream(dependencies));
    if (durableGeneration && (await clickhouseGeneration(dependencies)) !== durableGeneration) {
      throw new Error(
        "ClickHouse generation does not match the durable canonical seed; run a full rebuild before consuming more facts.",
      );
    }
  }
  const wait = dependencies.wait ?? delay;
  const states = new Map<string, { caughtUp: boolean; closed: boolean; started: boolean }>();
  const tasks = new Set<Promise<void>>();
  let failure: unknown;
  let initialReplayComplete = false;
  while (!dependencies.signal.aborted) {
    if (failure) throw failure;
    const shards = await listShards(dependencies.kinesis, dependencies.streamName);
    dependencies.catchUp?.shardsListed(shards.map((shard) => shard.shardId));
    const discoveredIds = new Set(shards.map((shard) => shard.shardId));
    for (const shard of shards) {
      if (!states.has(shard.shardId)) {
        states.set(shard.shardId, {
          caughtUp: false,
          closed: false,
          started: false,
        });
      }
    }
    for (const shard of shards) {
      const state = states.get(shard.shardId)!;
      const parentsComplete = shard.parentShardIds.every(
        (parentId) => !discoveredIds.has(parentId) || states.get(parentId)?.closed === true,
      );
      if (state.started || !parentsComplete) continue;
      state.started = true;
      let task!: Promise<void>;
      task = (async () => {
        while (!dependencies.signal.aborted && !state.closed) {
          const result = await processShard(dependencies, shard.shardId, () => {
            state.caughtUp = true;
          });
          if (dependencies.signal.aborted) return;
          state.caughtUp = true;
          state.closed = result.closed;
          if (state.closed) dependencies.catchUp?.shardClosed(shard.shardId);
          if (!state.closed) await wait(KINESIS_READ_INTERVAL_MS, dependencies.signal);
        }
      })()
        .catch((cause: unknown) => {
          failure ??= cause;
        })
        .finally(() => tasks.delete(task));
      tasks.add(task);
    }
    await wait(0, dependencies.signal);
    if (failure) throw failure;
    if (
      !initialReplayComplete &&
      !dependencies.signal.aborted &&
      shards.every((shard) => states.get(shard.shardId)?.caughtUp === true) &&
      (dependencies.requireCanonicalSeed === false || (await canonicalSeedReady(dependencies)))
    ) {
      await saveCheckpoint(dependencies, INITIAL_REPLAY_SHARD, "complete");
      initialReplayComplete = true;
      dependencies.onInitialReplayComplete?.();
    }
    await wait(1_000, dependencies.signal);
  }
  await Promise.all(tasks);
}
