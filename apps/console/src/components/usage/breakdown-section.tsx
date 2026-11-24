import { useSuspenseQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { usageBreakdownQuery } from "../../data/usage-queries.ts";
import { formatExact, formatUsdMicros } from "../../observability/format.ts";
import type { MetricGroup } from "../../observability/series.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { oneOf } from "../../observability/range.ts";
import {
  BREAKDOWN_GROUPS,
  type BreakdownGroupBy,
  type UsageSelection,
} from "../../usage/selection.ts";
import { GroupedMetricChart, groupColors } from "../observability/charts.tsx";
import { ChartPanel } from "../observability/panels.tsx";
import { GROUP_BY_LABELS } from "../observability/selection-controls.tsx";

const numberCell = "text-right tabular-nums";

export function BreakdownSelect({
  onChange,
  value,
}: Readonly<{ onChange: (groupBy: BreakdownGroupBy) => void; value: BreakdownGroupBy }>) {
  return (
    <NativeSelect
      aria-label="Break down by"
      className="w-44"
      onChange={(event) => {
        const groupBy = oneOf(BREAKDOWN_GROUPS, event.target.value);
        if (groupBy) onChange(groupBy);
      }}
      value={value}
    >
      {BREAKDOWN_GROUPS.map((groupBy) => (
        <option key={groupBy} value={groupBy}>
          By {GROUP_BY_LABELS[groupBy].toLowerCase()}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Legend swatch in a group's chart color. */
export function Swatch({ group, index }: Readonly<{ group: MetricGroup<unknown>; index: number }>) {
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

function GroupName({
  group,
  index,
  monospace,
}: Readonly<{ group: MetricGroup<unknown>; index: number; monospace: boolean }>) {
  return (
    <TableCell className="max-w-72">
      <span className="flex items-center gap-2 truncate">
        <Swatch group={group} index={index} />
        {monospace ? <Code>{group.label}</Code> : group.label}
      </span>
    </TableCell>
  );
}

/**
 * Tokens and cost by agent, model, or provider (plan §5.8 breakdowns) from the observability hot
 * plane. Analytics figures: they cover finalized traces and model invocations, never the ledger.
 */
export function BreakdownSection({
  scope,
  selection,
}: Readonly<{ scope: EnvironmentScope; selection: UsageSelection }>) {
  const { data } = useSuspenseQuery(usageBreakdownQuery(scope, selection));
  const { grouped, window } = data;
  const label = GROUP_BY_LABELS[selection.groupBy];
  if (grouped.groups.length === 0) {
    return <Text>No analytics in this period.</Text>;
  }
  const charts = (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartPanel description={`Tokens by ${label.toLowerCase()}`} title="Tokens">
        <GroupedMetricChart
          buckets={grouped.buckets}
          format="count"
          groups={grouped.groups}
          interval={window.interval}
          kind="bars"
          values={grouped.values.tokens}
        />
      </ChartPanel>
      <ChartPanel description={`Model cost by ${label.toLowerCase()}`} title="Cost">
        <GroupedMetricChart
          buckets={grouped.buckets}
          format="usd"
          groups={grouped.groups}
          interval={window.interval}
          kind="bars"
          values={grouped.values.costUsdMicros}
        />
      </ChartPanel>
    </div>
  );
  if (grouped.source === "traces") {
    return (
      <div className="flex flex-col gap-4">
        {charts}
        <Table dense>
          <TableHeader>
            <TableRow>
              <TableHead>{label}</TableHead>
              <TableHead className={numberCell}>Traces</TableHead>
              <TableHead className={numberCell}>Tokens</TableHead>
              <TableHead className={numberCell}>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grouped.groups.map((group, index) => (
              <TableRow key={group.key}>
                <GroupName group={group} index={index} monospace={false} />
                <TableCell className={numberCell}>{formatExact(group.totals.traces)}</TableCell>
                <TableCell className={numberCell}>{formatExact(group.totals.tokens)}</TableCell>
                <TableCell className={numberCell}>
                  {formatUsdMicros(group.totals.costUsdMicros)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {charts}
      <Text>
        Model and provider breakdowns aggregate individual model invocations, kept 30 days.
      </Text>
      <Table dense>
        <TableHeader>
          <TableRow>
            <TableHead>{label}</TableHead>
            <TableHead className={numberCell}>Invocations</TableHead>
            <TableHead className={numberCell}>Input</TableHead>
            <TableHead className={numberCell}>Output</TableHead>
            <TableHead className={numberCell}>Cached</TableHead>
            <TableHead className={numberCell}>Total tokens</TableHead>
            <TableHead className={numberCell}>Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grouped.groups.map((group, index) => (
            <TableRow key={group.key}>
              <GroupName group={group} index={index} monospace />
              <TableCell className={numberCell}>{formatExact(group.totals.invocations)}</TableCell>
              <TableCell className={numberCell}>{formatExact(group.totals.inputTokens)}</TableCell>
              <TableCell className={numberCell}>{formatExact(group.totals.outputTokens)}</TableCell>
              <TableCell className={numberCell}>{formatExact(group.totals.cachedTokens)}</TableCell>
              <TableCell className={numberCell}>{formatExact(group.totals.tokens)}</TableCell>
              <TableCell className={numberCell}>
                {formatUsdMicros(group.totals.costUsdMicros)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
