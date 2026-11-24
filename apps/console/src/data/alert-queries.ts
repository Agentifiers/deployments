import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  loadAlertPreferences,
  loadIncident,
  loadIncidentPage,
  loadMonitor,
  loadMonitorPage,
  loadMonitorsRoute,
} from "../server/alert-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { STATUS_REFRESH_MS } from "./refresh.ts";
import { fields, pageInputAt, requireIds, type PageInputAt, type ScopeAt } from "./server-input.ts";

type AlertPageInput = PageInputAt<"organization"> & { readonly environmentId?: string };

function alertPageInput(input: AlertPageInput) {
  const environment = fields(input).environmentId;
  return {
    ...pageInputAt("organization", input),
    environmentId:
      environment === undefined ? undefined : requireIds(input, ["environmentId"]).environmentId,
  };
}

const fetchMonitorPage = createServerFn({ method: "GET" })
  .validator(alertPageInput)
  .handler(async ({ data }) =>
    loadMonitorPage(await requireAccessToken(), data.scope.organizationId, data),
  );

const fetchMonitor = createServerFn({ method: "GET" })
  .validator((input: ScopeAt<"organization"> & { readonly monitorId: string }) =>
    requireIds(input, ["monitorId", "organizationId"]),
  )
  .handler(async ({ data }) =>
    loadMonitor(await requireAccessToken(), data.organizationId, data.monitorId),
  );

const fetchIncidentPage = createServerFn({ method: "GET" })
  .validator(alertPageInput)
  .handler(async ({ data }) =>
    loadIncidentPage(await requireAccessToken(), data.scope.organizationId, data),
  );

const fetchIncident = createServerFn({ method: "GET" })
  .validator(
    (
      input: ScopeAt<"organization"> & { readonly incidentId: string; readonly monitorId: string },
    ) => requireIds(input, ["incidentId", "monitorId", "organizationId"]),
  )
  .handler(async ({ data }) =>
    loadIncident(await requireAccessToken(), data.organizationId, data.monitorId, data.incidentId),
  );

const fetchAlertPreferences = createServerFn({ method: "GET" })
  .validator((input: ScopeAt<"organization">) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) =>
    loadAlertPreferences(await requireAccessToken(), data.organizationId),
  );

const fetchMonitorsRoute = createServerFn({ method: "GET" })
  .validator((input: ScopeAt<"organization">) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) => loadMonitorsRoute(await requireAccessToken(), data.organizationId));

/** Every alerts query key starts here, so one invalidation after a change refreshes them all. */
const alertsKey = (organizationId: string) => ["alerts", organizationId] as const;

export function invalidateAlerts(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: alertsKey(organizationId) });
}

/** Which alerts a list shows: the organization's, or one environment's. */
export interface AlertListScope {
  readonly environmentId?: string;
  readonly organizationId: string;
}

function pageData({ environmentId, organizationId }: AlertListScope, cursor: string | undefined) {
  return {
    scope: { organizationId },
    ...(cursor === undefined ? {} : { cursor }),
    ...(environmentId === undefined ? {} : { environmentId }),
  };
}

export const monitorPagesQuery = (list: AlertListScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) => fetchMonitorPage({ data: pageData(list, pageParam) }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...alertsKey(list.organizationId), "monitors", list.environmentId ?? "all"],
    refetchInterval: STATUS_REFRESH_MS,
  });

export const monitorQuery = (organizationId: string, monitorId: string) =>
  queryOptions({
    queryFn: () => fetchMonitor({ data: { monitorId, organizationId } }),
    queryKey: [...alertsKey(organizationId), "monitor", monitorId],
  });

export const incidentPagesQuery = (list: AlertListScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) => fetchIncidentPage({ data: pageData(list, pageParam) }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...alertsKey(list.organizationId), "incidents", list.environmentId ?? "all"],
    refetchInterval: STATUS_REFRESH_MS,
  });

export const incidentQuery = (organizationId: string, monitorId: string, incidentId: string) =>
  queryOptions({
    queryFn: () => fetchIncident({ data: { incidentId, monitorId, organizationId } }),
    queryKey: [...alertsKey(organizationId), "incident", monitorId, incidentId],
    refetchInterval: STATUS_REFRESH_MS,
  });

export const alertPreferencesQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchAlertPreferences({ data: { organizationId } }),
    queryKey: [...alertsKey(organizationId), "preferences"],
  });

/** Whether the install serves the monitors API; asked only when the caller may not read it. */
export const monitorsRouteQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchMonitorsRoute({ data: { organizationId } }),
    queryKey: [...alertsKey(organizationId), "route"],
  });
