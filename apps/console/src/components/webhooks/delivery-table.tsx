import { PackageDeliveredIcon } from "@hugeicons/core-free-icons";
import { keepPreviousData, useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { deliveryPagesQuery, endpointOptionsQuery } from "../../data/webhook-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import {
  DELIVERY_STATUSES,
  parseDeliveryFilters,
  type DeliveryFilters,
} from "../../webhooks/webhook-state.ts";
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

export function DeliveryFeed({
  filters,
  onFilters,
  scope,
}: Readonly<{
  filters: DeliveryFilters;
  onFilters: (filters: DeliveryFilters) => void;
  scope: EnvironmentScope;
}>) {
  const { data: endpoints = [] } = useQuery({
    ...endpointOptionsQuery(scope, filters.webhookId),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Status"
          onChange={(status) => onFilters(parseDeliveryFilters({ ...filters, status }))}
          options={DELIVERY_STATUSES.map((value) => ({ label: value, value }))}
          value={filters.status}
        />
        <FilterSelect
          label="Endpoint"
          onChange={(webhookId) => onFilters(parseDeliveryFilters({ ...filters, webhookId }))}
          options={endpoints.map((endpoint) => ({ label: endpoint.name, value: endpoint.id }))}
          value={filters.webhookId}
        />
      </div>
      <SectionBoundary resetKey={`${filters.status ?? "any"}:${filters.webhookId ?? "any"}`}>
        <DeliveryTable filters={filters} scope={scope} />
      </SectionBoundary>
    </div>
  );
}

export function DeliveryTable({
  filters,
  scope,
}: Readonly<{ filters: DeliveryFilters; scope: EnvironmentScope }>) {
  const showEndpoint = filters.webhookId === undefined;
  const pagesQuery = deliveryPagesQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const deliveries = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/webhooks/deliveries`;
  if (deliveries.length === 0) {
    const filtered = filters.status !== undefined || filters.webhookId !== undefined;
    return (
      <ListEmpty
        docs="/docs/capabilities/webhooks"
        icon={PackageDeliveredIcon}
        title={filtered ? "No matching deliveries" : "No deliveries"}
      >
        Each event an endpoint subscribes to becomes a delivery, kept until its retention ends.
      </ListEmpty>
    );
  }
  return (
    <>
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead>
            {showEndpoint ? <TableHead>Endpoint</TableHead> : null}
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Attempt</TableHead>
            <TableHead className="text-right">Response</TableHead>
            <TableHead>Last attempt</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deliveries.map((delivery) => (
            <TableRow
              href={`${basePath}/${delivery.id}`}
              key={delivery.id}
              title={`${delivery.eventType} delivery`}
            >
              <TableCell>
                <Code>{delivery.eventType}</Code>
              </TableCell>
              {showEndpoint ? (
                <TableCell>
                  {delivery.endpointName ?? <PublicId value={delivery.webhookEndpointId} />}
                </TableCell>
              ) : null}
              <TableCell>
                <StatusBadge status={delivery.status} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {delivery.attempt} of {delivery.maxAttempts}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {delivery.responseCode ?? "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {delivery.lastAttemptAt ? <Timestamp value={delivery.lastAttemptAt} /> : "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={delivery.createdAt} />
              </TableCell>
              <TableCell>
                <PublicId value={delivery.id} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </>
  );
}
