import { McpServerIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { mcpServerRowsQuery } from "../../data/mcp-queries.ts";
import { SERVER_VIEWS, serverAuth, type ServerAuth, type ServerView } from "../../mcp/mcp-state.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ListEmpty } from "../list-controls.tsx";
import { useListCreateAction } from "../list-create-action.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

const VIEW_LABELS: Readonly<Record<ServerView, string>> = { active: "Active", all: "All" };
const AUTH_LABELS: Readonly<Record<ServerAuth, string>> = {
  deleted: "Deleted on archive",
  none: "None",
  stored: "Stored secret",
};

export function McpServerList({
  onView,
  scope,
  view,
}: Readonly<{
  onView: (view: ServerView) => void;
  scope: EnvironmentScope;
  view: ServerView;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <SingleToggleGroup
        aria-label="Servers shown"
        className="self-start"
        onValueChange={(next) => {
          const nextView = oneOf(SERVER_VIEWS, next);
          if (nextView) onView(nextView);
        }}
        size="sm"
        value={view}
      >
        {SERVER_VIEWS.map((option) => (
          <ToggleGroupItem key={option} value={option}>
            {VIEW_LABELS[option]}
          </ToggleGroupItem>
        ))}
      </SingleToggleGroup>
      <SectionBoundary resetKey={view}>
        <ServerTable scope={scope} view={view} />
      </SectionBoundary>
    </div>
  );
}

function ServerTable({ scope, view }: Readonly<{ scope: EnvironmentScope; view: ServerView }>) {
  const createAction = useListCreateAction();
  const { data } = useSuspenseQuery(mcpServerRowsQuery(scope, view));
  const { complete, hidden, rows } = data;
  const basePath = `${environmentPath(scope)}/mcp-servers`;
  return (
    <div className="flex flex-col gap-4">
      {view === "active" ? (
        <Text>
          {hidden > 0
            ? `${formatExact(hidden)} archived ${hidden === 1 ? "server is" : "servers are"} hidden.`
            : "Archived servers are hidden."}
        </Text>
      ) : null}
      {complete ? null : (
        <Text>
          This environment has more MCP servers or connections than the console reads, so the list
          and its counts cover the first 2,000 of each.
        </Text>
      )}
      {rows.length === 0 ? (
        <ListEmpty
          action={createAction}
          docs="/docs/capabilities/mcp"
          icon={McpServerIcon}
          title={hidden > 0 ? "No active MCP servers" : "No MCP servers"}
        >
          A remote MCP server gives agents the tools on its allowlist, through a connection and a
          workspace grant.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Allowlisted tools</TableHead>
              <TableHead>Authentication</TableHead>
              <TableHead className="text-right">Active connections</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ activeConnections, server }) => (
              <TableRow href={`${basePath}/${server.id}`} key={server.id} title={server.name}>
                <TableCell>
                  {server.name}
                  <div className="max-w-96 truncate font-mono text-xs/5 text-muted-foreground">
                    {server.endpointOrigin}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={server.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatExact(server.toolAllowlist.length)}
                </TableCell>
                <TableCell>{AUTH_LABELS[serverAuth(server)]}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatExact(activeConnections)}
                </TableCell>
                <TableCell>
                  <PublicId value={server.id} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
