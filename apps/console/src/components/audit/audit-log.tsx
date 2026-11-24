import { AuditIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_SCOPE_NOTE,
  changeEntries,
  isFiltered,
  type AuditFilters,
} from "../../audit/audit-state.ts";
import { environmentAuditQuery, organizationAuditQuery } from "../../data/audit-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { EnvironmentAuditEvent, OrganizationAuditEvent } from "../../server/audit-data.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { AuditFilterBar } from "./audit-filter-bar.tsx";

type AuditEvent = EnvironmentAuditEvent | OrganizationAuditEvent;

export function AuditActor({ actor }: Readonly<{ actor: AuditEvent["actor"] }>) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-muted-foreground">{actor.type}</span>
      {actor.id ? <PublicId value={actor.id} /> : null}
      {actor.operatorAccessGrantId ? (
        <span className="text-muted-foreground">platform administrator, operator access</span>
      ) : null}
    </span>
  );
}

export function RecordedChange({ changes }: Readonly<{ changes: AuditEvent["changes"] }>) {
  const entries = changeEntries(changes);
  if (entries.length === 0) return <span className="text-muted-foreground">None recorded</span>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs/5">
      {entries.map(([key, value]) => (
        <div className="contents" key={key}>
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AuditTable({
  events,
  filters,
  footer,
  more,
  rowHref,
}: Readonly<{
  events: readonly AuditEvent[];
  filters: AuditFilters;
  footer: ReactNode;
  more: boolean;
  rowHref?: (event: AuditEvent) => string;
}>) {
  if (events.length === 0 && more) return footer;
  if (events.length === 0) {
    return (
      <ListEmpty
        docs="/docs/capabilities/governance"
        icon={AuditIcon}
        title={isFiltered(filters) ? "No matching audit events" : "No audit events"}
      />
    );
  }
  return (
    <>
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Resource</TableHead>
            <TableHead>Recorded change</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow
              key={event.id}
              {...(rowHref ? { href: rowHref(event), title: `${event.action} event` } : {})}
            >
              <TableCell className="whitespace-nowrap">
                <Timestamp value={event.occurredAt} />
              </TableCell>
              <TableCell>
                {AUDIT_ACTION_LABELS[event.action] ? (
                  <span className="block">{AUDIT_ACTION_LABELS[event.action]}</span>
                ) : null}
                <Code>{event.action}</Code>
              </TableCell>
              <TableCell>
                <AuditActor actor={event.actor} />
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-2">
                  {event.resourceType ? (
                    <span className="text-muted-foreground">{event.resourceType}</span>
                  ) : null}
                  {event.resourceId ? <PublicId value={event.resourceId} /> : null}
                </span>
              </TableCell>
              <TableCell>
                <RecordedChange changes={event.changes} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {footer}
    </>
  );
}

function EnvironmentAuditTable({
  filters,
  scope,
}: Readonly<{ filters: AuditFilters; scope: EnvironmentScope }>) {
  const query = environmentAuditQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  return (
    <AuditTable
      events={data.pages.flatMap((page) => page.items)}
      filters={filters}
      footer={
        <>
          {hasNextPage && data.pages.at(-1)?.items.length === 0 ? (
            <Text>
              No matching events in this stretch of the log. Load more continues the search.
            </Text>
          ) : null}
          <LoadMore
            error={error}
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            queryKey={query.queryKey}
          />
        </>
      }
      more={hasNextPage}
      rowHref={(event) => `${environmentPath(scope)}/audit/${event.id}`}
    />
  );
}

function OrganizationAuditTable({
  filters,
  organizationId,
}: Readonly<{ filters: AuditFilters; organizationId: string }>) {
  const query = organizationAuditQuery(organizationId, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  return (
    <AuditTable
      events={data.pages.flatMap((page) => page.items)}
      filters={filters}
      footer={
        <LoadMore
          error={error}
          fetchNextPage={fetchNextPage}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          queryKey={query.queryKey}
        />
      }
      more={hasNextPage}
    />
  );
}

export function AuditLog({
  filters,
  onFilters,
  target,
}: Readonly<{
  filters: AuditFilters;
  onFilters: (filters: AuditFilters) => void;
  target:
    | { readonly kind: "environment"; readonly scope: EnvironmentScope }
    | { readonly kind: "organization"; readonly organizationId: string };
}>) {
  const filterKey = JSON.stringify(filters);
  return (
    <div className="flex flex-col gap-6">
      <Text>{AUDIT_SCOPE_NOTE[target.kind]}</Text>
      <AuditFilterBar filters={filters} key={filterKey} onFilters={onFilters} scope={target.kind} />
      <SectionBoundary resetKey={filterKey}>
        {target.kind === "environment" ? (
          <EnvironmentAuditTable filters={filters} scope={target.scope} />
        ) : (
          <OrganizationAuditTable filters={filters} organizationId={target.organizationId} />
        )}
      </SectionBoundary>
    </div>
  );
}
