const SHARD_COUNT = 16;

export function reconciliationShardOrder(timestamp: Date) {
  const startingShard = Math.floor(timestamp.getTime() / 60_000) % SHARD_COUNT;
  return Array.from({ length: SHARD_COUNT }, (_, offset) => (startingShard + offset) % SHARD_COUNT);
}

export const RECONCILIATION_LIMIT = 500;
export const RECONCILIATION_PER_SHARD_LIMIT = Math.ceil(RECONCILIATION_LIMIT / SHARD_COUNT);
