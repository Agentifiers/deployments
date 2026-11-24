import type { WorkflowExecutionSummaryResponse } from "@deployments-ai/api-contract";
import type { EnvironmentScope } from "../../scope.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ResourceLink } from "../resource-link.tsx";
import { StatusBadge } from "@/components/status-badge";

export function StatusOrderNote() {
  return <Text>The API lists executions grouped by status, not by time.</Text>;
}

export function ExecutionTable({
  executions,
  scope,
}: Readonly<{
  executions: readonly WorkflowExecutionSummaryResponse[];
  scope: EnvironmentScope;
}>) {
  return (
    <Table striped>
      <TableHeader>
        <TableRow>
          <TableHead>Execution</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Current step</TableHead>
          <TableHead>Release</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Completed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {executions.map((execution) => (
          <TableRow key={execution.id}>
            <TableCell>
              <ResourceLink
                scope={scope}
                to={{ executionId: execution.id, kind: "workflowExecution" }}
              >
                <Code>…{execution.id.slice(-8)}</Code>
              </ResourceLink>
            </TableCell>
            <TableCell>
              <StatusBadge status={execution.status} />
            </TableCell>
            <TableCell>
              {execution.currentStepId ? <Code>{execution.currentStepId}</Code> : "—"}
            </TableCell>
            <TableCell>
              <ResourceLink
                scope={scope}
                to={{ kind: "workflowRelease", releaseId: execution.workflowReleaseId }}
              >
                #{execution.workflowReleaseNumber}
              </ResourceLink>{" "}
              <PublicId value={execution.workflowReleaseId} />
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <Timestamp value={execution.createdAt} />
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {execution.completedAt ? <Timestamp value={execution.completedAt} /> : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
