import "@tanstack/react-start/server-only";
import type { AuditFilters } from "../audit/audit-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

export type EnvironmentAuditEvent = RouteResponse<"getAuditEvent">;
export type OrganizationAuditEvent = RouteResponse<"listOrganizationAuditEvents">["items"][number];

/**
 * Each environment request scans at most 10 storage pages of every event type and keeps the
 * audit events, so a console page stops after 3 requests and may come back empty with a cursor.
 */
const ENVIRONMENT_AUDIT_REQUESTS = 3;

export function loadEnvironmentAuditPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: AuditFilters,
  cursor: string | undefined,
): Promise<Page<EnvironmentAuditEvent>> {
  return fillPage(
    async (pageCursor, limit) =>
      callRoute(
        "listAuditEvents",
        { query: { ...filters, cursor: pageCursor, limit }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
    ENVIRONMENT_AUDIT_REQUESTS,
  );
}

export function loadAuditEvent(
  accessToken: string,
  scope: EnvironmentScope,
  eventId: string,
): Promise<EnvironmentAuditEvent> {
  return callRoute("getAuditEvent", { path: { id: eventId }, scope }, accessToken);
}

export function loadOrganizationAuditPage(
  accessToken: string,
  organizationId: string,
  filters: AuditFilters,
  cursor: string | undefined,
): Promise<Page<OrganizationAuditEvent>> {
  return callRoute(
    "listOrganizationAuditEvents",
    {
      path: { id: organizationId },
      query: { ...filters, cursor, limit: PAGE_SIZE },
      scope: { organizationId },
    },
    accessToken,
  );
}
