import {
  assertRunAdmissible,
  leaseIsMessagePublicationBarrier,
} from "@deployments-ai/conversations";
import {
  MessageRecord,
  RunLookupRecord,
  RunRecord,
  ThreadRecord,
  TraceRecord,
  executionEventPayload,
  key,
  makeConversationMessagePublicationPersistence,
  usageScopeOf,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import {
  OBSERVABILITY_REDACTION_POLICY_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
  createSpanId,
  createTraceId,
} from "@deployments-ai/observability";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { publicApproval, publicRun, publicToolCall } from "./public-projections.ts";
import { recordActor, runInitiatingCaller } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  assertRecord,
  getRecord,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

import { loadRunById, projectItems, queryRecords } from "./runtime-cursors.ts";
import {
  loadRuntimeMutationPublication,
  publicationRunSnapshot,
  runEvent,
  runQueueMessage,
  runRequestedEvent,
  runtimeMutationPublication,
} from "@deployments-ai/worker/run-mutations";
import { type RunMutationResult } from "./runtime-listing.ts";
import { loadRunnableRunContext, runnableRunConditionChecks } from "./runtime-run-context.ts";
import { authorizeRunInputArtifacts } from "./run-input-artifacts.ts";

async function requireReplayOrderingAvailable(
  dependencies: RuntimeApiDependencies,
  threadId: Ulid,
) {
  const lease = await makeConversationMessagePublicationPersistence(
    dependencies.database,
  ).loadThreadExecutionLease(threadId);
  if (leaseIsMessagePublicationBarrier(lease)) {
    throw new RuntimeApiError(
      409,
      "publication_busy",
      "The conversation is waiting for an external delivery outcome.",
    );
  }
}

export async function replayRun(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  runId: Ulid,
  idempotencyKey: string,
): Promise<RunMutationResult> {
  const source = await loadRunById(dependencies, principal, runId);
  const existingValue = await getRecord(dependencies.database, "execution", {
    pk: source.pk,
    sk: key("RUN", idempotencyKey),
  });
  if (existingValue) {
    const existing = scoped(assertRecord(existingValue, "run", "Replayed run"), principal);
    if (existing.data.replayedFromRunId !== source.data.id) {
      throw new RuntimeApiError(
        409,
        "idempotency_conflict",
        "Idempotency key belongs to another run.",
      );
    }
    const publication = await loadRuntimeMutationPublication(
      dependencies.database,
      existing,
      "runtime-api.replay-publication",
    );
    if (!publication) {
      return { run: publicRun(existing), snapshot: existing };
    }
    const snapshot = scoped(publicationRunSnapshot(publication), principal);
    return { publication, run: publicRun(snapshot), snapshot };
  }
  if (!["canceled", "completed", "failed"].includes(source.data.status)) {
    throw new RuntimeApiError(409, "run_not_replayable", "Only terminal runs can be replayed.");
  }
  const context = await loadRunnableRunContext(dependencies, principal, source);
  const { thread } = context;
  await requireReplayOrderingAvailable(dependencies, thread.data.id);
  const sourceQueueMessage = runQueueMessage(source);
  const sourceMessageValue = await getRecord(dependencies.database, "execution", {
    pk: source.pk,
    sk: key(
      "MESSAGE",
      String(sourceQueueMessage.userMessageSequence).padStart(16, "0"),
      sourceQueueMessage.userMessageId,
    ),
  });
  const sourceMessage = scoped(
    assertRecord(sourceMessageValue, "message", "Run user message"),
    principal,
  );
  if (
    sourceMessage.data.role !== "user" ||
    sourceMessage.data.runId !== source.data.id ||
    sourceMessage.data.threadId !== source.data.threadId ||
    sourceMessage.data.sequence !== sourceQueueMessage.userMessageSequence ||
    sourceMessage.data.agentDeploymentId !== source.data.agentDeploymentId
  ) {
    throw new RuntimeApiError(
      409,
      "run_not_replayable",
      "Run user message is not bound to the source run.",
    );
  }
  if (sourceMessage.data.bodyRef) {
    throw new RuntimeApiError(
      409,
      "run_not_replayable",
      "Runs with externally stored prompt bodies cannot be replayed.",
    );
  }
  if (thread.data.archived) {
    throw new RuntimeApiError(
      409,
      "thread_archived",
      "Archived threads cannot receive replayed runs.",
    );
  }
  if (
    thread.data.agentDeploymentId !== source.data.agentDeploymentId ||
    thread.data.executionBindingId !== source.data.executionBindingId
  ) {
    throw new RuntimeApiError(
      409,
      "run_not_replayable",
      "A child run targeting a different deployment cannot be replayed as a detached root on its parent thread.",
    );
  }
  await authorizeRunInputArtifacts(dependencies, principal, source);
  const now = dependencies.now?.() ?? new Date();
  await assertRunAdmissible(dependencies.database, usageScopeOf(source.data), now);
  const [newRunId, newMessageId, eventId, dispatchEventId, threadEventId] = await Promise.all([
    dependencies.generateId(),
    dependencies.generateId(),
    dependencies.generateId(),
    dependencies.generateId(),
    dependencies.generateId(),
  ]);
  const timestamp = now.toISOString();
  const traceId = createTraceId();
  const spanId = createSpanId();
  const messageSequence = thread.data.version + 1;
  const {
    createdAt: _sourceCreatedAt,
    id: _sourceMessageId,
    runId: _sourceRunId,
    sequence: _sourceSequence,
    streamEventId: _sourceStreamEventId,
    ...sourceMessageData
  } = sourceMessage.data;
  const replayMessage = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...sourceMessageData,
        createdAt: timestamp,
        id: newMessageId,
        runId: newRunId,
        sequence: messageSequence,
      },
      itemType: "message" as const,
    }),
  );
  const replayThread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      ...thread,
      data: {
        ...thread.data,
        updatedAt: timestamp,
        version: messageSequence,
      },
    }),
  );
  const replay = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(source.data.executionBindingId === undefined
          ? {
              agentDeploymentId: source.data.agentDeploymentId,
              agentReleaseId: source.data.agentReleaseId,
            }
          : {
              ...(source.data.agentReleaseId === undefined
                ? {}
                : { agentReleaseId: source.data.agentReleaseId }),
              executionBindingId: source.data.executionBindingId,
              executionPurpose: source.data.executionPurpose,
            }),
        attempt: 0,
        captureMode: source.data.captureMode,
        createdAt: timestamp,
        environmentId: source.data.environmentId,
        executor: source.data.executor,
        id: newRunId,
        idempotencyKey,
        initiatingCaller: runInitiatingCaller(principal),
        organizationId: source.data.organizationId,
        priority: source.data.priority,
        projectId: source.data.projectId,
        queuedAt: timestamp,
        redactionPolicyVersion: OBSERVABILITY_REDACTION_POLICY_VERSION,
        ...(source.data.responsePublication
          ? { responsePublication: source.data.responsePublication }
          : {}),
        ...(source.data.runContext ? { runContext: source.data.runContext } : {}),
        ...(source.data.inputArtifacts ? { inputArtifacts: source.data.inputArtifacts } : {}),
        ...(source.data.responseFormat ? { responseFormat: source.data.responseFormat } : {}),
        replayedFromRunId: source.data.id,
        replayedFromTraceId: source.data.traceId,
        schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
        spanId,
        status: "queued" as const,
        threadId: source.data.threadId,
        trigger: source.data.trigger,
        traceId,
        updatedAt: timestamp,
        userMessageId: replayMessage.data.id,
        userMessageSequence: replayMessage.data.sequence,
        version: 0,
        ...(source.data.workspaceId ? { workspaceId: source.data.workspaceId } : {}),
      },
      itemType: "run" as const,
    }),
  );
  const trace = Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        captureMode: replay.data.captureMode,
        createdAt: timestamp,
        environmentId: replay.data.environmentId,
        id: traceId,
        organizationId: replay.data.organizationId,
        projectId: replay.data.projectId,
        redactionPolicyVersion: OBSERVABILITY_REDACTION_POLICY_VERSION,
        rootRunId: replay.data.id,
        rootSpanId: spanId,
        runIds: [replay.data.id],
        terminalRunIds: [],
        schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
        sessionId: replay.data.threadId,
        status: "open" as const,
        traceId,
        updatedAt: timestamp,
        version: 0,
        ...(replay.data.workspaceId ? { workspaceId: replay.data.workspaceId } : {}),
      },
      itemType: "trace" as const,
    }),
  );
  const publication = runtimeMutationPublication(
    replay,
    eventId,
    "runtime-api.replay-publication",
    now,
    { runVersion: replay.data.version },
  );
  const lookup = Schema.decodeUnknownSync(RunLookupRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        environmentId: source.data.environmentId,
        idempotencyKey,
        organizationId: source.data.organizationId,
        projectId: source.data.projectId,
        runId: newRunId,
        threadId: source.data.threadId,
      },
      itemType: "run-lookup" as const,
    }),
  );
  let accepted = replay;
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        ...runnableRunConditionChecks(context, false),
        {
          kind: "put",
          previousRecord: thread,
          record: replayThread,
        },
        { kind: "put", record: replayMessage },
        { kind: "put", record: replay },
        { kind: "put", record: trace },
        { kind: "put", record: lookup },
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: publication,
        },
      ],
      [
        makeSemanticEventRecord({
          actor: recordActor(principal),
          aggregateId: replayThread.data.id,
          aggregateType: "thread",
          aggregateVersion: replayThread.data.version + 1,
          environmentId: replayThread.data.environmentId,
          eventId: threadEventId,
          eventType: "user-message.replayed",
          occurredAt: now,
          organizationId: replayThread.data.organizationId,
          payload: executionEventPayload(replay.data, {
            messageId: replayMessage.data.id,
            runId: replay.data.id,
            sequence: replayMessage.data.sequence,
            sourceMessageId: sourceMessage.data.id,
            sourceRunId: source.data.id,
          }),
          projectId: replayThread.data.projectId,
        }),
        runEvent(replay, eventId, "run.replayed", now),
        runRequestedEvent(replay, dispatchEventId, now),
      ],
    );
  } catch (cause) {
    const winner = await getRecord(dependencies.database, "execution", {
      pk: source.pk,
      sk: key("RUN", idempotencyKey),
    });
    if (!winner || winner.itemType !== "run" || winner.data.replayedFromRunId !== source.data.id) {
      await requireReplayOrderingAvailable(dependencies, thread.data.id);
      throw cause;
    }
    accepted = scoped(winner, principal);
  }
  if (accepted.data.id !== replay.data.id) {
    const winnerPublication = await loadRuntimeMutationPublication(
      dependencies.database,
      accepted,
      "runtime-api.replay-publication",
    );
    if (!winnerPublication) return { run: publicRun(accepted), snapshot: accepted };
    const snapshot = scoped(publicationRunSnapshot(winnerPublication), principal);
    return { publication: winnerPublication, run: publicRun(snapshot), snapshot };
  }
  return { publication, run: publicRun(replay), snapshot: replay };
}

export async function listApprovals(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  query: Readonly<Record<string, string | undefined>>,
) {
  const status = query.status;
  if (status !== undefined && !["approved", "expired", "pending", "rejected"].includes(status)) {
    throw new RuntimeApiError(400, "invalid_status", "status is invalid.");
  }
  const page = await queryRecords(
    dependencies.database,
    "execution",
    dependencies.sessionTokenSecret,
    {
      cursor: query.cursor,
      expressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
      expressionAttributeValues: {
        ":pk": key("ENV", principal.scope.environmentId),
        ":prefix": status === undefined ? "APPROVAL#" : `APPROVAL#${status}#`,
      },
      indexName: "gsi2",
      keyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      limit: query.limit,
    },
  );
  return {
    approvals: projectItems(page.items, "approval", principal).map(publicApproval),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function getApproval(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  runId: Ulid,
  approvalId: Ulid,
) {
  await loadRunById(dependencies, principal, runId);
  return publicApproval(
    scoped(
      assertRecord(
        await getRecord(dependencies.database, "execution", {
          pk: key("ORG", principal.scope.organizationId, "RUN", runId),
          sk: key("APPROVAL", approvalId),
        }),
        "approval",
        "Approval",
      ),
      principal,
    ),
  );
}

export async function listRunToolCalls(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  runId: Ulid,
  query: Readonly<Record<string, string | undefined>>,
) {
  await loadRunById(dependencies, principal, runId);
  const page = await queryRecords(
    dependencies.database,
    "execution",
    dependencies.sessionTokenSecret,
    {
      cursor: query.cursor,
      cursorContext: {
        organizationId: principal.scope.organizationId,
        projectId: principal.scope.projectId,
        runId,
      },
      expressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      expressionAttributeValues: {
        ":pk": key("ORG", principal.scope.organizationId, "RUN", runId),
        ":prefix": "TOOL-CALL#",
      },
      keyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      limit: query.limit,
    },
  );
  return {
    toolCalls: projectItems(page.items, "tool-call", principal).map(publicToolCall),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}
