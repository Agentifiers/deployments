import {
  continuationCheckpointRecord,
  isDatabaseWriteConflict,
  makeConversationPersistence,
  makeConversationContinuityRecoveryPersistence,
  makeConversationThreadContinuityPersistence,
  ThreadRecord,
  executionEventPayload,
  key,
  withCanonicalRecordKeys,
  type EndUserKey,
  type PlatformRecord,
  type Ulid,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { enqueueThreadContinuityRecovery } from "@deployments-ai/worker/thread-continuity-recovery";
import type { RunCancellation } from "@deployments-ai/worker/run-mutations";
import { Schema } from "effect";
import { publicRun, publicThread } from "./public-projections.ts";
import { recordActor } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  assertRecord,
  getRecord,
  loadThread,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

import { nextAggregateEventVersion } from "./runtime-cursors.ts";
export async function createThread(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  input: {
    readonly agentDeploymentId: Ulid;
    readonly channel?: "api" | "console";
    readonly continueFromThreadId?: Ulid;
    readonly endUserKey?: EndUserKey;
    readonly title?: string;
    readonly workspaceId?: Ulid;
  },
) {
  const deployment = scoped(
    assertRecord(
      await getRecord(dependencies.database, "control", {
        pk: key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId),
        sk: key("AGENT-DEPLOYMENT", input.agentDeploymentId),
      }),
      "agent-deployment",
      "Agent deployment",
    ),
    principal,
  );
  if (deployment.data.currentState !== "ready" || deployment.data.desiredState !== "running") {
    throw new RuntimeApiError(409, "deployment_unavailable", "Agent deployment is not runnable.");
  }
  const predecessorThread = input.continueFromThreadId
    ? await loadThread(dependencies, principal, input.continueFromThreadId)
    : undefined;
  if (predecessorThread?.data.archived) {
    throw new RuntimeApiError(
      409,
      "thread_continuity_mismatch",
      "Archived threads cannot be continued into a new deployment.",
    );
  }
  const predecessorSubject = predecessorThread?.data.endUserKey;
  if (predecessorThread && input.endUserKey && input.endUserKey !== predecessorSubject) {
    throw new RuntimeApiError(
      409,
      "end_user_mismatch",
      "A continued thread belongs to the same end user as the thread it continues.",
    );
  }
  const endUserKey = input.endUserKey ?? predecessorSubject;
  const predecessorDeploymentId = predecessorThread?.data.agentDeploymentId;
  if (predecessorThread && predecessorDeploymentId === undefined) {
    throw new RuntimeApiError(
      409,
      "thread_continuity_mismatch",
      "Preview and evaluation threads cannot be continued by a deployment.",
    );
  }
  const predecessorDeployment = predecessorDeploymentId
    ? scoped(
        assertRecord(
          await getRecord(dependencies.database, "control", {
            pk: key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId),
            sk: key("AGENT-DEPLOYMENT", predecessorDeploymentId),
          }),
          "agent-deployment",
          "Predecessor agent deployment",
        ),
        principal,
      )
    : undefined;
  if (
    predecessorDeployment &&
    predecessorDeployment.data.agentDefinitionId !== deployment.data.agentDefinitionId
  ) {
    throw new RuntimeApiError(
      409,
      "thread_continuity_mismatch",
      "Thread continuity requires deployments of the same agent definition.",
    );
  }
  if (
    predecessorThread &&
    input.workspaceId !== undefined &&
    input.workspaceId !== predecessorThread.data.workspaceId
  ) {
    throw new RuntimeApiError(
      409,
      "thread_continuity_mismatch",
      "Thread continuity cannot change workspace scope.",
    );
  }
  const workspaceId = input.workspaceId ?? predecessorThread?.data.workspaceId;
  if (predecessorThread && workspaceId !== predecessorThread.data.workspaceId) {
    throw new RuntimeApiError(
      409,
      "thread_continuity_mismatch",
      "Thread continuity cannot change workspace scope.",
    );
  }
  const workspace = workspaceId
    ? scoped(
        assertRecord(
          await getRecord(dependencies.database, "control", {
            pk: key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId),
            sk: key("WORKSPACE", workspaceId),
          }),
          "workspace",
          "Workspace",
        ),
        principal,
      )
    : undefined;
  if (workspace && workspace.data.status !== "active") {
    throw new RuntimeApiError(409, "workspace_unavailable", "Workspace is not active.");
  }
  const predecessorCheckpoint = predecessorThread
    ? await makeConversationPersistence(dependencies.database).latestCheckpoint(
        {
          organizationId: principal.scope.organizationId,
          threadId: predecessorThread.data.id,
        },
        predecessorThread.data.version,
      )
    : undefined;
  if (
    predecessorCheckpoint &&
    (predecessorCheckpoint.data.organizationId !== principal.scope.organizationId ||
      predecessorCheckpoint.data.projectId !== principal.scope.projectId ||
      predecessorCheckpoint.data.environmentId !== principal.scope.environmentId ||
      predecessorCheckpoint.data.threadId !== predecessorThread?.data.id ||
      predecessorCheckpoint.data.agentDeploymentId !== predecessorThread.data.agentDeploymentId)
  ) {
    throw new RuntimeApiError(
      409,
      "thread_continuity_mismatch",
      "The predecessor checkpoint does not belong to the requested thread.",
    );
  }
  const uncoveredReplayableMessages =
    predecessorThread &&
    predecessorThread.data.version > (predecessorCheckpoint?.data.throughSequence ?? -1)
      ? await makeConversationPersistence(dependencies.database).messagesInSequenceRange(
          {
            organizationId: principal.scope.organizationId,
            threadId: predecessorThread.data.id,
          },
          {
            ...(predecessorCheckpoint
              ? { afterSequence: predecessorCheckpoint.data.throughSequence }
              : {}),
            limit: 1,
            throughSequence: predecessorThread.data.version,
          },
        )
      : [];
  if (
    predecessorThread &&
    (predecessorCheckpoint?.data.throughMessageCharacterOffset !== undefined ||
      uncoveredReplayableMessages.length > 0)
  ) {
    const candidates = await makeConversationContinuityRecoveryPersistence(
      dependencies.database,
    ).candidates({
      ...(predecessorCheckpoint ? { checkpoint: predecessorCheckpoint } : {}),
      scope: {
        environmentId: principal.scope.environmentId,
        organizationId: principal.scope.organizationId,
        projectId: principal.scope.projectId,
        threadId: predecessorThread.data.id,
      },
      throughSequence: predecessorThread.data.version,
    });
    await candidates.reduce(async (previous, candidate) => {
      await previous;
      await enqueueThreadContinuityRecovery(
        dependencies.enqueueRun,
        candidate.run,
        candidate.publication,
      );
    }, Promise.resolve());
    throw new RuntimeApiError(
      409,
      "thread_continuity_incomplete",
      "The predecessor thread has replayable history outside its complete rolling checkpoint.",
    );
  }
  const [threadId, streamId, eventId, checkpointId] = await Promise.all([
    dependencies.generateId(),
    dependencies.generateId(),
    dependencies.generateId(),
    ...(predecessorCheckpoint ? [dependencies.generateId()] : []),
  ]);
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  const thread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: input.agentDeploymentId,
        archived: false,
        channel: input.channel ?? "api",
        ...(predecessorThread ? { continuedFromThreadId: predecessorThread.data.id } : {}),
        createdAt: timestamp,
        createdBy: recordActor(principal),
        ...(endUserKey ? { endUserKey } : {}),
        environmentId: principal.scope.environmentId,
        id: threadId,
        organizationId: principal.scope.organizationId,
        pinned: false,
        projectId: principal.scope.projectId,
        streamId,
        title: input.title?.trim() || "New conversation",
        updatedAt: timestamp,
        version: 0,
        ...(workspaceId ? { workspaceId } : {}),
      },
      itemType: "thread" as const,
    }),
  );
  const event = makeSemanticEventRecord({
    actor: recordActor(principal),
    aggregateId: threadId,
    aggregateType: "thread",
    aggregateVersion: 1,
    environmentId: principal.scope.environmentId,
    eventId,
    eventType: "thread.created",
    occurredAt: now,
    organizationId: principal.scope.organizationId,
    payload: {
      agentDeploymentId: input.agentDeploymentId,
      ...(predecessorCheckpoint
        ? { continuedFromCheckpointId: predecessorCheckpoint.data.id }
        : {}),
      ...(predecessorThread ? { continuedFromThreadId: predecessorThread.data.id } : {}),
      threadId,
    },
    projectId: principal.scope.projectId,
  });
  if (predecessorThread && predecessorDeployment) {
    const checkpoint =
      predecessorCheckpoint && checkpointId
        ? continuationCheckpointRecord(predecessorCheckpoint, {
            agentDeploymentId: input.agentDeploymentId,
            createdAt: timestamp,
            id: checkpointId,
            threadId,
          })
        : undefined;
    try {
      await makeConversationThreadContinuityPersistence(dependencies.database).createSuccessor({
        ...(checkpoint ? { checkpoint } : {}),
        event,
        ...(predecessorCheckpoint ? { predecessorCheckpoint } : {}),
        predecessorDeployment,
        predecessorThread,
        targetDeployment: deployment,
        thread,
        ...(workspace ? { workspace } : {}),
      });
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      throw new RuntimeApiError(
        409,
        "thread_continuity_changed",
        "Thread continuity state changed concurrently; retry the request.",
      );
    }
  } else {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        { kind: "put", record: thread },
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
      ],
      [event],
    );
  }
  return publicThread(thread);
}

export async function archiveThread(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  threadId: Ulid,
) {
  const previous = await loadThread(dependencies, principal, threadId);
  if (previous.data.archived) return publicThread(previous);
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = await runtimeApiPersistence.find(dependencies.database, "execution", {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ConsistentRead: true,
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": previous.pk,
        ":prefix": "RUN#",
      },
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      Limit: 100,
    });
    const active = page.items.some(
      (record) =>
        record.itemType === "run" &&
        record.data.organizationId === principal.scope.organizationId &&
        record.data.projectId === principal.scope.projectId &&
        record.data.environmentId === principal.scope.environmentId &&
        record.data.threadId === threadId &&
        !["canceled", "completed", "failed"].includes(record.data.status),
    );
    if (active) {
      throw new RuntimeApiError(
        409,
        "thread_active",
        "Threads with active runs cannot be archived.",
      );
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  const now = dependencies.now?.() ?? new Date();
  const replacement = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        archived: true,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
    }),
  );
  const event = makeSemanticEventRecord({
    actor: recordActor(principal),
    aggregateId: threadId,
    aggregateType: "thread",
    aggregateVersion: await nextAggregateEventVersion(
      dependencies,
      principal.scope.organizationId,
      "thread",
      threadId,
    ),
    environmentId: principal.scope.environmentId,
    eventId: await dependencies.generateId(),
    eventType: "thread.archived",
    occurredAt: now,
    organizationId: principal.scope.organizationId,
    payload: executionEventPayload(previous.data, { threadId }),
    projectId: principal.scope.projectId,
  });
  await transactWithSemanticEvents(
    dependencies.database,
    [{ kind: "put", previousRecord: previous, record: replacement }],
    [event],
  );
  return publicThread(replacement);
}

export type RunMutationResult = Readonly<{
  publication?: Extract<PlatformRecord, { readonly itemType: "timeline-event" }>;
  run: ReturnType<typeof publicRun>;
  snapshot: Extract<PlatformRecord, { readonly itemType: "run" }>;
}>;

export type CancelRunResult = RunCancellation & Readonly<{ run: ReturnType<typeof publicRun> }>;
