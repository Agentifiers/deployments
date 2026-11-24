import { HeartbeatRecord, Ulid, withCanonicalRecordKeys } from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { AutomationError } from "./errors.ts";
import { automationCreationIdentity, deterministicId, required } from "./identifiers.ts";
import type { AutomationDependencies, AutomationScope } from "./index.ts";
import { MIN_HEARTBEAT_INTERVAL_MS, finishTimerProvisioning } from "./timer-provisioning.ts";
import { validateHeartbeatActiveWindow } from "./validation.ts";

import {
  MAX_CREATION_CONFLICT_RETRIES,
  MAX_HEARTBEAT_INTERVAL_MS,
  activeAutomationControlConditions,
  assertCreationReplay,
  creationControlConditions,
  creationControlsChanged,
  expected,
  get,
  heartbeatFromCreationEvent,
  requireActiveThread,
  requireActiveWorkspace,
  requireRunnableDeployment,
  resolveAutomationThread,
  timezone,
  type Heartbeat,
} from "./automation-validation.ts";

export type HeartbeatCreationInput = AutomationScope & {
  readonly activeWindow?: Readonly<Record<string, unknown>>;
  readonly agentDeploymentId: Ulid;
  readonly createdBy?: NonNullable<Heartbeat["data"]["createdBy"]>;
  readonly idempotencyKey: string;
  readonly instructions: string;
  readonly intervalMs?: number;
  readonly skipWhenBusy?: boolean;
  readonly threadId?: Ulid;
  readonly timezone?: string;
};

async function createHeartbeatAttempt(
  input: HeartbeatCreationInput,
  dependencies: AutomationDependencies,
  conflictAttempts: number,
): Promise<Heartbeat> {
  const intervalMs = input.intervalMs ?? 30 * 60_000;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MIN_HEARTBEAT_INTERVAL_MS ||
    intervalMs > MAX_HEARTBEAT_INTERVAL_MS ||
    intervalMs % MIN_HEARTBEAT_INTERVAL_MS !== 0
  ) {
    throw new AutomationError(
      "invalid_interval",
      "Heartbeat interval must be a whole number of minutes from 1 minute to 30 days.",
    );
  }
  const normalizedTimezone = timezone(input.timezone);
  const activeWindow = validateHeartbeatActiveWindow(input.activeWindow);
  const instructions = required(input.instructions, "Heartbeat instructions", 32_000);
  const skipWhenBusy = input.skipWhenBusy ?? true;
  const scopedThread = await resolveAutomationThread(input, dependencies);
  const effectiveInput =
    input.workspaceId === undefined && scopedThread?.data.workspaceId
      ? { ...input, workspaceId: scopedThread.data.workspaceId }
      : input;
  const finishProvisioning = (heartbeat: Heartbeat) =>
    finishTimerProvisioning(heartbeat, dependencies, () =>
      activeAutomationControlConditions(effectiveInput, dependencies, "heartbeat"),
    ) as Promise<Heartbeat>;
  const identity = automationCreationIdentity(effectiveInput, "heartbeat", input.idempotencyKey, {
    activeWindow: activeWindow ?? null,
    agentDeploymentId: input.agentDeploymentId,
    instructions,
    intervalMs,
    skipWhenBusy,
    threadId: input.threadId ?? null,
    timezone: normalizedTimezone ?? null,
    workspaceId: effectiveInput.workspaceId ?? null,
  });
  const canonicalExisting = await get(dependencies.database, {
    agentDeploymentId: input.agentDeploymentId,
    heartbeatId: identity.id,
    kind: "heartbeat",
    organizationId: input.organizationId,
  });
  if (canonicalExisting) {
    const heartbeat = expected(canonicalExisting, "heartbeat");
    assertCreationReplay(heartbeat, effectiveInput, identity.creationHash);
    return finishProvisioning(heartbeat);
  }
  const now = dependencies.now?.() ?? new Date();
  const event = makeSemanticEventRecord({
    aggregateId: identity.id,
    aggregateType: "heartbeat",
    aggregateVersion: 1,
    environmentId: effectiveInput.environmentId,
    eventId: deterministicId(identity.id, "created-event"),
    eventType: "heartbeat.created",
    occurredAt: now,
    organizationId: effectiveInput.organizationId,
    payload: {
      agentDeploymentId: input.agentDeploymentId,
      intervalMs,
      status: "provisioning",
    },
    projectId: effectiveInput.projectId,
  });
  const conflicting = await heartbeatFromCreationEvent(
    dependencies.database,
    effectiveInput,
    identity.id,
    await get(dependencies.database, {
      aggregateId: identity.id,
      aggregateType: "heartbeat",
      kind: "creation-event",
      organizationId: effectiveInput.organizationId,
    }),
  );
  if (conflicting) {
    const heartbeat = expected(conflicting, "heartbeat");
    assertCreationReplay(heartbeat, effectiveInput, identity.creationHash);
    return finishProvisioning(heartbeat);
  }
  const workspace = await requireActiveWorkspace(effectiveInput, dependencies);
  const thread = await requireActiveThread(effectiveInput, dependencies);
  const { deployment, release } = await requireRunnableDeployment(
    effectiveInput,
    dependencies,
    "heartbeat",
  );
  const record = Schema.decodeUnknownSync(HeartbeatRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(activeWindow ? { activeWindow } : {}),
        agentDeploymentId: input.agentDeploymentId,
        createdAt: now.toISOString(),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        environmentId: effectiveInput.environmentId,
        id: identity.id,
        nextRunAt: new Date(now.getTime() + intervalMs).toISOString(),
        organizationId: effectiveInput.organizationId,
        projectId: effectiveInput.projectId,
        schedule: {
          creationHash: identity.creationHash,
          instructions,
          intervalMs,
          skipWhenBusy,
          timerVersion: 0,
          ...(normalizedTimezone ? { timezone: normalizedTimezone } : {}),
        },
        status: "provisioning" as const,
        ...(effectiveInput.threadId ? { threadId: effectiveInput.threadId } : {}),
        updatedAt: now.toISOString(),
        version: 0,
        ...(effectiveInput.workspaceId ? { workspaceId: effectiveInput.workspaceId } : {}),
      },
      itemType: "heartbeat" as const,
    }),
  );
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
    let reconciled = await get(dependencies.database, {
      agentDeploymentId: record.data.agentDeploymentId,
      heartbeatId: record.data.id,
      kind: "heartbeat",
      organizationId: record.data.organizationId,
    });
    if (!reconciled) {
      reconciled = await heartbeatFromCreationEvent(
        dependencies.database,
        effectiveInput,
        identity.id,
        await get(dependencies.database, {
          aggregateId: identity.id,
          aggregateType: "heartbeat",
          kind: "creation-event",
          organizationId: effectiveInput.organizationId,
        }),
      );
    }
    if (!reconciled) {
      const controlsChanged = await creationControlsChanged(
        effectiveInput,
        dependencies,
        deployment,
        release,
        workspace,
        thread,
        "heartbeat",
      );
      if (controlsChanged && conflictAttempts < MAX_CREATION_CONFLICT_RETRIES) {
        return createHeartbeatAttempt(input, dependencies, conflictAttempts + 1);
      }
      throw cause;
    }
    const heartbeat = expected(reconciled, "heartbeat");
    assertCreationReplay(heartbeat, effectiveInput, identity.creationHash);
    return finishProvisioning(heartbeat);
  }
  return finishProvisioning(record);
}

export function createHeartbeat(
  input: HeartbeatCreationInput,
  dependencies: AutomationDependencies,
) {
  return createHeartbeatAttempt(input, dependencies, 0);
}
