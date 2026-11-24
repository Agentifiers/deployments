import { DatabaseIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { spacePagesQuery } from "../../data/memory-queries.ts";
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
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { useListCreateAction } from "../list-create-action.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SPACE_KIND_LABELS } from "./space-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

export function SpaceList({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const createAction = useListCreateAction();
  const pagesQuery = spacePagesQuery(scope);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const spaces = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/memory/spaces`;
  return (
    <div className="flex flex-col gap-4">
      {spaces.length === 0 ? (
        <ListEmpty
          action={createAction}
          docs="/docs/capabilities/memory"
          icon={DatabaseIcon}
          title="No memory spaces"
        >
          A space holds an agent's long-term memories. Agents use it through a grant.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Retention</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spaces.map((space) => (
              <TableRow href={`${basePath}/${space.id}`} key={space.id} title={space.name}>
                <TableCell>
                  {space.name}
                  {space.description ? (
                    <div className="max-w-96 truncate text-xs/5 text-muted-foreground">
                      {space.description}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>{SPACE_KIND_LABELS[space.kind]}</TableCell>
                <TableCell>
                  <StatusBadge status={space.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {space.retentionDays === undefined
                    ? "Not set"
                    : `${formatExact(space.retentionDays)} days`}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={space.createdAt} />
                </TableCell>
                <TableCell>
                  <PublicId value={space.id} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}
