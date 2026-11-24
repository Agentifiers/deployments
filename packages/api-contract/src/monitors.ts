import { Schema } from "effect";
import { Cursor, PublicId, ResourceName, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

/** The closed set of monitor kinds; each names the signal it watches. */
export const MONITOR_KIND_VALUES = [
  "run-failures",
  "tool-failures",
  "schedule-problems",
  "approval-wait",
  "webhook-endpoint-health",
  "budget-threshold",
  "operator-spend-exhausted",
  "trace-error-rate",
  "trace-latency",
] as const;
export type MonitorKind = (typeof MONITOR_KIND_VALUES)[number];

/** Kinds that watch the whole organization rather than one environment. */
export const ORGANIZATION_MONITOR_KINDS = [
  "budget-threshold",
  "operator-spend-exhausted",
] as const satisfies readonly MonitorKind[];

export const MONITOR_ROLE_VALUES = ["owner", "admin", "billing", "member", "viewer"] as const;
export const MAX_MONITORS_PAGE_LIMIT = 100;
export const MAX_ALERT_INCIDENTS_PAGE_LIMIT = 50;

function bounded(minimum: number, maximum: number, label: string) {
  return Schema.Number.pipe(
    Schema.check(
      Schema.isInt({ message: `${label} must be a whole number.` }),
      Schema.isGreaterThanOrEqualTo(minimum, { message: `${label} must be at least ${minimum}.` }),
      Schema.isLessThanOrEqualTo(maximum, { message: `${label} must be at most ${maximum}.` }),
    ),
  );
}

const Threshold = bounded(1, 1_000, "The threshold");
const WindowMinutes = bounded(5, 1_440, "The window");
const WindowHours = bounded(1, 24, "The window");
const MinimumTraces = bounded(1, 100_000, "The minimum trace count");
const ToolName = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200)));

/** What a monitor watches. Each arm carries only the fields its kind evaluates. */
export const MonitorCondition = Schema.Union([
  Schema.Struct({
    agentDeploymentId: Schema.optionalKey(PublicId),
    kind: Schema.Literal("run-failures"),
    threshold: Threshold,
    windowMinutes: WindowMinutes,
  }),
  Schema.Struct({
    kind: Schema.Literal("tool-failures"),
    threshold: Threshold,
    toolName: Schema.optionalKey(ToolName),
    windowMinutes: WindowMinutes,
  }),
  Schema.Struct({
    kind: Schema.Literal("schedule-problems"),
    scheduleId: Schema.optionalKey(PublicId),
    threshold: Threshold,
    windowMinutes: WindowMinutes,
  }),
  Schema.Struct({
    kind: Schema.Literal("approval-wait"),
    waitMinutes: bounded(5, 10_080, "The wait"),
  }),
  Schema.Struct({
    consecutiveFailures: Schema.optionalKey(bounded(1, 1_000, "The failure count")),
    kind: Schema.Literal("webhook-endpoint-health"),
    webhookEndpointId: Schema.optionalKey(PublicId),
  }),
  Schema.Struct({
    budgetId: Schema.optionalKey(PublicId),
    kind: Schema.Literal("budget-threshold"),
    minimumThreshold: bounded(1, 100, "The minimum threshold"),
  }),
  Schema.Struct({ kind: Schema.Literal("operator-spend-exhausted") }),
  Schema.Struct({
    agentDeploymentId: Schema.optionalKey(PublicId),
    kind: Schema.Literal("trace-error-rate"),
    minimumTraces: MinimumTraces,
    thresholdPercent: bounded(1, 100, "The error rate"),
    windowHours: WindowHours,
  }),
  Schema.Struct({
    agentDeploymentId: Schema.optionalKey(PublicId),
    kind: Schema.Literal("trace-latency"),
    minimumTraces: MinimumTraces,
    p95Milliseconds: bounded(100, 3_600_000, "The latency"),
    windowHours: WindowHours,
  }),
]);
export type MonitorCondition = typeof MonitorCondition.Type;

/** Who hears about incidents. Email goes only to members of the organization. */
export const MonitorNotify = Schema.Struct({
  emailPrincipalIds: Schema.Array(PublicId).pipe(Schema.check(Schema.isMaxLength(50))),
  emailRoles: Schema.Array(Schema.Literals(MONITOR_ROLE_VALUES)),
  webhooks: Schema.Boolean,
});

const RenotifyMinutes = bounded(15, 10_080, "The repeat interval");

export const MonitorResponse = Schema.Struct({
  archivedAt: Schema.optional(Timestamp),
  condition: MonitorCondition,
  createdAt: Timestamp,
  environmentId: Schema.optional(PublicId),
  id: PublicId,
  mutedUntil: Schema.optional(Timestamp),
  name: ResourceName,
  notify: MonitorNotify,
  organizationId: PublicId,
  projectId: Schema.optional(PublicId),
  renotifyMinutes: Schema.optional(RenotifyMinutes),
  /** Whether an incident is open now. */
  state: Schema.Literals(["firing", "ok"]),
  status: Schema.Literals(["active", "archived", "muted"]),
  updatedAt: Timestamp,
  version: Schema.Number,
});

export const ListMonitorsResponse = Schema.Struct({
  items: Schema.Array(MonitorResponse),
  nextCursor: Schema.optional(Cursor),
});

/** Environment kinds name the environment and its project; organization kinds name neither. */
export const CreateMonitorRequest = Schema.Struct({
  condition: MonitorCondition,
  environmentId: Schema.optional(PublicId),
  name: ResourceName,
  notify: MonitorNotify,
  projectId: Schema.optional(PublicId),
  renotifyMinutes: Schema.optional(RenotifyMinutes),
});

/** `mute: {}` mutes until unmuted, `mute: { until }` until then, and `mute: null` unmutes. */
export const UpdateMonitorRequest = Schema.Struct({
  condition: Schema.optional(MonitorCondition),
  expectedVersion: Schema.optional(Schema.Number),
  mute: Schema.optional(Schema.NullOr(Schema.Struct({ until: Schema.optional(Timestamp) }))),
  name: Schema.optional(ResourceName),
  notify: Schema.optional(MonitorNotify),
  renotifyMinutes: Schema.optional(Schema.NullOr(RenotifyMinutes)),
}).pipe(
  Schema.check(
    Schema.isMinProperties(1, { message: "Monitor updates must change at least one property." }),
  ),
);

export const TestMonitorResponse = Schema.Struct({ eventId: PublicId });

export const AlertIncidentTimelineEntry = Schema.Struct({
  at: Timestamp,
  notified: Schema.Boolean,
  summary: Schema.String,
  type: Schema.Literals(["fired", "renotified", "resolved"]),
  value: Schema.optional(Schema.Number),
});

export const AlertIncidentResponse = Schema.Struct({
  environmentId: Schema.optional(PublicId),
  id: PublicId,
  kind: Schema.Literals(MONITOR_KIND_VALUES),
  monitorId: PublicId,
  monitorName: Schema.String,
  openedAt: Timestamp,
  organizationId: PublicId,
  projectId: Schema.optional(PublicId),
  resolution: Schema.optional(
    Schema.Literals(["condition-cleared", "monitor-archived", "monitor-changed"]),
  ),
  resolvedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["firing", "resolved"]),
  summary: Schema.String,
  timeline: Schema.Array(AlertIncidentTimelineEntry),
});

export const ListAlertIncidentsResponse = Schema.Struct({
  items: Schema.Array(AlertIncidentResponse),
  nextCursor: Schema.optional(Cursor),
});

export const AlertNotificationPreferencesResponse = Schema.Struct({
  email: Schema.Literals(["all", "none"]),
  mutedMonitorIds: Schema.Array(PublicId),
});

export const PutAlertNotificationPreferencesRequest = Schema.Struct({
  email: Schema.Literals(["all", "none"]),
  mutedMonitorIds: Schema.Array(PublicId).pipe(Schema.check(Schema.isMaxLength(200))),
});

export const MONITOR_API_SCHEMAS = {
  AlertIncidentResponse,
  AlertNotificationPreferencesResponse,
  CreateMonitorRequest,
  ListAlertIncidentsResponse,
  ListMonitorsResponse,
  MonitorResponse,
  PutAlertNotificationPreferencesRequest,
  TestMonitorResponse,
  UpdateMonitorRequest,
} as const;

const readErrors = [400, 401, 403, 404, 422] as const;
const mutationErrors = [400, 401, 403, 404, 409, 422, 429] as const;
const cursor = {
  name: "cursor",
  schema: { maxLength: 4_096, minLength: 1, type: "string" },
} as const;

function limit(maximum: number) {
  return { name: "limit", schema: { maximum, minimum: 1, type: "integer" } } as const;
}

const environmentFilter = {
  description: "Only monitors or incidents of this environment.",
  name: "environmentId",
  schema: { type: "string" },
} as const;

export const MONITOR_API_ROUTES = [
  {
    authentication: "platform-bearer",
    errors: readErrors,
    idempotency: "none",
    method: "GET",
    name: "listMonitors",
    path: "/v1/monitors",
    queryParameters: [cursor, limit(MAX_MONITORS_PAGE_LIMIT), environmentFilter],
    requiredAuthorization: "monitors:read",
    responseBody: "ListMonitorsResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: mutationErrors,
    idempotency: "required",
    method: "POST",
    name: "createMonitor",
    path: "/v1/monitors",
    requestBody: "CreateMonitorRequest",
    requiredAuthorization: "monitors:write",
    responseBody: "MonitorResponse",
    scopeHeaders: "organization",
    successStatus: 201,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: readErrors,
    idempotency: "none",
    method: "GET",
    name: "getMonitor",
    path: "/v1/monitors/:id",
    requiredAuthorization: "monitors:read",
    responseBody: "MonitorResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: mutationErrors,
    idempotency: "required",
    method: "PATCH",
    name: "updateMonitor",
    path: "/v1/monitors/:id",
    requestBody: "UpdateMonitorRequest",
    requiredAuthorization: "monitors:write",
    responseBody: "MonitorResponse",
    scopeHeaders: "organization",
    standing: "remediation",
    successStatus: 200,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: mutationErrors,
    idempotency: "required",
    method: "DELETE",
    name: "archiveMonitor",
    path: "/v1/monitors/:id",
    requiredAuthorization: "monitors:write",
    responseBody: "MonitorResponse",
    scopeHeaders: "organization",
    standing: "remediation",
    successStatus: 200,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: mutationErrors,
    idempotency: "optional",
    method: "POST",
    name: "testMonitor",
    path: "/v1/monitors/:id/test",
    requiredAuthorization: "monitors:write",
    responseBody: "TestMonitorResponse",
    scopeHeaders: "organization",
    successStatus: 202,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: readErrors,
    idempotency: "none",
    method: "GET",
    name: "listAlertIncidents",
    path: "/v1/alert-incidents",
    queryParameters: [cursor, limit(MAX_ALERT_INCIDENTS_PAGE_LIMIT), environmentFilter],
    requiredAuthorization: "monitors:read",
    responseBody: "ListAlertIncidentsResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: readErrors,
    idempotency: "none",
    method: "GET",
    name: "getAlertIncident",
    path: "/v1/monitors/:id/incidents/:incidentId",
    requiredAuthorization: "monitors:read",
    responseBody: "AlertIncidentResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: readErrors,
    idempotency: "none",
    method: "GET",
    name: "getAlertNotificationPreferences",
    path: "/v1/alert-notification-preferences",
    principals: ["human"],
    requiredAuthorization: "monitors:read",
    responseBody: "AlertNotificationPreferencesResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Alerts",
  },
  {
    authentication: "platform-bearer",
    errors: mutationErrors,
    idempotency: "none",
    method: "PUT",
    name: "putAlertNotificationPreferences",
    path: "/v1/alert-notification-preferences",
    principals: ["human"],
    requestBody: "PutAlertNotificationPreferencesRequest",
    requestBodyRequired: true,
    requiredAuthorization: "monitors:read",
    responseBody: "AlertNotificationPreferencesResponse",
    scopeHeaders: "organization",
    standing: "remediation",
    successStatus: 200,
    tag: "Alerts",
  },
] as const satisfies readonly PublicApiRouteContract[];

export type MonitorApiRouteName = (typeof MONITOR_API_ROUTES)[number]["name"];
