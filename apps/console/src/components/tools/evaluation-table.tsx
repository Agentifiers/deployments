import type { RouteResponse } from "../../server/platform-api.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

export type ToolEvaluation = RouteResponse<"evaluateToolPolicy">["results"][number];

const BASIS_LABELS: Readonly<Record<string, string>> = {
  default: "Default action",
  required_scopes: "Required scopes",
  rule: "Policy rule",
  unavailable: "Unavailable",
};

export function EvaluationTable({ results }: Readonly<{ results: readonly ToolEvaluation[] }>) {
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Decision</TableHead>
          <TableHead>Basis</TableHead>
          <TableHead>Matched policy</TableHead>
          <TableHead>Catalog</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {results.map((result) => (
          <TableRow key={result.toolName}>
            <TableCell>
              <Code>{result.toolName}</Code>
            </TableCell>
            <TableCell>
              <StatusBadge status={result.action} />
            </TableCell>
            <TableCell>{BASIS_LABELS[result.basis] ?? result.basis}</TableCell>
            <TableCell className="whitespace-nowrap">
              {result.toolPolicyId ? (
                <>
                  <PublicId value={result.toolPolicyId} />
                  {result.matchedRuleIndex === null ? null : (
                    <span className="ml-2 text-muted-foreground">
                      rule {result.matchedRuleIndex + 1}
                    </span>
                  )}
                </>
              ) : result.policyApplies ? (
                "No policy pinned"
              ) : (
                "Catalog default"
              )}
            </TableCell>
            <TableCell>
              <StatusBadge status={result.catalogStatus} />
            </TableCell>
            <TableCell className="max-w-96 whitespace-normal">{result.reason}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
