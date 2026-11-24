import { TestTube01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { datasetDirectoryQuery, runPagesQuery } from "../../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { RUN_STATUSES, type EvaluationRunFilters } from "../../evaluations/filters.ts";
import { agentLabels, type AgentLabels } from "../../observability/agent-labels.ts";
import { formatExact, formatUsdMicros } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { EvaluationRun } from "../../server/evaluation-data.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { ListEmpty, FilterSelect, LoadMore, ReleaseFilter } from "../list-controls.tsx";
import { StatusBadge } from "@/components/status-badge";

/** A run filter change: a value sets the filter, `undefined` clears it. */
export type RunFilterPatch = {
  readonly [Key in keyof EvaluationRunFilters]?: EvaluationRunFilters[Key] | undefined;
};

/** Evaluation runs newest first; rows open the run detail. */
export function RunTable({
  datasetNames,
  labels,
  runs,
  scope,
}: Readonly<{
  datasetNames: ReadonlyMap<string, string>;
  labels: AgentLabels;
  runs: readonly EvaluationRun[];
  scope: EnvironmentScope;
}>) {
  const basePath = `${environmentPath(scope)}/evaluations/runs`;
  return (
    <Table striped>
      <TableHeader>
        <TableRow>
          <TableHead>Created</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Release</TableHead>
          <TableHead>Dataset</TableHead>
          <TableHead className="text-right">Scored</TableHead>
          <TableHead className="text-right">Failed</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead>Comparison</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow href={`${basePath}/${run.id}`} key={run.id} title={`Evaluation run ${run.id}`}>
            <TableCell className="whitespace-nowrap">
              <Timestamp value={run.createdAt} />
            </TableCell>
            <TableCell>
              <StatusBadge status={run.status} />
            </TableCell>
            <TableCell>{run.kind}</TableCell>
            <TableCell className="max-w-56 truncate">
              {run.target ? labels.release(run.target.agentReleaseId) : "—"}
            </TableCell>
            <TableCell>
              {run.datasetId ? (
                <Code>{datasetNames.get(run.datasetId) ?? run.datasetId.slice(-6)}</Code>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatExact(run.counts.scored)} / {formatExact(run.caseCount)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatExact(run.counts.failed + run.counts.timedOut)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {run.summary ? formatUsdMicros(run.summary.costUsdMicros) : "—"}
            </TableCell>
            <TableCell>{run.comparison ? run.comparison.role : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The Runs tab: evaluation run history filtered by status, release, and dataset. */
export function RunList({
  filters,
  onFilter,
  scope,
}: Readonly<{
  filters: EvaluationRunFilters;
  onFilter: (patch: RunFilterPatch) => void;
  scope: EnvironmentScope;
}>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data: datasets } = useSuspenseQuery(datasetDirectoryQuery(scope));
  const datasetNames = useMemo(
    () => new Map(datasets.map((dataset) => [dataset.id, dataset.name])),
    [datasets],
  );
  const pagesQuery = runPagesQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const releases = useMemo(() => data.pages.flatMap((page) => page.releases), [data.pages]);
  const labels = useMemo(() => agentLabels(directory, releases), [directory, releases]);
  const runs = data.pages.flatMap((page) => page.items);
  const filteredRelease = releases.find((entry) => entry.id === filters.agentReleaseId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Status"
          onChange={(status) =>
            onFilter({ status: RUN_STATUSES.find((candidate) => candidate === status) })
          }
          options={RUN_STATUSES.map((status) => ({ label: status, value: status }))}
          value={filters.status}
        />
        <ReleaseFilter
          definitionId={filteredRelease?.definitionId}
          label="Release"
          onChange={(agentReleaseId) => onFilter({ agentReleaseId })}
          scope={scope}
          value={filters.agentReleaseId}
        />
        <FilterSelect
          label="Dataset"
          onChange={(datasetId) => onFilter({ datasetId })}
          options={datasets
            .map((dataset) => ({ label: dataset.name, value: dataset.id }))
            .toSorted((left, right) => left.label.localeCompare(right.label))}
          value={filters.datasetId}
        />
      </div>
      {runs.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/evaluations"
          icon={TestTube01Icon}
          title="No evaluation runs"
        >
          No runs match these filters. Start one to replay a dataset against a release.
        </ListEmpty>
      ) : (
        <RunTable datasetNames={datasetNames} labels={labels} runs={runs} scope={scope} />
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}
