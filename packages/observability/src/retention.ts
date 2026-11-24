/**
 * Hot-plane (ClickHouse) retention: run spans, finalized traces, and deletion tombstones keep
 * the trace window; every other span keeps the shorter span window. The hot-plane TTL and
 * operator surfaces read these values so they cannot drift apart.
 */
export const HOT_PLANE_RETENTION_DAYS = { span: 30, trace: 90 } as const;
