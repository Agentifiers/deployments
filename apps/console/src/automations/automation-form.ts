import type { Heartbeat, Schedule } from "./automation-state.ts";
import { sameValue } from "../lib/same-value.ts";
import { parseScheduleExpression, type RateUnit } from "./cadence.ts";

/** How a schedule fires, as the form edits it; each kind builds one EventBridge expression. */
export type CadenceDraft =
  | { readonly kind: "rate"; readonly every: string; readonly unit: RateUnit }
  | { readonly kind: "at"; readonly wallTime: string }
  | { readonly kind: "cron"; readonly fields: string };

export type CadenceKind = CadenceDraft["kind"];

export const CADENCE_KINDS: readonly { readonly kind: CadenceKind; readonly label: string }[] = [
  { kind: "rate", label: "Every interval" },
  { kind: "at", label: "Once" },
  { kind: "cron", label: "Calendar (cron)" },
];

export const RATE_UNITS: readonly RateUnit[] = ["minute", "hour", "day"];

export interface ScheduleDraft {
  readonly agentDeploymentId: string;
  readonly cadence: CadenceDraft;
  readonly name: string;
  readonly prompt: string;
  /** Pauses the schedule right after it is created, so its timer never fires until resumed. */
  readonly startPaused: boolean;
  readonly timezone: string;
  /** `""` runs outside any workspace. */
  readonly workspaceId: string;
}

export interface WindowDraft {
  /** 0 = Sunday; empty means every day. */
  readonly days: readonly number[];
  readonly enabled: boolean;
  /** `HH:MM`; an end of `00:00` means midnight at the end of the day. */
  readonly end: string;
  readonly start: string;
}

export interface HeartbeatDraft {
  readonly agentDeploymentId: string;
  /** Pauses the heartbeat right after it is created, so it never fires until resumed. */
  readonly startPaused: boolean;
  readonly instructions: string;
  readonly intervalMinutes: string;
  readonly skipWhenBusy: boolean;
  readonly timezone: string;
  readonly window: WindowDraft;
  readonly workspaceId: string;
}

type ActiveWindow = NonNullable<Heartbeat["activeWindow"]>;

export interface ScheduleCreateBody {
  readonly agentDeploymentId: string;
  readonly expression: string;
  readonly name: string;
  readonly prompt: string;
  readonly timezone: string;
  readonly workspaceId?: string;
}

export interface ScheduleChanges {
  readonly expression?: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly timezone?: string;
}

export interface HeartbeatCreateBody {
  readonly activeWindow?: ActiveWindow;
  readonly agentDeploymentId: string;
  readonly instructions: string;
  readonly intervalMs: number;
  readonly skipWhenBusy: boolean;
  readonly timezone: string;
  readonly workspaceId?: string;
}

export interface HeartbeatChanges {
  readonly activeWindow?: ActiveWindow | null;
  readonly instructions?: string;
  readonly intervalMs?: number;
  readonly skipWhenBusy?: boolean;
  readonly timezone?: string;
}

export type ScheduleField = "agentDeploymentId" | "cadence" | "name" | "prompt" | "timezone";
export type HeartbeatField =
  | "agentDeploymentId"
  | "instructions"
  | "intervalMinutes"
  | "timezone"
  | "window";

/** A form's verdict: the first invalid field, no change to save, or the request body. */
export type FormCheck<Field extends string, Body> =
  | { readonly kind: "invalid"; readonly field: Field }
  | { readonly kind: "unchanged" }
  | { readonly kind: "ready"; readonly body: Body };

const MINUTE_MS = 60_000;
const MAX_INTERVAL_MINUTES = 30 * 24 * 60;
const MAX_NAME = 120;
const MAX_PROMPT = 40_000;
const MAX_INSTRUCTIONS = 32_000;

export function isTimeZone(value: string): boolean {
  if (value === "" || value.length > 50) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The server trims nothing and refuses surrounding whitespace, so the form sends trimmed text. */
function text(value: string, max: number): string | undefined {
  const trimmed = value.trim();
  return trimmed !== "" && Array.from(trimmed).length <= max ? trimmed : undefined;
}

export function scheduleExpression(cadence: CadenceDraft): string | undefined {
  const raw = expressionText(cadence);
  return raw !== undefined && parseScheduleExpression(raw).kind !== "unparsed" ? raw : undefined;
}

function expressionText(cadence: CadenceDraft): string | undefined {
  switch (cadence.kind) {
    case "rate": {
      const every = Number(cadence.every);
      if (!Number.isSafeInteger(every) || every < 1) return undefined;
      return `rate(${every} ${cadence.unit}${every === 1 ? "" : "s"})`;
    }
    case "at":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(cadence.wallTime)
        ? `at(${cadence.wallTime}:00)`
        : `at(${cadence.wallTime})`;
    case "cron":
      return `cron(${cadence.fields.trim().replaceAll(/\s+/gu, " ")})`;
  }
}

/** The form's cadence for a stored expression; an unparsed one opens as raw cron fields. */
export function cadenceDraft(raw: string): CadenceDraft {
  const expression = parseScheduleExpression(raw);
  switch (expression.kind) {
    case "rate":
      return { every: String(expression.every), kind: "rate", unit: expression.unit };
    case "at":
      return { kind: "at", wallTime: expression.wallTime };
    case "cron":
    case "unparsed":
      return { fields: /^\s*cron\((.*)\)\s*$/u.exec(raw)?.[1]?.trim() ?? raw, kind: "cron" };
  }
}

export function checkScheduleCreate(
  draft: ScheduleDraft,
): FormCheck<ScheduleField, ScheduleCreateBody> {
  const name = text(draft.name, MAX_NAME);
  if (name === undefined) return { field: "name", kind: "invalid" };
  if (draft.agentDeploymentId === "") return { field: "agentDeploymentId", kind: "invalid" };
  const expression = scheduleExpression(draft.cadence);
  if (expression === undefined) return { field: "cadence", kind: "invalid" };
  const timezone = draft.timezone.trim();
  if (!isTimeZone(timezone)) return { field: "timezone", kind: "invalid" };
  const prompt = text(draft.prompt, MAX_PROMPT);
  if (prompt === undefined) return { field: "prompt", kind: "invalid" };
  return {
    body: {
      agentDeploymentId: draft.agentDeploymentId,
      expression,
      name,
      prompt,
      timezone,
      ...(draft.workspaceId === "" ? {} : { workspaceId: draft.workspaceId }),
    },
    kind: "ready",
  };
}

export function scheduleEditDraft(schedule: Schedule): ScheduleDraft {
  return {
    agentDeploymentId: schedule.agentDeploymentId,
    cadence: cadenceDraft(schedule.schedule.expression),
    name: schedule.name,
    prompt: schedule.prompt ?? "",
    startPaused: false,
    timezone: schedule.schedule.timezone ?? "UTC",
    workspaceId: schedule.workspaceId ?? "",
  };
}

/** The values an edit compares, keyed by the update body's field names. */
export function scheduleValues(schedule: Schedule): Readonly<Record<string, unknown>> {
  return {
    expression: schedule.schedule.expression,
    name: schedule.name,
    prompt: schedule.prompt,
    timezone: schedule.schedule.timezone ?? "UTC",
  };
}

export function checkScheduleEdit(
  base: Schedule,
  draft: ScheduleDraft,
): FormCheck<ScheduleField, ScheduleChanges> {
  const checked = checkScheduleCreate({ ...draft, agentDeploymentId: base.agentDeploymentId });
  if (checked.kind !== "ready") return checked;
  return changedFields(scheduleValues(base), {
    expression: checked.body.expression,
    name: checked.body.name,
    prompt: checked.body.prompt,
    timezone: checked.body.timezone,
  });
}

function minuteOfDay(clock: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/u.exec(clock);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  return match && hours <= 23 && minutes <= 59 ? hours * 60 + minutes : undefined;
}

function clock(minute: number): string {
  const wrapped = minute % 1_440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function activeWindow(window: WindowDraft): ActiveWindow | null | undefined {
  if (!window.enabled) return null;
  const start = minuteOfDay(window.start);
  const end = minuteOfDay(window.end);
  if (start === undefined || end === undefined) return undefined;
  const endMinuteOfDay = end === 0 ? 1_440 : end;
  if (endMinuteOfDay <= start) return undefined;
  const days = [...new Set(window.days)].toSorted((left, right) => left - right);
  return {
    endMinuteOfDay,
    startMinuteOfDay: start,
    ...(days.length === 0 || days.length === 7 ? {} : { daysOfWeek: days }),
  };
}

export function checkHeartbeatCreate(
  draft: HeartbeatDraft,
): FormCheck<HeartbeatField, HeartbeatCreateBody> {
  if (draft.agentDeploymentId === "") return { field: "agentDeploymentId", kind: "invalid" };
  const minutes = Number(draft.intervalMinutes);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MINUTES) {
    return { field: "intervalMinutes", kind: "invalid" };
  }
  const timezone = draft.timezone.trim();
  if (!isTimeZone(timezone)) return { field: "timezone", kind: "invalid" };
  const window = activeWindow(draft.window);
  if (window === undefined) return { field: "window", kind: "invalid" };
  const instructions = text(draft.instructions, MAX_INSTRUCTIONS);
  if (instructions === undefined) return { field: "instructions", kind: "invalid" };
  return {
    body: {
      agentDeploymentId: draft.agentDeploymentId,
      instructions,
      intervalMs: minutes * MINUTE_MS,
      skipWhenBusy: draft.skipWhenBusy,
      timezone,
      ...(window === null ? {} : { activeWindow: window }),
      ...(draft.workspaceId === "" ? {} : { workspaceId: draft.workspaceId }),
    },
    kind: "ready",
  };
}

const DEFAULT_WINDOW: WindowDraft = { days: [], enabled: false, end: "17:00", start: "09:00" };

export function heartbeatEditDraft(heartbeat: Heartbeat): HeartbeatDraft {
  const { activeWindow: window, schedule } = heartbeat;
  return {
    agentDeploymentId: heartbeat.agentDeploymentId,
    instructions: schedule.instructions,
    intervalMinutes: String(schedule.intervalMs / MINUTE_MS),
    skipWhenBusy: schedule.skipWhenBusy,
    startPaused: false,
    timezone: schedule.timezone ?? "UTC",
    window: window
      ? {
          days: window.daysOfWeek ?? [],
          enabled: true,
          end: clock(window.endMinuteOfDay),
          start: clock(window.startMinuteOfDay),
        }
      : DEFAULT_WINDOW,
    workspaceId: heartbeat.workspaceId ?? "",
  };
}

export function heartbeatValues(heartbeat: Heartbeat): Readonly<Record<string, unknown>> {
  return {
    activeWindow: heartbeat.activeWindow ?? null,
    instructions: heartbeat.schedule.instructions,
    intervalMs: heartbeat.schedule.intervalMs,
    skipWhenBusy: heartbeat.schedule.skipWhenBusy,
    timezone: heartbeat.schedule.timezone ?? "UTC",
  };
}

export function checkHeartbeatEdit(
  base: Heartbeat,
  draft: HeartbeatDraft,
): FormCheck<HeartbeatField, HeartbeatChanges> {
  const checked = checkHeartbeatCreate({ ...draft, agentDeploymentId: base.agentDeploymentId });
  if (checked.kind !== "ready") return checked;
  const { body } = checked;
  return changedFields(heartbeatValues(base), {
    activeWindow: body.activeWindow ?? null,
    instructions: body.instructions,
    intervalMs: body.intervalMs,
    skipWhenBusy: body.skipWhenBusy,
    timezone: body.timezone,
  });
}

function changedFields<Body extends object, Field extends string>(
  current: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): FormCheck<Field, Body> {
  const body = Object.fromEntries(
    Object.entries(next).filter(([field, value]) => !sameValue(current[field], value)),
  );
  return Object.keys(body).length === 0
    ? { kind: "unchanged" }
    : { body: body as Body, kind: "ready" };
}

export function newScheduleDraft(timezone: string): ScheduleDraft {
  return {
    agentDeploymentId: "",
    cadence: { every: "1", kind: "rate", unit: "day" },
    name: "",
    prompt: "",
    startPaused: false,
    timezone,
    workspaceId: "",
  };
}

export function newHeartbeatDraft(timezone: string): HeartbeatDraft {
  return {
    agentDeploymentId: "",
    instructions: "",
    intervalMinutes: "60",
    skipWhenBusy: true,
    startPaused: false,
    timezone,
    window: DEFAULT_WINDOW,
    workspaceId: "",
  };
}
