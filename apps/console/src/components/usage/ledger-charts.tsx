import { useMemo, type ReactNode } from "react";
import { EvilAreaChart } from "../../evilcharts/charts/recharts-area-chart.tsx";
import { EvilBarChart } from "../../evilcharts/charts/recharts-bar-chart.tsx";
import { EvilLineChart } from "../../evilcharts/charts/recharts-line-chart.tsx";
import type { ChartConfig } from "../../evilcharts/ui/recharts-chart.tsx";
import { formatUsdTick, valueAxis, type AxisUnit } from "../../observability/axis.ts";
import { formatBucket, formatExact } from "../../observability/format.ts";
import type { MetricInterval } from "../../observability/range.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { seriesFormat, seriesLabel, type UsageFormat } from "../../usage/catalog.ts";
import { exportValue, formatUsage } from "../../usage/export.ts";
import type { LedgerSeries } from "../../usage/ledger.ts";
import { groupColors, maxValue, TimeSeriesFrame } from "../observability/charts.tsx";

const CHART_CLASS = "h-64 w-full";
const NANODOLLARS_PER_USD = 1_000_000_000;
const MS_PER_HOUR = 3_600_000;
const MIB_PER_GIB = 1_024;
/** Raw ledger units against the units `formatUsage` shows, for evenly stepped axis ticks. */
const AXIS_UNITS: Readonly<Record<UsageFormat, AxisUnit>> = {
  bytes: { integer: true, kind: "number" },
  count: { integer: true, kind: "number" },
  duration: { kind: "duration" },
  "gib-hours": { kind: "number", perUnit: 1 / (MIB_PER_GIB * MS_PER_HOUR) },
  usd: { integer: true, kind: "number", perUnit: 1 / NANODOLLARS_PER_USD },
  "vcpu-hours": { kind: "number", perUnit: 1 / MS_PER_HOUR },
};

/** A card for ledger figures: the ledger counterpart of the analytics `ChartPanel`. */
export function LedgerPanel({
  children,
  description,
  title,
}: Readonly<{ children: ReactNode; description?: ReactNode; title: ReactNode }>) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * Ledger series over the window's buckets. `bars` stack additive series (costs, inbound and
 * outbound mail); `lines` keep overlapping ones apart (token types, where cached input is part of
 * input); a single series draws as an area.
 */
export function LedgerSeriesChart({
  buckets,
  interval,
  kind,
  series,
}: Readonly<{
  buckets: readonly string[];
  interval: MetricInterval;
  kind: "area" | "bars" | "lines";
  series: readonly LedgerSeries[];
}>) {
  const format = seriesFormat(series[0]!);
  // Synthetic keys: chart colors become CSS custom properties named after them.
  const rows = useMemo(
    () =>
      buckets.map((bucket, index) => {
        const row: Record<string, number | string> = { bucket };
        series.forEach((entry, position) => {
          row[`s${position}`] = entry.values[index] ?? 0;
        });
        return row;
      }),
    [buckets, series],
  );
  const config = useMemo(() => {
    const entries: ChartConfig = {};
    series.forEach((entry, position) => {
      entries[`s${position}`] = {
        colors: groupColors({ groupValue: entry.id }, position),
        label: seriesLabel(entry),
      };
    });
    return entries;
  }, [series]);
  const axisDetail = interval === "hour" && buckets.length > 24 ? "dated-axis" : "axis";
  const axis = (value: string) => formatBucket(value, interval, axisDetail);
  const tooltip = (label: unknown) => formatBucket(String(label), interval, "full");
  // Stacked bars reach the sum of a bucket's series; lines and areas their largest value.
  const max = maxValue(
    kind === "bars"
      ? buckets.map((_, index) =>
          series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0),
        )
      : series.flatMap((entry) => entry.values),
  );
  const { domain, step, ticks } = valueAxis(max, AXIS_UNITS[format]);
  const yAxis = {
    domain,
    interval: 0,
    tickFormatter: (value: number) =>
      format === "usd"
        ? formatUsdTick(value / NANODOLLARS_PER_USD, step)
        : formatUsage(value, format),
    ticks,
  };
  const exact = (value: number) => {
    if (format === "usd") return `$${exportValue(series[0]!, value)}`;
    return format === "count" ? formatExact(value) : formatUsage(value, format);
  };
  const keys = series.map((_, position) => `s${position}`);

  if (kind === "lines") {
    return (
      <TimeSeriesFrame interval={interval}>
        <EvilLineChart className={CHART_CLASS} config={config} data={rows}>
          <EvilLineChart.Grid />
          <EvilLineChart.XAxis dataKey="bucket" tickFormatter={axis} />
          <EvilLineChart.YAxis {...yAxis} />
          <EvilLineChart.Tooltip labelFormatter={tooltip} valueFormatter={exact} />
          <EvilLineChart.Legend />
          {keys.map((key) => (
            <EvilLineChart.Line dataKey={key} key={key} strokeWidth={1.5} />
          ))}
        </EvilLineChart>
      </TimeSeriesFrame>
    );
  }
  if (kind === "bars") {
    return (
      <TimeSeriesFrame interval={interval}>
        <EvilBarChart className={CHART_CLASS} config={config} data={rows} stackType="stacked">
          <EvilBarChart.Grid />
          <EvilBarChart.XAxis dataKey="bucket" tickFormatter={axis} />
          <EvilBarChart.YAxis {...yAxis} />
          <EvilBarChart.Tooltip labelFormatter={tooltip} valueFormatter={exact} />
          <EvilBarChart.Legend />
          {keys.map((key) => (
            <EvilBarChart.Bar dataKey={key} key={key} />
          ))}
        </EvilBarChart>
      </TimeSeriesFrame>
    );
  }
  return (
    <TimeSeriesFrame interval={interval}>
      <EvilAreaChart className={CHART_CLASS} config={config} data={rows}>
        <EvilAreaChart.Grid />
        <EvilAreaChart.XAxis dataKey="bucket" tickFormatter={axis} />
        <EvilAreaChart.YAxis {...yAxis} />
        <EvilAreaChart.Tooltip labelFormatter={tooltip} valueFormatter={exact} />
        {keys.map((key) => (
          <EvilAreaChart.Area dataKey={key} key={key} strokeVariant="solid" strokeWidth={1.5} />
        ))}
      </EvilAreaChart>
    </TimeSeriesFrame>
  );
}
