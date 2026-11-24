import "@tanstack/react-start/server-only";
import type { AlertIncident, AlertPreferences, Monitor } from "../alerts/monitor-model.ts";
import { PlatformApiError } from "../errors.ts";
import { callRoute, type PlatformApiClient, type RouteResponse } from "./platform-api.ts";

/*
 * Every alerts call sends only the organization header: a project or environment header narrows
 * a person's token, and the API then hides organization monitors and their incidents.
 */

const MONITOR_PAGE_SIZE = 50;
const INCIDENT_PAGE_SIZE = 25;

/** `environmentId` narrows the list to one environment's monitors. */
export interface AlertListFilter {
  readonly cursor?: string | undefined;
  readonly environmentId?: string | undefined;
}

export function loadMonitorPage(
  accessToken: string,
  organizationId: string,
  { cursor, environmentId }: AlertListFilter,
): Promise<RouteResponse<"listMonitors">> {
  return callRoute(
    "listMonitors",
    { query: { cursor, environmentId, limit: MONITOR_PAGE_SIZE }, scope: { organizationId } },
    accessToken,
  );
}

export function loadMonitor(
  accessToken: string,
  organizationId: string,
  monitorId: string,
): Promise<Monitor> {
  return callRoute(
    "getMonitor",
    { path: { id: monitorId }, scope: { organizationId } },
    accessToken,
  );
}

export function loadIncidentPage(
  accessToken: string,
  organizationId: string,
  { cursor, environmentId }: AlertListFilter,
): Promise<RouteResponse<"listAlertIncidents">> {
  return callRoute(
    "listAlertIncidents",
    { query: { cursor, environmentId, limit: INCIDENT_PAGE_SIZE }, scope: { organizationId } },
    accessToken,
  );
}

export function loadIncident(
  accessToken: string,
  organizationId: string,
  monitorId: string,
  incidentId: string,
): Promise<AlertIncident> {
  return callRoute(
    "getAlertIncident",
    { path: { id: monitorId, incidentId }, scope: { organizationId } },
    accessToken,
  );
}

export function loadAlertPreferences(
  accessToken: string,
  organizationId: string,
): Promise<AlertPreferences> {
  return callRoute("getAlertNotificationPreferences", { scope: { organizationId } }, accessToken);
}

/** Whether this install serves the monitors API at all, whatever the caller may do with it. */
export type MonitorsRoute = "deployed" | "not_deployed";

/**
 * Asks the API for one monitor to learn whether the route exists. The platform answers a path no
 * deployed function serves with `404 route_not_found`, before it checks the credential; a denial
 * or an answer means the route is there. Anything else is a real failure and is rethrown.
 */
export async function loadMonitorsRoute(
  accessToken: string,
  organizationId: string,
  client: Pick<PlatformApiClient, "callRoute"> = { callRoute },
): Promise<MonitorsRoute> {
  try {
    await client.callRoute(
      "listMonitors",
      { query: { limit: 1 }, scope: { organizationId } },
      accessToken,
    );
    return "deployed";
  } catch (error) {
    if (!(error instanceof PlatformApiError)) throw error;
    if (error.problem.status === 404 && error.problem.code === "route_not_found") {
      return "not_deployed";
    }
    if (error.problem.status === 403) return "deployed";
    throw error;
  }
}
