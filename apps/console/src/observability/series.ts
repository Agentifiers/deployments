import type {
  ObservabilityMetricPoint,
  ObservabilityMetricSeriesResponse,
  ObservabilityModelMetricPoint,
} from "@deployments-ai/api-contract/observability";

type MetricSeriesResponse = typeof ObservabilityMetricSeriesResponse.Type;
type MetricPointUnion = MetricSeriesResponse["items"][number];
type TracePoint = typeof ObservabilityMetricPoint.Type;
type ModelPoint = typeof ObservabilityModelMetricPoint.Type;

/**
 * One bucket of the ungrouped trace series. Counts are zero-filled; percentiles stay absent. A
 * type alias, not an interface, so chart components accept it as a `Record<string, unknown>` row.
 */
export type TraceBucket = {
  readonly bucket: string;
  readonly costUsdMicros: number;
  readonly errors: number;
  readonly p50?: number;
  readonly p95?: number;
  readonly tokens: number;
  readonly traces: number;
};

export interface TraceTotals {
  readonly costUsdMicros: number;
  readonly errors: number;
  readonly tokens: number;
  readonly traces: number;
}

export type TraceMetric = "costUsdMicros" | "errors" | "p95" | "tokens" | "traces";
export type ModelMetric = "costUsdMicros" | "errors" | "invocations" | "p95" | "tokens";

export interface TraceGroupTotals extends TraceTotals {
  readonly source: "traces";
}

interface ModelGroupTotals {
  readonly cachedTokens: number;
  readonly costUsdMicros: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly invocations: number;
  readonly outputTokens: number;
  readonly source: "model-invocations";
  readonly tokens: number;
}

/**
 * One group of a grouped series. `key` is a synthetic CSS-safe series key (`s0`…): chart colors
 * become custom properties named after it, and group values such as `openai/gpt-5` are not valid
 * there. `groupValue` is null for facts that lack the dimension (for example traces finalized
 * before agent attribution existed).
 */
export interface MetricGroup<Totals> {
  readonly groupValue: string | null;
  readonly key: string;
  readonly label: string;
  readonly totals: Totals;
}

/**
 * A grouped series as a bucket × group matrix: `values[metric][group][bucket]`. Counts, tokens,
 * and cost are zero-filled; latency stays null where a group had no facts in the bucket.
 */
interface GroupedSeries<Metric extends string, Totals> {
  readonly buckets: readonly string[];
  readonly groups: readonly MetricGroup<Totals>[];
  readonly values: Readonly<Record<Metric, readonly (readonly (number | null)[])[]>>;
}

export type GroupedMetrics =
  | ({ readonly source: "traces" } & GroupedSeries<TraceMetric, TraceGroupTotals>)
  | ({ readonly source: "model-invocations" } & GroupedSeries<ModelMetric, ModelGroupTotals>);

function isTracePoint(point: MetricPointUnion): point is TracePoint {
  return "trace_count" in point;
}

/** The ungrouped trace series over every bucket of the window, zero-filled. */
export function traceBuckets(
  items: readonly MetricPointUnion[],
  buckets: readonly string[],
): TraceBucket[] {
  const byBucket = new Map<string, TracePoint>();
  for (const point of items) {
    if (isTracePoint(point)) byBucket.set(new Date(point.bucket).toISOString(), point);
  }
  return buckets.map((bucket) => {
    const point = byBucket.get(bucket);
    if (!point) return { bucket, costUsdMicros: 0, errors: 0, tokens: 0, traces: 0 };
    return {
      bucket,
      costUsdMicros: point.total_cost_usd_micros,
      errors: point.error_count,
      tokens: point.total_tokens,
      traces: point.trace_count,
      ...(point.p50_duration_ms === undefined ? {} : { p50: point.p50_duration_ms }),
      ...(point.p95_duration_ms === undefined ? {} : { p95: point.p95_duration_ms }),
    };
  });
}

/** Window totals of the ungrouped trace series; percentiles do not sum, so they are omitted. */
export function traceTotals(items: readonly MetricPointUnion[]): TraceTotals {
  let costUsdMicros = 0;
  let errors = 0;
  let tokens = 0;
  let traces = 0;
  for (const point of items) {
    if (!isTracePoint(point)) continue;
    costUsdMicros += point.total_cost_usd_micros;
    errors += point.error_count;
    tokens += point.total_tokens;
    traces += point.trace_count;
  }
  return { costUsdMicros, errors, tokens, traces };
}

interface GroupAccumulator<Point> {
  readonly groupValue: string | null;
  readonly points: Map<string, Point>;
  volume: number;
}

/**
 * Collects points by group, ranked like the API ranks them: by total volume descending, then by
 * group value (the API ranks facts lacking the dimension as the empty string, so first on ties).
 */
function rankGroups<
  Point extends { readonly bucket: string; readonly group_value?: string | undefined },
>(points: readonly Point[], volume: (point: Point) => number): GroupAccumulator<Point>[] {
  const groups = new Map<string | null, GroupAccumulator<Point>>();
  for (const point of points) {
    const groupValue = point.group_value ?? null;
    let group = groups.get(groupValue);
    if (!group) {
      group = { groupValue, points: new Map(), volume: 0 };
      groups.set(groupValue, group);
    }
    group.points.set(new Date(point.bucket).toISOString(), point);
    group.volume += volume(point);
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.volume - left.volume || (left.groupValue ?? "").localeCompare(right.groupValue ?? ""),
  );
}

/** Reads one metric from a point; `empty` fills buckets where the group had no facts. */
interface MetricReader<Point> {
  readonly empty: 0 | null;
  readonly read: (point: Point) => number | undefined;
}

function matrix<Point, Metric extends string>(
  ranked: readonly GroupAccumulator<Point>[],
  buckets: readonly string[],
  metrics: Readonly<Record<Metric, MetricReader<Point>>>,
): Record<Metric, (number | null)[][]> {
  const values = {} as Record<Metric, (number | null)[][]>;
  for (const metric of Object.keys(metrics) as Metric[]) {
    const { empty, read } = metrics[metric];
    values[metric] = ranked.map((group) =>
      buckets.map((bucket) => {
        const point = group.points.get(bucket);
        return point ? (read(point) ?? empty) : empty;
      }),
    );
  }
  return values;
}

const TRACE_METRICS: Readonly<Record<TraceMetric, MetricReader<TracePoint>>> = {
  costUsdMicros: { empty: 0, read: (point) => point.total_cost_usd_micros },
  errors: { empty: 0, read: (point) => point.error_count },
  p95: { empty: null, read: (point) => point.p95_duration_ms },
  tokens: { empty: 0, read: (point) => point.total_tokens },
  traces: { empty: 0, read: (point) => point.trace_count },
};

const MODEL_METRICS: Readonly<Record<ModelMetric, MetricReader<ModelPoint>>> = {
  costUsdMicros: { empty: 0, read: (point) => point.total_cost_usd_micros },
  errors: { empty: 0, read: (point) => point.error_count },
  invocations: { empty: 0, read: (point) => point.invocation_count },
  p95: { empty: null, read: (point) => point.p95_latency_ms },
  tokens: { empty: 0, read: (point) => point.total_tokens },
};

function sum<Point>(points: Iterable<Point>, read: (point: Point) => number) {
  let total = 0;
  for (const point of points) total += read(point);
  return total;
}

/**
 * Turns a grouped metrics response into a bucket × group matrix with CSS-safe series keys and the
 * caller's labels. `source` decides the point shape: agent dimensions aggregate traces, `model`
 * and `provider` aggregate model invocations.
 */
export function groupedMetrics(
  response: Pick<MetricSeriesResponse, "items" | "source">,
  buckets: readonly string[],
  label: (groupValue: string | null) => string,
): GroupedMetrics {
  if (response.source === "traces") {
    const ranked = rankGroups(response.items.filter(isTracePoint), (point) => point.trace_count);
    return {
      buckets,
      groups: ranked.map((group, index) => {
        const points = [...group.points.values()];
        return {
          groupValue: group.groupValue,
          key: `s${index}`,
          label: label(group.groupValue),
          totals: {
            costUsdMicros: sum(points, (point) => point.total_cost_usd_micros),
            errors: sum(points, (point) => point.error_count),
            source: "traces",
            tokens: sum(points, (point) => point.total_tokens),
            traces: group.volume,
          },
        };
      }),
      source: "traces",
      values: matrix(ranked, buckets, TRACE_METRICS),
    };
  }
  const ranked = rankGroups(
    response.items.filter((point): point is ModelPoint => !isTracePoint(point)),
    (point) => point.invocation_count,
  );
  return {
    buckets,
    groups: ranked.map((group, index) => {
      const points = [...group.points.values()];
      return {
        groupValue: group.groupValue,
        key: `s${index}`,
        label: label(group.groupValue),
        totals: {
          cachedTokens: sum(points, (point) => point.cached_tokens),
          costUsdMicros: sum(points, (point) => point.total_cost_usd_micros),
          errors: sum(points, (point) => point.error_count),
          inputTokens: sum(points, (point) => point.input_tokens),
          invocations: group.volume,
          outputTokens: sum(points, (point) => point.output_tokens),
          source: "model-invocations",
          tokens: sum(points, (point) => point.total_tokens),
        },
      };
    }),
    source: "model-invocations",
    values: matrix(ranked, buckets, MODEL_METRICS),
  };
}

/** Chart rows for one metric: `{ bucket, s0, s1, … }`, omitting null latency cells. */
export function groupedRows(
  buckets: readonly string[],
  groups: readonly { readonly key: string }[],
  values: readonly (readonly (number | null)[])[],
): Record<string, number | string>[] {
  return buckets.map((bucket, bucketIndex) => {
    const row: Record<string, number | string> = { bucket };
    groups.forEach((group, groupIndex) => {
      const value = values[groupIndex]?.[bucketIndex];
      if (value !== null && value !== undefined) row[group.key] = value;
    });
    return row;
  });
}
