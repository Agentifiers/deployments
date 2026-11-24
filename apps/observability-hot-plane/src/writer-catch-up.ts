/** Every open shard must have been read this recently for the writer to count as caught up. */
const WRITER_READ_FRESHNESS_MS = 30_000;
/** A shard read at most this far behind its tip counts as caught up. */
const WRITER_CAUGHT_UP_MAX_BEHIND_MS = 5_000;

interface ShardRead {
  readonly millisBehindLatest: number;
  readonly readStartedAt: number;
}

/**
 * Per-shard progress of the hot-plane writer, used to prove that every fact
 * Kinesis accepted before a point in time is already in ClickHouse.
 *
 * Kinesis's stream-level `GetRecords.IteratorAgeMilliseconds` cannot prove
 * this: on an idle stream it reports the age of the last record and grows
 * with wall-clock time even when the writer is fully caught up.
 */
export interface WriterCatchUp {
  /** Replaces the set of shards currently listed on the stream. */
  readonly shardsListed: (shardIds: readonly string[]) => void;
  /** Marks a shard fully consumed (closed after resharding). */
  readonly shardClosed: (shardId: string) => void;
  /**
   * Records a successful `GetRecords` whose returned records the writer has
   * already inserted (or deliberately dropped) and checkpointed.
   */
  readonly shardRead: (shardId: string, read: ShardRead) => void;
  /**
   * Arrival time through which every open shard's records are in ClickHouse,
   * or `undefined` unless every open shard was read within
   * {@link WRITER_READ_FRESHNESS_MS} at most {@link WRITER_CAUGHT_UP_MAX_BEHIND_MS}
   * behind its tip.
   */
  readonly caughtUpThrough: (now: number) => number | undefined;
}

export function createWriterCatchUp(): WriterCatchUp {
  let listed: readonly string[] = [];
  const closed = new Set<string>();
  const reads = new Map<string, ShardRead>();
  return {
    caughtUpThrough(now) {
      let through: number | undefined;
      for (const shardId of listed) {
        if (closed.has(shardId)) continue;
        const read = reads.get(shardId);
        if (
          !read ||
          now - read.readStartedAt > WRITER_READ_FRESHNESS_MS ||
          read.millisBehindLatest > WRITER_CAUGHT_UP_MAX_BEHIND_MS
        ) {
          return undefined;
        }
        // Records that arrived before the read started, less the reported lag,
        // were returned by this read or an earlier one.
        const covered = read.readStartedAt - read.millisBehindLatest;
        through = through === undefined ? covered : Math.min(through, covered);
      }
      return through;
    },
    shardClosed(shardId) {
      closed.add(shardId);
    },
    shardRead(shardId, read) {
      reads.set(shardId, read);
    },
    shardsListed(shardIds) {
      listed = [...shardIds];
      const current = new Set(shardIds);
      for (const shardId of reads.keys()) if (!current.has(shardId)) reads.delete(shardId);
      for (const shardId of closed) if (!current.has(shardId)) closed.delete(shardId);
    },
  };
}
