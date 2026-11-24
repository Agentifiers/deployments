import type { Ulid } from "../ids.ts";
import type { MonitorIncidentRecord, MonitorRecord } from "../records/monitors.ts";
import { makeSemanticEventRecord } from "../semantic-event-storage.ts";

/** Customer-visible alert events, delivered to webhook endpoints that list them. */
export const ALERT_FIRED_EVENT = "alert.fired";
export const ALERT_RENOTIFIED_EVENT = "alert.renotified";
export const ALERT_RESOLVED_EVENT = "alert.resolved";
export const MONITOR_TEST_EVENT = "alert.test";

export type AlertEventType =
  | typeof ALERT_FIRED_EVENT
  | typeof ALERT_RENOTIFIED_EVENT
  | typeof ALERT_RESOLVED_EVENT
  | typeof MONITOR_TEST_EVENT;

/**
 * Whether people were told. Each alert event carries the recipients' channels so the email worker
 * and webhook fan-out act on the decision the state machine made, not on a later read.
 */
export interface AlertDelivery {
  readonly email: boolean;
  readonly webhooks: boolean;
}

/** One semantic event on the incident's aggregate, numbered by the incident's version. */
export function alertEvent(input: {
  readonly delivery: AlertDelivery;
  readonly eventId: Ulid;
  readonly eventType: Exclude<AlertEventType, typeof MONITOR_TEST_EVENT>;
  readonly incident: MonitorIncidentRecord;
  readonly monitor: MonitorRecord;
  readonly occurredAt: string;
}) {
  const { incident, monitor } = input;
  return makeSemanticEventRecord({
    actor: { type: "system" },
    aggregateId: incident.data.id,
    aggregateType: "monitor-incident",
    aggregateVersion: incident.data.version,
    ...(incident.data.environmentId ? { environmentId: incident.data.environmentId } : {}),
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    organizationId: incident.data.organizationId,
    payload: {
      deliverEmail: input.delivery.email,
      deliverWebhooks: input.delivery.webhooks,
      incidentId: incident.data.id,
      kind: incident.data.kind,
      monitorId: monitor.data.id,
      monitorName: monitor.data.name,
      openedAt: incident.data.openedAt,
      ...(incident.data.resolvedAt ? { resolvedAt: incident.data.resolvedAt } : {}),
      status: incident.data.status,
      summary: incident.data.timeline.at(-1)?.summary ?? incident.data.summary,
    },
    ...(incident.data.projectId ? { projectId: incident.data.projectId } : {}),
  });
}

/**
 * A test notification for one monitor: email to the member who asked, and webhooks when the
 * monitor delivers to them. Its own one-event aggregate, so a test never touches incident history.
 */
export function alertTestEvent(input: {
  readonly eventId: Ulid;
  readonly monitor: MonitorRecord;
  readonly occurredAt: string;
  readonly requestedByPrincipalId: Ulid;
}) {
  const { monitor } = input;
  return makeSemanticEventRecord({
    actor: { id: input.requestedByPrincipalId, type: "principal" },
    aggregateId: input.eventId,
    aggregateType: "monitor-test",
    aggregateVersion: 1,
    ...(monitor.data.environmentId ? { environmentId: monitor.data.environmentId } : {}),
    eventId: input.eventId,
    eventType: MONITOR_TEST_EVENT,
    occurredAt: input.occurredAt,
    organizationId: monitor.data.organizationId,
    payload: {
      deliverEmail: true,
      deliverWebhooks: monitor.data.notify.webhooks,
      emailPrincipalId: input.requestedByPrincipalId,
      kind: monitor.data.condition.kind,
      monitorId: monitor.data.id,
      monitorName: monitor.data.name,
      openedAt: input.occurredAt,
      status: "test",
      summary: "This is a test notification. Nothing is wrong.",
    },
    ...(monitor.data.projectId ? { projectId: monitor.data.projectId } : {}),
  });
}
