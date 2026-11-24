import { useSuspenseQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { metricsQuery } from "../../data/observability-queries.ts";
import {
  formatCompact,
  formatExact,
  formatPercent,
  formatUsdMicros,
} from "../../observability/format.ts";
import type { MetricInterval, MetricSelection } from "../../observability/range.ts";
import type {
  GroupedMetrics,
  MetricGroup,
  ModelMetric,
  TraceMetric,
} from "../../observability/series.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import {
  GroupedMetricChart,
  groupColors,
  TraceCostChart,
  TraceLatencyChart,
  TraceTokensChart,
  TraceVolumeChart,
  type ValueFormat,
} from "./charts.tsx";
import { ChartPanel, StatTile } from "./panels.tsx";
import { GROUP_BY_LABELS } from "./selection-controls.tsx";
import { ToolTable } from "./tool-table.tsx";

const numberCell = "text-right tabular-nums";

function Swatch({ group, index }: Readonly<{ group: MetricGroup<unknown>; index: number }>) {
  const colors = groupColors(group, index);
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-[2px] bg-(--swatch-light) dark:bg-(--swatch-dark)"
      style={
        {
          "--swatch-dark": colors.dark?.[0],
          "--swatch-light": colors.light?.[0],
        } as CSSProperties
      }
    />
  );
}

interface GroupedChartSpec<Metric extends string> {
  readonly description: string;
  readonly format: ValueFormat;
  readonly kind: "bars" | "lines";
  readonly metric: Metric;
  readonly title: string;
}

const TRACE_GROUP_CHARTS: readonly GroupedChartSpec<TraceMetric>[] = [
  {
    description: "Finalized traces",
    format: "count",
    kind: "bars",
    metric: "traces",
    title: "Traces",
  },
  {
    description: "Errored traces",
    format: "count",
    kind: "bars",
    metric: "errors",
    title: "Errors",
  },
  {
    description: "Trace duration, p95",
    format: "duration",
    kind: "lines",
    metric: "p95",
    title: "Latency",
  },
  {
    description: "Tokens across each trace",
    format: "count",
    kind: "bars",
    metric: "tokens",
    title: "Tokens",
  },
  {
    description: "Model cost of finalized traces",
    format: "usd",
    kind: "bars",
    metric: "costUsdMicros",
    title: "Cost",
  },
];

const MODEL_GROUP_CHARTS: readonly GroupedChartSpec<ModelMetric>[] = [
  {
    description: "Model invocations",
    format: "count",
    kind: "bars",
    metric: "invocations",
    title: "Invocations",
  },
  {
    description: "Failed invocations",
    format: "count",
    kind: "bars",
    metric: "errors",
    title: "Errors",
  },
  {
    description: "Invocation latency, p95",
    format: "duration",
    kind: "lines",
    metric: "p95",
    title: "Latency",
  },
  {
    description: "Input, output, and cached tokens",
    format: "count",
    kind: "bars",
    metric: "tokens",
    title: "Tokens",
  },
  {
    description: "Model cost",
    format: "usd",
    kind: "bars",
    metric: "costUsdMicros",
    title: "Cost",
  },
];

function GroupedCharts({
  grouped,
  interval,
}: Readonly<{ grouped: GroupedMetrics; interval: MetricInterval }>) {
  const panels =
    grouped.source === "traces"
      ? TRACE_GROUP_CHARTS.map((spec) => ({ spec, values: grouped.values[spec.metric] }))
      : MODEL_GROUP_CHARTS.map((spec) => ({ spec, values: grouped.values[spec.metric] }));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {panels.map(({ spec, values }) => (
        <ChartPanel description={spec.description} key={spec.metric} title={spec.title}>
          <GroupedMetricChart
            buckets={grouped.buckets}
            format={spec.format}
            groups={grouped.groups}
            interval={interval}
            kind={spec.kind}
            values={values}
          />
        </ChartPanel>
      ))}
    </div>
  );
}

function GroupTable({ grouped, label }: Readonly<{ grouped: GroupedMetrics; label: string }>) {
  if (grouped.source === "traces") {
    return (
      <Table dense>
        <TableHeader>
          <TableRow>
            <TableHead>{label}</TableHead>
            <TableHead className={numberCell}>Traces</TableHead>
            <TableHead className={numberCell}>Errors</TableHead>
            <TableHead className={numberCell}>Error rate</TableHead>
            <TableHead className={numberCell}>Tokens</TableHead>
            <TableHead className={numberCell}>Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grouped.groups.map((group, index) => (
            <TableRow key={group.key}>
              <TableCell className="max-w-72">
                <span className="flex items-center gap-2 truncate">
                  <Swatch group={group} index={index} />
                  {group.label}
                </span>
              </TableCell>
              <TableCell className={numberCell}>{formatExact(group.totals.traces)}</TableCell>
              <TableCell className={numberCell}>{formatExact(group.totals.errors)}</TableCell>
              <TableCell className={numberCell}>
                {group.totals.traces === 0
                  ? "—"
                  : formatPercent(group.totals.errors / group.totals.traces)}
              </TableCell>
              <TableCell className={numberCell}>{formatExact(group.totals.tokens)}</TableCell>
              <TableCell className={numberCell}>
                {formatUsdMicros(group.totals.costUsdMicros)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className={numberCell}>Invocations</TableHead>
          <TableHead className={numberCell}>Errors</TableHead>
          <TableHead className={numberCell}>Input</TableHead>
          <TableHead className={numberCell}>Output</TableHead>
          <TableHead className={numberCell}>Cached</TableHead>
          <TableHead className={numberCell}>Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {grouped.groups.map((group, index) => (
          <TableRow key={group.key}>
            <TableCell className="max-w-72">
              <span className="flex items-center gap-2 truncate">
                <Swatch group={group} index={index} />
                <Code>{group.label}</Code>
              </span>
            </TableCell>
            <TableCell className={numberCell}>{formatExact(group.totals.invocations)}</TableCell>
            <TableCell className={numberCell}>{formatExact(group.totals.errors)}</TableCell>
            <TableCell className={numberCell}>{formatExact(group.totals.inputTokens)}</TableCell>
            <TableCell className={numberCell}>{formatExact(group.totals.outputTokens)}</TableCell>
            <TableCell className={numberCell}>{formatExact(group.totals.cachedTokens)}</TableCell>
            <TableCell className={numberCell}>
              {formatUsdMicros(group.totals.costUsdMicros)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Metrics screen body (plan §5.4): volume, errors, latency, tokens, and cost per bucket, grouped
 * by agent, deployment, release, model, or provider, then the tool table for the same window.
 */
export function MetricsView({
  scope,
  selection,
}: Readonly<{ scope: EnvironmentScope; selection: MetricSelection }>) {
  const { data } = useSuspenseQuery(metricsQuery(scope, selection));
  const { series, window } = data;
  return (
    <div className="flex flex-col gap-8">
      {series.kind === "ungrouped" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Traces"
              title={formatExact(series.totals.traces)}
              value={formatCompact(series.totals.traces)}
            />
            <StatTile
              detail={`${formatExact(series.totals.errors)} errored`}
              label="Error rate"
              value={
                series.totals.traces === 0
                  ? "—"
                  : formatPercent(series.totals.errors / series.totals.traces)
              }
            />
            <StatTile
              label="Tokens"
              title={formatExact(series.totals.tokens)}
              value={formatCompact(series.totals.tokens)}
            />
            <StatTile label="Model cost" value={formatUsdMicros(series.totals.costUsdMicros)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartPanel description="Finalized traces and errored traces" title="Activity">
              <TraceVolumeChart interval={window.interval} rows={series.buckets} />
            </ChartPanel>
            <ChartPanel description="Trace duration, p50 and p95" title="Latency">
              <TraceLatencyChart interval={window.interval} rows={series.buckets} />
            </ChartPanel>
            <ChartPanel description="Tokens across every run of each trace" title="Tokens">
              <TraceTokensChart interval={window.interval} rows={series.buckets} />
            </ChartPanel>
            <ChartPanel description="Model cost of finalized traces" title="Cost">
              <TraceCostChart interval={window.interval} rows={series.buckets} />
            </ChartPanel>
          </div>
        </>
      ) : series.grouped.groups.length === 0 ? (
        <p className="text-sm/6 text-muted-foreground">No data in this range.</p>
      ) : (
        <>
          <GroupedCharts grouped={series.grouped} interval={window.interval} />
          <section className="flex flex-col gap-3">
            <Subheading>
              {selection.groupBy ? `By ${GROUP_BY_LABELS[selection.groupBy].toLowerCase()}` : ""}
            </Subheading>
            {series.grouped.source === "model-invocations" ? (
              <p className="text-sm/6 text-muted-foreground">
                Model and provider metrics aggregate individual model invocations, kept for 30 days.
              </p>
            ) : null}
            <GroupTable
              grouped={series.grouped}
              label={selection.groupBy ? GROUP_BY_LABELS[selection.groupBy] : "Group"}
            />
          </section>
        </>
      )}

      <section className="flex flex-col gap-3">
        <Subheading>Tools</Subheading>
        {data.tools.length === 0 ? (
          <p className="text-sm/6 text-muted-foreground">No tool calls in this range.</p>
        ) : (
          <ToolTable tools={data.tools} />
        )}
      </section>
    </div>
  );
}
