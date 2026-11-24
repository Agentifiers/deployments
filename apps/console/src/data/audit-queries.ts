import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { parseAuditSearch, type AuditFilters } from "../audit/audit-state.ts";
import {
  loadAuditEvent,
  loadEnvironmentAuditPage,
  loadOrganizationAuditPage,
} from "../server/audit-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  fields,
  pageInput,
  pageInputAt,
  scopedInput,
  type PageInput,
  type PageInputAt,
  type ScopedInput,
} from "./server-input.ts";

type Filtered<Input> = Input & { readonly filters: AuditFilters };

const fetchEnvironmentAuditPage = createServerFn({ method: "GET" })
  .validator((input: Filtered<PageInput>) => ({
    ...pageInput(input),
    filters: parseAuditSearch(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadEnvironmentAuditPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchOrganizationAuditPage = createServerFn({ method: "GET" })
  .validator((input: Filtered<PageInputAt<"organization">>) => ({
    ...pageInputAt("organization", input),
    filters: parseAuditSearch(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadOrganizationAuditPage(
      await requireAccessToken(),
      data.scope.organizationId,
      data.filters,
      data.cursor,
    ),
  );

const fetchAuditEvent = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly eventId: string }) => scopedInput(input, ["eventId"]))
  .handler(async ({ data }) =>
    loadAuditEvent(await requireAccessToken(), data.scope, data.eventId),
  );

const cursorField = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

/** The API seals each cursor to its filters, so the filters are part of the key. */
export const environmentAuditQuery = (scope: EnvironmentScope, filters: AuditFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchEnvironmentAuditPage({ data: { filters, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["audit", ...scopeKey(scope), filters],
  });

export const auditEventQuery = (scope: EnvironmentScope, eventId: string) =>
  queryOptions({
    queryFn: () => fetchAuditEvent({ data: { eventId, scope } }),
    queryKey: ["audit", ...scopeKey(scope), "event", eventId],
  });

export const organizationAuditQuery = (organizationId: string, filters: AuditFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchOrganizationAuditPage({
        data: { filters, scope: { organizationId }, ...cursorField(pageParam) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["audit", organizationId, filters],
  });
