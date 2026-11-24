import { ArrowDown01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import { useMutation } from "@tanstack/react-query";
import { exportTracesFn } from "../../data/observability-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import { agentLabels, labelTrace, type AgentDirectory } from "../../observability/agent-labels.ts";
import { RANGE_LABELS } from "../../observability/range.ts";
import {
  EXPORT_LIMIT,
  exportFilename,
  tracesCsv,
  tracesJson,
} from "../../observability/trace-export.ts";
import type { TraceFilters } from "../../observability/trace-filters.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { downloadText } from "../download.ts";
import { Icon } from "../icon.tsx";
import { describeProblem } from "../section-boundary.tsx";

type ExportFormat = "csv" | "json";

const MEDIA_TYPES: Readonly<Record<ExportFormat, string>> = {
  csv: "text/csv;charset=utf-8",
  json: "application/json",
};

/**
 * Export for the trace list (plan §5.4): runs `createObservabilityExport`, narrows the result to
 * the list's window and filters, and downloads it as JSON or CSV with agents and releases named.
 */
export function TraceExport({
  directory,
  filters,
  scope,
}: Readonly<{ directory: AgentDirectory; filters: TraceFilters; scope: EnvironmentScope }>) {
  const mutation = useMutation({
    mutationFn: (format: ExportFormat) =>
      exportTracesFn({ data: { filters, scope } }).then((result) => ({ format, result })),
    onError: (error) => {
      const problem = describeProblem(error, "Export failed");
      toast.error(problem.title, { description: problem.description });
    },
    onSuccess: ({ format, result }) => {
      const labels = agentLabels(directory, result.releases);
      const traces = result.items.map((trace) => labelTrace(trace, labels));
      downloadText(
        format === "csv" ? tracesCsv(traces) : tracesJson(result, filters, traces),
        exportFilename(result, filters.range, format),
        MEDIA_TYPES[format],
      );
      const exported = `Exported ${traces.length} ${traces.length === 1 ? "trace" : "traces"}`;
      if (result.complete) {
        toast.success(exported);
      } else {
        toast.warning(exported, {
          description: `The export returns the newest ${EXPORT_LIMIT.toLocaleString("en-US")} traces of the last 7 days, which do not cover the whole ${RANGE_LABELS[filters.range].toLowerCase()}.`,
        });
      }
    },
  });
  if (mutation.error instanceof UnauthenticatedError) throw mutation.error;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={mutation.isPending} render={<Button variant="outline" />}>
        <Icon icon={Download04Icon} />
        {mutation.isPending ? "Exporting…" : "Export"}
        <Icon icon={ArrowDown01Icon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => mutation.mutate("json")}>Download JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={() => mutation.mutate("csv")}>Download CSV</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
