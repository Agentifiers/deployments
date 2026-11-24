import { formatDurationMs, formatExact, formatPercent } from "../../observability/format.ts";
import type { ToolMetric } from "../../observability/traces.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";

const numberCell = "text-right tabular-nums";

/** Tool calls by tool, busiest first: calls, errors, error rate, and p95 duration. */
export function ToolTable({ tools }: Readonly<{ tools: readonly ToolMetric[] }>) {
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead className={numberCell}>Calls</TableHead>
          <TableHead className={numberCell}>Errors</TableHead>
          <TableHead className={numberCell}>Error rate</TableHead>
          <TableHead className={numberCell}>p95</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tools.map((tool) => (
          <TableRow key={tool.name}>
            <TableCell className="max-w-64 truncate">
              <Code>{tool.name || "unnamed"}</Code>
            </TableCell>
            <TableCell className={numberCell}>{formatExact(tool.calls)}</TableCell>
            <TableCell className={numberCell}>{formatExact(tool.errors)}</TableCell>
            <TableCell className={numberCell}>
              {tool.calls === 0 ? "—" : formatPercent(tool.errors / tool.calls)}
            </TableCell>
            <TableCell className={numberCell}>
              {tool.p95DurationMs === undefined ? "—" : formatDurationMs(tool.p95DurationMs)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
