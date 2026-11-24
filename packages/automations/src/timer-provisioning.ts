import {
  HeartbeatRecord,
  ScheduleRecord,
  makeAutomationPersistence,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { AutomationError } from "./errors.ts";
import { deterministicId } from "./identifiers.ts";
import type { AutomationDependencies, TimerProviderSchedule } from "./index.ts";

type Schedule = Extract<PlatformRecord, { readonly itemType: "schedule" }>;
type Heartbeat = Extract<PlatformRecord, { readonly itemType: "heartbeat" }>;
type Automation = Schedule | Heartbeat;
type ActivationControlValidator = () => Promise<readonly TransactionOperation[] | void>;

export const MIN_HEARTBEAT_INTERVAL_MS = 60_000;
const TIMER_ACTIVATION_PENDING = "timerActivationPending";
const TIMER_ACTIVATION_VALIDATED = "timerActivationValidated";
const MAX_TIMER_FINALIZATION_ATTEMPTS = 3;
const TERMINAL_CONTROL_ERROR_CODES = new Set([
  "deployment_unavailable",
  "not_found",
  "release_unavailable",
  "scope_mismatch",
  "thread_archived",
  "trigger_not_allowed",
  "workspace_unavailable",
]);

class TimerTransitionOutcomeUnknownError extends AggregateError {
  constructor(writeCause: unknown, reconciliationCause: unknown) {
    super(
      [writeCause, reconciliationCause],
      "Automation timer persistence outcome could not be reconciled.",
    );
    this.name = "TimerTransitionOutcomeUnknownError";
  }
}

async function getAutomation(record: Automation, dependencies: AutomationDependencies) {
  const value = await makeAutomationPersistence(dependencies.database).getCurrent(record);
  return value?.itemType === record.itemType ? value : undefined;
}

function activationPending(record: Automation) {
  return record.data.schedule[TIMER_ACTIVATION_PENDING] === true;
}

function activationValidated(record: Automation) {
  return record.data.schedule[TIMER_ACTIVATION_VALIDATED] === true;
}

function creationHash(record: Automation) {
  const value = record.data.schedule.creationHash;
  return typeof value === "string" ? value : undefined;
}

function timerVersion(record: Automation) {
  const value = record.data.schedule.timerVersion;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : record.data.version;
}

function replaceAutomation(
  record: Automation,
  now: Date,
  phase: "final" | "pending" | "validated",
): Automation {
  const {
    [TIMER_ACTIVATION_PENDING]: _pending,
    [TIMER_ACTIVATION_VALIDATED]: _validated,
    ...schedule
  } = record.data.schedule;
  const stableSchedule = {
    ...schedule,
    ...(typeof schedule.timerVersion === "number" ? {} : { timerVersion: record.data.version }),
  };
  const data = {
    ...record.data,
    schedule:
      phase === "final"
        ? stableSchedule
        : {
            ...stableSchedule,
            [TIMER_ACTIVATION_PENDING]: true,
            ...(phase === "validated" ? { [TIMER_ACTIVATION_VALIDATED]: true } : {}),
          },
    status: "active" as const,
    updatedAt: now.toISOString(),
    version: record.data.version + 1,
  };
  return record.itemType === "schedule"
    ? Schema.decodeUnknownSync(ScheduleRecord)(
        withCanonicalRecordKeys({ data, itemType: "schedule" as const }),
      )
    : Schema.decodeUnknownSync(HeartbeatRecord)(
        withCanonicalRecordKeys({ data, itemType: "heartbeat" as const }),
      );
}

function localTimestamp(at: Date, timeZone: string) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        calendar: "gregory",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        numberingSystem: "latn",
        second: "2-digit",
        timeZone,
        year: "numeric",
      })
        .formatToParts(at)
        .map((part) => [part.type, part.value]),
    );
    const timestamp = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function expiredOneShot(record: Automation, now: Date) {
  if (record.itemType !== "schedule") return false;
  const expression = record.data.schedule.expression;
  if (typeof expression !== "string") return false;
  const match = /^at\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\)$/u.exec(expression);
  if (!match) return false;
  const nowInScheduleTimezone = localTimestamp(
    now,
    typeof record.data.schedule.timezone === "string" ? record.data.schedule.timezone : "UTC",
  );
  return nowInScheduleTimezone !== undefined && match[1]! <= nowInScheduleTimezone;
}

function archivedAutomation(record: Automation, now: Date): Automation {
  const {
    [TIMER_ACTIVATION_PENDING]: _pending,
    [TIMER_ACTIVATION_VALIDATED]: _validated,
    ...schedule
  } = record.data.schedule;
  const data = {
    ...record.data,
    schedule,
    status: "archived" as const,
    updatedAt: now.toISOString(),
    version: record.data.version + 1,
  };
  return record.itemType === "schedule"
    ? Schema.decodeUnknownSync(ScheduleRecord)(
        withCanonicalRecordKeys({ data, itemType: "schedule" as const }),
      )
    : Schema.decodeUnknownSync(HeartbeatRecord)(
        withCanonicalRecordKeys({ data, itemType: "heartbeat" as const }),
      );
}

function archivedExpiredOneShot(record: Schedule, now: Date): Schedule {
  return archivedAutomation(record, now) as Schedule;
}

export function scheduleExpression(record: Schedule): string {
  const expression = record.data.schedule.expression;
  if (typeof expression !== "string") {
    throw new AutomationError("invalid_schedule", "Schedule expression is invalid.");
  }
  return expression;
}

function scheduleTimer(record: Schedule, enabled: boolean): TimerProviderSchedule {
  const scheduleTimezone = record.data.schedule.timezone;
  return {
    enabled,
    expression: scheduleExpression(record),
    kind: "schedule",
    payload: {
      environmentId: record.data.environmentId,
      organizationId: record.data.organizationId,
      projectId: record.data.projectId,
      scheduleId: record.data.id,
      scheduleVersion: timerVersion(record),
      ...(record.data.workspaceId ? { workspaceId: record.data.workspaceId } : {}),
    },
    scheduleId: record.data.id,
    ...(typeof scheduleTimezone === "string" ? { timezone: scheduleTimezone } : {}),
  };
}

function heartbeatTimer(record: Heartbeat, enabled: boolean): TimerProviderSchedule {
  const intervalMs = record.data.schedule.intervalMs;
  const scheduleTimezone = record.data.schedule.timezone;
  if (!Number.isSafeInteger(intervalMs)) {
    throw new AutomationError("invalid_heartbeat", "Heartbeat interval is invalid.");
  }
  const intervalMinutes = Number(intervalMs) / MIN_HEARTBEAT_INTERVAL_MS;
  return {
    enabled,
    expression: `rate(${intervalMinutes} ${intervalMinutes === 1 ? "minute" : "minutes"})`,
    kind: "heartbeat",
    payload: {
      agentDeploymentId: record.data.agentDeploymentId,
      environmentId: record.data.environmentId,
      heartbeatId: record.data.id,
      organizationId: record.data.organizationId,
      projectId: record.data.projectId,
      scheduleVersion: timerVersion(record),
      ...(record.data.workspaceId ? { workspaceId: record.data.workspaceId } : {}),
    },
    scheduleId: record.data.id,
    ...(typeof scheduleTimezone === "string" ? { timezone: scheduleTimezone } : {}),
  };
}

function timerFor(record: Automation, enabled: boolean) {
  return record.itemType === "schedule"
    ? scheduleTimer(record, enabled)
    : heartbeatTimer(record, enabled);
}

async function upsertTimer(
  record: Automation,
  enabled: boolean,
  dependencies: AutomationDependencies,
) {
  if (!dependencies.timerProvider) {
    throw new AutomationError(
      "timer_provider_unavailable",
      "Automation timer provisioning is not configured.",
    );
  }
  await dependencies.timerProvider.upsert(timerFor(record, enabled));
}

async function transition(
  previous: Automation,
  next: Automation,
  eventType: string,
  eventSuffix: string,
  dependencies: AutomationDependencies,
  controlConditions: readonly TransactionOperation[] = [],
): Promise<Automation> {
  const now = dependencies.now?.() ?? new Date();
  const event = makeSemanticEventRecord({
    aggregateId: next.data.id,
    aggregateType: next.itemType,
    aggregateVersion: next.data.version + 1,
    environmentId: next.data.environmentId,
    eventId: deterministicId(next.data.id, `${eventSuffix}:${next.data.version + 1}`),
    eventType,
    occurredAt: now,
    organizationId: next.data.organizationId,
    payload: {
      status: next.data.status,
      timerActivationPending: activationPending(next),
      timerActivationValidated: activationValidated(next),
    },
    projectId: next.data.projectId,
  });
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [...controlConditions, { kind: "put", previousRecord: previous, record: next }],
      [event],
    );
    return next;
  } catch (cause) {
    let reconciled: Automation | undefined;
    try {
      reconciled = await getAutomation(previous, dependencies);
    } catch (reconciliationCause) {
      throw new TimerTransitionOutcomeUnknownError(cause, reconciliationCause);
    }
    if (
      reconciled &&
      creationHash(reconciled) === creationHash(previous) &&
      reconciled.data.version >= next.data.version
    ) {
      return reconciled;
    }
    throw cause;
  }
}

async function acceptedScheduledFire(
  schedule: Schedule,
  scheduleVersion: number,
  dependencies: AutomationDependencies,
) {
  return makeAutomationPersistence(dependencies.database).hasAcceptedScheduleFire({
    organizationId: schedule.data.organizationId,
    scheduleId: schedule.data.id,
    scheduleVersion,
  });
}

async function enableTimerUnlessAlreadyFired(
  record: Automation,
  dependencies: AutomationDependencies,
) {
  const alreadyFired =
    record.itemType === "schedule" &&
    typeof record.data.schedule.expression === "string" &&
    record.data.schedule.expression.startsWith("at(") &&
    (await acceptedScheduledFire(record, timerVersion(record), dependencies));
  if (alreadyFired) return "already-fired" as const;
  if (expiredOneShot(record, dependencies.now?.() ?? new Date())) {
    return "expired" as const;
  }
  await upsertTimer(record, true, dependencies);
  return "enabled" as const;
}

function provisioningCanceled(record: Automation) {
  return (
    record.data.status === "archived" ||
    record.data.status === "disabled" ||
    record.data.status === "paused"
  );
}

async function restoreCanceledTimerState(record: Automation, dependencies: AutomationDependencies) {
  if (!dependencies.timerProvider) return;
  if (record.data.status === "paused") {
    await upsertTimer(record, false, dependencies);
    return;
  }
  await dependencies.timerProvider.delete(record.data.id);
}

async function archiveInvalidAutomation(record: Automation, dependencies: AutomationDependencies) {
  let current = record;
  for (let attempt = 0; attempt < MAX_TIMER_FINALIZATION_ATTEMPTS; attempt += 1) {
    if (provisioningCanceled(current)) {
      await restoreCanceledTimerState(current, dependencies);
      return;
    }
    const now = dependencies.now?.() ?? new Date();
    current = await transition(
      current,
      archivedAutomation(current, now),
      `${current.itemType}.controls-invalidated`,
      "controls-invalidated-event",
      dependencies,
    );
  }
  throw new AutomationError(
    "timer_provisioning_conflict",
    "Automation could not be terminalized after its activation controls became invalid.",
  );
}

async function controlConditionsOrArchive(
  record: Automation,
  dependencies: AutomationDependencies,
  validateControls?: ActivationControlValidator,
) {
  try {
    return (await validateControls?.()) ?? [];
  } catch (cause) {
    if (cause instanceof AutomationError && TERMINAL_CONTROL_ERROR_CODES.has(cause.code)) {
      try {
        await archiveInvalidAutomation(record, dependencies);
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          "Automation controls became invalid and timer cleanup did not complete.",
        );
      }
    }
    throw cause;
  }
}

export async function finishTimerProvisioning(
  record: Automation,
  dependencies: AutomationDependencies,
  validateControls?: ActivationControlValidator,
): Promise<Automation> {
  if (record.data.status === "active" && !activationPending(record)) return record;
  if (provisioningCanceled(record)) {
    await restoreCanceledTimerState(record, dependencies);
    return record;
  }
  if (record.data.status !== "provisioning" && !activationPending(record)) return record;
  if (!dependencies.timerProvider) {
    throw new AutomationError(
      "timer_provider_unavailable",
      "Automation timer provisioning is not configured.",
    );
  }

  const provisioningNow = dependencies.now?.() ?? new Date();
  if (expiredOneShot(record, provisioningNow) && record.itemType === "schedule") {
    const expired = await transition(
      record,
      archivedExpiredOneShot(record, provisioningNow),
      "schedule.expired",
      "expired-event",
      dependencies,
    );
    if (expired.data.status === "archived") {
      await dependencies.timerProvider.delete(expired.data.id);
      return expired;
    }
    return finishTimerProvisioning(expired, dependencies, validateControls);
  }
  let pending = record;
  let validatedForActivation = false;
  if (!activationPending(pending)) {
    const controlConditions = await controlConditionsOrArchive(
      pending,
      dependencies,
      validateControls,
    );
    const now = dependencies.now?.() ?? new Date();
    const prepared = replaceAutomation(pending, now, "validated");
    pending = await transition(
      pending,
      prepared,
      `${pending.itemType}.timer-prepared`,
      "timer-prepared-event",
      dependencies,
      controlConditions,
    );
    validatedForActivation = activationValidated(pending);
    if (provisioningCanceled(pending)) {
      await restoreCanceledTimerState(pending, dependencies);
      return pending;
    }
    if (pending.data.status === "active" && !activationPending(pending)) {
      return pending;
    }
  }

  for (let attempt = 0; attempt < MAX_TIMER_FINALIZATION_ATTEMPTS; attempt += 1) {
    if (!validatedForActivation) {
      const controlConditions = await controlConditionsOrArchive(
        pending,
        dependencies,
        validateControls,
      );
      const validationNow = dependencies.now?.() ?? new Date();
      const validated = replaceAutomation(pending, validationNow, "validated");
      pending = await transition(
        pending,
        validated,
        `${pending.itemType}.timer-validated`,
        "timer-validated-event",
        dependencies,
        controlConditions,
      );
      if (provisioningCanceled(pending)) {
        await restoreCanceledTimerState(pending, dependencies);
        return pending;
      }
      if (!activationPending(pending)) return pending;
      validatedForActivation = activationValidated(pending);
      if (!validatedForActivation) continue;
    }
    const activationNow = dependencies.now?.() ?? new Date();
    if (expiredOneShot(pending, activationNow) && pending.itemType === "schedule") {
      const expired = await transition(
        pending,
        archivedExpiredOneShot(pending, activationNow),
        "schedule.expired",
        "expired-event",
        dependencies,
      );
      if (expired.data.status === "archived") {
        await dependencies.timerProvider.delete(expired.data.id);
        return expired;
      }
      return finishTimerProvisioning(expired, dependencies, validateControls);
    }
    const final = replaceAutomation(pending, activationNow, "final");
    const enablement = await enableTimerUnlessAlreadyFired(final, dependencies);
    if (enablement === "expired" && pending.itemType === "schedule") {
      const expiredAt = dependencies.now?.() ?? new Date();
      const expired = await transition(
        pending,
        archivedExpiredOneShot(pending, expiredAt),
        "schedule.expired",
        "expired-event",
        dependencies,
      );
      if (expired.data.status === "archived") {
        await dependencies.timerProvider.delete(expired.data.id);
        return expired;
      }
      return finishTimerProvisioning(expired, dependencies, validateControls);
    }
    const transitioned = await transition(
      pending,
      final,
      `${pending.itemType}.provisioned`,
      "provisioned-event",
      dependencies,
    );
    if (provisioningCanceled(transitioned)) {
      await restoreCanceledTimerState(transitioned, dependencies);
      return transitioned;
    }
    if (!activationPending(transitioned)) return transitioned;
    pending = transitioned;
    validatedForActivation = false;
  }
  throw new AutomationError(
    "timer_provisioning_conflict",
    "Automation timer activation could not be finalized after concurrent updates.",
  );
}
