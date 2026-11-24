import { WebhookIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { endpointPagesQuery } from "../../data/webhook-queries.ts";
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
import { formatEventTypes } from "../../webhooks/event-types.ts";
import { ENDPOINT_VIEWS, type EndpointView } from "../../webhooks/webhook-state.ts";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { useListCreateAction } from "../list-create-action.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

const VIEW_LABELS: Readonly<Record<EndpointView, string>> = { active: "Active", all: "All" };

export function WebhookList({
  onView,
  scope,
  view,
}: Readonly<{
  onView: (view: EndpointView) => void;
  scope: EnvironmentScope;
  view: EndpointView;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SingleToggleGroup
          aria-label="Endpoints shown"
          onValueChange={(next) => {
            const nextView = oneOf(ENDPOINT_VIEWS, next);
            if (nextView) onView(nextView);
          }}
          size="sm"
          value={view}
        >
          {ENDPOINT_VIEWS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {VIEW_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </SingleToggleGroup>
      </div>
      <SectionBoundary resetKey={view}>
        <EndpointTable scope={scope} view={view} />
      </SectionBoundary>
    </div>
  );
}

function EndpointTable({ scope, view }: Readonly<{ scope: EnvironmentScope; view: EndpointView }>) {
  const createAction = useListCreateAction();
  const pagesQuery = endpointPagesQuery(scope, view);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const endpoints = data.pages.flatMap((page) => page.endpoints);
  const hidden = data.pages[0]?.hidden ?? 0;
  const basePath = `${environmentPath(scope)}/webhooks`;
  return (
    <div className="flex flex-col gap-4">
      {view === "active" ? (
        <Text>
          {hidden > 0
            ? `${formatExact(hidden)} archived ${hidden === 1 ? "endpoint is" : "endpoints are"} hidden.`
            : "Archived endpoints are hidden."}
        </Text>
      ) : null}
      {endpoints.length === 0 ? (
        <ListEmpty
          action={createAction}
          docs="/docs/capabilities/webhooks"
          icon={WebhookIcon}
          title={hidden > 0 ? "No active webhook endpoints" : "No webhook endpoints"}
        >
          An endpoint receives signed events, such as a completed or failed run, at an HTTPS URL.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Event types</TableHead>
              <TableHead className="text-right">Consecutive failures</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.map((endpoint) => (
              <TableRow href={`${basePath}/${endpoint.id}`} key={endpoint.id} title={endpoint.name}>
                <TableCell>
                  {endpoint.name}
                  <div className="max-w-96 truncate font-mono text-xs/5 text-muted-foreground">
                    {endpoint.url}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={endpoint.status} />
                </TableCell>
                <TableCell
                  className="max-w-80 truncate"
                  title={formatEventTypes(endpoint.eventTypes)}
                >
                  {formatEventTypes(endpoint.eventTypes)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatExact(endpoint.consecutiveFailures)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={endpoint.createdAt} />
                </TableCell>
                <TableCell>
                  <PublicId value={endpoint.id} />
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
