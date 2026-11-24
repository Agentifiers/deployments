import { Route01Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { agentDirectoryQuery, sessionTracePagesQuery } from "../../data/observability-queries.ts";
import { PlatformApiError } from "../../errors.ts";
import { agentLabels, labelTrace } from "../../observability/agent-labels.ts";
import { formatDurationMs, formatExact, formatUsdMicros } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { SourceNote, StatTile } from "./panels.tsx";
import { TraceTable } from "./trace-table.tsx";

/**
 * A session is one thread: every finalized trace of its runs over the last 30 days, with the
 * loaded traces' combined duration, tokens, and cost.
 */
export function SessionTraces({
  scope,
  sessionId,
}: Readonly<{ scope: EnvironmentScope; sessionId: string }>) {
  const queryClient = useQueryClient();
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const pagesQuery = sessionTracePagesQuery(scope, sessionId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const releases = useMemo(() => data.pages.flatMap((page) => page.releases), [data.pages]);
  const traces = useMemo(() => {
    const labels = agentLabels(directory, releases);
    return data.pages.flatMap((page) => page.items).map((trace) => labelTrace(trace, labels));
  }, [data.pages, directory, releases]);
  const totals = traces.reduce(
    (sum, trace) => ({
      cost: sum.cost + (trace.total_cost_usd_micros ?? 0),
      duration: sum.duration + (trace.duration_ms ?? 0),
      runs: sum.runs + (trace.run_count ?? 0),
      tokens: sum.tokens + (trace.total_tokens ?? 0),
    }),
    { cost: 0, duration: 0, runs: 0, tokens: 0 },
  );
  const cursorExpired =
    error instanceof PlatformApiError && error.problem.code === "cursor_expired";

  if (traces.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={Route01Icon} />
          </EmptyMedia>
          <EmptyTitle>No traces in this thread</EmptyTitle>
          <EmptyDescription>
            A run&apos;s trace appears here a few seconds after the run finishes. Traces are kept
            for 30 days in this view.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <SourceNote source="analytics" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          detail={hasNextPage ? "loaded so far" : "in the last 30 days"}
          label="Traces"
          value={formatExact(traces.length)}
        />
        <StatTile
          detail={`${formatExact(totals.runs)} ${totals.runs === 1 ? "run" : "runs"}`}
          label="Duration"
          value={formatDurationMs(totals.duration)}
        />
        <StatTile
          detail="input, output, and cached"
          label="Tokens"
          value={formatExact(totals.tokens)}
        />
        <StatTile label="Model cost" value={formatUsdMicros(totals.cost)} />
      </div>
      <TraceTable environmentPath={environmentPath(scope)} traces={traces} />
      {cursorExpired ? (
        <Text>
          This list is more than five minutes old.{" "}
          <Button
            onClick={() => void queryClient.resetQueries({ queryKey: pagesQuery.queryKey })}
            variant="ghost"
          >
            Reload from the newest trace
          </Button>
        </Text>
      ) : error ? (
        <p className="text-sm/6 text-destructive">{error.message}</p>
      ) : null}
      {hasNextPage && !cursorExpired ? (
        <div>
          <Button
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            variant="outline"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
