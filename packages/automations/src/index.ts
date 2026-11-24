import { isRunRefusalCode, type RunRefusalCode } from "@deployments-ai/conversations";
import {
  HeartbeatRecord,
  HeartbeatRunRecord,
  ScheduleFireRecord,
  Ulid,
  automationScheduleFireSortKey,
  makeAutomationPersistence,
  withCanonicalRecordKeys,
  type AutomationRecordLocator,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { AutomationError } from "./errors.ts";
import { deterministicId, requiredUtf8 } from "./identifiers.ts";
import { archiveHeartbeat, archiveScheduleIfCurrent } from "./lifecycle.ts";
import { automationRunIdempotencyKey } from "./run-key.ts";
import { validateHeartbeatActiveWindow } from "./validation.ts";

export { AutomationError } from "./errors.ts";
export { createEventBridgeTimerDeleter, createEventBridgeTimerProvider } from "./aws-scheduler.ts";
export { createHeartbeat, createSchedule, validateScheduleExpression } from "./creation.ts";
export {
  archiveHeartbeat,
  archiveSchedule,
  getHeartbeat,
  getSchedule,
  pauseHeartbeat,
  pauseSchedule,
  resumeHeartbeat,
  resumeSchedule,
  updateHeartbeat,
  updateSchedule,
} from "./lifecycle.ts";
export type { EventBridgeTimerProviderOptions } from "./aws-scheduler.ts";

export interface AutomationScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly workspaceId?: Ulid;
}

export interface AutomationRunRequest extends AutomationScope {
  readonly agentDeploymentId: Ulid;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly threadId?: Ulid;
  readonly trigger: "heartbeat" | "schedule";
}

export interface AutomationRunResult {
  readonly runId: Ulid;
  readonly threadId: Ulid;
}

/**
 * Admits one automation run. Rejects with an `AutomationError` carrying a run refusal code, such as
 * `budget_exhausted` or `organization_suspended`, when admission refuses the run; the fire is then
 * recorded as skipped instead of failing.
 */
export type SubmitAutomationRun = (input: AutomationRunRequest) => Promise<AutomationRunResult>;

export interface TimerProviderSchedule {
  readonly enabled?: boolean;
  readonly expression: string;
  readonly kind: "heartbeat" | "schedule";
  readonly payload: Readonly<Record<string, unknown>>;
  readonly scheduleId: Ulid;
  readonly timezone?: string;
}

export interface TimerProvider {
  readonly delete: (scheduleId: Ulid) => Promise<void>;
  readonly upsert: (schedule: TimerProviderSchedule) => Promise<void>;
}

export interface AutomationDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
  readonly submitRun: SubmitAutomationRun;
  readonly timerProvider?: TimerProvider;
}

type ScheduleFire = Extract<PlatformRecord, { readonly itemType: "schedule-fire" }>;
type Schedule = Extract<PlatformRecord, { readonly itemType: "schedule" }>;
type Heartbeat = Extract<PlatformRecord, { readonly itemType: "heartbeat" }>;
type HeartbeatRun = Extract<PlatformRecord, { readonly itemType: "heartbeat-run" }>;

function persistedAutomationRun(
  record: ScheduleFire | HeartbeatRun,
): AutomationRunResult | undefined {
  return record.data.runId && record.data.threadId
    ? { runId: record.data.runId, threadId: record.data.threadId }
    : undefined;
}

function scheduleFireSortKey(scheduleId: Ulid, fireKey: string) {
  const value = automationScheduleFireSortKey(scheduleId, fireKey);
  if (new TextEncoder().encode(value).byteLength > 1_024) {
    throw new AutomationError(
      "invalid_fire_key",
      "Schedule fire key is too large after DynamoDB key encoding.",
    );
  }
  return value;
}

async function get(database: DynamoDatabaseService, locator: AutomationRecordLocator) {
  return makeAutomationPersistence(database).get(locator);
}

function expected<ItemType extends PlatformRecord["itemType"]>(
  value: PlatformRecord | undefined,
  itemType: ItemType,
): Extract<PlatformRecord, { readonly itemType: ItemType }> {
  if (!value || value.itemType !== itemType) {
    throw new AutomationError("not_found", `${itemType} was not found.`);
  }
  return value as Extract<PlatformRecord, { readonly itemType: ItemType }>;
}

function assertScope(record: PlatformRecord, scope: AutomationScope) {
  const data = record.data as Readonly<Record<string, unknown>>;
  if (
    data.organizationId !== scope.organizationId ||
    data.projectId !== scope.projectId ||
    data.environmentId !== scope.environmentId ||
    (scope.workspaceId !== undefined && data.workspaceId !== scope.workspaceId)
  ) {
    throw new AutomationError("scope_mismatch", `${record.itemType} does not match the scope.`);
  }
}

async function storedWorkspaceIsActive(
  scope: AutomationScope,
  workspaceId: Ulid | undefined,
  dependencies: AutomationDependencies,
) {
  if (!workspaceId) return true;
  const workspace = await get(dependencies.database, {
    environmentId: scope.environmentId,
    id: workspaceId,
    itemType: "workspace",
    kind: "environment-resource",
    organizationId: scope.organizationId,
  });
  if (!workspace || workspace.itemType !== "workspace") return false;
  if (
    workspace.data.organizationId !== scope.organizationId ||
    workspace.data.projectId !== scope.projectId ||
    workspace.data.environmentId !== scope.environmentId
  ) {
    throw new AutomationError("scope_mismatch", "Workspace does not match the automation scope.");
  }
  return workspace.data.status === "active";
}

async function storedThreadIsActive(
  scope: AutomationScope,
  agentDeploymentId: Ulid,
  workspaceId: Ulid | undefined,
  threadId: Ulid | undefined,
  dependencies: AutomationDependencies,
) {
  if (!threadId) return true;
  const thread = await get(dependencies.database, {
    kind: "thread",
    organizationId: scope.organizationId,
    threadId,
  });
  if (!thread || thread.itemType !== "thread") return false;
  if (
    thread.data.organizationId !== scope.organizationId ||
    thread.data.projectId !== scope.projectId ||
    thread.data.environmentId !== scope.environmentId ||
    thread.data.workspaceId !== workspaceId ||
    thread.data.agentDeploymentId !== agentDeploymentId
  ) {
    throw new AutomationError("scope_mismatch", "Thread does not match the automation scope.");
  }
  return !thread.data.archived;
}

function scheduleVersionMatchesFire(schedule: Schedule, scheduleVersion: number | undefined) {
  if (scheduleVersion === undefined) return false;
  const timerActivationPending = schedule.data.schedule.timerActivationPending === true;
  return (
    scheduleVersion === automationTimerVersion(schedule) ||
    (timerActivationPending &&
      schedule.data.schedule.timerVersion === undefined &&
      scheduleVersion === schedule.data.version + 1)
  );
}

async function archiveScheduleAfterTerminalFire(
  schedule: Schedule,
  scheduleVersionMatches: boolean,
  threadActive: boolean,
  dependencies: AutomationDependencies,
) {
  const expression = schedule.data.schedule.expression;
  if (typeof expression !== "string") return;
  const threadUnavailable = Boolean(schedule.data.threadId) && !threadActive;
  const completedOneShot = scheduleVersionMatches && expression.startsWith("at(");
  if (
    (!threadUnavailable && !completedOneShot) ||
    (schedule.data.status !== "active" && schedule.data.status !== "archived")
  ) {
    return;
  }
  await archiveScheduleIfCurrent(
    {
      environmentId: schedule.data.environmentId,
      expectedExpression: expression,
      expectedTimerVersion: automationTimerVersion(schedule),
      organizationId: schedule.data.organizationId,
      projectId: schedule.data.projectId,
      scheduleId: schedule.data.id,
      ...(schedule.data.workspaceId ? { workspaceId: schedule.data.workspaceId } : {}),
    },
    dependencies,
  );
}

async function archiveHeartbeatAfterUnavailableThread(
  heartbeat: Heartbeat,
  threadActive: boolean,
  dependencies: AutomationDependencies,
) {
  if (!heartbeat.data.threadId || threadActive) return;
  await archiveHeartbeat(
    {
      environmentId: heartbeat.data.environmentId,
      heartbeatId: heartbeat.data.id,
      organizationId: heartbeat.data.organizationId,
      projectId: heartbeat.data.projectId,
      ...(heartbeat.data.workspaceId ? { workspaceId: heartbeat.data.workspaceId } : {}),
    },
    dependencies,
  );
}

/** Why a fire did not submit a run; recorded on heartbeat runs and skip events. */
const SKIP_REASON_BY_REFUSAL = {
  budget_exhausted: "budget-exhausted",
  organization_suspended: "organization-suspended",
} as const satisfies Record<RunRefusalCode, string>;

type AutomationSkipReason = (typeof SKIP_REASON_BY_REFUSAL)[RunRefusalCode];

/**
 * Submits a fire's run. A run refusal is a terminal skip of this fire rather than a failure:
 * retrying cannot succeed until the budget or the organization's standing changes.
 */
async function submitAdmitted(
  dependencies: AutomationDependencies,
  request: AutomationRunRequest,
): Promise<
  | { readonly run: AutomationRunResult; readonly skipReason?: undefined }
  | { readonly run?: undefined; readonly skipReason: AutomationSkipReason }
> {
  try {
    return { run: await dependencies.submitRun(request) };
  } catch (cause) {
    if (cause instanceof AutomationError && isRunRefusalCode(cause.code)) {
      return { skipReason: SKIP_REASON_BY_REFUSAL[cause.code] };
    }
    throw cause;
  }
}

export async function fireSchedule(
  input: AutomationScope & {
    readonly fireKey: string;
    readonly findCurrentRun?: (
      agentDeploymentId: Ulid,
      currentRunIdempotencyKey: string,
      workspaceId: Ulid | undefined,
    ) => Promise<AutomationRunResult | undefined>;
    readonly scheduleId: Ulid;
    readonly scheduleVersion?: number;
  },
  dependencies: AutomationDependencies,
): Promise<{
  readonly fire: ScheduleFire;
  readonly duplicate: boolean;
  readonly run?: AutomationRunResult;
}> {
  const fireKey = requiredUtf8(input.fireKey, "Schedule fire key", 512);
  const schedule = expected(
    await get(dependencies.database, {
      environmentId: input.environmentId,
      id: input.scheduleId,
      itemType: "schedule",
      kind: "environment-resource",
      organizationId: input.organizationId,
    }),
    "schedule",
  );
  assertScope(schedule, input);
  scheduleFireSortKey(input.scheduleId, fireKey);
  const existing = await get(dependencies.database, {
    fireKey,
    kind: "schedule-fire",
    organizationId: input.organizationId,
    scheduleId: input.scheduleId,
  });
  if (existing) {
    const fire = expected(existing, "schedule-fire");
    const persistedRun = persistedAutomationRun(fire);
    const threadActive = await storedThreadIsActive(
      input,
      schedule.data.agentDeploymentId,
      schedule.data.workspaceId,
      schedule.data.threadId,
      dependencies,
    );
    await archiveScheduleAfterTerminalFire(
      schedule,
      scheduleVersionMatchesFire(schedule, fire.data.scheduleVersion),
      threadActive,
      dependencies,
    );
    return {
      duplicate: true,
      fire,
      ...(persistedRun ? { run: persistedRun } : {}),
    };
  }
  const fireId = deterministicId(schedule.data.id, fireKey);
  const now = dependencies.now?.() ?? new Date();
  let run: AutomationRunResult | undefined;
  let status: "accepted" | "failed" = "failed";
  let skipReason: AutomationSkipReason | undefined;
  const effectiveScheduleVersion = input.scheduleVersion ?? automationTimerVersion(schedule);
  const scheduleVersionMatches = scheduleVersionMatchesFire(schedule, effectiveScheduleVersion);
  const runIdempotencyKey = automationRunIdempotencyKey({
    fireId,
    id: schedule.data.id,
    kind: "schedule",
  });
  const runRequest: AutomationRunRequest = {
    agentDeploymentId: schedule.data.agentDeploymentId,
    content: schedule.data.prompt ?? "",
    environmentId: input.environmentId,
    idempotencyKey: runIdempotencyKey,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...(schedule.data.threadId ? { threadId: schedule.data.threadId } : {}),
    trigger: "schedule",
    ...(schedule.data.workspaceId ? { workspaceId: schedule.data.workspaceId } : {}),
  };
  const currentRun = input.findCurrentRun
    ? await input.findCurrentRun(
        schedule.data.agentDeploymentId,
        runIdempotencyKey,
        schedule.data.workspaceId,
      )
    : undefined;
  const threadActive = await storedThreadIsActive(
    input,
    schedule.data.agentDeploymentId,
    schedule.data.workspaceId,
    schedule.data.threadId,
    dependencies,
  );
  const workspaceActive = await storedWorkspaceIsActive(
    input,
    schedule.data.workspaceId,
    dependencies,
  );
  if (currentRun) {
    run = currentRun;
    status = "accepted";
  } else if (
    schedule.data.status === "active" &&
    schedule.data.prompt &&
    scheduleVersionMatches &&
    workspaceActive &&
    threadActive
  ) {
    ({ run, skipReason } = await submitAdmitted(dependencies, runRequest));
    if (run) status = "accepted";
  }
  const fire = Schema.decodeUnknownSync(ScheduleFireRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId: input.environmentId,
        fireKey,
        firedAt: now.toISOString(),
        id: fireId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ...(run ? { runId: run.runId } : {}),
        scheduleId: schedule.data.id,
        scheduleVersion: effectiveScheduleVersion,
        status,
        ...(run ? { threadId: run.threadId } : {}),
      },
      itemType: "schedule-fire" as const,
    }),
  );
  const event = makeSemanticEventRecord({
    aggregateId: fireId,
    aggregateType: "schedule-fire",
    aggregateVersion: 1,
    environmentId: input.environmentId,
    eventId: deterministicId(schedule.data.id, `event:${fireKey}`),
    eventType: status === "accepted" ? "schedule.fired" : "schedule.skipped",
    occurredAt: now,
    organizationId: input.organizationId,
    payload: {
      fireKey,
      ...(run ? { runId: run.runId } : {}),
      ...(skipReason ? { skipReason } : {}),
      scheduleId: schedule.data.id,
      status,
      ...(run ? { threadId: run.threadId } : {}),
    },
    projectId: input.projectId,
  });
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [{ kind: "put", record: fire }],
      [event],
    );
  } catch (cause) {
    const reconciled = await get(dependencies.database, {
      fireKey,
      kind: "schedule-fire",
      organizationId: input.organizationId,
      scheduleId: input.scheduleId,
    });
    if (!reconciled) throw cause;
    const reconciledFire = expected(reconciled, "schedule-fire");
    const persistedRun = persistedAutomationRun(reconciledFire) ?? run;
    await archiveScheduleAfterTerminalFire(
      schedule,
      scheduleVersionMatchesFire(schedule, reconciledFire.data.scheduleVersion),
      threadActive,
      dependencies,
    );
    return {
      duplicate: true,
      fire: reconciledFire,
      ...(persistedRun ? { run: persistedRun } : {}),
    };
  }
  await archiveScheduleAfterTerminalFire(
    schedule,
    scheduleVersionMatches,
    threadActive,
    dependencies,
  );
  return { duplicate: false, fire, ...(run ? { run } : {}) };
}

function heartbeatSchedule(heartbeat: Heartbeat) {
  const schedule = heartbeat.data.schedule;
  const intervalMs = schedule.intervalMs;
  const instructions = schedule.instructions;
  if (
    !Number.isSafeInteger(intervalMs) ||
    typeof instructions !== "string" ||
    !instructions.trim()
  ) {
    throw new AutomationError("invalid_heartbeat", "Heartbeat schedule is invalid.");
  }
  return {
    instructions: instructions.trim(),
    intervalMs: Number(intervalMs),
    skipWhenBusy: schedule.skipWhenBusy !== false,
    timezone: typeof schedule.timezone === "string" ? schedule.timezone : "UTC",
  };
}

function automationTimerVersion(record: Schedule | Heartbeat) {
  const value = record.data.schedule.timerVersion;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : record.data.version;
}

function insideActiveWindow(heartbeat: Heartbeat, at: Date, timeZone: string) {
  const window = validateHeartbeatActiveWindow(heartbeat.data.activeWindow);
  if (!window) return true;
  const start = window.startMinuteOfDay;
  const end = window.endMinuteOfDay;
  const days = window.daysOfWeek;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      timeZone,
      weekday: "short",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const activeWindowWeekday = start > end && minute < end ? (weekday + 6) % 7 : weekday;
  if (days && !days.includes(activeWindowWeekday)) return false;
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

export async function fireHeartbeat(
  input: AutomationScope & {
    readonly fireKey: string;
    readonly agentDeploymentId: Ulid;
    readonly hasActiveRun?: (
      agentDeploymentId: Ulid,
      currentRunIdempotencyKey: string,
      workspaceId: Ulid | undefined,
      includeOtherActiveRuns: boolean,
    ) => Promise<boolean | AutomationRunResult>;
    readonly heartbeatId: Ulid;
    readonly scheduleVersion?: number;
  },
  dependencies: AutomationDependencies,
): Promise<{
  readonly heartbeatRun: HeartbeatRun;
  readonly duplicate: boolean;
  readonly run?: AutomationRunResult;
}> {
  const fireKey = requiredUtf8(input.fireKey, "Heartbeat fire key", 512);
  const heartbeat = expected(
    await get(dependencies.database, {
      agentDeploymentId: input.agentDeploymentId,
      heartbeatId: input.heartbeatId,
      kind: "heartbeat",
      organizationId: input.organizationId,
    }),
    "heartbeat",
  );
  assertScope(heartbeat, input);
  const threadActive = await storedThreadIsActive(
    input,
    heartbeat.data.agentDeploymentId,
    heartbeat.data.workspaceId,
    heartbeat.data.threadId,
    dependencies,
  );
  const heartbeatRunId = deterministicId(heartbeat.data.id, fireKey);
  const existing = await get(dependencies.database, {
    heartbeatId: input.heartbeatId,
    heartbeatRunId,
    kind: "heartbeat-run",
    organizationId: input.organizationId,
  });
  if (existing) {
    const heartbeatRun = expected(existing, "heartbeat-run");
    const persistedRun = persistedAutomationRun(heartbeatRun);
    await archiveHeartbeatAfterUnavailableThread(heartbeat, threadActive, dependencies);
    return {
      duplicate: true,
      heartbeatRun,
      ...(persistedRun ? { run: persistedRun } : {}),
    };
  }
  const now = dependencies.now?.() ?? new Date();
  const schedule = heartbeatSchedule(heartbeat);
  let status: "accepted" | "skipped" = "skipped";
  let skipReason: string | undefined;
  let run: AutomationRunResult | undefined;
  const runIdempotencyKey = automationRunIdempotencyKey({
    fireId: heartbeatRunId,
    id: heartbeat.data.id,
    kind: "heartbeat",
  });
  const runRequest: AutomationRunRequest = {
    agentDeploymentId: heartbeat.data.agentDeploymentId,
    content: schedule.instructions,
    environmentId: input.environmentId,
    idempotencyKey: runIdempotencyKey,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...(heartbeat.data.threadId ? { threadId: heartbeat.data.threadId } : {}),
    trigger: "heartbeat",
    ...(heartbeat.data.workspaceId ? { workspaceId: heartbeat.data.workspaceId } : {}),
  };
  const activeRun = input.hasActiveRun
    ? await input.hasActiveRun(
        heartbeat.data.agentDeploymentId,
        runIdempotencyKey,
        heartbeat.data.workspaceId,
        schedule.skipWhenBusy,
      )
    : false;
  if (typeof activeRun === "object") {
    run = await dependencies.submitRun(runRequest);
    status = "accepted";
  } else if (
    input.scheduleVersion !== undefined &&
    input.scheduleVersion !== automationTimerVersion(heartbeat)
  ) {
    skipReason = "stale-schedule-version";
  } else if (heartbeat.data.status !== "active") {
    skipReason = "not-active";
  } else if (!(await storedWorkspaceIsActive(input, heartbeat.data.workspaceId, dependencies))) {
    skipReason = "workspace-unavailable";
  } else if (!threadActive) {
    skipReason = "thread-unavailable";
  } else if (!insideActiveWindow(heartbeat, now, schedule.timezone)) {
    skipReason = "outside-active-window";
  } else if (activeRun) {
    skipReason = "busy";
  } else {
    ({ run, skipReason } = await submitAdmitted(dependencies, runRequest));
    if (run) status = "accepted";
  }
  const heartbeatRun = Schema.decodeUnknownSync(HeartbeatRunRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId: input.environmentId,
        heartbeatId: heartbeat.data.id,
        id: heartbeatRunId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ...(run ? { runId: run.runId } : {}),
        ...(skipReason ? { skipReason } : {}),
        status,
        ...(run ? { threadId: run.threadId } : {}),
        version: 0,
      },
      itemType: "heartbeat-run" as const,
    }),
  );
  const updated = Schema.decodeUnknownSync(HeartbeatRecord)(
    withCanonicalRecordKeys({
      data: {
        ...heartbeat.data,
        lastRunAt: now.toISOString(),
        nextRunAt: new Date(now.getTime() + schedule.intervalMs).toISOString(),
        updatedAt: now.toISOString(),
        version: heartbeat.data.version + 1,
      },
      itemType: "heartbeat" as const,
    }),
  );
  const event = makeSemanticEventRecord({
    aggregateId: heartbeat.data.id,
    aggregateType: "heartbeat",
    aggregateVersion: updated.data.version + 1,
    environmentId: input.environmentId,
    eventId: deterministicId(heartbeat.data.id, `event:${fireKey}`),
    eventType: status === "accepted" ? "heartbeat.fired" : "heartbeat.skipped",
    occurredAt: now,
    organizationId: input.organizationId,
    payload: {
      heartbeatRunId,
      ...(run ? { runId: run.runId } : {}),
      ...(skipReason ? { skipReason } : {}),
      status,
      ...(run ? { threadId: run.threadId } : {}),
    },
    projectId: input.projectId,
  });
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        { kind: "put", previousRecord: heartbeat, record: updated },
        { kind: "put", record: heartbeatRun },
      ],
      [event],
    );
  } catch (cause) {
    const reconciled = await get(dependencies.database, {
      heartbeatId: input.heartbeatId,
      heartbeatRunId,
      kind: "heartbeat-run",
      organizationId: input.organizationId,
    });
    if (!reconciled) throw cause;
    const reconciledHeartbeatRun = expected(reconciled, "heartbeat-run");
    const persistedRun = persistedAutomationRun(reconciledHeartbeatRun) ?? run;
    await archiveHeartbeatAfterUnavailableThread(heartbeat, threadActive, dependencies);
    return {
      duplicate: true,
      heartbeatRun: reconciledHeartbeatRun,
      ...(persistedRun ? { run: persistedRun } : {}),
    };
  }
  await archiveHeartbeatAfterUnavailableThread(heartbeat, threadActive, dependencies);
  return { duplicate: false, heartbeatRun, ...(run ? { run } : {}) };
}
