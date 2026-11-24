import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";

const OrganizationRole = Schema.Literals(["admin", "billing", "member", "owner", "viewer"]);

function boundedInteger(minimum: number, maximum: number) {
  return Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(minimum),
      Schema.isLessThanOrEqualTo(maximum),
    ),
  );
}

const Threshold = boundedInteger(1, 1_000);
const WindowMinutes = boundedInteger(5, 1_440);
const WindowHours = boundedInteger(1, 24);

/**
 * What a monitor watches. The closed set of kinds is the registry in `monitors/kinds.ts`; each
 * arm carries only the fields its kind evaluates.
 */
export const MonitorCondition = Schema.Union([
  Schema.Struct({
    agentDeploymentId: Schema.optionalKey(Ulid),
    kind: Schema.Literal("run-failures"),
    threshold: Threshold,
    windowMinutes: WindowMinutes,
  }),
  Schema.Struct({
    kind: Schema.Literal("tool-failures"),
    threshold: Threshold,
    toolName: Schema.optionalKey(NonEmptyString),
    windowMinutes: WindowMinutes,
  }),
  Schema.Struct({
    kind: Schema.Literal("schedule-problems"),
    scheduleId: Schema.optionalKey(Ulid),
    threshold: Threshold,
    windowMinutes: WindowMinutes,
  }),
  Schema.Struct({
    kind: Schema.Literal("approval-wait"),
    waitMinutes: boundedInteger(5, 10_080),
  }),
  Schema.Struct({
    /** Also fire on an active endpoint with this many deliveries in a row that exhausted retries. */
    consecutiveFailures: Schema.optionalKey(boundedInteger(1, 1_000)),
    kind: Schema.Literal("webhook-endpoint-health"),
    webhookEndpointId: Schema.optionalKey(Ulid),
  }),
  Schema.Struct({
    budgetId: Schema.optionalKey(Ulid),
    kind: Schema.Literal("budget-threshold"),
    minimumThreshold: boundedInteger(1, 100),
  }),
  Schema.Struct({ kind: Schema.Literal("operator-spend-exhausted") }),
  Schema.Struct({
    agentDeploymentId: Schema.optionalKey(Ulid),
    kind: Schema.Literal("trace-error-rate"),
    minimumTraces: boundedInteger(1, 100_000),
    thresholdPercent: boundedInteger(1, 100),
    windowHours: WindowHours,
  }),
  Schema.Struct({
    agentDeploymentId: Schema.optionalKey(Ulid),
    kind: Schema.Literal("trace-latency"),
    minimumTraces: boundedInteger(1, 100_000),
    p95Milliseconds: boundedInteger(100, 3_600_000),
    windowHours: WindowHours,
  }),
]);
export type MonitorCondition = typeof MonitorCondition.Type;
export type MonitorKind = MonitorCondition["kind"];

/** Who hears about a monitor's incidents. Email goes only to members of the organization. */
export const MonitorNotify = Schema.Struct({
  emailPrincipalIds: Schema.Array(Ulid).pipe(Schema.check(Schema.isMaxLength(50))),
  emailRoles: Schema.Array(OrganizationRole),
  webhooks: Schema.Boolean,
});
export type MonitorNotify = typeof MonitorNotify.Type;

export const MonitorStatus = Schema.Literals(["active", "archived", "muted"]);
export type MonitorStatus = typeof MonitorStatus.Type;

/**
 * A configured alert. Environment kinds name the environment and its project; organization kinds
 * name neither. `muted` monitors still open and resolve incidents but notify nobody.
 */
export const MonitorRecord = makeRecordSchema("monitor", {
  ...mutableResourceFields,
  archivedAt: Schema.optionalKey(Timestamp),
  condition: MonitorCondition,
  environmentId: Schema.optionalKey(Ulid),
  id: Ulid,
  mutedUntil: Schema.optionalKey(Timestamp),
  name: NonEmptyString,
  notify: MonitorNotify,
  organizationId: Ulid,
  projectId: Schema.optionalKey(Ulid),
  /** Repeat the fired notification this often while the incident stays open. */
  renotifyMinutes: Schema.optionalKey(boundedInteger(15, 10_080)),
  status: MonitorStatus,
});
export type MonitorRecord = typeof MonitorRecord.Type;

/**
 * The monitor's evaluation state and the one write every evaluator races on: opening, repeating,
 * and resolving an incident all replace this record at its version, so concurrent and retried
 * evaluations converge on one incident. Kept apart from `monitor` so configuration edits and
 * evaluation never conflict. A sharded index lists every live state for the scheduled evaluator.
 */
export const MonitorStateRecord = makeRecordSchema("monitor-state", {
  ...mutableResourceFields,
  environmentId: Schema.optionalKey(Ulid),
  firingSince: Schema.optionalKey(Timestamp),
  /** An incident opened by a one-time event (a budget crossing) resolves itself at this time. */
  firingUntil: Schema.optionalKey(Timestamp),
  incidentId: Schema.optionalKey(Ulid),
  lastNotifiedAt: Schema.optionalKey(Timestamp),
  monitorId: Ulid,
  organizationId: Ulid,
  /** One-time events already applied, so a redelivered event changes nothing. */
  appliedEventIds: Schema.optionalKey(
    Schema.Array(Ulid).pipe(Schema.check(Schema.isMaxLength(20))),
  ),
  phase: Schema.Literals(["firing", "ok"]),
  projectId: Schema.optionalKey(Ulid),
});
export type MonitorStateRecord = typeof MonitorStateRecord.Type;

/** One event a counting monitor observed, alive until it leaves the monitor's window. */
export const MonitorSignalRecord = makeRecordSchema(
  "monitor-signal",
  {
    activeUntil: Timestamp,
    eventId: Ulid,
    eventType: NonEmptyString,
    monitorId: Ulid,
    occurredAt: Timestamp,
    organizationId: Ulid,
  },
  { expiresAtField: "activeUntil" },
);
export type MonitorSignalRecord = typeof MonitorSignalRecord.Type;

export const MonitorIncidentTimelineEntry = Schema.Struct({
  at: Timestamp,
  notified: Schema.Boolean,
  summary: Schema.String,
  type: Schema.Literals(["fired", "renotified", "resolved"]),
  value: Schema.optionalKey(Schema.Number),
});
export type MonitorIncidentTimelineEntry = typeof MonitorIncidentTimelineEntry.Type;

export const MonitorIncidentResolution = Schema.Literals([
  "condition-cleared",
  "monitor-archived",
  "monitor-changed",
]);

/** One firing of a monitor, from fired to resolved, with what happened in between. */
export const MonitorIncidentRecord = makeRecordSchema("monitor-incident", {
  ...mutableResourceFields,
  environmentId: Schema.optionalKey(Ulid),
  id: Ulid,
  kind: NonEmptyString,
  monitorId: Ulid,
  monitorName: NonEmptyString,
  openedAt: Timestamp,
  organizationId: Ulid,
  projectId: Schema.optionalKey(Ulid),
  resolution: Schema.optionalKey(MonitorIncidentResolution),
  resolvedAt: Schema.optionalKey(Timestamp),
  status: Schema.Literals(["firing", "resolved"]),
  summary: Schema.String,
  timeline: Schema.Array(MonitorIncidentTimelineEntry).pipe(Schema.check(Schema.isMaxLength(50))),
});
export type MonitorIncidentRecord = typeof MonitorIncidentRecord.Type;

/**
 * A member's alert email choice in one organization. Absent means every alert they are a
 * recipient of; `none` stops all of them; `mutedMonitorIds` stops individual monitors.
 */
export const AlertNotificationPreferenceRecord = makeRecordSchema("alert-notification-preference", {
  ...mutableResourceFields,
  email: Schema.Literals(["all", "none"]),
  mutedMonitorIds: Schema.Array(Ulid).pipe(Schema.check(Schema.isMaxLength(200))),
  organizationId: Ulid,
  principalId: Ulid,
});
export type AlertNotificationPreferenceRecord = typeof AlertNotificationPreferenceRecord.Type;

/**
 * Claim that one alert event's email to one member was handed to the mail sender. Written before
 * the send, so a retried event skips members already sent to. A `failed` send, or a claim older
 * than the sender's timeout (the sender crashed), may be taken again until the attempt budget.
 */
export const AlertEmailDeliveryRecord = makeRecordSchema(
  "alert-email-delivery",
  {
    attempts: NonNegativeSafeInteger,
    claimedAt: Timestamp,
    eventId: Ulid,
    expiresAt: Timestamp,
    organizationId: Ulid,
    principalId: Ulid,
    sentAt: Schema.optionalKey(Timestamp),
    status: Schema.Literals(["abandoned", "claimed", "failed", "sent"]),
    version: NonNegativeSafeInteger,
  },
  { expiresAtField: "expiresAt" },
);
export type AlertEmailDeliveryRecord = typeof AlertEmailDeliveryRecord.Type;

export const MONITOR_CONTROL_RECORD_SCHEMAS = {
  "alert-notification-preference": AlertNotificationPreferenceRecord,
  monitor: MonitorRecord,
  "monitor-state": MonitorStateRecord,
} as const;

export const MONITOR_EVENTS_RECORD_SCHEMAS = {
  "alert-email-delivery": AlertEmailDeliveryRecord,
  "monitor-incident": MonitorIncidentRecord,
  "monitor-signal": MonitorSignalRecord,
} as const;
