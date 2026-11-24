import { useSuspenseQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useMemo, useState, type ReactNode } from "react";
import { agentDirectoryQuery, traceDetailQuery } from "../../data/observability-queries.ts";
import { agentLabels, labelTrace } from "../../observability/agent-labels.ts";
import { formatDurationMs, formatExact, formatUsdMicros } from "../../observability/format.ts";
import type { SpanSummary } from "../../observability/traces.ts";
import { OBSERVABILITY_IDENTIFIER } from "../../observability/trace-filters.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Subheading } from "@/components/ui/heading";
import { Code, Text, TextLink } from "@/components/ui/text";
import { AnalyticsBadge, Timestamp } from "./panels.tsx";
import { TraceFeedback } from "./trace-feedback.tsx";
import { StatusBadge } from "@/components/status-badge";

/** Span kinds from the observability contract, each with a fixed waterfall color. */
const KIND_BAR_CLASSES: Readonly<Record<string, string>> = {
  agent: "bg-blue-500",
  approval_wait: "bg-yellow-500",
  artifact: "bg-teal-500",
  custom: "bg-pink-500",
  memory: "bg-amber-500",
  model: "bg-violet-500",
  queue_wait: "bg-muted-foreground/60",
  run: "bg-sky-500",
  sandbox: "bg-orange-500",
  tool: "bg-emerald-500",
};

interface WaterfallRow {
  readonly depth: number;
  readonly endMs: number;
  readonly span: SpanSummary;
  readonly startMs: number;
}

/**
 * Orders spans as a tree: children under their parent, siblings by start time. A span's start is
 * its end (`occurred_at`) minus its duration. Spans whose parent is missing (outside the page cap
 * or retention) become roots.
 */
function waterfallRows(spans: readonly SpanSummary[]): WaterfallRow[] {
  const timed = spans.map((span) => {
    const endMs = Date.parse(span.occurred_at);
    return { endMs, span, startMs: endMs - (span.duration_ms ?? 0) };
  });
  const ids = new Set(spans.map((span) => span.span_id));
  const children = new Map<string | undefined, typeof timed>();
  for (const entry of timed) {
    const parent =
      entry.span.parent_span_id && ids.has(entry.span.parent_span_id)
        ? entry.span.parent_span_id
        : undefined;
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  const rows: WaterfallRow[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | undefined, depth: number) => {
    const siblings = (children.get(parent) ?? []).toSorted(
      (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
    );
    for (const entry of siblings) {
      // A parent cycle in bad data must not recurse forever.
      if (visited.has(entry.span.fact_id)) continue;
      visited.add(entry.span.fact_id);
      rows.push({ ...entry, depth });
      visit(entry.span.span_id, depth + 1);
    }
  };
  visit(undefined, 0);
  return rows;
}

/**
 * The time every span covers together. A child span can outlast its root (memory written after
 * the run answered), so this can exceed the root's duration.
 */
function traceExtent(rows: readonly WaterfallRow[]) {
  const start = Math.min(...rows.map((row) => row.startMs));
  return { start, total: Math.max(1, Math.max(...rows.map((row) => row.endMs)) - start) };
}

const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;
const ROW_COLUMNS = "grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem]";

/** Hot-plane IDs are free-form; only platform ULIDs name console pages. */
const PLATFORM_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

function RuntimeLink({
  basePath,
  id,
  kind,
}: Readonly<{ basePath: string; id: string; kind: "runs" | "threads" }>) {
  if (!PLATFORM_ID.test(id)) return <Code>{id}</Code>;
  return (
    <TextLink href={`${basePath}/${kind}/${id}`}>
      <Code>{id}</Code>
    </TextLink>
  );
}

function SpanInspector({ basePath, span }: Readonly<{ basePath: string; span: SpanSummary }>) {
  const fields: [string, ReactNode][] = [
    ["Span", <Code key="span">{span.span_id}</Code>],
    ["Kind", span.kind ?? "—"],
    ["Status", span.status ? <StatusBadge status={span.status} /> : "—"],
    ["Duration", span.duration_ms === undefined ? "—" : formatDurationMs(span.duration_ms)],
    ["Finished", <Timestamp key="finished" value={span.occurred_at} />],
  ];
  if (span.error_class) fields.push(["Error class", <Code key="error">{span.error_class}</Code>]);
  if (span.requested_model_id || span.actual_model_id) {
    fields.push(
      ["Requested", `${span.requested_provider ?? "?"} / ${span.requested_model_id ?? "?"}`],
      ["Served by", `${span.actual_provider ?? "?"} / ${span.actual_model_id ?? "?"}`],
    );
  }
  if (span.fallback_attempt !== undefined) {
    fields.push([
      "Fallback",
      `attempt ${span.fallback_attempt}${span.fallback_reason ? ` · ${span.fallback_reason}` : ""}`,
    ]);
  }
  if (span.input_tokens !== undefined || span.output_tokens !== undefined) {
    fields.push([
      "Tokens",
      `${formatExact(span.input_tokens ?? 0)} in · ${formatExact(span.output_tokens ?? 0)} out · ${formatExact(span.cached_tokens ?? 0)} cached`,
    ]);
  }
  if (span.cost_usd_micros !== undefined) {
    fields.push(["Cost", formatUsdMicros(span.cost_usd_micros)]);
  }
  if (span.stop_reason) fields.push(["Stop reason", span.stop_reason]);
  if (span.run_id) {
    fields.push([
      "Run",
      <RuntimeLink basePath={basePath} id={span.run_id} key="run" kind="runs" />,
    ]);
  }
  if (span.attempt_id) fields.push(["Attempt", <Code key="attempt">{span.attempt_id}</Code>]);
  if (span.provider_request_id) {
    fields.push(["Provider request", <Code key="provider">{span.provider_request_id}</Code>]);
  }
  return (
    <div className="flex flex-col gap-3">
      <Subheading>{span.name || span.kind || "Span"}</Subheading>
      <DescriptionList>
        {fields.flatMap(([term, detail]) => [
          <DescriptionTerm key={`${term}-term`}>{term}</DescriptionTerm>,
          <DescriptionDetails key={`${term}-detail`}>{detail}</DescriptionDetails>,
        ])}
      </DescriptionList>
    </div>
  );
}

/** The waterfall with the selected span's inspector; the selection also targets new feedback. */
function SpanWaterfall({
  basePath,
  onSelect,
  rows,
  selected,
}: Readonly<{
  basePath: string;
  onSelect: (factId: string) => void;
  rows: readonly WaterfallRow[];
  selected: SpanSummary | undefined;
}>) {
  const selectedId = selected?.fact_id;
  const { start, total } = traceExtent(rows);
  return (
    <div className="grid gap-6 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <ol aria-label="Spans" className="flex flex-col gap-0.5">
        <li
          aria-hidden="true"
          className={clsx("grid gap-3 px-2 text-xs/5 text-muted-foreground", ROW_COLUMNS)}
        >
          <span>Span</span>
          <span className="relative h-5 border-b border-border">
            {AXIS_TICKS.map((tick) => (
              <span
                className={clsx(
                  "absolute top-0 whitespace-nowrap tabular-nums",
                  tick === 0 ? "" : tick === 1 ? "-translate-x-full" : "-translate-x-1/2",
                )}
                key={tick}
                style={{ left: `${tick * 100}%` }}
              >
                {formatDurationMs(total * tick)}
              </span>
            ))}
          </span>
          <span className="text-right">Duration</span>
        </li>
        {rows.map((row) => (
          <li key={row.span.fact_id}>
            <button
              aria-pressed={row.span.fact_id === selectedId}
              className={clsx(
                "grid w-full items-center gap-3 rounded-md px-2 py-1 text-left text-sm/6 hover:bg-muted",
                ROW_COLUMNS,
                row.span.fact_id === selectedId && "bg-muted",
              )}
              onClick={() => onSelect(row.span.fact_id)}
              type="button"
            >
              <span
                className="flex min-w-0 items-center gap-2"
                style={{ paddingLeft: row.depth * 12 }}
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    "size-2 shrink-0 rounded-full",
                    KIND_BAR_CLASSES[row.span.kind ?? ""] ?? "bg-muted-foreground/60",
                  )}
                />
                <span className="truncate">
                  {row.span.name || row.span.kind || row.span.span_id}
                </span>
                {row.span.status && row.span.status !== "ok" ? (
                  <StatusBadge status={row.span.status} />
                ) : null}
              </span>
              <span className="relative h-4">
                <span
                  className={clsx(
                    "absolute top-0.5 h-3 rounded-sm",
                    KIND_BAR_CLASSES[row.span.kind ?? ""] ?? "bg-muted-foreground/60",
                  )}
                  style={{
                    left: `${((row.startMs - start) / total) * 100}%`,
                    minWidth: 2,
                    width: `${((row.endMs - row.startMs) / total) * 100}%`,
                  }}
                />
              </span>
              <span className="text-right text-xs/5 text-muted-foreground tabular-nums">
                {row.span.duration_ms === undefined ? "—" : formatDurationMs(row.span.duration_ms)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {selected ? <SpanInspector basePath={basePath} span={selected} /> : null}
    </div>
  );
}

/**
 * Trace detail (plan §6.3): summary, span waterfall colored by kind, a span inspector, and the
 * scores and annotations footer.
 */
export function TraceDetail({
  initialSpanId,
  scope,
  traceId,
}: Readonly<{
  /** The `span_id` to select first, when the link that opened the trace named one. */
  initialSpanId?: string | undefined;
  scope: EnvironmentScope;
  traceId: string;
}>) {
  const { data } = useSuspenseQuery(traceDetailQuery(scope, traceId));
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const rows = useMemo(() => waterfallRows(data.spans), [data.spans]);
  const extentMs = rows.length === 0 ? undefined : traceExtent(rows).total;
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => rows.find((row) => row.span.span_id === initialSpanId)?.span.fact_id,
  );
  const selectedSpan = (rows.find((row) => row.span.fact_id === selectedId) ?? rows[0])?.span;
  const trace = labelTrace(data.trace, agentLabels(directory, data.releases));
  const basePath = environmentPath(scope);
  return (
    <div className="flex flex-col gap-10">
      <DescriptionList>
        <DescriptionTerm>Status</DescriptionTerm>
        <DescriptionDetails>
          <StatusBadge status={trace.status ?? "unknown"} />
        </DescriptionDetails>
        <DescriptionTerm>Agent</DescriptionTerm>
        <DescriptionDetails>{trace.agentLabel ?? "—"}</DescriptionDetails>
        <DescriptionTerm>Release</DescriptionTerm>
        <DescriptionDetails>
          {trace.releaseLabel ?? "—"}
          {trace.release_selection ? ` (${trace.release_selection})` : ""}
        </DescriptionDetails>
        <DescriptionTerm>Trigger · purpose</DescriptionTerm>
        <DescriptionDetails>
          {trace.trigger ?? "—"} · {trace.execution_purpose ?? "—"}
        </DescriptionDetails>
        {trace.error_class ? (
          <>
            <DescriptionTerm>Error class</DescriptionTerm>
            <DescriptionDetails>
              <Code>{trace.error_class}</Code>
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Run duration</DescriptionTerm>
        <DescriptionDetails>
          {trace.duration_ms === undefined ? "—" : formatDurationMs(trace.duration_ms)}
        </DescriptionDetails>
        {extentMs !== undefined &&
        trace.duration_ms !== undefined &&
        extentMs > trace.duration_ms + 1000 ? (
          <>
            <DescriptionTerm>All spans</DescriptionTerm>
            <DescriptionDetails>
              {formatDurationMs(extentMs)}, including work that finished after the run, such as
              saving memories
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Runs · tokens · cost</DescriptionTerm>
        <DescriptionDetails>
          {formatExact(trace.run_count ?? 0)} · {formatExact(trace.total_tokens ?? 0)} ·{" "}
          {formatUsdMicros(trace.total_cost_usd_micros ?? 0)} <AnalyticsBadge />
        </DescriptionDetails>
        <DescriptionTerm>Finished</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={trace.occurred_at} />
        </DescriptionDetails>
        {trace.root_run_id ? (
          <>
            <DescriptionTerm>Root run</DescriptionTerm>
            <DescriptionDetails>
              <RuntimeLink basePath={basePath} id={trace.root_run_id} kind="runs" />
            </DescriptionDetails>
          </>
        ) : null}
        {trace.session_id ? (
          <>
            <DescriptionTerm>Thread</DescriptionTerm>
            <DescriptionDetails>
              <RuntimeLink basePath={basePath} id={trace.session_id} kind="threads" />
              {OBSERVABILITY_IDENTIFIER.test(trace.session_id) ? (
                <>
                  {" · "}
                  <TextLink
                    href={`${basePath}/traces/sessions/${encodeURIComponent(trace.session_id)}`}
                  >
                    Every trace in this thread
                  </TextLink>
                </>
              ) : null}
            </DescriptionDetails>
          </>
        ) : null}
      </DescriptionList>

      <section className="flex flex-col gap-4">
        <Subheading>Spans</Subheading>
        {data.spans.length === 0 ? (
          <Text>
            No spans. Spans are kept for 30 days and traces for 90, so older traces keep only their
            summary.
          </Text>
        ) : (
          <>
            <SpanWaterfall
              basePath={basePath}
              onSelect={setSelectedId}
              rows={rows}
              selected={selectedSpan}
            />
            {data.spansTruncated ? (
              <Text>Showing the first {formatExact(data.spans.length)} spans of this trace.</Text>
            ) : null}
          </>
        )}
      </section>

      {/* Feedback links to a span only after the user picks one; the default row is just a view. */}
      <TraceFeedback
        scope={scope}
        selectedSpan={selectedId === undefined ? undefined : selectedSpan}
        traceId={traceId}
      />
    </div>
  );
}
