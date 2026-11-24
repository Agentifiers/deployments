import { Route01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  agentDirectoryQuery,
  environmentDashboardQuery,
} from "../../data/observability-queries.ts";
import { agentLabels, groupLabel, labelTrace } from "../../observability/agent-labels.ts";
import {
  formatCompact,
  formatExact,
  formatPercent,
  formatUsdMicros,
} from "../../observability/format.ts";
import { RANGE_LABELS, type MetricSelection } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Icon } from "../icon.tsx";
import {
  TraceCostChart,
  TraceLatencyChart,
  TraceTokensChart,
  TraceVolumeChart,
} from "./charts.tsx";
import { ChartPanel, SourceNote, StatTile } from "./panels.tsx";
import { ToolTable } from "./tool-table.tsx";
import { TraceTable } from "./trace-table.tsx";

/**
 * Environment overview dashboard (management console plan §5.1): totals, activity, latency,
 * tokens, and cost over the selected range, then top deployments, top tools, and recent failures.
 */
export function EnvironmentDashboard({
  environmentPath,
  scope,
  selection,
}: Readonly<{ environmentPath: string; scope: EnvironmentScope; selection: MetricSelection }>) {
  const { data } = useSuspenseQuery(environmentDashboardQuery(scope, selection));
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const labels = useMemo(
    () => agentLabels(directory, data.failureReleases),
    [directory, data.failureReleases],
  );
  const deploymentName = groupLabel("agentDeploymentId", labels);
  const failures = useMemo(
    () => data.failures.map((trace) => labelTrace(trace, labels)),
    [data.failures, labels],
  );
  const { totals, window } = data;
  const rangeLabel = RANGE_LABELS[selection.range].toLowerCase();
  const tracesParams = {
    envId: scope.environmentId,
    orgId: scope.organizationId,
    projectId: scope.projectId,
  };

  if (totals.traces === 0 && data.failures.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={Route01Icon} />
          </EmptyMedia>
          <EmptyTitle>No traces in the {rangeLabel}</EmptyTitle>
          <EmptyDescription>
            Traces appear here once agent runs in this environment finish.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <SourceNote source="analytics" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          detail={rangeLabel}
          label="Traces"
          title={formatExact(totals.traces)}
          value={formatCompact(totals.traces)}
        />
        <StatTile
          detail={`${formatExact(totals.errors)} errored`}
          label="Error rate"
          value={totals.traces === 0 ? "—" : formatPercent(totals.errors / totals.traces)}
        />
        <StatTile
          detail="input, output, and cached"
          label="Tokens"
          title={formatExact(totals.tokens)}
          value={formatCompact(totals.tokens)}
        />
        <StatTile label="Model cost" value={formatUsdMicros(totals.costUsdMicros)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartPanel description="Finalized traces and errored traces" title="Activity">
          <TraceVolumeChart interval={window.interval} rows={data.activity} />
        </ChartPanel>
        <ChartPanel description="Trace duration, p50 and p95" title="Latency">
          <TraceLatencyChart interval={window.interval} rows={data.activity} />
        </ChartPanel>
        <ChartPanel description="Tokens across every run of each trace" title="Tokens">
          <TraceTokensChart interval={window.interval} rows={data.activity} />
        </ChartPanel>
        <ChartPanel description="Model cost of finalized traces" title="Cost">
          <TraceCostChart interval={window.interval} rows={data.activity} />
        </ChartPanel>
      </div>

      <div className="grid gap-8 2xl:grid-cols-[3fr_2fr]">
        <section className="flex flex-col gap-3">
          <Subheading>Top agents</Subheading>
          {data.topAgents.length === 0 ? (
            <p className="text-sm/6 text-muted-foreground">No agent traces in the {rangeLabel}.</p>
          ) : (
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>Deployment</TableHead>
                  <TableHead className="text-right">Traces</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topAgents.map((group) => (
                  <TableRow key={group.key}>
                    <TableCell className="max-w-64 truncate">
                      {group.groupValue === null ? (
                        deploymentName(null)
                      ) : (
                        <Link
                          className="hover:underline"
                          params={tracesParams}
                          search={{ agentDeploymentId: group.groupValue, range: selection.range }}
                          to="/o/$orgId/p/$projectId/e/$envId/traces"
                        >
                          {deploymentName(group.groupValue)}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatExact(group.totals.traces)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatExact(group.totals.errors)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatExact(group.totals.tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatUsdMicros(group.totals.costUsdMicros)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <Subheading>Top tools</Subheading>
          {data.tools.length === 0 ? (
            <p className="text-sm/6 text-muted-foreground">No tool calls in the {rangeLabel}.</p>
          ) : (
            <ToolTable tools={data.tools} />
          )}
        </section>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Subheading>Recent failures</Subheading>
          <span className="ml-auto text-sm/6">
            <Link
              className="font-medium text-foreground underline decoration-foreground/50 hover:decoration-foreground"
              params={tracesParams}
              search={{ range: selection.range, status: "error" }}
              to="/o/$orgId/p/$projectId/e/$envId/traces"
            >
              All failed traces
            </Link>
          </span>
        </div>
        {data.failures.length === 0 ? (
          <p className="text-sm/6 text-muted-foreground">No failed traces in the {rangeLabel}.</p>
        ) : (
          <TraceTable compact environmentPath={environmentPath} traces={failures} />
        )}
      </section>
    </div>
  );
}
