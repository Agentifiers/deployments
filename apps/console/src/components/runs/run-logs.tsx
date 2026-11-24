import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { appendNewRunLogLines, runLogPagesQuery } from "../../data/runtime-log-queries.ts";
import { IN_FLIGHT_REFRESH_MS } from "../../data/refresh.ts";
import {
  RUN_LOG_LEVEL_COLOR,
  RUN_LOG_LEVELS,
  RUN_LOG_SOURCES,
  type RunLogFilters,
} from "../../runs/run-logs.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { Run } from "../../server/runtime-data.ts";
import type { RunLogEntry } from "../../server/runtime-log-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import { Code, Text, TextLink } from "@/components/ui/text";
import { DocsLink } from "../docs-link.tsx";
import { FilterSelect } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { SectionBoundary } from "../section-boundary.tsx";

const LEVEL_OPTIONS = RUN_LOG_LEVELS.map((level) => ({
  label: `${level} and above`,
  value: level,
}));
const SOURCE_OPTIONS = RUN_LOG_SOURCES.map((source) => ({ label: source, value: source }));

/**
 * What the runtime logged while it executed the run, with level and source filters. While the
 * run is in flight the panel follows it, asking for lines after the last one it holds.
 */
export function RunLogs({
  filters,
  inFlight,
  onFiltersChange,
  run,
  scope,
  toolName,
}: Readonly<{
  filters: RunLogFilters;
  inFlight: boolean;
  onFiltersChange: (update: (filters: RunLogFilters) => RunLogFilters) => void;
  run: Pick<Run, "id" | "traceId">;
  scope: EnvironmentScope;
  /** The tool the `toolCallId` filter names, for its chip. */
  toolName: string | undefined;
}>) {
  const setFilters = onFiltersChange;
  return (
    <section className="flex flex-col gap-4" id="runtime-logs">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Runtime logs</Subheading>
        {filters.toolCallId ? (
          <Button
            onClick={() => setFilters((current) => withFilter(current, "toolCallId", undefined))}
            variant="outline"
          >
            Tool call <Code>{toolName ?? `…${filters.toolCallId.slice(-8)}`}</Code> ×
          </Button>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-3">
          <FilterSelect
            label="Level"
            onChange={(level) => setFilters((current) => withFilter(current, "level", level))}
            options={LEVEL_OPTIONS}
            value={filters.level}
          />
          <FilterSelect
            label="Source"
            onChange={(source) => setFilters((current) => withFilter(current, "source", source))}
            options={SOURCE_OPTIONS}
            value={filters.source}
          />
        </div>
      </div>
      <SectionBoundary
        resetKey={`${run.id}:${filters.level ?? ""}:${filters.source ?? ""}:${filters.toolCallId ?? ""}`}
      >
        <RunLogLines filters={filters} inFlight={inFlight} run={run} scope={scope} />
      </SectionBoundary>
    </section>
  );
}

/** The filters with `key` set to `value`, or without `key` when `value` is undefined. */
function withFilter(
  filters: RunLogFilters,
  key: keyof RunLogFilters,
  value: string | undefined,
): RunLogFilters {
  const next: Record<string, string> = { ...filters };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as RunLogFilters;
}

function RunLogLines({
  filters,
  inFlight,
  run,
  scope,
}: Readonly<{
  filters: RunLogFilters;
  inFlight: boolean;
  run: Pick<Run, "id" | "traceId">;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery(
    runLogPagesQuery(scope, run.id, filters),
  );
  const pages = data.pages;
  const [following, setFollowing] = useState(true);
  const [followError, setFollowError] = useState<Error>();
  // Counts finished follow reads; an empty read changes nothing else, yet must arm the next one.
  const [reads, setReads] = useState(0);
  const follow = inFlight && following;
  // Following reads the lines after the newest one every few seconds. Once the run ends, one more
  // read collects what it flushed while finishing.
  const [drained, setDrained] = useState(!inFlight);
  useEffect(() => {
    if (isFetchingNextPage || hasNextPage) return undefined;
    const append = () =>
      appendNewRunLogLines(queryClient, scope, run.id, filters)
        .then(
          () => setFollowError(undefined),
          (cause: unknown) =>
            setFollowError(cause instanceof Error ? cause : new Error(String(cause))),
        )
        .finally(() => setReads((count) => count + 1));
    if (follow) {
      const timer = setTimeout(() => void append(), IN_FLIGHT_REFRESH_MS);
      return () => clearTimeout(timer);
    }
    if (!inFlight && !drained) {
      setDrained(true);
      void append();
    }
    return undefined;
  }, [
    drained,
    filters,
    follow,
    hasNextPage,
    inFlight,
    isFetchingNextPage,
    queryClient,
    reads,
    run.id,
    scope,
  ]);

  const lines = pages.flatMap((page) => page.logs);
  const basePath = environmentPath(scope);
  return (
    <div className="flex flex-col gap-3">
      {lines.length === 0 ? (
        <Text>
          {filters.level || filters.source || filters.toolCallId
            ? "No lines match these filters."
            : inFlight
              ? "The runtime has not logged anything for this run yet."
              : "The runtime kept no log lines for this run. Lines are kept for 30 days."}
        </Text>
      ) : (
        <ol
          aria-label="Runtime log lines"
          className="flex max-h-[32rem] flex-col overflow-auto rounded-lg border border-border bg-muted/30 py-1 font-mono text-xs/5"
        >
          {lines.map((line) => (
            <RunLogLine basePath={basePath} key={line.id} line={line} />
          ))}
        </ol>
      )}
      {(error ?? followError) ? (
        <p className="text-sm/6 text-destructive">{(error ?? followError)?.message}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {hasNextPage ? (
          <Button
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            variant="outline"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}
        {inFlight ? (
          <Button onClick={() => setFollowing((value) => !value)} variant="outline">
            {following ? "Pause following" : "Follow the run"}
          </Button>
        ) : null}
        {follow ? (
          <Text>Following this run; new lines appear as the runtime writes them.</Text>
        ) : null}
        <span className="ml-auto">
          <DocsLink path="/docs/capabilities/threads-and-runs/#runtime-logs">
            About runtime logs
          </DocsLink>
        </span>
      </div>
    </div>
  );
}

function RunLogLine({ basePath, line }: Readonly<{ basePath: string; line: RunLogEntry }>) {
  const attributes = Object.entries(line.attributes ?? {});
  return (
    <li className="grid grid-cols-[auto_4rem_6rem_minmax(0,1fr)] items-start gap-x-3 px-3 py-0.5 hover:bg-muted">
      <span className="text-muted-foreground tabular-nums">
        <Timestamp value={line.time} />
      </span>
      <span>
        <Badge color={RUN_LOG_LEVEL_COLOR[line.level]}>{line.level}</Badge>
      </span>
      <span className="text-muted-foreground">{line.source}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="break-words whitespace-pre-wrap">{line.message}</span>
        {attributes.length > 0 || line.toolCallId || line.spanId ? (
          <span className="flex flex-wrap gap-x-3 text-muted-foreground">
            {attributes.map(([name, value]) => (
              <span key={name}>
                {name}=<Code>{String(value)}</Code>
              </span>
            ))}
            {line.toolCallId ? (
              <span>
                tool call <Code>…{line.toolCallId.slice(-8)}</Code>
              </span>
            ) : null}
            {line.spanId ? (
              <TextLink
                href={`${basePath}/traces/${encodeURIComponent(line.traceId)}?span=${encodeURIComponent(line.spanId)}`}
              >
                View span
              </TextLink>
            ) : null}
          </span>
        ) : null}
      </span>
    </li>
  );
}
