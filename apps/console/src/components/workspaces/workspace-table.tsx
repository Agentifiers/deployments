import { Folder01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { workspacesQuery } from "../../data/connection-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, TextLink } from "@/components/ui/text";
import { ListEmpty } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

export function WorkspaceTable({
  emptyAction,
  scope,
}: Readonly<{ emptyAction?: ReactNode; scope: EnvironmentScope }>) {
  const { data: workspaces } = useSuspenseQuery(workspacesQuery(scope));
  if (workspaces.length === 0) {
    return (
      <ListEmpty
        action={emptyAction}
        docs="/docs/capabilities/tenancy"
        icon={Folder01Icon}
        title="No workspaces"
      >
        A workspace groups runs. Connection grants and runs name one, so agents use a connection
        only in the workspaces it is granted to.
      </ListEmpty>
    );
  }
  const ordered = workspaces.toSorted(
    (left, right) =>
      Number(left.status !== "active") - Number(right.status !== "active") ||
      left.name.localeCompare(right.name),
  );
  return (
    <Table striped>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Slug</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Version</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((workspace) => (
          <TableRow key={workspace.id}>
            <TableCell>
              <TextLink href={`${environmentPath(scope)}/workspaces/${workspace.id}`}>
                {workspace.name}
              </TextLink>
              {workspace.description ? (
                <div className="max-w-96 truncate text-xs/5 text-muted-foreground">
                  {workspace.description}
                </div>
              ) : null}
            </TableCell>
            <TableCell>
              <Code>{workspace.slug}</Code>
            </TableCell>
            <TableCell>
              <StatusBadge status={workspace.status} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatExact(workspace.version)}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <Timestamp value={workspace.createdAt} />
            </TableCell>
            <TableCell>
              <PublicId value={workspace.id} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
