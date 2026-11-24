import { GitCompareIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { comparisonPagesQuery } from "../../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { COMPARISON_STATUSES, type ComparisonFilters } from "../../evaluations/filters.ts";
import { agentLabels, type AgentLabels } from "../../observability/agent-labels.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { ReleaseComparison } from "../../server/evaluation-data.ts";
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
import { useDatasetNames } from "./list-controls.tsx";
import { StatusBadge } from "@/components/status-badge";

/** A comparison filter change: a value sets the filter, `undefined` clears it. */
export type ComparisonFilterPatch = {
  readonly [Key in keyof ComparisonFilters]?: ComparisonFilters[Key] | undefined;
};

/** Advisory verdicts; a comparison without one has not finished. */
export function VerdictBadge({ verdict }: Readonly<{ verdict: ReleaseComparison["verdict"] }>) {
  return verdict ? (
    <StatusBadge status={verdict} title="Advisory verdict against the gate policy" />
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/** Release comparisons newest first; rows open the comparison detail. */
export function ComparisonTable({
  comparisons,
  datasetNames,
  labels,
  scope,
}: Readonly<{
  comparisons: readonly ReleaseComparison[];
  datasetNames: ReadonlyMap<string, string>;
  labels: AgentLabels;
  scope: EnvironmentScope;
}>) {
  const basePath = `${environmentPath(scope)}/evaluations/comparisons`;
  return (
    <Table striped>
      <TableHeader>
        <TableRow>
          <TableHead>Created</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Verdict</TableHead>
          <TableHead>Baseline</TableHead>
          <TableHead>Candidate</TableHead>
          <TableHead>Dataset</TableHead>
          <TableHead className="text-right">Comparable</TableHead>
          <TableHead className="text-right">Regressions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {comparisons.map((comparison) => (
          <TableRow
            href={`${basePath}/${comparison.id}`}
            key={comparison.id}
            title={`Release comparison ${comparison.id}`}
          >
            <TableCell className="whitespace-nowrap">
              <Timestamp value={comparison.createdAt} />
            </TableCell>
            <TableCell>
              <StatusBadge status={comparison.status} />
            </TableCell>
            <TableCell>
              <VerdictBadge verdict={comparison.verdict} />
            </TableCell>
            <TableCell className="max-w-48 truncate">
              {labels.release(comparison.baseline.agentReleaseId)}
            </TableCell>
            <TableCell className="max-w-48 truncate">
              {labels.release(comparison.candidate.agentReleaseId)}
            </TableCell>
            <TableCell>
              <Code>
                {datasetNames.get(comparison.datasetId) ?? comparison.datasetId.slice(-6)}
              </Code>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {comparison.summary
                ? `${formatExact(comparison.summary.comparableCases)} / ${formatExact(comparison.summary.totalCases)}`
                : "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {comparison.summary ? formatExact(comparison.summary.regressions) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The Release comparisons tab: comparison history filtered by status, baseline, and candidate. */
export function ComparisonList({
  filters,
  onFilter,
  scope,
}: Readonly<{
  filters: ComparisonFilters;
  onFilter: (patch: ComparisonFilterPatch) => void;
  scope: EnvironmentScope;
}>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const datasetNames = useDatasetNames(scope);
  const pagesQuery = comparisonPagesQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const releases = useMemo(() => data.pages.flatMap((page) => page.releases), [data.pages]);
  const labels = useMemo(() => agentLabels(directory, releases), [directory, releases]);
  const comparisons = data.pages.flatMap((page) => page.items);
  const definitionOf = (releaseId: string | undefined) =>
    releases.find((entry) => entry.id === releaseId)?.definitionId;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Status"
          onChange={(status) =>
            onFilter({ status: COMPARISON_STATUSES.find((candidate) => candidate === status) })
          }
          options={COMPARISON_STATUSES.map((status) => ({ label: status, value: status }))}
          value={filters.status}
        />
        <ReleaseFilter
          definitionId={definitionOf(filters.baselineReleaseId)}
          label="Baseline"
          onChange={(baselineReleaseId) => onFilter({ baselineReleaseId })}
          scope={scope}
          value={filters.baselineReleaseId}
        />
        <ReleaseFilter
          definitionId={definitionOf(filters.candidateReleaseId)}
          label="Candidate"
          onChange={(candidateReleaseId) => onFilter({ candidateReleaseId })}
          scope={scope}
          value={filters.candidateReleaseId}
        />
      </div>
      {comparisons.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/evaluations"
          icon={GitCompareIcon}
          title="No release comparisons"
        >
          No comparisons match these filters. Compare a candidate release against a baseline on a
          dataset.
        </ListEmpty>
      ) : (
        <ComparisonTable
          comparisons={comparisons}
          datasetNames={datasetNames}
          labels={labels}
          scope={scope}
        />
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
