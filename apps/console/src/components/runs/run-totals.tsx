import { useSuspenseQuery } from "@tanstack/react-query";
import { runTraceQuery } from "../../data/observability-queries.ts";
import { formatDurationMs, formatExact, formatUsdMicros } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Text } from "@/components/ui/text";
import { SourceNote, StatTile } from "../observability/panels.tsx";

/**
 * Duration, tokens, and model cost of the trace the run belongs to. A trace can hold more than
 * one run (an approval resume, a handoff), so the tiles say how many runs they cover.
 */
export function RunTotals({
  inFlight,
  runId,
  scope,
}: Readonly<{ inFlight: boolean; runId: string; scope: EnvironmentScope }>) {
  const { data: trace } = useSuspenseQuery(runTraceQuery(scope, runId));
  if (trace === null) {
    return (
      <Text>
        {inFlight
          ? "Duration, tokens, and cost appear once the run finishes."
          : "Duration, tokens, and cost appear a few seconds after the run finishes. Traces older than 90 days keep no totals."}
      </Text>
    );
  }
  const runs = trace.run_count ?? 1;
  const covers = runs === 1 ? "this run" : `${formatExact(runs)} runs in its trace`;
  return (
    <div className="flex flex-col gap-3">
      <SourceNote source="analytics" />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          detail={covers}
          label="Duration"
          value={trace.duration_ms === undefined ? "—" : formatDurationMs(trace.duration_ms)}
        />
        <StatTile
          detail="input, output, and cached"
          label="Tokens"
          value={trace.total_tokens === undefined ? "—" : formatExact(trace.total_tokens)}
        />
        <StatTile
          label="Model cost"
          value={
            trace.total_cost_usd_micros === undefined
              ? "—"
              : formatUsdMicros(trace.total_cost_usd_micros)
          }
        />
      </div>
    </div>
  );
}
