import { formatDurationMs, formatExact, formatUsdMicros } from "../../observability/format.ts";
import type { LabeledTrace } from "../../observability/traces.ts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import { Timestamp } from "./panels.tsx";
import { ScrollCue } from "./scroll-cue.tsx";
import { StatusBadge } from "@/components/status-badge";

/** Traces newest first; each row opens the trace detail under `environmentPath`. */
export function TraceTable({
  compact = false,
  environmentPath,
  showAgent = true,
  traces,
}: Readonly<{
  compact?: boolean;
  environmentPath: string;
  /** Off on one agent's own pages, where every row names that agent. */
  showAgent?: boolean;
  traces: readonly LabeledTrace[];
}>) {
  return (
    <ScrollCue>
      <Table dense={compact} striped>
        <TableHeader>
          <TableRow>
            <TableHead>Finished</TableHead>
            <TableHead>Status</TableHead>
            {showAgent ? <TableHead>Agent</TableHead> : null}
            <TableHead>Release</TableHead>
            {compact ? null : (
              <>
                <TableHead>Purpose</TableHead>
                <TableHead>Trigger</TableHead>
              </>
            )}
            <TableHead>Error class</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            {compact ? null : (
              <>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {traces.map((trace) => (
            <TableRow
              href={`${environmentPath}/traces/${encodeURIComponent(trace.trace_id)}`}
              key={trace.fact_id}
              title={`Trace ${trace.trace_id}`}
            >
              <TableCell className="whitespace-nowrap">
                <Timestamp value={trace.occurred_at} />
              </TableCell>
              <TableCell>
                <StatusBadge status={trace.status ?? "unknown"} />
              </TableCell>
              {showAgent ? (
                <TableCell className="max-w-56 truncate">{trace.agentLabel ?? "—"}</TableCell>
              ) : null}
              <TableCell className="whitespace-nowrap">
                {trace.releaseLabel ?? "—"}
                {trace.release_selection === "candidate" ? (
                  <Badge className="ml-2" color="amber">
                    canary
                  </Badge>
                ) : null}
              </TableCell>
              {compact ? null : (
                <>
                  <TableCell>{trace.execution_purpose ?? "—"}</TableCell>
                  <TableCell>{trace.trigger ?? "—"}</TableCell>
                </>
              )}
              <TableCell>{trace.error_class ? <Code>{trace.error_class}</Code> : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">
                {trace.duration_ms === undefined ? "—" : formatDurationMs(trace.duration_ms)}
              </TableCell>
              {compact ? null : (
                <>
                  <TableCell className="text-right tabular-nums">
                    {trace.run_count === undefined ? "—" : formatExact(trace.run_count)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {trace.total_tokens === undefined ? "—" : formatExact(trace.total_tokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {trace.total_cost_usd_micros === undefined
                      ? "—"
                      : formatUsdMicros(trace.total_cost_usd_micros)}
                  </TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollCue>
  );
}
