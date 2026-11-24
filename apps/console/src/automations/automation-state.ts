import type { ConsoleOperation, OperationAccess } from "../access.ts";
import { oneOf } from "../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import type { RouteResponse } from "../server/platform-api.ts";
import { nextScheduleFires, parseScheduleExpression, type Cadence } from "./cadence.ts";

export type Schedule = RouteResponse<"getSchedule">;
export type Heartbeat = RouteResponse<"getHeartbeat">;
export type ScheduleFire = RouteResponse<"listScheduleFires">["fires"][number];
export type HeartbeatFire = RouteResponse<"listHeartbeatFires">["fires"][number];
export type AutomationKind = "heartbeat" | "schedule";
export type AutomationStatus = Heartbeat["status"];
export type AutomationAction = "archive" | "fire" | "pause" | "resume";

export type AutomationEntry =
  | { readonly kind: "schedule"; readonly schedule: Schedule }
  | { readonly kind: "heartbeat"; readonly heartbeat: Heartbeat };

/** `unrecorded` is an automation written before creators were recorded. */
export type AutomationOrigin =
  | {
      readonly kind: "agent-tool";
      readonly toolName: string;
      readonly runId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "caller";
      readonly actorType: NonNullable<Schedule["createdBy"]>["type"];
      readonly actorId?: string;
    }
  | { readonly kind: "unrecorded" };

export type ThreadBinding =
  | { readonly kind: "continues"; readonly threadId: string }
  | { readonly kind: "new-thread-per-fire" };

/** `beyond-horizon`: a cron with no match in the five years the console searches. */
export type NextFire =
  | { readonly kind: "at"; readonly at: string; readonly estimate: boolean }
  | {
      readonly kind: "none";
      readonly reason: "beyond-horizon" | "inactive" | "passed" | "unparsed";
    };

export type AutomationHealth =
  | { readonly kind: "ok" }
  | { readonly kind: "stuck-provisioning"; readonly since: string }
  | { readonly kind: "missed-fire"; readonly expectedAt: string }
  | { readonly kind: "last-fire-without-run"; readonly at: string };

export interface FireRow {
  readonly id: string;
  readonly at: string;
  readonly scheduledFor?: string;
  readonly source: "manual" | "timer" | "unknown";
  readonly outcome: "not-started" | "skipped" | "started";
  readonly reason?: string;
  readonly runId?: string;
  readonly threadId?: string;
}

interface RecordFields {
  readonly id: string;
  readonly version: number;
  readonly label: string;
  readonly status: AutomationStatus;
  readonly agentDeploymentId: string;
  readonly thread: ThreadBinding;
  readonly origin: AutomationOrigin;
  readonly updatedAt: string;
}

/**
 * The fields the list, agent tab, and thread views read, without fire history. Prompts and
 * instructions stay on the server, and a schedule keeps its expression as text, which
 * `automationRow` parses.
 */
export type AutomationRecord =
  | (RecordFields & {
      readonly kind: "schedule";
      readonly cadence: Omit<ScheduleCadence, "expression">;
    })
  | (RecordFields & {
      readonly kind: "heartbeat";
      readonly cadence: HeartbeatCadence;
      readonly nextRunAt?: string;
    });

/** `unavailable` means the read failed; the row still renders. */
export type LastFire =
  | { readonly kind: "fired"; readonly fire: FireRow }
  | { readonly kind: "never" }
  | { readonly kind: "unavailable" };

export type AutomationRow = (ParsedSchedule | HeartbeatRecord) & {
  readonly nextFire: NextFire;
  readonly lastFire: LastFire;
  readonly health: AutomationHealth;
};

export interface AutomationFilters {
  readonly agentDeploymentId?: string;
  readonly kind?: AutomationKind;
  readonly origin?: "agent" | "caller";
  readonly show?: "all";
}

export const AUTOMATION_KINDS = {
  heartbeat: {
    label: "Heartbeat",
    operations: {
      archive: "archiveHeartbeat",
      fire: "fireHeartbeat",
      get: "getHeartbeat",
      listFires: "listHeartbeatFires",
      pause: "pauseHeartbeat",
      resume: "resumeHeartbeat",
    },
    segment: "heartbeats",
  },
  schedule: {
    label: "Schedule",
    operations: {
      archive: "archiveSchedule",
      fire: "fireSchedule",
      get: "getSchedule",
      listFires: "listScheduleFires",
      pause: "pauseSchedule",
      resume: "resumeSchedule",
    },
    segment: "schedules",
  },
} as const satisfies Readonly<
  Record<
    AutomationKind,
    {
      readonly label: string;
      readonly segment: "heartbeats" | "schedules";
      readonly operations: Readonly<
        Record<AutomationAction | "get" | "listFires", ConsoleOperation>
      >;
    }
  >
>;

type ActionOperation = (typeof AUTOMATION_KINDS)[AutomationKind]["operations"][AutomationAction];

/** `resume` on a provisioning automation retries timer provisioning. */
export const STATUS_ACTIONS: Readonly<Record<AutomationStatus, readonly AutomationAction[]>> = {
  active: ["fire", "pause", "archive"],
  archived: [],
  disabled: [],
  paused: ["resume", "archive"],
  provisioning: ["resume", "pause", "archive"],
};

const BUSY = "Another run was in progress";
const OUTSIDE_ACTIVE_WINDOW = "Outside the active window";

/** Heartbeat skip reasons, in the order the fire handler checks them. */
export const SKIP_REASON_TEXT: Readonly<Record<string, string>> = {
  "stale-schedule-version": "The heartbeat changed after this fire was scheduled",
  "not-active": "The heartbeat was not active",
  "workspace-unavailable": "The workspace was unavailable",
  "thread-unavailable": "The thread was unavailable",
  "outside-active-window": OUTSIDE_ACTIVE_WINDOW,
  busy: BUSY,
  "budget-exhausted": "A spend budget refused the run",
  "organization-suspended": "The organization was suspended",
};

/** Skips the heartbeat's own settings ask for, which are not a health problem. */
const EXPECTED_SKIPS: Readonly<Record<string, true>> = {
  [BUSY]: true,
  [OUTSIDE_ACTIVE_WINDOW]: true,
};

/** A failed schedule fire does not record which of these causes applied. */
const FAILED_FIRE_REASON =
  "The schedule was not active, the fire was for an earlier version, the thread or workspace was unavailable, a spend budget refused the run, or the organization was suspended";

const MINUTE_MS = 60_000;
const STUCK_PROVISIONING_MS = 5 * MINUTE_MS;
const MISSED_FIRE_GRACE_MS = 10 * MINUTE_MS;
const LABEL_LENGTH = 60;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
/** Timer fires carry their scheduled time as the fire key; manual fires carry the caller's key. */
const SCHEDULED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

type ScheduleCadence = Extract<Cadence, { readonly kind: "schedule" }>;
type HeartbeatCadence = Extract<Cadence, { readonly kind: "heartbeat" }>;
type ScheduleRecord = Extract<AutomationRecord, { readonly kind: "schedule" }>;
type ParsedSchedule = Omit<ScheduleRecord, "cadence"> & { readonly cadence: ScheduleCadence };
type HeartbeatRecord = Extract<AutomationRecord, { readonly kind: "heartbeat" }>;

interface Timing {
  readonly nextFire: NextFire;
  readonly missedAt?: string;
}

const INACTIVE: NextFire = { kind: "none", reason: "inactive" };

function instructionsLabel(instructions: string): string {
  const [firstLine = ""] = instructions.trimStart().split("\n", 1);
  const line = firstLine.trim();
  return line.length > LABEL_LENGTH ? `${line.slice(0, LABEL_LENGTH - 1)}…` : line;
}

export function automationLabel(entry: AutomationEntry): string {
  return entry.kind === "schedule"
    ? entry.schedule.name
    : instructionsLabel(entry.heartbeat.schedule.instructions);
}

function scheduleCadence(schedule: Schedule): ScheduleRecord["cadence"] {
  return {
    kind: "schedule",
    raw: schedule.schedule.expression,
    timeZone: schedule.schedule.timezone ?? "UTC",
  };
}

function heartbeatCadence(heartbeat: Heartbeat): HeartbeatCadence {
  const { activeWindow, schedule } = heartbeat;
  return {
    intervalMs: schedule.intervalMs,
    kind: "heartbeat",
    skipWhenBusy: schedule.skipWhenBusy,
    timeZone: schedule.timezone ?? "UTC",
    ...(activeWindow
      ? {
          window: {
            endMinuteOfDay: activeWindow.endMinuteOfDay,
            startMinuteOfDay: activeWindow.startMinuteOfDay,
            ...(activeWindow.daysOfWeek ? { daysOfWeek: activeWindow.daysOfWeek } : {}),
          },
        }
      : {}),
  };
}

const isOverdue = (expectedMs: number, now: Date) =>
  now.getTime() - expectedMs > MISSED_FIRE_GRACE_MS;

/** A rate() steps from its last timer fire; before one exists, `updatedAt` approximates the start. */
function rateAnchor(record: ParsedSchedule, fire: FireRow | undefined) {
  return fire?.scheduledFor === undefined
    ? { estimate: true, scheduledFor: record.updatedAt }
    : { estimate: false, scheduledFor: fire.scheduledFor };
}

function scheduleTiming(record: ParsedSchedule, lastFire: LastFire, now: Date): Timing {
  const { cadence } = record;
  const { expression } = cadence;
  if (record.status !== "active") return { nextFire: INACTIVE };
  if (expression.kind === "unparsed") return { nextFire: { kind: "none", reason: "unparsed" } };
  const fire = lastFire.kind === "fired" ? lastFire.fire : undefined;
  const anchor = expression.kind === "rate" ? rateAnchor(record, fire) : undefined;
  const [next] = nextScheduleFires(cadence, now, 1, anchor);
  const nextFire: NextFire =
    next === undefined
      ? { kind: "none", reason: expression.kind === "at" ? "passed" : "beyond-horizon" }
      : { at: next, estimate: anchor?.estimate ?? false, kind: "at" };
  // Without the last fire, `updatedAt` is the only baseline, and a schedule that fires on time
  // would read as missed.
  if (lastFire.kind === "unavailable") return { nextFire };
  // Resuming or editing writes updatedAt without firing, so expect a fire after whichever is later.
  const lastFired = fire?.scheduledFor ?? fire?.at;
  const since =
    lastFired !== undefined && Date.parse(lastFired) > Date.parse(record.updatedAt)
      ? lastFired
      : record.updatedAt;
  const [expected] = nextScheduleFires(cadence, new Date(since), 1, anchor);
  return {
    nextFire,
    ...(expected !== undefined && isOverdue(Date.parse(expected), now)
      ? { missedAt: expected }
      : {}),
  };
}

/** Resuming writes updatedAt but leaves nextRunAt, so a nextRunAt before updatedAt is stale. */
function heartbeatTiming(record: HeartbeatRecord, now: Date): Timing {
  if (record.status !== "active") return { nextFire: INACTIVE };
  const { intervalMs } = record.cadence;
  const updatedAt = Date.parse(record.updatedAt);
  const nextRunAt = record.nextRunAt === undefined ? undefined : Date.parse(record.nextRunAt);
  const expected =
    nextRunAt !== undefined && nextRunAt >= updatedAt ? nextRunAt : updatedAt + intervalMs;
  const elapsed = now.getTime() - expected;
  const steps = elapsed < 0 ? 0 : Math.floor(elapsed / intervalMs) + 1;
  return {
    nextFire: {
      at: new Date(expected + steps * intervalMs).toISOString(),
      estimate: steps > 0,
      kind: "at",
    },
    ...(isOverdue(expected, now) ? { missedAt: new Date(expected).toISOString() } : {}),
  };
}

function automationHealth(
  record: Pick<AutomationRecord, "status" | "updatedAt">,
  missedAt: string | undefined,
  lastFire: LastFire,
  now: Date,
): AutomationHealth {
  if (record.status === "archived" || record.status === "disabled") return { kind: "ok" };
  if (
    record.status === "provisioning" &&
    now.getTime() - Date.parse(record.updatedAt) > STUCK_PROVISIONING_MS
  ) {
    return { kind: "stuck-provisioning", since: record.updatedAt };
  }
  if (missedAt !== undefined) return { expectedAt: missedAt, kind: "missed-fire" };
  if (
    lastFire.kind === "fired" &&
    lastFire.fire.outcome !== "started" &&
    !(lastFire.fire.reason !== undefined && EXPECTED_SKIPS[lastFire.fire.reason])
  ) {
    return { at: lastFire.fire.at, kind: "last-fire-without-run" };
  }
  return { kind: "ok" };
}

export function automationOrigin(fields: {
  readonly createdBy?: Schedule["createdBy"];
  readonly createdFrom?: Schedule["createdFrom"];
}): AutomationOrigin {
  const { createdBy, createdFrom } = fields;
  if (createdFrom) {
    return {
      kind: "agent-tool",
      runId: createdFrom.runId,
      threadId: createdFrom.threadId,
      toolName: createdFrom.toolName,
    };
  }
  if (createdBy) {
    return {
      actorType: createdBy.type,
      kind: "caller",
      ...(createdBy.id ? { actorId: createdBy.id } : {}),
    };
  }
  return { kind: "unrecorded" };
}

export function automationRecord(entry: AutomationEntry): AutomationRecord {
  const record = entry.kind === "schedule" ? entry.schedule : entry.heartbeat;
  const fields: RecordFields = {
    agentDeploymentId: record.agentDeploymentId,
    id: record.id,
    label: automationLabel(entry),
    origin: automationOrigin(record),
    status: record.status,
    thread:
      record.threadId === undefined
        ? { kind: "new-thread-per-fire" }
        : { kind: "continues", threadId: record.threadId },
    updatedAt: record.updatedAt,
    version: record.version,
  };
  if (entry.kind === "schedule") {
    return { ...fields, cadence: scheduleCadence(entry.schedule), kind: "schedule" };
  }
  const { nextRunAt } = entry.heartbeat;
  return {
    ...fields,
    cadence: heartbeatCadence(entry.heartbeat),
    kind: "heartbeat",
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
  };
}

export function automationRow(
  record: AutomationRecord,
  lastFire: LastFire,
  now: Date,
): AutomationRow {
  const parsed: ParsedSchedule | HeartbeatRecord =
    record.kind === "schedule"
      ? {
          ...record,
          cadence: { ...record.cadence, expression: parseScheduleExpression(record.cadence.raw) },
        }
      : record;
  const { missedAt, nextFire } =
    parsed.kind === "schedule"
      ? scheduleTiming(parsed, lastFire, now)
      : heartbeatTiming(parsed, now);
  return {
    ...parsed,
    health: automationHealth(parsed, missedAt, lastFire, now),
    lastFire,
    nextFire,
  };
}

/** A duplicate repeats an earlier fire's key; a run on it is that earlier fire's run. */
function scheduleOutcome(fire: ScheduleFire): Pick<FireRow, "outcome" | "reason"> {
  switch (fire.status) {
    case "accepted":
      return { outcome: "started" };
    case "duplicate":
      return fire.runId
        ? { outcome: "started" }
        : { outcome: "not-started", reason: "Duplicate of an earlier fire" };
    case "failed":
      return { outcome: "not-started", reason: FAILED_FIRE_REASON };
  }
}

function heartbeatOutcome(fire: HeartbeatFire): Pick<FireRow, "outcome" | "reason"> {
  if (fire.status === "accepted") return { outcome: "started" };
  const code = fire.skipReason;
  return {
    outcome: "skipped",
    ...(code === undefined ? {} : { reason: SKIP_REASON_TEXT[code] ?? code }),
  };
}

/** `fire.object` already names the kind; `_kind` keeps the shared call signature. */
export function fireRow(_kind: AutomationKind, fire: HeartbeatFire | ScheduleFire): FireRow {
  const run = {
    ...(fire.runId ? { runId: fire.runId } : {}),
    ...(fire.threadId ? { threadId: fire.threadId } : {}),
  };
  switch (fire.object) {
    case "schedule-fire":
      return {
        at: fire.firedAt,
        id: fire.id,
        ...scheduleOutcome(fire),
        ...(SCHEDULED_TIME.test(fire.fireKey)
          ? { scheduledFor: fire.fireKey, source: "timer" }
          : { source: "manual" }),
        ...run,
      };
    case "heartbeat-run":
      return {
        at: fire.createdAt,
        id: fire.id,
        ...heartbeatOutcome(fire),
        source: "unknown",
        ...run,
      };
  }
}

export function availableActions(
  row: Pick<AutomationRow, "kind" | "status">,
  access: Pick<OperationAccess, ActionOperation>,
): readonly AutomationAction[] {
  const { operations } = AUTOMATION_KINDS[row.kind];
  return STATUS_ACTIONS[row.status].filter((action) => access[operations[action]]);
}

/** An active at() schedule archives after any fire, whether or not a run starts. */
export function fireConsumesSchedule(row: AutomationRow): boolean {
  return (
    row.status === "active" &&
    row.cadence.kind === "schedule" &&
    row.cadence.expression.kind === "at"
  );
}

/** Resuming, or retrying provisioning of, an at() schedule whose time has passed only archives it. */
export function resumeBlockedReason(row: AutomationRow, now: Date): string | undefined {
  const { cadence } = row;
  return (row.status === "paused" || row.status === "provisioning") &&
    cadence.kind === "schedule" &&
    cadence.expression.kind === "at" &&
    nextScheduleFires(cadence, now, 1).length === 0
    ? "The one-time time has passed, so this schedule cannot fire again. Archive it instead."
    : undefined;
}

export function parseAutomationFilters(
  search: Readonly<Record<string, unknown>>,
): AutomationFilters {
  const { agentDeploymentId } = search;
  const kind = oneOf(["heartbeat", "schedule"], search.kind);
  const origin = oneOf(["agent", "caller"], search.origin);
  return {
    ...(typeof agentDeploymentId === "string" && ULID.test(agentDeploymentId)
      ? { agentDeploymentId }
      : {}),
    ...(kind ? { kind } : {}),
    ...(origin ? { origin } : {}),
    ...(search.show === "all" ? { show: "all" } : {}),
  };
}

export function automationPath(
  scope: EnvironmentScope,
  ref: { readonly kind: AutomationKind; readonly id: string },
): string {
  return `${environmentPath(scope)}/automations/${AUTOMATION_KINDS[ref.kind].segment}/${ref.id}`;
}
