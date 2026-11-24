import {
  apiPersistence,
  key,
  type DynamoDatabaseService,
  type OpaqueCursorCodec,
  type PlatformRecord,
} from "@deployments-ai/db";

/**
 * Usage and cost lists read the usage table's metric index (`gsi2`: `ENV#<env>#METRIC#<metric>`
 * ordered by `<bucket or occurrence time>#<identity>`), not the environment's base partition. The
 * base partition orders records by type and identity and also holds every API-credential
 * activity record, so a time window could only be found by scanning all of it; in the metric
 * index a window is one key range per metric.
 */

/** Index queries one page may issue before it returns a continuation. */
const MAX_INDEX_QUERIES = 25;
/** Metrics one page reads at once: the current metric and those after it. */
const METRIC_READ_AHEAD = 4;
/**
 * Records a read-ahead query fetches. A page that fills before it reaches a read-ahead metric
 * discards that read, so this bounds the waste per page; a metric with more records continues
 * from where its read-ahead stopped.
 */
const READ_AHEAD_LIMIT = 100;
const MAX_KEY_BYTES = 1_024;
const MAX_PARTITION_BYTES = 2_048;
/** Below every encoded timestamp and above every sort key, for open-ended windows. */
const INDEX_FLOOR = "0";
const INDEX_CEILING = "\uffff";

/**
 * Record types whose base sort keys begin with the metric (or cost source) they report;
 * attributed counters begin with their attribution's label and id, then the metric.
 */
export type MetricKeyedItemType =
  | "attributed-usage-counter-shard"
  | "cost-aggregate"
  | "usage-aggregate"
  | "usage-counter-shard";

/**
 * Where a metric-index page stopped: the metric, the index key to resume after when it stopped
 * mid-metric, and the metrics still to read (starting with `metric`) so later pages skip
 * discovery.
 */
export interface MetricIndexPosition {
  readonly key?: Readonly<Record<"gsi2pk" | "gsi2sk" | "pk" | "sk", string>>;
  readonly metric: string;
  readonly metrics?: readonly string[];
}

export function metricIndexPartition(environmentId: string, metric: string) {
  return key("ENV", environmentId, "METRIC", metric);
}

/** A discovered metric (or cost source) and the unit of the record that named it. */
export interface MetricEntry {
  readonly metric: string;
  readonly unit?: string;
}

function metricOf(record: PlatformRecord): MetricEntry {
  const data = record.data as Readonly<Record<string, unknown>>;
  const metric = data.metric ?? data.source;
  if (typeof metric !== "string") throw new Error(`${record.itemType} has no metric.`);
  return typeof data.unit === "string" ? { metric, unit: data.unit } : { metric };
}

/**
 * Distinct metrics of one record type in an environment partition. Base sort keys are
 * `<TYPE>#<within…>#<metric>#…`, so each step reads the first record past the previous metric's
 * keys: one single-item query per metric, however many records each metric has. `within` names
 * the key parts between the type and the metric (an attributed counter's label and id).
 */
export async function discoverMetrics(
  database: DynamoDatabaseService,
  partition: string,
  itemType: MetricKeyedItemType,
  within: readonly string[] = [],
): Promise<MetricEntry[]> {
  const parts = [itemType.toUpperCase(), ...within];
  const prefix = key(...parts);
  const metrics: MetricEntry[] = [];
  let lower = `${prefix}#`;
  for (;;) {
    const page = await apiPersistence.find(database, "usage", {
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":lower": lower,
        ":pk": partition,
        ":upper": `${prefix}#${INDEX_CEILING}`,
      },
      KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
      Limit: 1,
    });
    const record = page.items[0];
    if (!record) return metrics;
    const entry = metricOf(record);
    const next = `${key(...parts, entry.metric)}#${INDEX_CEILING}`;
    // A record at or below the bound would repeat this step forever.
    if (next <= lower) throw new Error(`${itemType} metric discovery did not advance.`);
    metrics.push(entry);
    lower = next;
  }
}

const COST_USAGE_METRIC_SUFFIXES = [".cost_usd_micros", ".cost_usd_nanodollars"] as const;

/** Cost counters share the usage record types; their metric names end in a cost unit. */
export function isCostUsageMetric(metric: string) {
  return COST_USAGE_METRIC_SUFFIXES.some((suffix) => metric.endsWith(suffix));
}

async function discovered(
  database: DynamoDatabaseService,
  partition: string,
  itemTypes: readonly MetricKeyedItemType[],
) {
  const lists = await Promise.all(
    itemTypes.map((itemType) => discoverMetrics(database, partition, itemType)),
  );
  return lists.flat().map((entry) => entry.metric);
}

/**
 * Index partitions a usage list reads: the `metric` filter alone, else every non-cost counter and
 * aggregate metric plus the type-named partitions of inbox and storage usage, which carry no
 * metric. Meter events share their metric's partition with its counters, which exist once the
 * metric's first event is materialized.
 */
export async function usageListMetrics(
  database: DynamoDatabaseService,
  partition: string,
  metric: unknown,
): Promise<string[]> {
  if (metric !== undefined) {
    return typeof metric === "string" && !isCostUsageMetric(metric) ? [metric] : [];
  }
  const metrics = await discovered(database, partition, ["usage-counter-shard", "usage-aggregate"]);
  return [
    ...metrics.filter((candidate) => !isCostUsageMetric(candidate)),
    "inbox-usage",
    "storage-usage",
  ];
}

/** Index partitions a cost list reads: cost counter and aggregate metrics and cost sources. */
export async function costListMetrics(
  database: DynamoDatabaseService,
  partition: string,
): Promise<string[]> {
  const [metrics, sources] = await Promise.all([
    discovered(database, partition, ["usage-counter-shard", "usage-aggregate"]),
    discoverMetrics(database, partition, "cost-aggregate"),
  ]);
  return [...metrics.filter(isCostUsageMetric), ...sources.map((entry) => entry.metric)];
}

function keyPart(value: unknown, maximumBytes: number) {
  if (typeof value !== "string" || !value) throw new Error();
  if (new TextEncoder().encode(value).byteLength > maximumBytes) throw new Error();
  return value;
}

/** Validates a decoded cursor position against the environment it was issued for. */
function parseMetricIndexPosition(
  value: unknown,
  environmentPartition: string,
  environmentId: string,
): MetricIndexPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const position = value as Readonly<Record<string, unknown>>;
  const metric = keyPart(position.metric, MAX_KEY_BYTES);
  const metrics = position.metrics === undefined ? undefined : remainingMetrics(position.metrics);
  if (metrics && metrics[0] !== metric) throw new Error();
  const listed = metrics ? { metrics } : {};
  if (position.key === undefined) return { metric, ...listed };
  if (!position.key || typeof position.key !== "object" || Array.isArray(position.key)) {
    throw new Error();
  }
  const indexKey = position.key as Readonly<Record<string, unknown>>;
  if (Object.keys(indexKey).toSorted().join(",") !== "gsi2pk,gsi2sk,pk,sk") throw new Error();
  const parsed = {
    gsi2pk: keyPart(indexKey.gsi2pk, MAX_PARTITION_BYTES),
    gsi2sk: keyPart(indexKey.gsi2sk, MAX_KEY_BYTES),
    pk: keyPart(indexKey.pk, MAX_PARTITION_BYTES),
    sk: keyPart(indexKey.sk, MAX_KEY_BYTES),
  };
  if (
    parsed.gsi2pk !== metricIndexPartition(environmentId, metric) ||
    parsed.pk !== environmentPartition
  ) {
    throw new Error();
  }
  return { key: parsed, metric, ...listed };
}

/** A cursor's metric list: distinct metric names in ascending order. */
function remainingMetrics(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error();
  const metrics = value.map((metric) => keyPart(metric, MAX_KEY_BYTES));
  if (metrics.some((metric, index) => index > 0 && metric <= metrics[index - 1]!)) {
    throw new Error();
  }
  return metrics;
}

/** Opens a metric-index cursor; throws unless it was issued for this partition and purpose. */
export async function openMetricCursor(
  codec: OpaqueCursorCodec,
  value: string,
  partition: string,
  environmentId: string,
  purpose: string,
): Promise<MetricIndexPosition> {
  const cursor = JSON.parse(await codec.open(value)) as Readonly<Record<string, unknown>>;
  if (cursor.partition !== partition || cursor.purpose !== purpose) throw new Error();
  return parseMetricIndexPosition(cursor.position, partition, environmentId);
}

/** Seals a position; a metric list too long for the cursor is left out and rediscovered. */
export function sealMetricCursor(
  codec: OpaqueCursorCodec,
  position: MetricIndexPosition,
  partition: string,
  purpose: string,
  maximumPlaintextBytes: number,
) {
  const listed = JSON.stringify({ partition, position, purpose });
  if (Buffer.byteLength(listed) <= maximumPlaintextBytes) return codec.seal(listed);
  const { metrics: _metrics, ...unlisted } = position;
  return codec.seal(JSON.stringify({ partition, position: unlisted, purpose }));
}

/** The key a page resumes after: an index query's last evaluated key, or a returned record's. */
function indexKeyOf(value: Readonly<Record<string, unknown>>): MetricIndexPosition["key"] {
  return {
    gsi2pk: String(value.gsi2pk),
    gsi2sk: String(value.gsi2sk),
    pk: String(value.pk),
    sk: String(value.sk),
  };
}

export interface MetricIndexPageInput {
  readonly database: DynamoDatabaseService;
  readonly environmentId: string;
  readonly limit: number;
  readonly matches: (record: PlatformRecord) => boolean;
  /** Metrics to read, in any order; the page walks them in sorted order. */
  readonly metrics: Iterable<string>;
  readonly since: string | undefined;
  readonly start: MetricIndexPosition | undefined;
  readonly until: string | undefined;
  /**
   * Whether a metric's index order is the list's time filter. Records indexed by another time
   * (provider billing periods sort by `updatedAt`, filter by `periodStart`) read the whole
   * partition and rely on `matches`.
   */
  readonly windowed?: (metric: string) => boolean;
}

function readMetricWindow(
  input: MetricIndexPageInput,
  metric: string,
  startKey: MetricIndexPosition["key"],
  limit: number,
) {
  const windowed = input.windowed?.(metric) ?? true;
  return apiPersistence.find(input.database, "usage", {
    ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
    ExpressionAttributeValues: {
      ":lower": windowed && input.since ? key(input.since) : INDEX_FLOOR,
      ":pk": metricIndexPartition(input.environmentId, metric),
      ":upper": windowed && input.until ? key(input.until) : INDEX_CEILING,
    },
    IndexName: "gsi2",
    KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
    Limit: limit,
    ScanIndexForward: false,
  });
}

type MetricRead = Promise<
  { readonly page: Awaited<ReturnType<typeof readMetricWindow>> } | { readonly error: unknown }
>;

/**
 * One page of the metrics' records in `[since, until)`, newest first within each metric. When it
 * starts a metric, the page also reads up to READ_AHEAD_LIMIT records of each of the next
 * METRIC_READ_AHEAD - 1 metrics, so a page spanning sparse metrics costs about one round trip per
 * read-ahead window; while it continues a metric known to have more records it reads nothing
 * ahead. A read-ahead result is kept until the page reaches its metric, so a page discards at
 * most the read-aheads still pending when it fills. A full page stops at its last record and
 * resumes right after it; a position past the last metric ends the list.
 */
export async function readMetricIndexPage(input: MetricIndexPageInput): Promise<{
  readonly items: readonly PlatformRecord[];
  readonly next?: MetricIndexPosition;
}> {
  const metrics = [...new Set(input.metrics)].toSorted();
  let index = input.start ? metrics.findIndex((metric) => metric >= input.start!.metric) : 0;
  if (index < 0) return { items: [] };
  let startKey = input.start?.metric === metrics[index] ? input.start?.key : undefined;
  const items: PlatformRecord[] = [];
  const position = (resumeKey: MetricIndexPosition["key"]): MetricIndexPosition => ({
    ...(resumeKey ? { key: resumeKey } : {}),
    metric: metrics[index]!,
    metrics: metrics.slice(index),
  });
  // Reads in flight by metric index. Each settles to a value, so a read-ahead left pending when
  // the page fills cannot surface as an unhandled rejection.
  const reads = new Map<number, MetricRead>();
  let queries = 0;
  const read = (at: number, from: MetricIndexPosition["key"], limit: number) => {
    queries += 1;
    reads.set(
      at,
      readMetricWindow(input, metrics[at]!, from, limit).then(
        (page) => ({ page }),
        (error: unknown) => ({ error }),
      ),
    );
  };
  while (index < metrics.length && items.length < input.limit) {
    const remaining = input.limit - items.length;
    if (!reads.has(index)) {
      if (queries >= MAX_INDEX_QUERIES) break;
      read(index, startKey, remaining);
    }
    if (startKey === undefined) {
      const end = Math.min(metrics.length, index + METRIC_READ_AHEAD);
      for (let ahead = index + 1; ahead < end && queries < MAX_INDEX_QUERIES; ahead += 1) {
        if (!reads.has(ahead)) read(ahead, undefined, Math.min(remaining, READ_AHEAD_LIMIT));
      }
    }
    const result = await reads.get(index)!;
    reads.delete(index);
    if ("error" in result) throw result.error;
    for (const record of result.page.items) {
      if (!input.matches(record)) continue;
      items.push(record);
      if (items.length === input.limit) return { items, next: position(indexKeyOf(record)) };
    }
    if (result.page.lastEvaluatedKey) {
      // The metric has more records in the window: continue it before moving on.
      startKey = indexKeyOf(result.page.lastEvaluatedKey);
      continue;
    }
    index += 1;
    startKey = undefined;
  }
  return index < metrics.length ? { items, next: position(startKey) } : { items };
}
