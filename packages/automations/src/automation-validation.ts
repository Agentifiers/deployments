import { agentManifestAllowsTrigger, type AgentTrigger } from "@deployments-ai/agent-manifest";
import {
  ScheduleRecord,
  Ulid,
  makeAutomationPersistence,
  withCanonicalRecordKeys,
  type AutomationRecordLocator,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { AutomationError } from "./errors.ts";
import { automationCreationIdentity, deterministicId, required } from "./identifiers.ts";
import type { AutomationDependencies, AutomationScope } from "./index.ts";
import { finishTimerProvisioning } from "./timer-provisioning.ts";

export type Schedule = Extract<PlatformRecord, { readonly itemType: "schedule" }>;
export type Heartbeat = Extract<PlatformRecord, { readonly itemType: "heartbeat" }>;
export type Deployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
export type Release = Extract<PlatformRecord, { readonly itemType: "agent-release" }>;
export type Thread = Extract<PlatformRecord, { readonly itemType: "thread" }>;
export type Workspace = Extract<PlatformRecord, { readonly itemType: "workspace" }>;

export const MAX_HEARTBEAT_INTERVAL_MS = 30 * 24 * 60 * 60_000;
export const MAX_CREATION_CONFLICT_RETRIES = 3;
const MONTHS = new Map(
  ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].map(
    (name, index) => [name, index + 1],
  ),
);
const WEEKDAYS = new Map(
  ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((name, index) => [name, index + 1]),
);

function cronValue(value: string, minimum: number, maximum: number, names?: Map<string, number>) {
  const named = names?.get(value.toUpperCase());
  const parsed = named ?? (/^\d+$/u.test(value) ? Number(value) : Number.NaN);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

function cronBase(value: string, minimum: number, maximum: number, names?: Map<string, number>) {
  if (value === "*") return true;
  const range = /^([A-Z]+|\d+)-([A-Z]+|\d+)$/iu.exec(value);
  if (range) {
    const start = cronValue(range[1]!, minimum, maximum, names);
    const end = cronValue(range[2]!, minimum, maximum, names);
    return start !== undefined && end !== undefined && start <= end;
  }
  return cronValue(value, minimum, maximum, names) !== undefined;
}

function cronField(
  value: string,
  minimum: number,
  maximum: number,
  options: {
    readonly names?: Map<string, number>;
    readonly special?: (segment: string) => boolean;
  } = {},
) {
  return value.split(",").every((segment) => {
    if (options.special?.(segment)) return true;
    const increment = /^(.+)\/(\d+)$/u.exec(segment);
    if (increment) {
      const step = Number(increment[2]);
      return (
        Number.isSafeInteger(step) &&
        step > 0 &&
        step <= maximum &&
        cronBase(increment[1]!, minimum, maximum, options.names)
      );
    }
    return cronBase(segment, minimum, maximum, options.names);
  });
}

function dayOfMonthSpecial(segment: string) {
  if (segment === "L" || segment === "LW") return true;
  const lastOffset = /^L-(\d+)$/u.exec(segment);
  if (lastOffset) return Number(lastOffset[1]) >= 1 && Number(lastOffset[1]) <= 30;
  const weekday = /^(\d+)W$/u.exec(segment);
  return Boolean(weekday && cronValue(weekday[1]!, 1, 31) !== undefined);
}

function dayOfWeekSpecial(segment: string) {
  const special = /^([A-Z]+|\d+)(L|#([1-5]))$/iu.exec(segment);
  return Boolean(special && cronValue(special[1]!, 1, 7, WEEKDAYS) !== undefined);
}

function validCron(body: string) {
  const fields = body.split(/\s+/u);
  if (fields.length !== 6) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek, year] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if ((dayOfMonth === "?") === (dayOfWeek === "?")) return false;
  if (
    dayOfWeek.includes("#") &&
    ((dayOfWeek.match(/#/gu)?.length ?? 0) > 1 || dayOfWeek.includes(","))
  ) {
    return false;
  }
  return (
    cronField(minute, 0, 59) &&
    cronField(hour, 0, 23) &&
    (dayOfMonth === "?" || cronField(dayOfMonth, 1, 31, { special: dayOfMonthSpecial })) &&
    cronField(month, 1, 12, { names: MONTHS }) &&
    (dayOfWeek === "?" ||
      cronField(dayOfWeek, 1, 7, {
        names: WEEKDAYS,
        special: dayOfWeekSpecial,
      })) &&
    cronField(year, 1970, 2199)
  );
}

export function validateScheduleExpression(value: string) {
  const expression = required(value, "Schedule expression", 256);
  const match = /^(at|cron|rate)\((.*)\)$/u.exec(expression);
  const kind = match?.[1];
  const body = match?.[2]?.trim() ?? "";
  let valid = false;
  if (kind === "rate") {
    const rate = /^([1-9]\d*)\s+(minute|minutes|hour|hours|day|days)$/u.exec(body);
    if (rate) {
      const count = Number(rate[1]);
      const unit = rate[2]!;
      valid = Number.isSafeInteger(count) && (count === 1) === !unit.endsWith("s");
    }
  } else if (kind === "at") {
    const at = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u.exec(body);
    if (at) {
      const parts = at.slice(1).map(Number);
      const timestamp = Date.UTC(
        parts[0]!,
        parts[1]! - 1,
        parts[2]!,
        parts[3]!,
        parts[4]!,
        parts[5]!,
      );
      valid = Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === body;
    }
  } else if (kind === "cron") {
    valid = validCron(body);
  }
  if (!valid) {
    throw new AutomationError(
      "invalid_schedule",
      "Schedule expression must be an EventBridge at(), cron(), or rate() expression.",
    );
  }
  return expression;
}

export function timezone(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 50) {
    throw new AutomationError("invalid_timezone", "Timezone must not exceed 50 characters.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
  } catch (cause) {
    throw new AutomationError("invalid_timezone", "Timezone must be a valid IANA timezone.", {
      cause,
    });
  }
  return normalized;
}

export async function get(database: DynamoDatabaseService, locator: AutomationRecordLocator) {
  return makeAutomationPersistence(database).get(locator);
}

export function expected<
  ItemType extends
    | "agent-deployment"
    | "agent-release"
    | "heartbeat"
    | "schedule"
    | "thread"
    | "workspace",
>(
  value: PlatformRecord | undefined,
  itemType: ItemType,
): Extract<PlatformRecord, { readonly itemType: ItemType }> {
  if (!value || value.itemType !== itemType) {
    throw new AutomationError("not_found", `${itemType} was not found.`);
  }
  return value as Extract<PlatformRecord, { readonly itemType: ItemType }>;
}

function assertScope(record: Schedule | Heartbeat, scope: AutomationScope) {
  if (
    record.data.organizationId !== scope.organizationId ||
    record.data.projectId !== scope.projectId ||
    record.data.environmentId !== scope.environmentId ||
    (scope.workspaceId !== undefined && record.data.workspaceId !== scope.workspaceId)
  ) {
    throw new AutomationError("scope_mismatch", `${record.itemType} does not match the scope.`);
  }
}

export function assertCreationReplay(
  record: Schedule | Heartbeat,
  scope: AutomationScope,
  creationHash: string,
) {
  assertScope(record, scope);
  if (record.data.schedule.creationHash !== creationHash) {
    throw new AutomationError(
      "idempotency_conflict",
      "Idempotency key belongs to another automation creation request.",
    );
  }
}

export async function heartbeatFromCreationEvent(
  database: DynamoDatabaseService,
  input: Pick<AutomationScope, "organizationId">,
  heartbeatId: Ulid,
  event: PlatformRecord | undefined,
) {
  const deploymentIdValue =
    event?.itemType === "semantic-event" &&
    event.data.aggregateId === heartbeatId &&
    event.data.eventType === "heartbeat.created"
      ? event.data.payload.agentDeploymentId
      : undefined;
  if (typeof deploymentIdValue !== "string") return undefined;
  try {
    const deploymentId = Schema.decodeUnknownSync(Ulid)(deploymentIdValue);
    return await get(database, {
      agentDeploymentId: deploymentId,
      heartbeatId,
      kind: "heartbeat",
      organizationId: input.organizationId,
    });
  } catch {
    return undefined;
  }
}

export async function requireRunnableDeployment(
  scope: AutomationScope & { readonly agentDeploymentId: Ulid },
  dependencies: AutomationDependencies,
  trigger: Extract<AgentTrigger, "heartbeat" | "schedule">,
): Promise<{ readonly deployment: Deployment; readonly release: Release }> {
  const deployment = expected(
    await get(dependencies.database, {
      environmentId: scope.environmentId,
      id: scope.agentDeploymentId,
      itemType: "agent-deployment",
      kind: "environment-resource",
      organizationId: scope.organizationId,
    }),
    "agent-deployment",
  );
  if (
    deployment.data.organizationId !== scope.organizationId ||
    deployment.data.projectId !== scope.projectId ||
    deployment.data.environmentId !== scope.environmentId
  ) {
    throw new AutomationError("scope_mismatch", "agent-deployment does not match the scope.");
  }
  if (deployment.data.currentState !== "ready" || deployment.data.desiredState !== "running") {
    throw new AutomationError("deployment_unavailable", "Agent deployment is not runnable.");
  }
  const release = expected(
    await get(dependencies.database, {
      environmentId: scope.environmentId,
      id: deployment.data.agentReleaseId,
      itemType: "agent-release",
      kind: "environment-resource",
      organizationId: scope.organizationId,
    }),
    "agent-release",
  );
  if (
    release.data.organizationId !== scope.organizationId ||
    release.data.projectId !== scope.projectId ||
    release.data.environmentId !== scope.environmentId ||
    release.data.id !== deployment.data.agentReleaseId ||
    release.data.agentDefinitionId !== deployment.data.agentDefinitionId
  ) {
    throw new AutomationError("scope_mismatch", "agent-release does not match the deployment.");
  }
  if (release.data.status !== "active") {
    throw new AutomationError("release_unavailable", "Agent release is not active.");
  }
  if (!agentManifestAllowsTrigger(release.data.manifest, trigger)) {
    throw new AutomationError(
      "trigger_not_allowed",
      `Pinned agent release does not allow the ${trigger} trigger.`,
    );
  }
  return { deployment, release };
}

export async function requireActiveWorkspace(
  scope: AutomationScope,
  dependencies: AutomationDependencies,
): Promise<Workspace | undefined> {
  if (!scope.workspaceId) return undefined;
  const workspace = expected(
    await get(dependencies.database, {
      environmentId: scope.environmentId,
      id: scope.workspaceId,
      itemType: "workspace",
      kind: "environment-resource",
      organizationId: scope.organizationId,
    }),
    "workspace",
  );
  if (
    workspace.data.organizationId !== scope.organizationId ||
    workspace.data.projectId !== scope.projectId ||
    workspace.data.environmentId !== scope.environmentId
  ) {
    throw new AutomationError("scope_mismatch", "Workspace does not match the automation scope.");
  }
  if (workspace.data.status !== "active") {
    throw new AutomationError("workspace_unavailable", "Workspace is not active.");
  }
  return workspace;
}

export async function resolveAutomationThread(
  scope: AutomationScope & {
    readonly agentDeploymentId: Ulid;
    readonly threadId?: Ulid;
  },
  dependencies: AutomationDependencies,
): Promise<Thread | undefined> {
  if (!scope.threadId) return undefined;
  const thread = expected(
    await get(dependencies.database, {
      kind: "thread",
      organizationId: scope.organizationId,
      threadId: scope.threadId,
    }),
    "thread",
  );
  if (
    thread.data.organizationId !== scope.organizationId ||
    thread.data.projectId !== scope.projectId ||
    thread.data.environmentId !== scope.environmentId ||
    (scope.workspaceId !== undefined && thread.data.workspaceId !== scope.workspaceId) ||
    thread.data.agentDeploymentId !== scope.agentDeploymentId
  ) {
    throw new AutomationError("scope_mismatch", "Thread does not match the automation scope.");
  }
  return thread;
}

export async function requireActiveThread(
  scope: AutomationScope & {
    readonly agentDeploymentId: Ulid;
    readonly threadId?: Ulid;
  },
  dependencies: AutomationDependencies,
): Promise<Thread | undefined> {
  const thread = await resolveAutomationThread(scope, dependencies);
  if (!thread) return undefined;
  if (thread.data.archived) {
    throw new AutomationError("thread_archived", "Archived threads cannot receive automations.");
  }
  return thread;
}

export function creationControlConditions(
  deployment: Deployment,
  release: Release,
  workspace: Workspace | undefined,
  thread: Thread | undefined,
): readonly TransactionOperation[] {
  return [
    {
      conditionExpression:
        "#data.#version = :version AND #data.#currentState = :ready AND #data.#desiredState = :running",
      expressionAttributeNames: {
        "#currentState": "currentState",
        "#data": "data",
        "#desiredState": "desiredState",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":ready": "ready",
        ":running": "running",
        ":version": deployment.data.version,
      },
      key: { pk: deployment.pk, sk: deployment.sk },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression:
        "#data.#version = :version AND #data.#status = :active AND #data.#contentHash = :contentHash",
      expressionAttributeNames: {
        "#contentHash": "contentHash",
        "#data": "data",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":contentHash": release.data.contentHash,
        ":version": release.data.version,
      },
      key: { pk: release.pk, sk: release.sk },
      kind: "condition-check",
      table: "control",
    },
    ...(workspace
      ? [
          {
            conditionExpression: "#data.#version = :version AND #data.#status = :active",
            expressionAttributeNames: {
              "#data": "data",
              "#status": "status",
              "#version": "version",
            },
            expressionAttributeValues: {
              ":active": "active",
              ":version": workspace.data.version,
            },
            key: { pk: workspace.pk, sk: workspace.sk },
            kind: "condition-check" as const,
            table: "control" as const,
          },
        ]
      : []),
    ...(thread
      ? [
          {
            conditionExpression: "#data.#version = :version AND #data.#archived = :archived",
            expressionAttributeNames: {
              "#archived": "archived",
              "#data": "data",
              "#version": "version",
            },
            expressionAttributeValues: {
              ":archived": false,
              ":version": thread.data.version,
            },
            key: { pk: thread.pk, sk: thread.sk },
            kind: "condition-check" as const,
            table: "execution" as const,
          },
        ]
      : []),
  ];
}

export async function activeAutomationControlConditions(
  scope: AutomationScope & {
    readonly agentDeploymentId: Ulid;
    readonly threadId?: Ulid;
  },
  dependencies: AutomationDependencies,
  trigger: Extract<AgentTrigger, "heartbeat" | "schedule">,
) {
  const [workspace, thread, controls] = await Promise.all([
    requireActiveWorkspace(scope, dependencies),
    requireActiveThread(scope, dependencies),
    requireRunnableDeployment(scope, dependencies, trigger),
  ]);
  return creationControlConditions(controls.deployment, controls.release, workspace, thread);
}

export async function creationControlsChanged(
  input: AutomationScope & { readonly agentDeploymentId: Ulid },
  dependencies: AutomationDependencies,
  deployment: Deployment,
  release: Release,
  workspace: Workspace | undefined,
  thread: Thread | undefined,
  trigger: Extract<AgentTrigger, "heartbeat" | "schedule">,
) {
  const [latestWorkspace, latestThread, latestControls] = await Promise.all([
    requireActiveWorkspace(input, dependencies),
    requireActiveThread(input, dependencies),
    requireRunnableDeployment(input, dependencies, trigger),
  ]);
  return (
    latestControls.deployment.data.version !== deployment.data.version ||
    latestControls.release.data.version !== release.data.version ||
    latestControls.release.data.contentHash !== release.data.contentHash ||
    latestWorkspace?.data.version !== workspace?.data.version ||
    latestThread?.data.version !== thread?.data.version
  );
}

export type ScheduleCreationInput = AutomationScope & {
  readonly agentDeploymentId: Ulid;
  readonly createdBy?: NonNullable<Schedule["data"]["createdBy"]>;
  readonly createdFrom?: NonNullable<Schedule["data"]["createdFrom"]>;
  readonly expression: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly prompt: string;
  readonly threadId?: Ulid;
  readonly timezone?: string;
};

async function createScheduleAttempt(
  input: ScheduleCreationInput,
  dependencies: AutomationDependencies,
  conflictAttempts: number,
): Promise<Schedule> {
  const expression = validateScheduleExpression(input.expression);
  const normalizedTimezone = timezone(input.timezone);
  const name = required(input.name, "Schedule name", 120);
  const prompt = required(input.prompt, "Schedule prompt", 40_000);
  const scopedThread = await resolveAutomationThread(input, dependencies);
  const effectiveInput =
    input.workspaceId === undefined && scopedThread?.data.workspaceId
      ? { ...input, workspaceId: scopedThread.data.workspaceId }
      : input;
  const finishProvisioning = (schedule: Schedule) =>
    finishTimerProvisioning(schedule, dependencies, () =>
      activeAutomationControlConditions(effectiveInput, dependencies, "schedule"),
    ) as Promise<Schedule>;
  const identity = automationCreationIdentity(effectiveInput, "schedule", input.idempotencyKey, {
    agentDeploymentId: input.agentDeploymentId,
    expression,
    name,
    prompt,
    threadId: input.threadId ?? null,
    timezone: normalizedTimezone ?? null,
    workspaceId: effectiveInput.workspaceId ?? null,
  });
  const existing = await get(dependencies.database, {
    environmentId: input.environmentId,
    id: identity.id,
    itemType: "schedule",
    kind: "environment-resource",
    organizationId: input.organizationId,
  });
  if (existing) {
    const schedule = expected(existing, "schedule");
    assertCreationReplay(schedule, effectiveInput, identity.creationHash);
    return finishProvisioning(schedule);
  }
  const workspace = await requireActiveWorkspace(effectiveInput, dependencies);
  const thread = await requireActiveThread(effectiveInput, dependencies);
  const { deployment, release } = await requireRunnableDeployment(
    effectiveInput,
    dependencies,
    "schedule",
  );
  const now = dependencies.now?.() ?? new Date();
  const record = Schema.decodeUnknownSync(ScheduleRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: input.agentDeploymentId,
        createdAt: now.toISOString(),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        ...(input.createdFrom ? { createdFrom: input.createdFrom } : {}),
        environmentId: effectiveInput.environmentId,
        id: identity.id,
        name,
        organizationId: effectiveInput.organizationId,
        projectId: effectiveInput.projectId,
        prompt,
        schedule: {
          creationHash: identity.creationHash,
          expression,
          timerVersion: 0,
          ...(normalizedTimezone ? { timezone: normalizedTimezone } : {}),
        },
        status: "provisioning" as const,
        ...(effectiveInput.threadId ? { threadId: effectiveInput.threadId } : {}),
        updatedAt: now.toISOString(),
        version: 0,
        ...(effectiveInput.workspaceId ? { workspaceId: effectiveInput.workspaceId } : {}),
      },
      itemType: "schedule" as const,
    }),
  );
  const event = makeSemanticEventRecord({
    aggregateId: record.data.id,
    aggregateType: "schedule",
    aggregateVersion: 1,
    environmentId: effectiveInput.environmentId,
    eventId: deterministicId(record.data.id, "created-event"),
    eventType: "schedule.created",
    occurredAt: now,
    organizationId: effectiveInput.organizationId,
    payload: {
      agentDeploymentId: input.agentDeploymentId,
      expression,
      status: "provisioning",
    },
    projectId: effectiveInput.projectId,
  });
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record,
        },
        ...creationControlConditions(deployment, release, workspace, thread),
      ],
      [event],
    );
  } catch (cause) {
    const reconciled = await get(dependencies.database, {
      environmentId: record.data.environmentId,
      id: record.data.id,
      itemType: "schedule",
      kind: "environment-resource",
      organizationId: record.data.organizationId,
    });
    if (!reconciled) {
      const controlsChanged = await creationControlsChanged(
        effectiveInput,
        dependencies,
        deployment,
        release,
        workspace,
        thread,
        "schedule",
      );
      if (controlsChanged && conflictAttempts < MAX_CREATION_CONFLICT_RETRIES) {
        return createScheduleAttempt(input, dependencies, conflictAttempts + 1);
      }
      throw cause;
    }
    const schedule = expected(reconciled, "schedule");
    assertCreationReplay(schedule, effectiveInput, identity.creationHash);
    return finishProvisioning(schedule);
  }
  return finishProvisioning(record);
}

export function createSchedule(input: ScheduleCreationInput, dependencies: AutomationDependencies) {
  return createScheduleAttempt(input, dependencies, 0);
}
