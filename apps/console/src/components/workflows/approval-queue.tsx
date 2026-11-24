import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { approvalQueueQuery } from "../../data/workflow-queries.ts";
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
import { ResourceLink } from "../resource-link.tsx";
import { ApprovalButtons } from "./approval-actions.tsx";
import { approvalQueueRows, type PendingWorkflowApproval } from "../../workflows/model.ts";

export function ApprovalQueueTable({
  canResolve,
  scope,
}: Readonly<{ canResolve: boolean; scope: EnvironmentScope }>) {
  const { complete, items } = useSuspenseQuery(approvalQueueQuery(scope)).data;
  const [held, setHeld] = useState<PendingWorkflowApproval>();
  const rows = approvalQueueRows(items, held);
  if (rows.length === 0 && complete) {
    return <Text>No workflow step in this environment is waiting for a decision.</Text>;
  }
  return (
    <div className="flex flex-col gap-4">
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Execution</TableHead>
            <TableHead>Release</TableHead>
            <TableHead>Step</TableHead>
            <TableHead>Prompt</TableHead>
            <TableHead>Waiting since</TableHead>
            {canResolve ? <TableHead>Decision</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((item) => (
            <TableRow key={item.approvalId}>
              <TableCell className="font-medium">
                <ResourceLink
                  scope={scope}
                  to={{ executionId: item.executionId, kind: "workflowExecution" }}
                >
                  …{item.executionId.slice(-8)}
                </ResourceLink>
              </TableCell>
              <TableCell>
                <ResourceLink
                  scope={scope}
                  to={{ kind: "workflowRelease", releaseId: item.releaseId }}
                >
                  {item.workflowName} #{item.releaseNumber}
                </ResourceLink>
              </TableCell>
              <TableCell>
                <Code>{item.stepId}</Code>
              </TableCell>
              <TableCell className="max-w-md whitespace-normal break-words">
                {item.prompt ?? "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={item.waitingSince} />
              </TableCell>
              {canResolve ? (
                <TableCell>
                  <ApprovalButtons
                    onOpenChange={(open) => setHeld(open ? item : undefined)}
                    scope={scope}
                    target={item}
                  />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {complete ? null : (
        <Text>
          The console stopped reading before it reached every execution waiting for approval, so
          this list may be missing some. Filter the Executions tab by waiting-for-approval to find
          the rest.
        </Text>
      )}
    </div>
  );
}
