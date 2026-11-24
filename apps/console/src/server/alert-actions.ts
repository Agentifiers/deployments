import "@tanstack/react-start/server-only";
import type { AlertPreferences, Monitor } from "../alerts/monitor-model.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

/** Alerts calls send only the organization header; see `server/alert-data.ts`. */
export interface AlertMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

export interface MonitorChange extends AlertMutation {
  readonly monitorId: string;
}

export function createMonitor({
  accessToken,
  body,
  idempotencyKey,
  organizationId,
}: AlertMutation & { readonly body: unknown }): Promise<Monitor> {
  return callRoute(
    "createMonitor",
    {
      body: decodeRequestBody("createMonitor", "CreateMonitorRequest", body),
      idempotencyKey,
      scope: { organizationId },
    },
    accessToken,
  );
}

/** Edits, mutes, and unmutes; an edit carries `expectedVersion`, so a stale dialog gets a 409. */
export function updateMonitor({
  accessToken,
  body,
  idempotencyKey,
  monitorId,
  organizationId,
}: MonitorChange & { readonly body: unknown }): Promise<Monitor> {
  return callRoute(
    "updateMonitor",
    {
      body: decodeRequestBody("updateMonitor", "UpdateMonitorRequest", body),
      idempotencyKey,
      path: { id: monitorId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export function archiveMonitor({
  accessToken,
  idempotencyKey,
  monitorId,
  organizationId,
}: MonitorChange): Promise<Monitor> {
  return callRoute(
    "archiveMonitor",
    { idempotencyKey, path: { id: monitorId }, scope: { organizationId } },
    accessToken,
  );
}

export function testMonitor({
  accessToken,
  idempotencyKey,
  monitorId,
  organizationId,
}: MonitorChange): Promise<RouteResponse<"testMonitor">> {
  return callRoute(
    "testMonitor",
    { idempotencyKey, path: { id: monitorId }, scope: { organizationId } },
    accessToken,
  );
}

export function putAlertPreferences({
  accessToken,
  body,
  organizationId,
}: Omit<AlertMutation, "idempotencyKey"> & { readonly body: unknown }): Promise<AlertPreferences> {
  return callRoute(
    "putAlertNotificationPreferences",
    {
      body: decodeRequestBody(
        "putAlertNotificationPreferences",
        "PutAlertNotificationPreferencesRequest",
        body,
      ),
      scope: { organizationId },
    },
    accessToken,
  );
}
