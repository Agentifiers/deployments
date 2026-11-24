import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { CONNECTION_FILTERS, type ConnectionFilter } from "../../connections/connection-state.ts";
import { connectionPagesQuery } from "../../data/connection-queries.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { useListCreateAction } from "../list-create-action.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

const FILTER_LABELS: Readonly<Record<ConnectionFilter, string>> = {
  active: "Active",
  all: "All, including disconnected",
  attention: "Needing attention",
  current: "Not disconnected",
  disconnected: "Disconnected",
  error: "Error",
  "reauthorization-required": "Reauthorization required",
};

export function ConnectionList({
  filter,
  onFilter,
  scope,
}: Readonly<{
  filter: ConnectionFilter;
  onFilter: (filter: ConnectionFilter) => void;
  scope: EnvironmentScope;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <div className="w-64">
        <NativeSelect
          aria-label="Connections shown"
          onChange={(event) => onFilter(oneOf(CONNECTION_FILTERS, event.target.value) ?? "current")}
          value={filter}
        >
          {CONNECTION_FILTERS.map((option) => (
            <option key={option} value={option}>
              {FILTER_LABELS[option]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <SectionBoundary resetKey={filter}>
        <ConnectionTable filter={filter} scope={scope} />
      </SectionBoundary>
    </div>
  );
}

function ConnectionTable({
  filter,
  scope,
}: Readonly<{ filter: ConnectionFilter; scope: EnvironmentScope }>) {
  const createAction = useListCreateAction();
  const pagesQuery = connectionPagesQuery(scope, filter);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  // Each page re-walks a list sorted by updatedAt, so a row updated between loads can repeat.
  const connections = [
    ...new Map(
      data.pages.flatMap((page) => page.items).map((connection) => [connection.id, connection]),
    ).values(),
  ];
  const complete = data.pages[0]?.complete ?? true;
  const basePath = `${environmentPath(scope)}/connections`;
  return (
    <div className="flex flex-col gap-4">
      {complete ? null : (
        <Text>
          This environment has more connections than the console reads. The list shows the first
          2,000.
        </Text>
      )}
      {connections.length === 0 ? (
        <ListEmpty
          action={filter === "current" ? createAction : undefined}
          docs="/docs/capabilities/providers-and-connections"
          icon={PlugSocketIcon}
          title={filter === "current" ? "No connections" : "No connections match this filter"}
        >
          A connection holds the credential for one provider account. A grant lets agent runs in a
          workspace use it.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Auth method</TableHead>
              <TableHead>External account</TableHead>
              <TableHead>Last verified</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <TableRow
                href={`${basePath}/${connection.id}`}
                key={connection.id}
                title={connection.displayName}
              >
                <TableCell>
                  {connection.displayName}
                  <div className="font-mono text-xs/5 text-muted-foreground">
                    {connection.providerKey}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={connection.status} />
                </TableCell>
                <TableCell>{connection.authMethod}</TableCell>
                <TableCell className="max-w-56 truncate">
                  {connection.externalAccountName ?? connection.externalAccountId ?? "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {connection.lastVerifiedAt ? (
                    <Timestamp value={connection.lastVerifiedAt} />
                  ) : (
                    "Never"
                  )}
                </TableCell>
                <TableCell>
                  <PublicId value={connection.id} />
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
