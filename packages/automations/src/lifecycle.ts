import {
  HeartbeatRecord,
  Metadata,
  ScheduleRecord,
  Ulid,
  makeAutomationPersistence,
  withCanonicalRecordKeys,
  type AutomationRecordLocator,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { AutomationError } from "./errors.ts";
import type { AutomationDependencies, AutomationScope } from "./index.ts";
import {
  finishTimerProvisioning,
  MIN_HEARTBEAT_INTERVAL_MS,
  scheduleExpression,
} from "./timer-provisioning.ts";
import {
  creationControlConditions,
  requireActiveThread,
  requireActiveWorkspace,
  requireRunnableDeployment,
  validateScheduleExpression,
} from "./creation.ts";
import { validateHeartbeatActiveWindow } from "./validation.ts";

type Schedule = Extract<PlatformRecord, { readonly itemType: "schedule" }>;
type Heartbeat = Extract<PlatformRecord, { readonly itemType: "heartbeat" }>;
type Automation = Schedule | Heartbeat;

const MAX_HEARTBEAT_INTERVAL_MS = 30 * 24 * 60 * 60_000;

async function record(dependencies: AutomationDependencies, locator: AutomationRecordLocator) {
  return makeAutomationPersistence(dependencies.database).get(locator);
}

function expected<T extends "heartbeat" | "schedule">(
  value: PlatformRecord | undefined,
  itemType: T,
): Extract<PlatformRecord, { readonly itemType: T }> {
  if (!value || value.itemType !== itemType) {
    throw new AutomationError("not_found", `${itemType} was not found.`);
  }
  return value as Extract<PlatformRecord, { readonly itemType: T }>;
}

function assertScope(value: Automation, scope: AutomationScope) {
  if (
    value.data.organizationId !== scope.organizationId ||
    value.data.projectId !== scope.projectId ||
    value.data.environmentId !== scope.environmentId ||
    (scope.workspaceId !== undefined && value.data.workspaceId !== scope.workspaceId)
  ) {
    throw new AutomationError("scope_mismatch", `${value.itemType} does not match the scope.`);
  }
}

async function heartbeatDeploymentId(
  scope: AutomationScope,
  heartbeatId: Ulid,
  dependencies: AutomationDependencies,
) {
  const event = await record(dependencies, {
    aggregateId: heartbeatId,
    aggregateType: "heartbeat",
    kind: "creation-event",
    organizationId: scope.organizationId,
  });
  const value =
    event?.itemType === "semantic-event" && event.data.eventType === "heartbeat.created"
      ? event.data.payload.agentDeploymentId
      : undefined;
  if (typeof value !== "string") {
    throw new AutomationError("not_found", "heartbeat was not found.");
  }
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new AutomationError("not_found", "heartbeat was not found.");
  }
}

export async function getSchedule(
  input: AutomationScope & { readonly scheduleId: Ulid },
  dependencies: AutomationDependencies,
) {
  const value = expected(
    await record(dependencies, {
      environmentId: input.environmentId,
      id: input.scheduleId,
      itemType: "schedule",
      kind: "environment-resource",
      organizationId: input.organizationId,
    }),
    "schedule",
  );
  assertScope(value, input);
  return value;
}

export async function getHeartbeat(
  input: AutomationScope & { readonly heartbeatId: Ulid },
  dependencies: AutomationDependencies,
) {
  const deploymentId = await heartbeatDeploymentId(input, input.heartbeatId, dependencies);
  const value = expected(
    await record(dependencies, {
      agentDeploymentId: deploymentId,
      heartbeatId: input.heartbeatId,
      kind: "heartbeat",
      organizationId: input.organizationId,
    }),
    "heartbeat",
  );
  assertScope(value, input);
  return value;
}

function text(value: string | undefined, label: string, maximumCharacters: number) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized !== value || Array.from(normalized).length > maximumCharacters) {
    throw new AutomationError(
      "invalid_request",
      `${label} must be trimmed and contain 1 to ${maximumCharacters} characters.`,
    );
  }
  return normalized;
}

function timezone(value: string): string;
function timezone(value: null): null;
function timezone(value: undefined): undefined;
function timezone(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const normalized = text(value, "Timezone", 50)!;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
  } catch {
    throw new AutomationError("invalid_timezone", "Timezone must be a valid IANA timezone.");
  }
  return normalized;
}

function heartbeatInterval(value: number | undefined) {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_HEARTBEAT_INTERVAL_MS ||
    value > MAX_HEARTBEAT_INTERVAL_MS ||
    value % MIN_HEARTBEAT_INTERVAL_MS !== 0
  ) {
    throw new AutomationError(
      "invalid_interval",
      "Heartbeat interval must be a whole number of minutes from 1 minute to 30 days.",
    );
  }
  return value;
}

async function persistTransition<T extends Automation>(
  previous: T,
  next: T,
  eventType: string,
  dependencies: AutomationDependencies,
  conditions: readonly TransactionOperation[] = [],
) {
  const event = makeSemanticEventRecord({
    aggregateId: next.data.id,
    aggregateType: next.itemType,
    aggregateVersion: next.data.version + 1,
    environmentId: next.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType,
    occurredAt: next.data.updatedAt,
    organizationId: next.data.organizationId,
    payload: { status: next.data.status },
    projectId: next.data.projectId,
  });
  await transactWithSemanticEvents(
    dependencies.database,
    [{ kind: "put", previousRecord: previous, record: next }, ...conditions],
    [event],
  );
  return next;
}

function scheduleRecord(data: Schedule["data"]) {
  return Schema.decodeUnknownSync(ScheduleRecord)(
    withCanonicalRecordKeys({ data, itemType: "schedule" as const }),
  );
}

function heartbeatRecord(data: Heartbeat["data"]) {
  return Schema.decodeUnknownSync(HeartbeatRecord)(
    withCanonicalRecordKeys({ data, itemType: "heartbeat" as const }),
  );
}

async function setTimerEnabled(
  record: Automation,
  enabled: boolean,
  dependencies: AutomationDependencies,
) {
  if (!dependencies.timerProvider) return;
  const scheduleVersion =
    typeof record.data.schedule.timerVersion === "number"
      ? record.data.schedule.timerVersion
      : record.data.version;
  if (record.itemType === "schedule") {
    await dependencies.timerProvider.upsert({
      enabled,
      expression: scheduleExpression(record),
      kind: "schedule",
      payload: {
        environmentId: record.data.environmentId,
        organizationId: record.data.organizationId,
        projectId: record.data.projectId,
        scheduleId: record.data.id,
        scheduleVersion,
      },
      scheduleId: record.data.id,
      ...(typeof record.data.schedule.timezone === "string"
        ? { timezone: record.data.schedule.timezone }
        : {}),
    });
    return;
  }
  const minutes = Number(record.data.schedule.intervalMs) / MIN_HEARTBEAT_INTERVAL_MS;
  await dependencies.timerProvider.upsert({
    enabled,
    expression: `rate(${minutes} ${minutes === 1 ? "minute" : "minutes"})`,
    kind: "heartbeat",
    payload: {
      agentDeploymentId: record.data.agentDeploymentId,
      environmentId: record.data.environmentId,
      heartbeatId: record.data.id,
      organizationId: record.data.organizationId,
      projectId: record.data.projectId,
      scheduleVersion,
    },
    scheduleId: record.data.id,
    ...(typeof record.data.schedule.timezone === "string"
      ? { timezone: record.data.schedule.timezone }
      : {}),
  });
}

export async function updateSchedule(
  input: AutomationScope & {
    readonly expression?: string;
    readonly name?: string;
    readonly prompt?: string;
    readonly scheduleId: Ulid;
    readonly timezone?: string | null;
  },
  dependencies: AutomationDependencies,
) {
  const previous = await getSchedule(input, dependencies);
  if (previous.data.status === "archived") {
    throw new AutomationError("automation_archived", "Archived schedules cannot be updated.");
  }
  const now = dependencies.now?.() ?? new Date();
  const timerChanged = input.expression !== undefined || input.timezone !== undefined;
  const nextStatus =
    previous.data.status === "active" && timerChanged ? "provisioning" : previous.data.status;
  const previousTimerVersion =
    typeof previous.data.schedule.timerVersion === "number"
      ? previous.data.schedule.timerVersion
      : previous.data.version;
  const { timezone: _previousTimezone, ...scheduleWithoutTimezone } = previous.data.schedule;
  const schedule = input.timezone === null ? scheduleWithoutTimezone : previous.data.schedule;
  const {
    timerActivationPending: _timerActivationPending,
    timerActivationValidated: _timerActivationValidated,
    ...scheduleWithoutPending
  } = schedule;
  const next = scheduleRecord({
    ...previous.data,
    ...(input.name === undefined ? {} : { name: text(input.name, "Schedule name", 120)! }),
    ...(input.prompt === undefined
      ? {}
      : { prompt: text(input.prompt, "Schedule prompt", 40_000)! }),
    schedule: {
      ...(timerChanged ? scheduleWithoutPending : schedule),
      ...(input.expression === undefined
        ? {}
        : { expression: validateScheduleExpression(input.expression) }),
      ...(typeof input.timezone === "string" ? { timezone: timezone(input.timezone) } : {}),
      ...(timerChanged
        ? { timerVersion: previousTimerVersion + 1 }
        : typeof previous.data.schedule.timerVersion === "number"
          ? {}
          : { timerVersion: previousTimerVersion }),
    },
    status: nextStatus,
    updatedAt: now.toISOString(),
    version: previous.data.version + 1,
  });
  const persisted = await persistTransition(previous, next, "schedule.updated", dependencies);
  if (
    persisted.data.status === "provisioning" ||
    persisted.data.schedule.timerActivationPending === true
  ) {
    return (await finishTimerProvisioning(persisted, dependencies, () =>
      resumeControlConditions(persisted, dependencies),
    )) as Schedule;
  }
  if (timerChanged && dependencies.timerProvider) {
    await dependencies.timerProvider.upsert({
      enabled: false,
      expression: scheduleExpression(persisted),
      kind: "schedule",
      payload: {
        environmentId: persisted.data.environmentId,
        organizationId: persisted.data.organizationId,
        projectId: persisted.data.projectId,
        scheduleId: persisted.data.id,
        scheduleVersion:
          typeof persisted.data.schedule.timerVersion === "number"
            ? persisted.data.schedule.timerVersion
            : persisted.data.version,
      },
      scheduleId: persisted.data.id,
      ...(typeof persisted.data.schedule.timezone === "string"
        ? { timezone: persisted.data.schedule.timezone }
        : {}),
    });
  }
  return persisted;
}

export async function updateHeartbeat(
  input: AutomationScope & {
    readonly activeWindow?: Readonly<Record<string, unknown>> | null;
    readonly heartbeatId: Ulid;
    readonly instructions?: string;
    readonly intervalMs?: number;
    readonly skipWhenBusy?: boolean;
    readonly timezone?: string | null;
  },
  dependencies: AutomationDependencies,
) {
  const previous = await getHeartbeat(input, dependencies);
  if (previous.data.status === "archived" || previous.data.status === "disabled") {
    throw new AutomationError("automation_archived", "Archived heartbeats cannot be updated.");
  }
  const intervalMs = heartbeatInterval(input.intervalMs);
  const activeWindow =
    input.activeWindow === undefined
      ? undefined
      : input.activeWindow === null
        ? null
        : Schema.decodeUnknownSync(Metadata)(validateHeartbeatActiveWindow(input.activeWindow));
  const now = dependencies.now?.() ?? new Date();
  const timerChanged = input.intervalMs !== undefined || input.timezone !== undefined;
  const nextStatus =
    previous.data.status === "active" && timerChanged ? "provisioning" : previous.data.status;
  const previousTimerVersion =
    typeof previous.data.schedule.timerVersion === "number"
      ? previous.data.schedule.timerVersion
      : previous.data.version;
  const { activeWindow: _previousActiveWindow, ...heartbeatWithoutActiveWindow } = previous.data;
  const heartbeat = activeWindow === null ? heartbeatWithoutActiveWindow : previous.data;
  const { timezone: _previousTimezone, ...scheduleWithoutTimezone } = previous.data.schedule;
  const schedule = input.timezone === null ? scheduleWithoutTimezone : previous.data.schedule;
  const {
    timerActivationPending: _timerActivationPending,
    timerActivationValidated: _timerActivationValidated,
    ...scheduleWithoutPending
  } = schedule;
  const next = heartbeatRecord({
    ...heartbeat,
    ...(activeWindow === undefined || activeWindow === null ? {} : { activeWindow }),
    ...(intervalMs === undefined
      ? {}
      : { nextRunAt: new Date(now.getTime() + intervalMs).toISOString() }),
    schedule: {
      ...(timerChanged ? scheduleWithoutPending : schedule),
      ...(input.instructions === undefined
        ? {}
        : {
            instructions: text(input.instructions, "Heartbeat instructions", 32_000)!,
          }),
      ...(intervalMs === undefined ? {} : { intervalMs }),
      ...(input.skipWhenBusy === undefined ? {} : { skipWhenBusy: input.skipWhenBusy }),
      ...(typeof input.timezone === "string" ? { timezone: timezone(input.timezone) } : {}),
      ...(timerChanged
        ? { timerVersion: previousTimerVersion + 1 }
        : typeof previous.data.schedule.timerVersion === "number"
          ? {}
          : { timerVersion: previousTimerVersion }),
    },
    status: nextStatus,
    updatedAt: now.toISOString(),
    version: previous.data.version + 1,
  });
  const persisted = await persistTransition(previous, next, "heartbeat.updated", dependencies);
  if (
    persisted.data.status === "provisioning" ||
    persisted.data.schedule.timerActivationPending === true
  ) {
    return (await finishTimerProvisioning(persisted, dependencies, () =>
      resumeControlConditions(persisted, dependencies),
    )) as Heartbeat;
  }
  if (timerChanged && dependencies.timerProvider) {
    const minutes = Number(persisted.data.schedule.intervalMs) / MIN_HEARTBEAT_INTERVAL_MS;
    await dependencies.timerProvider.upsert({
      enabled: false,
      expression: `rate(${minutes} ${minutes === 1 ? "minute" : "minutes"})`,
      kind: "heartbeat",
      payload: {
        agentDeploymentId: persisted.data.agentDeploymentId,
        environmentId: persisted.data.environmentId,
        heartbeatId: persisted.data.id,
        organizationId: persisted.data.organizationId,
        projectId: persisted.data.projectId,
        scheduleVersion:
          typeof persisted.data.schedule.timerVersion === "number"
            ? persisted.data.schedule.timerVersion
            : persisted.data.version,
      },
      scheduleId: persisted.data.id,
      ...(typeof persisted.data.schedule.timezone === "string"
        ? { timezone: persisted.data.schedule.timezone }
        : {}),
    });
  }
  return persisted;
}

async function resumeControlConditions(
  automation: Automation,
  dependencies: AutomationDependencies,
) {
  const controlScope = {
    agentDeploymentId: automation.data.agentDeploymentId,
    environmentId: automation.data.environmentId,
    organizationId: automation.data.organizationId,
    projectId: automation.data.projectId,
    ...(automation.data.threadId ? { threadId: automation.data.threadId } : {}),
    ...(automation.data.workspaceId ? { workspaceId: automation.data.workspaceId } : {}),
  };
  const workspace = await requireActiveWorkspace(controlScope, dependencies);
  const thread = await requireActiveThread(controlScope, dependencies);
  const { deployment, release } = await requireRunnableDeployment(
    controlScope,
    dependencies,
    automation.itemType,
  );
  return creationControlConditions(deployment, release, workspace, thread);
}

async function setStatus<T extends Automation>(
  previous: T,
  status: "archived" | "paused" | "provisioning",
  action: "archived" | "paused" | "resumed",
  dependencies: AutomationDependencies,
) {
  if (previous.data.status === "archived" || previous.data.status === "disabled") {
    if (action === "archived") {
      await dependencies.timerProvider?.delete(previous.data.id);
      return previous;
    }
    throw new AutomationError("automation_archived", "Archived automations cannot be changed.");
  }
  if (action === "paused" && previous.data.status === "paused") {
    await setTimerEnabled(previous, false, dependencies);
    return previous;
  }
  if (action === "resumed" && previous.data.status === "active") {
    return previous.data.schedule.timerActivationPending === true
      ? ((await finishTimerProvisioning(previous, dependencies, () =>
          resumeControlConditions(previous, dependencies),
        )) as T)
      : previous;
  }
  if (action === "resumed" && previous.data.status === "provisioning") {
    return (await finishTimerProvisioning(previous, dependencies, () =>
      resumeControlConditions(previous, dependencies),
    )) as T;
  }
  if (action === "resumed" && previous.data.status !== "paused") {
    throw new AutomationError(
      "invalid_automation_state",
      "Only paused automations can be resumed.",
    );
  }
  const now = dependencies.now?.() ?? new Date();
  const {
    timerActivationPending: _timerActivationPending,
    timerActivationValidated: _timerActivationValidated,
    ...scheduleWithoutPending
  } = previous.data.schedule;
  const data = {
    ...previous.data,
    schedule: scheduleWithoutPending,
    status,
    updatedAt: now.toISOString(),
    version: previous.data.version + 1,
  };
  const next =
    previous.itemType === "schedule"
      ? scheduleRecord(data as Schedule["data"])
      : heartbeatRecord(data as Heartbeat["data"]);
  const conditions =
    action === "resumed" ? await resumeControlConditions(previous, dependencies) : [];
  const persisted = await persistTransition(
    previous,
    next as T,
    `${previous.itemType}.${action}`,
    dependencies,
    conditions,
  );
  if (action === "resumed") {
    return (await finishTimerProvisioning(persisted, dependencies, () =>
      resumeControlConditions(persisted, dependencies),
    )) as T;
  }
  if (action === "archived") await dependencies.timerProvider?.delete(persisted.data.id);
  else await setTimerEnabled(persisted, false, dependencies);
  return persisted;
}

export async function pauseSchedule(
  input: AutomationScope & { readonly scheduleId: Ulid },
  dependencies: AutomationDependencies,
) {
  return setStatus(await getSchedule(input, dependencies), "paused", "paused", dependencies);
}

export async function resumeSchedule(
  input: AutomationScope & { readonly scheduleId: Ulid },
  dependencies: AutomationDependencies,
) {
  return setStatus(await getSchedule(input, dependencies), "provisioning", "resumed", dependencies);
}

export async function archiveSchedule(
  input: AutomationScope & { readonly scheduleId: Ulid },
  dependencies: AutomationDependencies,
) {
  return setStatus(await getSchedule(input, dependencies), "archived", "archived", dependencies);
}

export async function archiveScheduleIfCurrent(
  input: AutomationScope & {
    readonly expectedExpression: string;
    readonly expectedTimerVersion: number;
    readonly scheduleId: Ulid;
  },
  dependencies: AutomationDependencies,
) {
  const current = await getSchedule(input, dependencies);
  const currentTimerVersion =
    typeof current.data.schedule.timerVersion === "number"
      ? current.data.schedule.timerVersion
      : current.data.version;
  if (
    currentTimerVersion !== input.expectedTimerVersion ||
    current.data.schedule.expression !== input.expectedExpression
  ) {
    return current;
  }
  return setStatus(current, "archived", "archived", dependencies);
}

export async function pauseHeartbeat(
  input: AutomationScope & { readonly heartbeatId: Ulid },
  dependencies: AutomationDependencies,
) {
  return setStatus(await getHeartbeat(input, dependencies), "paused", "paused", dependencies);
}

export async function resumeHeartbeat(
  input: AutomationScope & { readonly heartbeatId: Ulid },
  dependencies: AutomationDependencies,
) {
  return setStatus(
    await getHeartbeat(input, dependencies),
    "provisioning",
    "resumed",
    dependencies,
  );
}

export async function archiveHeartbeat(
  input: AutomationScope & { readonly heartbeatId: Ulid },
  dependencies: AutomationDependencies,
) {
  return setStatus(await getHeartbeat(input, dependencies), "archived", "archived", dependencies);
}
