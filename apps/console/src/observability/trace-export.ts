import { DAY_MS, RANGE_DAYS } from "./range.ts";
import type { TraceFilters } from "./trace-filters.ts";
import type { LabeledTrace, TraceSummary } from "./traces.ts";

/** `POST /v1/observability/exports` returns at most this many traces, newest first. */
export const EXPORT_LIMIT = 1_000;
/**
 * The export takes no window or filter parameters: it returns the newest traces of the hot
 * plane's default seven-day lookback, so the console narrows that set to the list's selection.
 */
const EXPORT_LOOKBACK_DAYS = 7;

/** The trace list's selection applied to one export response. */
export interface TraceExportSelection {
  /**
   * Whether the response covered the whole window: false when the 1,000-trace cap cut it short
   * or the range reaches past the export's seven-day lookback.
   */
  readonly complete: boolean;
  readonly from: string;
  readonly generatedAt: string;
  readonly items: readonly TraceSummary[];
  readonly to: string;
}

/**
 * Narrows an export response to the trace list's window (ending at `generatedAt`) and filters,
 * with the hot plane's semantics: a trace without an outcome has status `unknown`, and a trace
 * lacking a filtered field never matches.
 */
export function selectExportedTraces(
  items: readonly TraceSummary[],
  filters: TraceFilters,
  generatedAt: string,
  limit = EXPORT_LIMIT,
): TraceExportSelection {
  const to = Date.parse(generatedAt);
  const from = to - RANGE_DAYS[filters.range] * DAY_MS;
  const times = items.map((trace) => Date.parse(trace.occurred_at));
  const oldest = Math.min(...times);
  const covered = items.length < limit || oldest <= from;
  return {
    complete: covered && RANGE_DAYS[filters.range] <= EXPORT_LOOKBACK_DAYS,
    from: new Date(from).toISOString(),
    generatedAt,
    items: items.filter(
      (trace, index) =>
        times[index]! >= from &&
        times[index]! <= to &&
        (filters.status === undefined || (trace.status ?? "unknown") === filters.status) &&
        (filters.agentDefinitionId === undefined ||
          trace.agent_definition_id === filters.agentDefinitionId) &&
        (filters.agentDeploymentId === undefined ||
          trace.agent_deployment_id === filters.agentDeploymentId) &&
        (filters.agentReleaseId === undefined ||
          trace.agent_release_id === filters.agentReleaseId) &&
        (filters.executionPurpose === undefined ||
          trace.execution_purpose === filters.executionPurpose) &&
        (filters.errorClass === undefined || trace.error_class === filters.errorClass),
    ),
    to: new Date(to).toISOString(),
  };
}

/** `traces-24h-20261002T120000Z-20261003T120000Z.csv`: the range and window, filesystem-safe. */
export function exportFilename(
  selection: Pick<TraceExportSelection, "from" | "to">,
  range: TraceFilters["range"],
  extension: "csv" | "json",
) {
  const [start, end] = [selection.from, selection.to].map((instant) =>
    instant.replaceAll(/[-:]|\.\d+/gu, ""),
  );
  return `traces-${range}-${start}-${end}.${extension}`;
}

const CSV_COLUMNS = [
  ["trace_id", (trace) => trace.trace_id],
  ["occurred_at", (trace) => trace.occurred_at],
  ["status", (trace) => trace.status ?? "unknown"],
  ["agent", (trace) => trace.agentLabel],
  ["agent_definition_id", (trace) => trace.agent_definition_id],
  ["agent_deployment_id", (trace) => trace.agent_deployment_id],
  ["release", (trace) => trace.releaseLabel],
  ["agent_release_id", (trace) => trace.agent_release_id],
  ["release_selection", (trace) => trace.release_selection],
  ["trigger", (trace) => trace.trigger],
  ["execution_purpose", (trace) => trace.execution_purpose],
  ["error_class", (trace) => trace.error_class],
  ["duration_ms", (trace) => trace.duration_ms],
  ["run_count", (trace) => trace.run_count],
  ["total_tokens", (trace) => trace.total_tokens],
  ["total_cost_usd_micros", (trace) => trace.total_cost_usd_micros],
  ["root_run_id", (trace) => trace.root_run_id],
  ["session_id", (trace) => trace.session_id],
] as const satisfies readonly (readonly [
  string,
  (trace: LabeledTrace) => number | string | undefined,
])[];

/**
 * One RFC 4180 cell. Text that a spreadsheet would evaluate as a formula (`=`, `+`, `-`, `@`, tab,
 * carriage return) gets a leading apostrophe; numbers are written as they are.
 */
function csvCell(value: number | string | undefined) {
  if (value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The traces as CSV with a header row and CRLF line endings. */
export function tracesCsv(traces: readonly LabeledTrace[]) {
  const header = CSV_COLUMNS.map(([name]) => name).join(",");
  const rows = traces.map((trace) =>
    CSV_COLUMNS.map(([, value]) => csvCell(value(trace))).join(","),
  );
  return `${[header, ...rows].join("\r\n")}\r\n`;
}

/** The export as JSON: the window, the filters applied, completeness, and the labeled traces. */
export function tracesJson(
  selection: TraceExportSelection,
  filters: TraceFilters,
  traces: readonly LabeledTrace[],
) {
  const { range, ...applied } = filters;
  return `${JSON.stringify(
    {
      complete: selection.complete,
      filters: applied,
      generatedAt: selection.generatedAt,
      items: traces,
      window: { from: selection.from, range, to: selection.to },
    },
    null,
    2,
  )}\n`;
}
