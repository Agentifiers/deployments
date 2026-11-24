import { USAGE_SUMMARY_INTERVALS, USAGE_SUMMARY_MAX_BUCKETS } from "@deployments-ai/api-contract";
import {
  apiPersistence,
  attributedCounterKeyParts,
  key,
  type Attribution,
  type AttributionTarget,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { canonicalTimestamp, OperationalReadError } from "./operational-read-input.ts";
import {
  discoverMetrics,
  isCostUsageMetric,
  metricIndexPartition,
  type MetricEntry,
} from "./usage-metric-index.ts";
import {
  intervalMilliseconds,
  reconcileLedger,
  tallyLedger,
  type LedgerSummary,
  type SummaryInterval,
  type SummaryWindow,
  type TallyCell,
} from "./usage-summary.ts";

/** Reads in flight at once across a summary's metrics and time slices. */
const READ_CONCURRENCY = 16;
/** A token metric's window is read as slices of at most a day, all in parallel. */
const SLICE_MS = 86_400_000;

/** The `since`, `until`, and `interval` of a summary request, on interval boundaries. */
export function summaryWindow(query: Readonly<Record<string, unknown>>): SummaryWindow {
  const since = canonicalTimestamp(query.since, "since");
  const until = canonicalTimestamp(query.until, "until");
  if (!since || !until) {
    throw new OperationalReadError(400, "invalid_query", "since and until are required.");
  }
  const interval = (query.interval ?? "hour") as SummaryInterval;
  if (!USAGE_SUMMARY_INTERVALS.includes(interval)) {
    throw new OperationalReadError(400, "invalid_query", "interval must be hour or day.");
  }
  const width = intervalMilliseconds(interval);
  const start = Date.parse(since);
  const end = Date.parse(until);
  if (start % width !== 0 || end % width !== 0) {
    throw new OperationalReadError(
      400,
      "invalid_query",
      `since and until must fall on UTC ${interval} boundaries.`,
    );
  }
  if (start >= end) {
    throw new OperationalReadError(400, "invalid_time_range", "since must be earlier than until.");
  }
  if ((end - start) / width > USAGE_SUMMARY_MAX_BUCKETS[interval]) {
    throw new OperationalReadError(
      400,
      "invalid_time_range",
      `A summary holds at most ${USAGE_SUMMARY_MAX_BUCKETS[interval]} ${interval} buckets.`,
    );
  }
  return { interval, since, until };
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/** The query parameter that narrows a summary to one id of each attribution. */
const SUMMARY_ATTRIBUTION_PARAMETERS = {
  agent: "agentDefinitionId",
  workspace: "workspaceId",
} as const satisfies Record<Attribution, string>;

/**
 * The optional attribution filter of a summary request: its `agentDefinitionId` or its
 * `workspaceId`. Attributions are counted separately, so a request may name at most one.
 */
export function summaryAttribution(
  query: Readonly<Record<string, unknown>>,
): AttributionTarget | undefined {
  const named = Object.entries(SUMMARY_ATTRIBUTION_PARAMETERS).filter(
    ([, parameter]) => query[parameter] !== undefined,
  );
  if (named.length > 1) {
    throw new OperationalReadError(
      400,
      "invalid_query",
      `Name at most one of ${Object.values(SUMMARY_ATTRIBUTION_PARAMETERS).join(", ")}.`,
    );
  }
  const [entry] = named;
  if (!entry) return undefined;
  const [attribution, parameter] = entry;
  const attributionId = query[parameter];
  if (typeof attributionId !== "string" || !ULID.test(attributionId)) {
    throw new OperationalReadError(400, "invalid_query", `${parameter} must be a ULID.`);
  }
  return { attribution: attribution as Attribution, attributionId };
}

type ReadTask = () => Promise<readonly TallyCell[]>;

/** Every page of one query, reduced to tally cells as it arrives. */
function queryTask(
  database: DynamoDatabaseService,
  input: Parameters<DynamoDatabaseService["queryRecords"]>[1],
): ReadTask {
  return async () => {
    const records: PlatformRecord[] = [];
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    do {
      const page = await apiPersistence.find(database, "usage", {
        ...input,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      });
      records.push(...page.items);
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return tallyLedger(records.map((record) => ({ data: record.data, type: record.itemType })));
  };
}

/** One metric's records of one base type in the window: `<prefix…>#<metric>#<bucket>…`. */
function baseRange(
  database: DynamoDatabaseService,
  partition: string,
  prefix: readonly string[],
  metric: string,
  window: SummaryWindow,
): ReadTask {
  return queryTask(database, {
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: {
      ":lower": key(...prefix, metric, window.since),
      ":pk": partition,
      ":upper": key(...prefix, metric, window.until),
    },
    KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
  });
}

/**
 * One metric index partition over the window, as slices of at most `sliceMs` read in parallel.
 * Slices are half-open although `BETWEEN` is inclusive: an index sort key is `<time>#<identity>`,
 * so one at a slice boundary sorts after the bare `:upper` time and within the next slice.
 */
function indexSlices(
  database: DynamoDatabaseService,
  environmentId: string,
  metric: string,
  window: SummaryWindow,
  sliceMs = SLICE_MS,
): ReadTask[] {
  const tasks: ReadTask[] = [];
  const end = Date.parse(window.until);
  for (let start = Date.parse(window.since); start < end; start += sliceMs) {
    tasks.push(
      queryTask(database, {
        ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
        ExpressionAttributeValues: {
          ":lower": key(new Date(start).toISOString()),
          ":pk": metricIndexPartition(environmentId, metric),
          ":upper": key(new Date(Math.min(start + sliceMs, end)).toISOString()),
        },
        IndexName: "gsi2",
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
      }),
    );
  }
  return tasks;
}

async function runAll(tasks: readonly ReadTask[]): Promise<TallyCell[]> {
  const cells: TallyCell[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < tasks.length; index = next++) {
      cells.push(...(await tasks[index]!()));
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, tasks.length) }, worker));
  return cells;
}

/** Discovered metrics by name; a metric found as both counter and aggregate keeps the counter. */
function byMetric(entries: readonly MetricEntry[]) {
  const metrics = new Map<string, MetricEntry>();
  for (const entry of entries) if (!metrics.has(entry.metric)) metrics.set(entry.metric, entry);
  return [...metrics.values()];
}

/**
 * A usage or cost summary of one environment. Totals come from the hourly counters (and
 * aggregates), read as one key range per metric of the base partition. Token metrics are read
 * from the metric index instead, because their input, output, cached, and cache-write splits
 * exist only on meter events; their windows are split into day slices read in parallel. Other
 * metrics' meter events are not read: their counters already hold them once materialized.
 *
 * With an attribution (an `agentDefinitionId` or a `workspaceId`), the summary covers that
 * attribution's events only: its own hourly counters, which the materializer keeps with their
 * token splits, one key range per metric.
 */
export async function readUsageSummary(
  database: DynamoDatabaseService,
  scope: {
    readonly attribution?: AttributionTarget;
    readonly environmentId: string;
    readonly partition: string;
  },
  window: SummaryWindow,
  kind: "costs" | "usage",
): Promise<LedgerSummary> {
  const { attribution, environmentId, partition } = scope;
  const tasks = attribution
    ? await attributedTasks(database, partition, attribution, window, kind)
    : await environmentTasks(database, { environmentId, partition }, window, kind);
  const summary = reconcileLedger(await runAll(tasks), window);
  const seriesKind = kind === "costs" ? "cost" : "quantity";
  return {
    buckets: summary.buckets,
    series: summary.series.filter((series) => series.kind === seriesKind),
  };
}

async function attributedTasks(
  database: DynamoDatabaseService,
  partition: string,
  target: AttributionTarget,
  window: SummaryWindow,
  kind: "costs" | "usage",
): Promise<ReadTask[]> {
  const within = attributedCounterKeyParts(target);
  const prefix = ["ATTRIBUTED-USAGE-COUNTER-SHARD", ...within];
  const metrics = await discoverMetrics(
    database,
    partition,
    "attributed-usage-counter-shard",
    within,
  );
  return metrics
    .filter(({ metric }) => isCostUsageMetric(metric) === (kind === "costs"))
    .map(({ metric }) => baseRange(database, partition, prefix, metric, window));
}

async function environmentTasks(
  database: DynamoDatabaseService,
  environment: { readonly environmentId: string; readonly partition: string },
  window: SummaryWindow,
  kind: "costs" | "usage",
): Promise<ReadTask[]> {
  const { environmentId, partition } = environment;
  const [counters, aggregates, sources] = await Promise.all([
    discoverMetrics(database, partition, "usage-counter-shard"),
    discoverMetrics(database, partition, "usage-aggregate"),
    kind === "costs" ? discoverMetrics(database, partition, "cost-aggregate") : [],
  ]);
  const tasks: ReadTask[] = [];
  for (const { metric, unit } of byMetric([...counters, ...aggregates])) {
    if (isCostUsageMetric(metric) !== (kind === "costs")) continue;
    if (unit === "tokens") {
      tasks.push(...indexSlices(database, environmentId, metric, window));
    } else {
      tasks.push(
        baseRange(database, partition, ["USAGE-COUNTER-SHARD"], metric, window),
        baseRange(database, partition, ["USAGE-AGGREGATE"], metric, window),
      );
    }
  }
  if (kind === "usage") {
    // Inbox and storage usage carry no metric; the index files them under their type. They hold
    // one record per inbox or storage class and bucket, so each is one read.
    const whole = Date.parse(window.until) - Date.parse(window.since);
    tasks.push(
      ...indexSlices(database, environmentId, "inbox-usage", window, whole),
      ...indexSlices(database, environmentId, "storage-usage", window, whole),
    );
  }
  for (const { metric } of sources) {
    tasks.push(baseRange(database, partition, ["COST-AGGREGATE"], metric, window));
  }
  return tasks;
}
