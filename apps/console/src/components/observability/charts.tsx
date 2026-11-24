import { useMemo, type ReactNode } from "react";
import { EvilAreaChart } from "../../evilcharts/charts/recharts-area-chart.tsx";
import { EvilBarChart } from "../../evilcharts/charts/recharts-bar-chart.tsx";
import { EvilLineChart } from "../../evilcharts/charts/recharts-line-chart.tsx";
import type { ChartConfig } from "../../evilcharts/ui/recharts-chart.tsx";
import { formatUsdTick, valueAxis, type AxisUnit } from "../../observability/axis.ts";
import {
  formatBucket,
  formatCompact,
  formatDurationMs,
  formatExact,
  formatUsdMicros,
} from "../../observability/format.ts";
import type { MetricInterval } from "../../observability/range.ts";
import { groupedRows, type MetricGroup, type TraceBucket } from "../../observability/series.ts";

/** Fixed height; the container's aspect ratio is ignored once both dimensions are set. */
const CHART_CLASS = "h-64 w-full";

type Colors = NonNullable<ChartConfig[string]["colors"]>;

/** Tailwind 600 (light) and 400 (dark) shades. */
const SERIES_COLORS = {
  cost: { dark: ["#fbbf24"], light: ["#d97706"] },
  errors: { dark: ["#f87171"], light: ["#dc2626"] },
  p50: { dark: ["#a78bfa"], light: ["#7c3aed"] },
  p95: { dark: ["#f472b6"], light: ["#db2777"] },
  tokens: { dark: ["#34d399"], light: ["#059669"] },
  traces: { dark: ["#38bdf8"], light: ["#0284c7"] },
} as const satisfies Readonly<Record<string, Colors>>;

/** Categorical palette for grouped series, cycled when there are more groups than colors. */
const GROUP_COLORS: readonly Colors[] = [
  { dark: ["#60a5fa"], light: ["#2563eb"] },
  { dark: ["#34d399"], light: ["#059669"] },
  { dark: ["#fbbf24"], light: ["#d97706"] },
  { dark: ["#a78bfa"], light: ["#7c3aed"] },
  { dark: ["#fb7185"], light: ["#e11d48"] },
  { dark: ["#22d3ee"], light: ["#0891b2"] },
  { dark: ["#a3e635"], light: ["#65a30d"] },
  { dark: ["#fb923c"], light: ["#ea580c"] },
  { dark: ["#e879f9"], light: ["#c026d3"] },
  { dark: ["#2dd4bf"], light: ["#0d9488"] },
];
const UNATTRIBUTED_COLORS: Colors = { dark: ["#71717a"], light: ["#a1a1aa"] };

/** A group's series colors; tables use them as legend swatches. */
export function groupColors(group: { readonly groupValue: string | null }, index: number) {
  return group.groupValue === null
    ? UNATTRIBUTED_COLORS
    : GROUP_COLORS[index % GROUP_COLORS.length]!;
}

export type ValueFormat = "count" | "duration" | "usd";

const MICROS_PER_USD = 1_000_000;
const VALUE_UNITS: Readonly<Record<ValueFormat, AxisUnit>> = {
  count: { integer: true, kind: "number" },
  duration: { kind: "duration" },
  usd: { integer: true, kind: "number", perUnit: 1 / MICROS_PER_USD },
};
const TOOLTIP_FORMAT: Readonly<Record<ValueFormat, (value: number) => string>> = {
  count: formatExact,
  duration: formatDurationMs,
  usd: formatUsdMicros,
};

interface SeriesChartProps {
  readonly interval: MetricInterval;
  readonly rows: TraceBucket[];
}

/** The largest value, ignoring gaps; zero when there is none. */
export function maxValue(values: Iterable<number | null | undefined>) {
  let max = 0;
  for (const value of values) if (typeof value === "number" && value > max) max = value;
  return max;
}

/**
 * Value-axis props: fixed ticks from zero to a nice step above `max`, labeled with the precision
 * the step needs, so no two ticks read the same.
 */
function valueAxisProps(format: ValueFormat, max: number) {
  const { domain, step, ticks } = valueAxis(max, VALUE_UNITS[format]);
  const tickFormatter =
    format === "usd"
      ? (value: number) => formatUsdTick(value / MICROS_PER_USD, step)
      : format === "count"
        ? formatCompact
        : formatDurationMs;
  return { domain, interval: 0, tickFormatter, ticks };
}

/**
 * A chart with its time-axis zone underneath. Buckets are labeled in UTC (see `formatBucket`),
 * so the zone is named once per chart instead of on every tick.
 */
export function TimeSeriesFrame({
  children,
  interval,
}: Readonly<{ children: ReactNode; interval: MetricInterval }>) {
  return (
    <figure className="flex flex-col gap-1">
      {children}
      <figcaption className="text-right text-xs/5 text-muted-foreground">
        {interval === "day" ? "Dates in UTC" : "Times in UTC"}
      </figcaption>
    </figure>
  );
}

/** Hourly series longer than a day carry the date in their axis labels. */
function bucketAxis(interval: MetricInterval, bucketCount: number) {
  const axisDetail = interval === "hour" && bucketCount > 24 ? "dated-axis" : "axis";
  return {
    axis: (value: string) => formatBucket(value, interval, axisDetail),
    tooltip: (label: unknown) => formatBucket(String(label), interval, "full"),
  };
}

const VOLUME_CONFIG = {
  errors: { colors: SERIES_COLORS.errors, label: "Errors" },
  traces: { colors: SERIES_COLORS.traces, label: "Traces" },
} satisfies ChartConfig;

/** Finalized traces and errored traces per bucket. */
export function TraceVolumeChart({ interval, rows }: SeriesChartProps) {
  const labels = bucketAxis(interval, rows.length);
  return (
    <TimeSeriesFrame interval={interval}>
      <EvilBarChart className={CHART_CLASS} config={VOLUME_CONFIG} data={rows}>
        <EvilBarChart.Grid />
        <EvilBarChart.XAxis dataKey="bucket" tickFormatter={labels.axis} />
        <EvilBarChart.YAxis {...valueAxisProps("count", maxValue(rows.map((row) => row.traces)))} />
        <EvilBarChart.Tooltip
          labelFormatter={labels.tooltip}
          valueFormatter={TOOLTIP_FORMAT.count}
        />
        <EvilBarChart.Legend />
        <EvilBarChart.Bar dataKey="traces" />
        <EvilBarChart.Bar dataKey="errors" />
      </EvilBarChart>
    </TimeSeriesFrame>
  );
}

const LATENCY_CONFIG = {
  p50: { colors: SERIES_COLORS.p50, label: "p50" },
  p95: { colors: SERIES_COLORS.p95, label: "p95" },
} satisfies ChartConfig;

/** Trace duration percentiles; buckets without finished traces stay gaps, not zeros. */
export function TraceLatencyChart({ interval, rows }: SeriesChartProps) {
  const labels = bucketAxis(interval, rows.length);
  return (
    <TimeSeriesFrame interval={interval}>
      <EvilLineChart className={CHART_CLASS} config={LATENCY_CONFIG} data={rows}>
        <EvilLineChart.Grid />
        <EvilLineChart.XAxis dataKey="bucket" tickFormatter={labels.axis} />
        <EvilLineChart.YAxis
          {...valueAxisProps("duration", maxValue(rows.flatMap((row) => [row.p50, row.p95])))}
        />
        <EvilLineChart.Tooltip
          labelFormatter={labels.tooltip}
          valueFormatter={TOOLTIP_FORMAT.duration}
        />
        <EvilLineChart.Legend />
        {/* Dots keep isolated buckets visible: a lone percentile between gaps draws no segment. */}
        <EvilLineChart.Line dataKey="p50" strokeWidth={1.5}>
          <EvilLineChart.Dot />
        </EvilLineChart.Line>
        <EvilLineChart.Line dataKey="p95" strokeWidth={1.5}>
          <EvilLineChart.Dot />
        </EvilLineChart.Line>
      </EvilLineChart>
    </TimeSeriesFrame>
  );
}

const TOKEN_CONFIG = {
  tokens: { colors: SERIES_COLORS.tokens, label: "Tokens" },
} satisfies ChartConfig;
const COST_CONFIG = {
  costUsdMicros: { colors: SERIES_COLORS.cost, label: "Cost" },
} satisfies ChartConfig;

export function TraceTokensChart({ interval, rows }: SeriesChartProps) {
  const labels = bucketAxis(interval, rows.length);
  return (
    <TimeSeriesFrame interval={interval}>
      <EvilAreaChart className={CHART_CLASS} config={TOKEN_CONFIG} data={rows}>
        <EvilAreaChart.Grid />
        <EvilAreaChart.XAxis dataKey="bucket" tickFormatter={labels.axis} />
        <EvilAreaChart.YAxis
          {...valueAxisProps("count", maxValue(rows.map((row) => row.tokens)))}
        />
        <EvilAreaChart.Tooltip
          labelFormatter={labels.tooltip}
          valueFormatter={TOOLTIP_FORMAT.count}
        />
        <EvilAreaChart.Area dataKey="tokens" strokeVariant="solid" strokeWidth={1.5} />
      </EvilAreaChart>
    </TimeSeriesFrame>
  );
}

export function TraceCostChart({ interval, rows }: SeriesChartProps) {
  const labels = bucketAxis(interval, rows.length);
  return (
    <TimeSeriesFrame interval={interval}>
      <EvilAreaChart className={CHART_CLASS} config={COST_CONFIG} data={rows}>
        <EvilAreaChart.Grid />
        <EvilAreaChart.XAxis dataKey="bucket" tickFormatter={labels.axis} />
        <EvilAreaChart.YAxis
          {...valueAxisProps("usd", maxValue(rows.map((row) => row.costUsdMicros)))}
        />
        <EvilAreaChart.Tooltip
          labelFormatter={labels.tooltip}
          valueFormatter={TOOLTIP_FORMAT.usd}
        />
        <EvilAreaChart.Area dataKey="costUsdMicros" strokeVariant="solid" strokeWidth={1.5} />
      </EvilAreaChart>
    </TimeSeriesFrame>
  );
}

interface GroupedChartProps {
  readonly buckets: readonly string[];
  readonly format: ValueFormat;
  readonly groups: readonly MetricGroup<unknown>[];
  readonly interval: MetricInterval;
  /** Stacked bars for additive metrics; lines for latency, which does not add up. */
  readonly kind: "bars" | "lines";
  readonly values: readonly (readonly (number | null)[])[];
}

/** One metric of a grouped series, one color per group in rank order. */
export function GroupedMetricChart({
  buckets,
  format,
  groups,
  interval,
  kind,
  values,
}: GroupedChartProps) {
  const labels = bucketAxis(interval, buckets.length);
  const rows = useMemo(() => groupedRows(buckets, groups, values), [buckets, groups, values]);
  const config = useMemo(() => {
    const entries: ChartConfig = {};
    groups.forEach((group, index) => {
      entries[group.key] = { colors: groupColors(group, index), label: group.label };
    });
    return entries;
  }, [groups]);
  // Stacked bars reach the sum of a bucket's groups.
  const stackedMax = useMemo(
    () =>
      maxValue(
        buckets.map((_, index) => values.reduce((sum, series) => sum + (series[index] ?? 0), 0)),
      ),
    [buckets, values],
  );
  if (kind === "lines") {
    return (
      <TimeSeriesFrame interval={interval}>
        <EvilLineChart className={CHART_CLASS} config={config} data={rows}>
          <EvilLineChart.Grid />
          <EvilLineChart.XAxis dataKey="bucket" tickFormatter={labels.axis} />
          <EvilLineChart.YAxis {...valueAxisProps(format, maxValue(values.flat()))} />
          <EvilLineChart.Tooltip
            labelFormatter={labels.tooltip}
            valueFormatter={TOOLTIP_FORMAT[format]}
          />
          {groups.map((group) => (
            <EvilLineChart.Line dataKey={group.key} key={group.key} strokeWidth={1.5}>
              <EvilLineChart.Dot />
            </EvilLineChart.Line>
          ))}
        </EvilLineChart>
      </TimeSeriesFrame>
    );
  }
  return (
    <TimeSeriesFrame interval={interval}>
      <EvilBarChart className={CHART_CLASS} config={config} data={rows} stackType="stacked">
        <EvilBarChart.Grid />
        <EvilBarChart.XAxis dataKey="bucket" tickFormatter={labels.axis} />
        <EvilBarChart.YAxis {...valueAxisProps(format, stackedMax)} />
        <EvilBarChart.Tooltip
          labelFormatter={labels.tooltip}
          valueFormatter={TOOLTIP_FORMAT[format]}
        />
        {groups.map((group) => (
          <EvilBarChart.Bar dataKey={group.key} key={group.key} />
        ))}
      </EvilBarChart>
    </TimeSeriesFrame>
  );
}
