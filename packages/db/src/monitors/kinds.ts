import type { Ulid } from "../ids.ts";
import type { MonitorCondition, MonitorKind, MonitorNotify } from "../records/monitors.ts";
import type { SemanticEventData } from "../records/events.ts";

type SemanticEvent = typeof SemanticEventData.Type;
type ConditionOf<Kind extends MonitorKind> = Extract<MonitorCondition, { readonly kind: Kind }>;

/** Where a kind's facts come from, which decides how the evaluator observes it. */
export type MonitorSource =
  /** Matching events are stored as signals and counted over a sliding window. */
  | { readonly type: "window-count" }
  /** Each matching event is news: it stays active until a time the event names. */
  | { readonly type: "one-shot" }
  /** Current records decide; events only wake the evaluator early. */
  | { readonly type: "current-state" }
  /** Finalized-trace metrics from the observability hot plane. */
  | { readonly type: "hot-plane" };

/** A matching event: stored as a signal, or a reason to evaluate now. */
export type MonitorEventMatch =
  | { readonly type: "signal"; readonly activeUntil: string; readonly summary?: string }
  | { readonly type: "wake" };

export interface MonitorKindDefinition<Kind extends MonitorKind> {
  readonly label: string;
  /** Environment monitors watch one environment; organization monitors watch org-wide signals. */
  readonly scope: "environment" | "organization";
  readonly source: MonitorSource;
  /** Event types the event-driven evaluator routes to monitors of this kind. */
  readonly eventTypes: readonly string[];
  readonly match: (
    condition: ConditionOf<Kind>,
    event: SemanticEvent,
  ) => MonitorEventMatch | undefined;
}

const MINUTE = 60_000;
/** Counting signals outlive any window a monitor can be edited to, so widening one counts history. */
const MAX_WINDOW_MINUTES = 1_440;

function payloadString(event: SemanticEvent, field: string) {
  const value = event.payload[field];
  return typeof value === "string" ? value : undefined;
}

function payloadNumber(event: SemanticEvent, field: string) {
  const value = event.payload[field];
  return typeof value === "number" ? value : undefined;
}

function windowSignal(event: SemanticEvent): MonitorEventMatch {
  return {
    activeUntil: new Date(Date.parse(event.occurredAt) + MAX_WINDOW_MINUTES * MINUTE).toISOString(),
    type: "signal",
  };
}

function nextMonthStart(month: string) {
  const [year = 0, monthNumber = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString();
}

function dollars(micros: number | undefined) {
  return micros === undefined ? "?" : `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * The closed registry of monitor kinds. Adding a kind means adding its condition arm in
 * `records/monitors.ts` and its entry here; the compiler rejects a kind missing from either.
 */
export const MONITOR_KINDS: { readonly [Kind in MonitorKind]: MonitorKindDefinition<Kind> } = {
  "run-failures": {
    eventTypes: ["run.failed"],
    label: "Run failures",
    match: (condition, event) =>
      condition.agentDeploymentId === undefined ||
      payloadString(event, "agentDeploymentId") === condition.agentDeploymentId
        ? windowSignal(event)
        : undefined,
    scope: "environment",
    source: { type: "window-count" },
  },
  "tool-failures": {
    eventTypes: ["tool-call.failed"],
    label: "Tool failures",
    match: (condition, event) =>
      condition.toolName === undefined || payloadString(event, "toolName") === condition.toolName
        ? windowSignal(event)
        : undefined,
    scope: "environment",
    source: { type: "window-count" },
  },
  "schedule-problems": {
    eventTypes: ["schedule.skipped", "schedule.expired"],
    label: "Schedule skipped or expired",
    match: (condition, event) => {
      const scheduleId =
        event.eventType === "schedule.expired"
          ? event.aggregateId
          : payloadString(event, "scheduleId");
      return condition.scheduleId === undefined || scheduleId === condition.scheduleId
        ? windowSignal(event)
        : undefined;
    },
    scope: "environment",
    source: { type: "window-count" },
  },
  "approval-wait": {
    eventTypes: ["approval.requested", "approval.resolved"],
    label: "Approval waiting",
    match: () => ({ type: "wake" }),
    scope: "environment",
    source: { type: "current-state" },
  },
  "webhook-endpoint-health": {
    eventTypes: [
      "webhook.endpoint.archived",
      "webhook.endpoint.disabled",
      "webhook.endpoint.enabled",
      "webhook.endpoint.updated",
    ],
    label: "Webhook endpoint failing",
    match: (condition, event) =>
      condition.webhookEndpointId === undefined ||
      payloadString(event, "webhookEndpointId") === condition.webhookEndpointId
        ? { type: "wake" }
        : undefined,
    scope: "environment",
    source: { type: "current-state" },
  },
  "budget-threshold": {
    eventTypes: ["budget.threshold-crossed"],
    label: "Budget threshold",
    match: (condition, event) => {
      const threshold = payloadNumber(event, "threshold") ?? 0;
      const periodEnd = payloadString(event, "periodEnd");
      if (
        threshold < condition.minimumThreshold ||
        periodEnd === undefined ||
        (condition.budgetId !== undefined &&
          payloadString(event, "budgetId") !== condition.budgetId)
      ) {
        return undefined;
      }
      return {
        activeUntil: periodEnd,
        summary: `Budget ${payloadString(event, "budgetName") ?? ""} reached ${threshold}%: ${dollars(
          payloadNumber(event, "spendUsdMicros"),
        )} of ${dollars(payloadNumber(event, "amountUsdMicros"))}.`,
        type: "signal",
      };
    },
    scope: "organization",
    source: { type: "one-shot" },
  },
  "operator-spend-exhausted": {
    eventTypes: ["organization.operator-funded-spend-exhausted"],
    label: "Included model spend exhausted",
    match: (_condition, event) => {
      const month = payloadString(event, "month");
      return month === undefined
        ? undefined
        : {
            activeUntil: nextMonthStart(month),
            summary: `Included model spend for ${month} is used up: ${dollars(
              payloadNumber(event, "operatorFundedUsdMicros"),
            )} of ${dollars(payloadNumber(event, "ceilingUsdMicros"))}.`,
            type: "signal",
          };
    },
    scope: "organization",
    source: { type: "one-shot" },
  },
  "trace-error-rate": {
    eventTypes: [],
    label: "Trace error rate",
    match: () => undefined,
    scope: "environment",
    source: { type: "hot-plane" },
  },
  "trace-latency": {
    eventTypes: [],
    label: "Trace latency",
    match: () => undefined,
    scope: "environment",
    source: { type: "hot-plane" },
  },
};

export function monitorKind<Kind extends MonitorKind>(kind: Kind): MonitorKindDefinition<Kind> {
  return MONITOR_KINDS[kind];
}

/** Routes an event to a condition through its kind's matcher with the matching condition type. */
export function matchMonitorEvent(condition: MonitorCondition, event: SemanticEvent) {
  const definition = MONITOR_KINDS[condition.kind] as MonitorKindDefinition<MonitorKind>;
  return definition.eventTypes.includes(event.eventType)
    ? definition.match(condition as never, event)
    : undefined;
}

/** Event types any monitor kind listens to; the event-driven evaluator's subscription. */
export const MONITOR_EVENT_TYPES: readonly string[] = [
  ...new Set(Object.values(MONITOR_KINDS).flatMap((definition) => definition.eventTypes)),
];

/**
 * Organization alerts that existed before monitors: every organization gets one of each the first
 * time its event arrives, so budget and included-spend alerts keep reaching people by default.
 * The id is derived from the organization, so concurrent first events create it once.
 */
export const DEFAULT_ORGANIZATION_MONITORS: readonly {
  readonly condition: MonitorCondition;
  readonly name: string;
  readonly notify: MonitorNotify;
}[] = [
  {
    condition: { kind: "budget-threshold", minimumThreshold: 1 },
    name: "Budget alerts",
    notify: { emailPrincipalIds: [], emailRoles: ["owner", "admin", "billing"], webhooks: false },
  },
  {
    condition: { kind: "operator-spend-exhausted" },
    name: "Included model spend exhausted",
    notify: { emailPrincipalIds: [], emailRoles: ["owner", "admin", "billing"], webhooks: false },
  },
];

export type MonitorScope =
  | { readonly kind: "environment"; readonly environmentId: Ulid; readonly projectId: Ulid }
  | { readonly kind: "organization" };
