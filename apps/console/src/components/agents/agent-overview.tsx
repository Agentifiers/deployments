import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { agentOverviewQuery } from "../../data/agent-queries.ts";
import { agentLabels, labelTrace } from "../../observability/agent-labels.ts";
import {
  formatCompact,
  formatDurationMs,
  formatExact,
  formatPercent,
  formatUsdMicros,
} from "../../observability/format.ts";
import { RANGE_LABELS, type MetricRange } from "../../observability/range.ts";
import type { LabeledTrace } from "../../observability/traces.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { AgentDeployment, AgentDetail } from "../../server/agent-data.ts";
import type { GroupedTotals, GroupTotals } from "../../server/agent-metrics.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { AnalyticsBadge, ChartPanel, StatTile, Timestamp } from "../observability/panels.tsx";
import { TraceTable } from "../observability/trace-table.tsx";
import { CanaryBar, liveDeployments, releaseLabel } from "./agent-header.tsx";

const EMPTY_TOTALS: GroupTotals = { costUsdMicros: 0, errors: 0, tokens: 0, traces: 0 };

/**
 * Primary and candidate releases of every running canary, sorted so the route loader and the tab
 * build the same overview query key.
 */
export function canaryReleaseIds(agent: AgentDetail): string[] {
  const ids = new Set<string>();
  for (const deployment of liveDeployments(agent)) {
    if (!deployment.candidateAgentReleaseId) continue;
    ids.add(deployment.agentReleaseId);
    ids.add(deployment.candidateAgentReleaseId);
  }
  return [...ids].toSorted();
}

/**
 * A group's totals, `EMPTY_TOTALS` when complete totals have no traces for it, and undefined
 * when the group ranked below the series' group limit and its traces were too many to total.
 */
function totalsOf(grouped: GroupedTotals, groupValue: string) {
  return grouped.groups[groupValue] ?? (grouped.complete ? EMPTY_TOTALS : undefined);
}

function errorRate(totals: GroupTotals) {
  return totals.traces === 0 ? "—" : formatPercent(totals.errors / totals.traces);
}

function KpiTiles({ range, totals }: Readonly<{ range: MetricRange; totals: GroupTotals }>) {
  const rangeLabel = RANGE_LABELS[range].toLowerCase();
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <StatTile
        detail={rangeLabel}
        label="Traces"
        title={formatExact(totals.traces)}
        value={formatCompact(totals.traces)}
      />
      <StatTile
        detail={`${formatExact(totals.errors)} errored`}
        label="Error rate"
        value={errorRate(totals)}
      />
      <StatTile
        detail={
          totals.p95 === undefined
            ? "no finished traces"
            : totals.p95.basis === "daily-peak"
              ? "highest daily p95 in the range"
              : "over the range's traces"
        }
        label="p95 duration"
        value={totals.p95 ? formatDurationMs(totals.p95.ms) : "—"}
      />
      <StatTile
        detail="input, output, and cached"
        label="Tokens"
        title={formatExact(totals.tokens)}
        value={formatCompact(totals.tokens)}
      />
      <StatTile
        detail={<AnalyticsBadge />}
        label="Model cost"
        value={formatUsdMicros(totals.costUsdMicros)}
      />
    </div>
  );
}

function CanaryComparison({
  agent,
  deployment,
  releases,
}: Readonly<{ agent: AgentDetail; deployment: AgentDeployment; releases: GroupedTotals }>) {
  const candidateId = deployment.candidateAgentReleaseId;
  if (!candidateId || deployment.candidateWeight === undefined) return null;
  const rows = [
    { id: deployment.agentReleaseId, role: "Primary" },
    { id: candidateId, role: "Candidate" },
  ];
  return (
    <ChartPanel
      description={
        <>
          Deployment …{deployment.id.slice(-8)}
          {deployment.candidateStartedAt ? (
            <>
              {" "}
              · started <Timestamp value={deployment.candidateStartedAt} />
            </>
          ) : null}{" "}
          · totals cover every deployment of each release
        </>
      }
      title="Canary"
    >
      <div className="flex flex-col gap-4">
        <CanaryBar
          candidate={releaseLabel(agent, candidateId)}
          primary={releaseLabel(agent, deployment.agentReleaseId)}
          weight={deployment.candidateWeight}
        />
        <Table dense>
          <TableHeader>
            <TableRow>
              <TableHead>Release</TableHead>
              <TableHead className="text-right">Traces</TableHead>
              <TableHead className="text-right">Error rate</TableHead>
              <TableHead className="text-right" title="Daily peak from metrics, else exact">
                p95
              </TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ id, role }) => {
              const totals = totalsOf(releases, id);
              return (
                <TableRow key={id}>
                  <TableCell>
                    {role} {releaseLabel(agent, id)}
                  </TableCell>
                  {totals ? (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {formatExact(totals.traces)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{errorRate(totals)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {totals.p95 ? formatDurationMs(totals.p95.ms) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatExact(totals.tokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUsdMicros(totals.costUsdMicros)}
                      </TableCell>
                    </>
                  ) : (
                    <TableCell className="text-right" colSpan={5}>
                      Too many traces to total for the range
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </ChartPanel>
  );
}

function TracesSection({
  agentDefinitionId,
  range,
  scope,
  status,
  title,
  traces,
}: Readonly<{
  agentDefinitionId: string;
  range: MetricRange;
  scope: EnvironmentScope;
  status?: "error";
  title: string;
  traces: readonly LabeledTrace[];
}>) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Subheading>{title}</Subheading>
        <AnalyticsBadge />
        <span className="ml-auto text-sm/6">
          <Link
            className="font-medium text-foreground underline decoration-foreground/50 hover:decoration-foreground"
            params={{
              envId: scope.environmentId,
              orgId: scope.organizationId,
              projectId: scope.projectId,
            }}
            search={{ agentDefinitionId, range, ...(status ? { status } : {}) }}
            to="/o/$orgId/p/$projectId/e/$envId/traces"
          >
            All {status ? "failed " : ""}traces
          </Link>
        </span>
      </div>
      {traces.length === 0 ? (
        <Text>
          No {status ? "failed " : ""}traces in the {RANGE_LABELS[range].toLowerCase()}.
        </Text>
      ) : (
        <TraceTable
          compact
          environmentPath={environmentPath(scope)}
          showAgent={false}
          traces={traces}
        />
      )}
    </section>
  );
}

/**
 * Overview tab (plan §6.1): KPIs over the range, a primary-versus-candidate comparison for each
 * running canary, and the agent's latest traces and failed traces.
 */
export function AgentOverview({
  agent,
  range,
  scope,
}: Readonly<{ agent: AgentDetail; range: MetricRange; scope: EnvironmentScope }>) {
  const { definition } = agent;
  const { data } = useSuspenseQuery(
    agentOverviewQuery(scope, definition.id, range, canaryReleaseIds(agent)),
  );
  const labels = useMemo(
    () =>
      agentLabels(
        {
          definitions: [{ id: definition.id, name: definition.name, slug: definition.slug }],
          deployments: agent.deployments.map((deployment) => ({
            definitionId: deployment.agentDefinitionId,
            id: deployment.id,
          })),
        },
        agent.releases.map((release) => ({
          definitionId: release.agentDefinitionId,
          id: release.id,
          releaseNumber: release.releaseNumber,
        })),
      ),
    [agent.deployments, agent.releases, definition.id, definition.name, definition.slug],
  );
  const totals = totalsOf(data.agent, definition.id);
  const canaries = liveDeployments(agent).filter(
    (deployment) => deployment.candidateAgentReleaseId,
  );

  return (
    <div className="flex flex-col gap-8">
      {totals ? (
        <KpiTiles range={range} totals={totals} />
      ) : (
        <Callout>
          <CalloutTitle>Metrics unavailable for this agent</CalloutTitle>
          <CalloutDescription>
            The metrics API returns only the 20 busiest agents of a range, and this agent&apos;s
            traces in the {RANGE_LABELS[range].toLowerCase()} were too many to total directly.
            Choose a shorter range; its latest traces are listed below.
          </CalloutDescription>
        </Callout>
      )}

      {canaries.length === 0 ? (
        <section className="flex flex-col gap-2">
          <Subheading>Canary</Subheading>
          <Text>No canary running.</Text>
        </section>
      ) : (
        <div className="flex flex-col gap-4">
          {canaries.map((deployment) => (
            <CanaryComparison
              agent={agent}
              deployment={deployment}
              key={deployment.id}
              releases={data.releases}
            />
          ))}
        </div>
      )}

      <TracesSection
        agentDefinitionId={definition.id}
        range={range}
        scope={scope}
        title="Recent traces"
        traces={data.recent.map((trace) => labelTrace(trace, labels))}
      />
      <TracesSection
        agentDefinitionId={definition.id}
        range={range}
        scope={scope}
        status="error"
        title="Recent errors"
        traces={data.errors.map((trace) => labelTrace(trace, labels))}
      />
    </div>
  );
}
