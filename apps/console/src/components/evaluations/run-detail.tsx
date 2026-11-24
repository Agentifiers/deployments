import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { runDetailQuery, runResultPagesQuery } from "../../data/evaluation-queries.ts";
import { IN_FLIGHT_REFRESH_MS } from "../../data/refresh.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { formatScore } from "../../evaluations/format.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import {
  formatCompact,
  formatDurationMs,
  formatExact,
  formatPercent,
  formatUsdMicros,
} from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { EvaluationRun } from "../../server/evaluation-data.ts";
import { Badge } from "@/components/ui/badge";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { SourceNote, StatTile, Timestamp } from "../observability/panels.tsx";
import { BudgetRefusalLink } from "../budgets/budget-refusal.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { LoadMore } from "../list-controls.tsx";
import { useDatasetNames } from "./list-controls.tsx";
import { StatusBadge } from "@/components/status-badge";

/** One evaluation run: what it replayed, its counts and summary, and per-case results. */
export function RunDetail({
  evaluationRunId,
  scope,
}: Readonly<{ evaluationRunId: string; scope: EnvironmentScope }>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data } = useSuspenseQuery(runDetailQuery(scope, evaluationRunId));
  const datasetNames = useDatasetNames(scope);
  const { run } = data;
  const labels = agentLabels(directory, data.releases);
  const basePath = environmentPath(scope);
  const release = data.releases.find((entry) => entry.id === run.target?.agentReleaseId);
  const { counts, summary } = run;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>Evaluation run</Heading>
        <PublicId value={run.id} />
        <StatusBadge status={run.status} />
        <Badge color="zinc">{run.kind}</Badge>
      </div>
      {run.error ? (
        <Callout variant="destructive">
          <CalloutTitle>{run.error.code}</CalloutTitle>
          <CalloutDescription>{run.error.message}</CalloutDescription>
        </Callout>
      ) : null}
      <DescriptionList>
        {run.target ? (
          <>
            <DescriptionTerm>Release</DescriptionTerm>
            <DescriptionDetails>
              {release ? (
                <TextLink href={`${basePath}/agents/${release.definitionId}/evaluations`}>
                  {labels.release(release.id)}
                </TextLink>
              ) : (
                <PublicId value={run.target.agentReleaseId} />
              )}
            </DescriptionDetails>
          </>
        ) : null}
        {run.target?.agentDeploymentId ? (
          <>
            <DescriptionTerm>Deployment</DescriptionTerm>
            <DescriptionDetails>
              {labels.deployment(run.target.agentDeploymentId)}
            </DescriptionDetails>
          </>
        ) : null}
        {run.datasetId ? (
          <>
            <DescriptionTerm>Dataset</DescriptionTerm>
            <DescriptionDetails>
              <TextLink href={`${basePath}/evaluations/datasets/${run.datasetId}`}>
                {datasetNames.get(run.datasetId) ?? run.datasetId}
              </TextLink>
            </DescriptionDetails>
          </>
        ) : null}
        {run.comparison ? (
          <>
            <DescriptionTerm>Comparison</DescriptionTerm>
            <DescriptionDetails>
              <TextLink
                href={`${basePath}/evaluations/comparisons/${run.comparison.releaseComparisonId}`}
              >
                {run.comparison.role} arm of a release comparison
              </TextLink>
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={run.createdAt} />
        </DescriptionDetails>
        {run.startedAt ? (
          <>
            <DescriptionTerm>Started</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={run.startedAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {run.completedAt ? (
          <>
            <DescriptionTerm>Completed</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={run.completedAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {run.kind === "dataset-replay" ? (
          <>
            <DescriptionTerm>Replay controls</DescriptionTerm>
            <DescriptionDetails>
              {run.concurrency} in parallel · {run.caseTimeoutSeconds} s per case
            </DescriptionDetails>
          </>
        ) : null}
      </DescriptionList>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label="Cases" value={formatExact(run.caseCount)} />
        <StatTile label="Scored" value={formatExact(counts.scored)} />
        <StatTile label="Failed" value={formatExact(counts.failed)} />
        <StatTile label="Timed out" value={formatExact(counts.timedOut)} />
        <StatTile label="In progress" value={formatExact(counts.pending + counts.running)} />
      </div>

      {summary ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Subheading>Summary</Subheading>
            <SourceNote source="analytics" />
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Cost" value={formatUsdMicros(summary.costUsdMicros)} />
            <StatTile
              label="Tokens"
              title={formatExact(summary.totalTokens)}
              value={formatCompact(summary.totalTokens)}
            />
            <StatTile
              label="Latency p50"
              value={
                summary.latencyP50Ms === undefined ? "—" : formatDurationMs(summary.latencyP50Ms)
              }
            />
            <StatTile
              label="Latency p95"
              value={
                summary.latencyP95Ms === undefined ? "—" : formatDurationMs(summary.latencyP95Ms)
              }
            />
          </div>
        </section>
      ) : null}

      <ScorerSummary run={run} />

      {run.traceIds && run.traceIds.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Subheading>Scored traces</Subheading>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {run.traceIds.map((traceId) => (
              <TextLink href={`${basePath}/traces/${traceId}`} key={traceId}>
                <Code>{traceId}</Code>
              </TextLink>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-4">
        <Subheading>Case results</Subheading>
        <SectionBoundary resetKey={run.id}>
          <ResultTable run={run} scope={scope} />
        </SectionBoundary>
      </section>
    </div>
  );
}

function ScorerSummary({ run }: Readonly<{ run: EvaluationRun }>) {
  const totals = new Map(
    (run.summary?.definitions ?? []).map((entry) => [entry.scoreDefinitionId, entry]),
  );
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Scorers</Subheading>
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Scorer</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Threshold</TableHead>
            <TableHead className="text-right">Scored</TableHead>
            <TableHead className="text-right">Passed</TableHead>
            <TableHead className="text-right">Pass rate</TableHead>
            <TableHead className="text-right">Mean</TableHead>
            <TableHead className="text-right">Errors</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {run.scoreDefinitions.map((definition) => {
            const total = totals.get(definition.scoreDefinitionId);
            return (
              <TableRow key={definition.scoreDefinitionId}>
                <TableCell>
                  <Code>{definition.name}</Code>{" "}
                  <span className="text-muted-foreground">rev {definition.revision}</span>
                </TableCell>
                <TableCell>{definition.type}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatScore(definition.threshold)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {total ? formatExact(total.scored) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {total ? formatExact(total.passed) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {total?.passRate === undefined ? "—" : formatPercent(total.passRate)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatScore(total?.mean)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {total ? formatExact(total.errors) : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function ResultTable({ run, scope }: Readonly<{ run: EvaluationRun; scope: EnvironmentScope }>) {
  const inFlight = run.status === "queued" || run.status === "running";
  const pagesQuery = runResultPagesQuery(scope, run.id);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery({
    ...pagesQuery,
    refetchInterval: inFlight ? IN_FLIGHT_REFRESH_MS : false,
  });
  const results = data.pages.flatMap((page) => page.items);
  const basePath = environmentPath(scope);
  if (results.length === 0) {
    return (
      <Text>{inFlight ? "No case has finished yet." : "This run recorded no case results."}</Text>
    );
  }
  return (
    <>
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Case</TableHead>
            <TableHead>Status</TableHead>
            {run.scoreDefinitions.map((definition) => (
              <TableHead className="text-right" key={definition.scoreDefinitionId}>
                {definition.name}
              </TableHead>
            ))}
            <TableHead className="text-right">Latency</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead>Trace</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((result) => {
            const traceId = result.traceId ?? result.sourceTraceId;
            return (
              <TableRow key={result.caseKey}>
                <TableCell className="max-w-64 truncate" title={result.error?.message}>
                  <Code>{result.caseKey}</Code>
                  {result.error ? (
                    <>
                      <div className="truncate text-xs/5 text-destructive">
                        {result.error.message}
                      </div>
                      <BudgetRefusalLink
                        problem={{ code: result.error.code, detail: result.error.message }}
                        scope={scope}
                      />
                    </>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge status={result.status} />
                </TableCell>
                {run.scoreDefinitions.map((definition) => {
                  const score = result.scores.find(
                    (entry) => entry.scoreDefinitionId === definition.scoreDefinitionId,
                  );
                  return (
                    <TableCell
                      className="text-right tabular-nums"
                      key={definition.scoreDefinitionId}
                    >
                      {result.notApplicable.includes(definition.scoreDefinitionId) ? (
                        <span className="text-muted-foreground">n/a</span>
                      ) : score === undefined ? (
                        "—"
                      ) : score.executionStatus === "error" ? (
                        <Badge color="red" title={score.errorClass}>
                          error
                        </Badge>
                      ) : (
                        <Badge color={score.passed ? "green" : "red"}>
                          {formatScore(score.value)}
                        </Badge>
                      )}
                    </TableCell>
                  );
                })}
                <TableCell className="text-right tabular-nums">
                  {result.latencyMs === undefined ? "—" : formatDurationMs(result.latencyMs)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {result.totalTokens === undefined ? "—" : formatExact(result.totalTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {result.costUsdMicros === undefined ? "—" : formatUsdMicros(result.costUsdMicros)}
                </TableCell>
                <TableCell>
                  {traceId ? (
                    <TextLink href={`${basePath}/traces/${traceId}`}>
                      {traceId.slice(0, 8)}…
                    </TextLink>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </>
  );
}
