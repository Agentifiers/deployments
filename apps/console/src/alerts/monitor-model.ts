import {
  MONITOR_ROLE_VALUES,
  MonitorCondition,
  ORGANIZATION_MONITOR_KINDS,
  type CreateMonitorRequest,
  type MonitorKind,
  type UpdateMonitorRequest,
} from "@deployments-ai/api-contract/monitors";
import { Schema } from "effect";
import type { InstallCopy } from "../edition.ts";
import type { RouteResponse } from "../server/platform-api.ts";

export type Monitor = RouteResponse<"getMonitor">;
export type AlertIncident = RouteResponse<"getAlertIncident">;
export type AlertPreferences = RouteResponse<"getAlertNotificationPreferences">;
export type MonitorRole = (typeof MONITOR_ROLE_VALUES)[number];
/** Request bodies as the browser builds them; the server decodes them against the contract. */
export type CreateMonitorBody = typeof CreateMonitorRequest.Encoded;
export type UpdateMonitorBody = typeof UpdateMonitorRequest.Encoded;

export { MONITOR_ROLE_VALUES, type MonitorKind };

/** A condition field the form edits: a whole number with the contract's bounds, or an id. */
export type ConditionField =
  | {
      readonly kind: "number";
      readonly name: string;
      readonly label: string;
      readonly description: string;
      readonly unit?: string;
      readonly initial: number;
      readonly required: boolean;
    }
  | {
      readonly kind: "text";
      readonly name: string;
      readonly label: string;
      readonly description: string;
      readonly placeholder?: string;
    };

export interface MonitorKindCopy {
  readonly label: string;
  /** A function when what the monitor watches depends on who runs the install. */
  readonly summary: string | ((copy: InstallCopy) => string);
  readonly fields: readonly ConditionField[];
}

const DEPLOYMENT_FIELD: ConditionField = {
  description: "Leave empty to watch every deployment in the environment.",
  kind: "text",
  label: "Agent deployment ID",
  name: "agentDeploymentId",
  placeholder: "All deployments",
};

function counting(noun: string): readonly ConditionField[] {
  return [
    {
      description: `Fire when at least this many ${noun} inside the window.`,
      initial: 3,
      kind: "number",
      label: "Threshold",
      name: "threshold",
      required: true,
    },
    {
      description: "From 5 minutes to 24 hours.",
      initial: 15,
      kind: "number",
      label: "Window",
      name: "windowMinutes",
      required: true,
      unit: "minutes",
    },
  ];
}

const TRACE_WINDOW: readonly ConditionField[] = [
  {
    description: "From 1 to 24 hours.",
    initial: 1,
    kind: "number",
    label: "Window",
    name: "windowHours",
    required: true,
    unit: "hours",
  },
  {
    description: "Stay quiet until the window holds at least this many finished traces.",
    initial: 20,
    kind: "number",
    label: "Minimum traces",
    name: "minimumTraces",
    required: true,
  },
];

/**
 * What each kind watches and the fields its condition takes, keyed by the contract's closed set
 * of kinds so a kind added to the contract fails to compile here until the form covers it.
 */
export const MONITOR_KIND_COPY: Readonly<Record<MonitorKind, MonitorKindCopy>> = {
  "run-failures": {
    fields: [...counting("runs fail"), DEPLOYMENT_FIELD],
    label: "Run failures",
    summary: "Runs that fail in one environment, or for one deployment.",
  },
  "tool-failures": {
    fields: [
      ...counting("tool calls fail"),
      {
        description: "Leave empty to count every tool.",
        kind: "text",
        label: "Tool name",
        name: "toolName",
        placeholder: "All tools",
      },
    ],
    label: "Tool failures",
    summary: "Tool calls that fail in one environment.",
  },
  "schedule-problems": {
    fields: [
      ...counting("schedule fires are skipped or schedules expire"),
      {
        description: "Leave empty to watch every schedule in the environment.",
        kind: "text",
        label: "Schedule ID",
        name: "scheduleId",
        placeholder: "All schedules",
      },
    ],
    label: "Schedule skipped or expired",
    summary: "Schedule fires that were skipped, and schedules that expired.",
  },
  "approval-wait": {
    fields: [
      {
        description: "Fire when an approval has waited longer than this. From 5 minutes to 7 days.",
        initial: 60,
        kind: "number",
        label: "Wait",
        name: "waitMinutes",
        required: true,
        unit: "minutes",
      },
    ],
    label: "Approval waiting",
    summary: "Approvals that stay pending too long.",
  },
  "webhook-endpoint-health": {
    fields: [
      {
        description: "Leave empty to watch every endpoint in the environment.",
        kind: "text",
        label: "Webhook endpoint ID",
        name: "webhookEndpointId",
        placeholder: "All endpoints",
      },
      {
        description:
          "Also fire when an active endpoint has this many failed deliveries in a row. Leave empty to fire only when the platform disables it.",
        initial: 5,
        kind: "number",
        label: "Failed deliveries in a row",
        name: "consecutiveFailures",
        required: false,
      },
    ],
    label: "Webhook endpoint failing",
    summary: "Webhook endpoints that were disabled after failures or keep failing deliveries.",
  },
  "budget-threshold": {
    fields: [
      {
        description: "Fire when a budget crosses one of its alert thresholds at or above this.",
        initial: 80,
        kind: "number",
        label: "Minimum threshold",
        name: "minimumThreshold",
        required: true,
        unit: "percent",
      },
      {
        description: "Leave empty to watch every budget in the organization.",
        kind: "text",
        label: "Budget ID",
        name: "budgetId",
        placeholder: "All budgets",
      },
    ],
    label: "Budget threshold",
    summary: "Budgets whose spend crosses an alert threshold.",
  },
  "operator-spend-exhausted": {
    fields: [],
    label: "Included model spend exhausted",
    summary: (copy) => copy.includedSpendExhausted,
  },
  "trace-error-rate": {
    fields: [
      {
        description: "Fire when at least this share of finished traces ended in error.",
        initial: 10,
        kind: "number",
        label: "Error rate",
        name: "thresholdPercent",
        required: true,
        unit: "percent",
      },
      ...TRACE_WINDOW,
      DEPLOYMENT_FIELD,
    ],
    label: "Trace error rate",
    summary: "The share of traces that end in error, from observability metrics.",
  },
  "trace-latency": {
    fields: [
      {
        description: "Fire when the p95 trace duration reaches this.",
        initial: 30_000,
        kind: "number",
        label: "p95 latency",
        name: "p95Milliseconds",
        required: true,
        unit: "ms",
      },
      ...TRACE_WINDOW,
      DEPLOYMENT_FIELD,
    ],
    label: "Trace latency",
    summary: "How long traces take, from observability metrics.",
  },
};

export const MONITOR_KINDS = Object.keys(MONITOR_KIND_COPY) as readonly MonitorKind[];

export function isOrganizationKind(kind: MonitorKind): boolean {
  return (ORGANIZATION_MONITOR_KINDS as readonly MonitorKind[]).includes(kind);
}

export const ROLE_LABELS: Readonly<Record<MonitorRole, string>> = {
  admin: "Admins",
  billing: "Billing",
  member: "Members",
  owner: "Owners",
  viewer: "Viewers",
};

export const RENOTIFY_CHOICES = [
  { label: "Once per incident", minutes: undefined },
  { label: "Every hour", minutes: 60 },
  { label: "Every 4 hours", minutes: 240 },
  { label: "Every day", minutes: 1_440 },
] as const;

export type MonitorState = "archived" | "firing" | "muted" | "ok";

/** What the list shows for a monitor: archived and muted outrank whether it is firing. */
export function monitorState(monitor: Monitor, now: Date): MonitorState {
  if (monitor.status === "archived") return "archived";
  const muted =
    monitor.status === "muted" &&
    (monitor.mutedUntil === undefined || Date.parse(monitor.mutedUntil) > now.getTime());
  if (muted) return "muted";
  return monitor.state;
}

/** Text the form edits, one string per condition field, so empty optional fields stay empty. */
export interface MonitorDraft {
  readonly kind: MonitorKind;
  readonly name: string;
  readonly environmentId: string;
  readonly values: Readonly<Record<string, string>>;
  readonly emailRoles: readonly MonitorRole[];
  readonly emailPrincipalIds: readonly string[];
  readonly webhooks: boolean;
  readonly renotifyMinutes: number | undefined;
}

export function initialValues(kind: MonitorKind): Readonly<Record<string, string>> {
  return Object.fromEntries(
    MONITOR_KIND_COPY[kind].fields.map((field) => [
      field.name,
      field.kind === "number" && field.required ? String(field.initial) : "",
    ]),
  );
}

export function newMonitorDraft(kind: MonitorKind, environmentId: string): MonitorDraft {
  return {
    emailPrincipalIds: [],
    emailRoles: isOrganizationKind(kind) ? ["owner", "admin", "billing"] : ["owner", "admin"],
    environmentId,
    kind,
    name: "",
    renotifyMinutes: undefined,
    values: initialValues(kind),
    webhooks: !isOrganizationKind(kind),
  };
}

export function monitorDraft(monitor: Monitor): MonitorDraft {
  const condition = monitor.condition as Readonly<Record<string, unknown>>;
  return {
    emailPrincipalIds: monitor.notify.emailPrincipalIds,
    emailRoles: monitor.notify.emailRoles,
    environmentId: monitor.environmentId ?? "",
    kind: monitor.condition.kind,
    name: monitor.name,
    renotifyMinutes: monitor.renotifyMinutes,
    values: Object.fromEntries(
      MONITOR_KIND_COPY[monitor.condition.kind].fields.map((field) => {
        const value = condition[field.name];
        return [
          field.name,
          typeof value === "number" || typeof value === "string" ? String(value) : "",
        ];
      }),
    ),
    webhooks: monitor.notify.webhooks,
  };
}

export type DraftCheck<Body> =
  | { readonly ok: true; readonly body: Body }
  | { readonly ok: false; readonly field: string; readonly message: string };

const decodeCondition = Schema.decodeUnknownSync(MonitorCondition);

function issueField(cause: unknown): string {
  if (!Schema.isSchemaError(cause)) return "condition";
  const message = String(cause.message);
  const match = /at \["([^"]+)"\]/u.exec(message);
  return match?.[1] ?? "condition";
}

function issueMessage(cause: unknown): string {
  return String(cause instanceof Error ? cause.message : cause)
    .split("\n")[0]!
    .trim();
}

/** The draft's condition decoded against the contract, so the form and the API agree on bounds. */
export function checkCondition(draft: MonitorDraft): DraftCheck<MonitorCondition> {
  const raw: Record<string, unknown> = { kind: draft.kind };
  for (const field of MONITOR_KIND_COPY[draft.kind].fields) {
    const text = (draft.values[field.name] ?? "").trim();
    if (text === "") {
      if (field.kind === "number" && field.required) {
        return { field: field.name, message: `Enter a ${field.label.toLowerCase()}.`, ok: false };
      }
      continue;
    }
    raw[field.name] = field.kind === "number" ? Number(text) : text;
  }
  try {
    return { body: decodeCondition(raw), ok: true };
  } catch (cause) {
    return { field: issueField(cause), message: issueMessage(cause), ok: false };
  }
}

function checkName(draft: MonitorDraft) {
  const name = draft.name.trim();
  return name.length === 0 || name.length > 120 ? undefined : name;
}

function notifyOf(draft: MonitorDraft) {
  return {
    emailPrincipalIds: draft.emailPrincipalIds,
    emailRoles: draft.emailRoles,
    webhooks: draft.webhooks,
  };
}

/** The create body, with the environment's project for environment kinds. */
export function checkCreate(
  draft: MonitorDraft,
  projectOf: (environmentId: string) => string | undefined,
): DraftCheck<CreateMonitorBody> {
  const name = checkName(draft);
  if (!name)
    return { field: "name", message: "Name the monitor (1 to 120 characters).", ok: false };
  const condition = checkCondition(draft);
  if (!condition.ok) return condition;
  const notify = notifyOf(draft);
  const renotify =
    draft.renotifyMinutes === undefined ? {} : { renotifyMinutes: draft.renotifyMinutes };
  if (isOrganizationKind(draft.kind)) {
    return { body: { condition: condition.body, name, notify, ...renotify }, ok: true };
  }
  const projectId = projectOf(draft.environmentId);
  if (!projectId) return { field: "environmentId", message: "Choose an environment.", ok: false };
  return {
    body: {
      condition: condition.body,
      environmentId: draft.environmentId,
      name,
      notify,
      projectId,
      ...renotify,
    },
    ok: true,
  };
}

/** The update body: the whole editable configuration at the version the dialog opened on. */
export function checkUpdate(monitor: Monitor, draft: MonitorDraft): DraftCheck<UpdateMonitorBody> {
  const name = checkName(draft);
  if (!name)
    return { field: "name", message: "Name the monitor (1 to 120 characters).", ok: false };
  const condition = checkCondition(draft);
  if (!condition.ok) return condition;
  return {
    body: {
      condition: condition.body,
      expectedVersion: monitor.version,
      name,
      notify: notifyOf(draft),
      renotifyMinutes: draft.renotifyMinutes ?? null,
    },
    ok: true,
  };
}

/** A condition in one line, for the list and the detail header. */
export function describeCondition(condition: MonitorCondition): string {
  switch (condition.kind) {
    case "run-failures":
      return `${condition.threshold}+ failed runs in ${condition.windowMinutes} min`;
    case "tool-failures":
      return `${condition.threshold}+ failed ${condition.toolName ?? "tool"} calls in ${condition.windowMinutes} min`;
    case "schedule-problems":
      return `${condition.threshold}+ skipped or expired in ${condition.windowMinutes} min`;
    case "approval-wait":
      return `Pending longer than ${condition.waitMinutes} min`;
    case "webhook-endpoint-health":
      return condition.consecutiveFailures === undefined
        ? "Endpoint disabled after failures"
        : `Disabled, or ${condition.consecutiveFailures} failed deliveries in a row`;
    case "budget-threshold":
      return `Threshold at or above ${condition.minimumThreshold}%`;
    case "operator-spend-exhausted":
      return "Included spend used up";
    case "trace-error-rate":
      return `${condition.thresholdPercent}%+ errors over ${condition.windowHours} h`;
    case "trace-latency":
      return `p95 at or above ${condition.p95Milliseconds.toLocaleString("en-US")} ms over ${condition.windowHours} h`;
  }
}

export type MonitorAction = "archive" | "edit" | "mute" | "test" | "unmute";

/** What a monitor in each state can do next. */
export function monitorActions(monitor: Monitor, now: Date): readonly MonitorAction[] {
  const state = monitorState(monitor, now);
  if (state === "archived") return [];
  return ["edit", state === "muted" ? "unmute" : "mute", "test", "archive"];
}

export const MUTE_CHOICES = [
  { hours: 1, label: "For 1 hour" },
  { hours: 8, label: "For 8 hours" },
  { hours: 24, label: "For 1 day" },
  { hours: 168, label: "For 1 week" },
  { hours: undefined, label: "Until I unmute it" },
] as const;

export function muteBody(hours: number | undefined, now: Date): UpdateMonitorBody {
  return {
    mute:
      hours === undefined
        ? {}
        : { until: new Date(now.getTime() + hours * 3_600_000).toISOString() },
  };
}
