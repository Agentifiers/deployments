import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { agentListMetricsQuery, agentListQuery } from "../../data/agent-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import { formatExact, formatUsdMicros } from "../../observability/format.ts";
import { RANGE_LABELS, type MetricRange } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { AgentDeployment } from "../../server/agent-data.ts";
import type { GroupTotals } from "../../server/agent-metrics.ts";
import { Badge } from "@/components/ui/badge";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Icon } from "../icon.tsx";
import { AnalyticsBadge, Timestamp } from "../observability/panels.tsx";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

/** A row lists this many live deployments, then counts the rest. */
const DEPLOYMENTS_SHOWN = 3;

/** The current state a deployment settles in for each desired state. */
const SETTLED_STATE: Readonly<Record<AgentDeployment["desiredState"], string>> = {
  paused: "paused",
  running: "ready",
  stopped: "stopped",
};

function DeploymentSummary({
  deployment,
  release,
}: Readonly<{ deployment: AgentDeployment; release: (id: string) => string }>) {
  const candidate = deployment.candidateAgentReleaseId;
  return (
    <div className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
      <StatusBadge status={deployment.currentState} />
      {deployment.currentState === SETTLED_STATE[deployment.desiredState] ? null : (
        <span className="text-xs/5 text-muted-foreground">→ {deployment.desiredState}</span>
      )}
      <span className="tabular-nums">{release(deployment.agentReleaseId)}</span>
      {candidate ? (
        <Badge color="amber">
          canary {release(candidate)} · {deployment.candidateWeight ?? "?"}%
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * The agents list (plan §5.2): one row per definition with its live deployments and, when the
 * caller may read observability, runs, errors, and cost over the range. Metrics load separately,
 * so a slow or unavailable hot plane never hides the list.
 */
export function AgentTable({
  emptyAction,
  includeArchived,
  range,
  scope,
  showMetrics,
}: Readonly<{
  emptyAction?: ReactNode;
  includeArchived: boolean;
  range: MetricRange;
  scope: EnvironmentScope;
  showMetrics: boolean;
}>) {
  const { data } = useSuspenseQuery(agentListQuery(scope, includeArchived));
  const metrics = useQuery({ ...agentListMetricsQuery(scope, range), enabled: showMetrics });
  const releaseNumbers = useMemo(
    () => new Map(data.releases.map((entry) => [entry.id, entry.releaseNumber])),
    [data.releases],
  );
  if (metrics.error instanceof UnauthenticatedError) throw metrics.error;
  const release = (id: string) => {
    const number = releaseNumbers.get(id);
    return number === undefined ? `…${id.slice(-8)}` : `#${number}`;
  };
  const rangeLabel = RANGE_LABELS[range].toLowerCase();
  const problem = metrics.error
    ? describeProblem(metrics.error, "Agent metrics failed to load")
    : undefined;

  if (data.rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={AiBrain01Icon} />
          </EmptyMedia>
          <EmptyTitle>No agents{includeArchived ? "" : " yet"}</EmptyTitle>
          <EmptyDescription>
            Create agent opens a manifest template to edit
            {data.hiddenArchived > 0
              ? `. ${formatExact(data.hiddenArchived)} archived agents are hidden.`
              : "."}
          </EmptyDescription>
        </EmptyHeader>
        {emptyAction ? <EmptyContent>{emptyAction}</EmptyContent> : null}
      </Empty>
    );
  }

  const metricCells = (definitionId: string) => {
    if (!showMetrics) return null;
    const grouped = metrics.data?.totals;
    const totals: GroupTotals | undefined =
      grouped?.groups[definitionId] ??
      (grouped?.complete ? { costUsdMicros: 0, errors: 0, tokens: 0, traces: 0 } : undefined);
    const placeholder = metrics.isPending ? "…" : "—";
    const title =
      grouped && !totals ? "Too many traces in the range to total this agent" : undefined;
    return (
      <>
        <TableCell className="text-right tabular-nums" title={title}>
          {totals ? formatExact(totals.traces) : placeholder}
        </TableCell>
        <TableCell className="text-right tabular-nums" title={title}>
          {totals ? formatExact(totals.errors) : placeholder}
        </TableCell>
        <TableCell className="text-right tabular-nums" title={title}>
          {totals ? formatUsdMicros(totals.costUsdMicros) : placeholder}
        </TableCell>
      </>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {problem ? (
        <Callout variant="destructive">
          <CalloutTitle>{problem.title}</CalloutTitle>
          <CalloutDescription>
            <p>{problem.description}</p>
            <ProblemReference requestId={problem.requestId} status={problem.status} />
          </CalloutDescription>
        </Callout>
      ) : null}
      {showMetrics ? (
        <p className="flex items-center gap-2 text-sm/6 text-muted-foreground">
          Runs, errors, and cost over the {rangeLabel} <AnalyticsBadge />
        </p>
      ) : null}
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Deployments</TableHead>
            <TableHead>Last transition</TableHead>
            {showMetrics ? (
              <>
                <TableHead className="text-right" title={`Traces in the ${rangeLabel}`}>
                  Runs
                </TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map(({ definition, deployments, lastTransitionAt, stoppedDeployments }) => (
            <TableRow
              href={`${environmentPath(scope)}/agents/${definition.id}`}
              key={definition.id}
              title={`Open ${definition.name}`}
            >
              <TableCell className="max-w-64">
                <div className="truncate font-medium">{definition.name}</div>
                <div className="truncate font-mono text-xs/5 text-muted-foreground">
                  {definition.slug}
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge status={definition.status} />
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  {deployments.slice(0, DEPLOYMENTS_SHOWN).map((deployment) => (
                    <DeploymentSummary
                      deployment={deployment}
                      key={deployment.id}
                      release={release}
                    />
                  ))}
                  {deployments.length > DEPLOYMENTS_SHOWN ? (
                    <span className="text-xs/5 text-muted-foreground">
                      +{deployments.length - DEPLOYMENTS_SHOWN} more live
                    </span>
                  ) : null}
                  {deployments.length === 0 ? (
                    <span className="text-muted-foreground">Not deployed</span>
                  ) : null}
                  {stoppedDeployments > 0 ? (
                    <span className="text-xs/5 text-muted-foreground">
                      {stoppedDeployments} stopped
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {lastTransitionAt ? <Timestamp value={lastTransitionAt} /> : "—"}
              </TableCell>
              {metricCells(definition.id)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
