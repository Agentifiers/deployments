import { Archive02Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { invalidateEvaluations } from "../../data/evaluation-queries.ts";
import {
  archiveScoreDefinitionFn,
  scoreResultPagesQuery,
} from "../../data/score-result-queries.ts";
import { formatScore } from "../../evaluations/format.ts";
import { formatDurationMs } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { ScoreDefinition } from "../../server/evaluation-data.ts";
import type { ScoreResult } from "../../server/score-result-data.ts";
import { statusColor } from "../../status.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Code, TextLink } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";

/** What a result's outcome reads as: pass or fail against its threshold, or the evaluator error. */
function outcome(result: Pick<ScoreResult, "executionStatus" | "passed">) {
  if (result.executionStatus === "error") return { color: statusColor("error"), label: "error" };
  if (result.passed === undefined) return { color: statusColor("unknown"), label: "scored" };
  return result.passed
    ? { color: statusColor("pass"), label: "pass" }
    : { color: statusColor("fail"), label: "fail" };
}

/** One scorer's results, newest first, each linked to the trace and run it graded. */
export function ScoreResults({
  scope,
  scoreDefinitionId,
}: Readonly<{ scope: EnvironmentScope; scoreDefinitionId: string }>) {
  const pagesQuery = scoreResultPagesQuery(scope, scoreDefinitionId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const results = data.pages.flatMap((page) => page.items);
  const basePath = environmentPath(scope);
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Results</Subheading>
      {results.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon icon={CheckListIcon} />
            </EmptyMedia>
            <EmptyTitle>No results yet</EmptyTitle>
            <EmptyDescription>
              Results appear when an evaluation run uses this scorer, when it samples finished
              traces automatically, or when someone records a score on a trace.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Scored</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Revision</TableHead>
              <TableHead className="text-right">Took</TableHead>
              <TableHead>Trace</TableHead>
              <TableHead>Run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result) => {
              const { color, label } = outcome(result);
              return (
                <TableRow key={result.id}>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={result.createdAt} />
                  </TableCell>
                  <TableCell title={result.errorMessage ?? result.rationale}>
                    <Badge color={color}>{label}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatScore(result.value)}
                  </TableCell>
                  <TableCell className="max-w-48 truncate" title={result.label}>
                    {result.label ?? "—"}
                  </TableCell>
                  <TableCell>{result.source}</TableCell>
                  <TableCell className="text-right tabular-nums">{result.revision}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDurationMs(result.durationMs)}
                  </TableCell>
                  <TableCell>
                    <TextLink
                      href={`${basePath}/traces/${encodeURIComponent(result.traceId)}`}
                      title={`Trace ${result.traceId}`}
                    >
                      <Code>…{result.traceId.slice(-8)}</Code>
                    </TextLink>
                  </TableCell>
                  <TableCell>
                    {result.runId ? (
                      <TextLink
                        href={`${basePath}/runs/${result.runId}`}
                        title={`Run ${result.runId}`}
                      >
                        <Code>…{result.runId.slice(-8)}</Code>
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
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </section>
  );
}

/** Archived scorers keep their results but stop scoring and leave the pickers; it cannot be undone. */
export function ArchiveScorer({
  scope,
  scorer,
}: Readonly<{ scope: EnvironmentScope; scorer: ScoreDefinition }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} variant="outline">
        <Icon icon={Archive02Icon} />
        Archive
      </Button>
      <ActionDialog
        confirmLabel="Archive scorer"
        confirmation={typedConfirmation(environment.type, {
          destructive: true,
          phrase: scorer.name,
        })}
        description="The scorer keeps its results, stops sampling traces, and no longer appears in evaluation pickers. Archiving cannot be undone."
        destructive
        onClose={() => setOpen(false)}
        onSuccess={() => void invalidateEvaluations(queryClient, scope)}
        open={open}
        run={(idempotencyKey) =>
          archiveScoreDefinitionFn({
            data: { idempotencyKey, scope, scoreDefinitionId: scorer.id },
          })
        }
        successMessage="Scorer archived"
        title={`Archive ${scorer.name}?`}
      />
    </>
  );
}
