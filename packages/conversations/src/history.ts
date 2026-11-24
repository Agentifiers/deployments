import {
  IdempotencyRecord,
  InboxMailErasedError,
  MessageRecord,
  RunLookupRecord,
  RunRecord,
  ThreadRecord,
  InvalidConversationHistoryCursorError,
  makeConversationMessagePublicationPersistence,
  makeConversationPersistence,
  usageScopeOf,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import {
  DEFAULT_CAPTURE_MODE,
  OBSERVABILITY_REDACTION_POLICY_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
  createSpanId,
  createTraceId,
} from "@deployments-ai/observability";
import {
  internalSemanticEventPayload,
  makeSemanticEventRecord,
  transactWithSemanticEvents,
} from "@deployments-ai/events";
import {
  createOffsetBeforeHistorySession,
  createThreadStreamEvent,
  type DurableStreamTransport,
  type ThreadHistoryPage,
  type ThreadStreamEvent,
  type ThreadStreamScope,
  type ThreadStreamSession,
  type ThreadStreamSessionClaims,
} from "@deployments-ai/streaming";
import { Schema } from "effect";
import { admitSubmittedInputMedia, validateSubmittedRunInput } from "./run-input.ts";
import { assertRunAdmissible } from "./run-admission.ts";
import { submittedThreadSubject } from "./end-user-subject.ts";
import { createHash } from "node:crypto";
import {
  ConversationError,
  DEFAULT_HISTORY_LIMIT,
  PERMANENT_IDEMPOTENCY_EXPIRES_AT,
  MAX_HISTORY_LIMIT,
  commandHash,
  conversationIdempotencyKey,
  content,
  loadDeploymentAndRelease,
  runnableControlChecks,
  loadThread,
  normalizeText,
  queueIdempotencyKey,
  queueGroupId,
  queueMessage,
  reconcileSubmission,
  requireActiveWorkspace,
  submittedThreadTitle,
  titleFromContent,
  streamActor,
} from "./submission.ts";
import { conversationHistorySnapshot } from "./history-snapshot.ts";
import { conversationMessageIsTransient } from "./message-visibility.ts";
import { leaseIsMessagePublicationBarrier } from "./message-publication-state.ts";
import { loadParentTraceContext, observabilityRecordsForRun } from "./trace-context.ts";
import { effectiveResponseFormat } from "./response-format-selection.ts";
import { appendAcceptedThreadEvent } from "./acceptance-stream.ts";
import type {
  ConversationMessage,
  ConversationServiceOptions,
  SubmitConversationTurnInput,
  SubmitConversationTurnResult,
} from "./submission.ts";

const MAX_TRANSIENT_HISTORY_SCAN_PAGES = 128;

export function createConversationService(options: ConversationServiceOptions) {
  const MAX_THREAD_CONFLICT_RETRIES = 3;
  const publicationPersistence = makeConversationMessagePublicationPersistence(options.database);
  const appendAcceptedEvent = (
    event: ThreadStreamEvent,
    messageMetadata: unknown,
    parentSignal?: AbortSignal,
  ) => appendAcceptedThreadEvent(options, event, messageMetadata, parentSignal);

  async function submitTurn(
    input: SubmitConversationTurnInput,
    threadConflictAttempts: number,
  ): Promise<SubmitConversationTurnResult> {
    const normalizedContent = content(input.content);
    validateSubmittedRunInput(input);
    const normalizedRunContext =
      input.runContext === undefined ? undefined : content(input.runContext);
    const normalizedIdempotencyKey = queueIdempotencyKey(input.idempotencyKey);
    const normalizedTitle = normalizeText(
      input.title ?? titleFromContent(normalizedContent),
      "Title",
      120,
    );
    const previousThread = await loadThread(options.database, input, {
      allowArchived: true,
    });
    const effectiveWorkspaceId = input.workspaceId ?? previousThread?.data.workspaceId;
    const effectiveInput = {
      ...input,
      ...(normalizedRunContext ? { runContext: normalizedRunContext } : {}),
      ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
    };
    const hash = commandHash(effectiveInput, normalizedContent, normalizedTitle);
    const existing = await reconcileSubmission(
      options.database,
      effectiveInput,
      normalizedIdempotencyKey,
      hash,
    );
    if (existing) {
      await options.enqueueRun(
        {
          deduplicationId: existing.run.data.id,
          message: existing.queueMessage,
          messageGroupId: queueGroupId(existing.queueMessage),
        },
        input.signal,
      );
      await appendAcceptedEvent(existing.streamEvent, existing.message.data.metadata, input.signal);
      return existing;
    }
    if (previousThread) {
      const executionLease = await publicationPersistence.loadThreadExecutionLease(
        previousThread.data.id,
      );
      if (leaseIsMessagePublicationBarrier(executionLease)) {
        throw new ConversationError(
          "publication_busy",
          "The conversation is waiting for an external delivery outcome.",
        );
      }
    }
    if (previousThread?.data.archived) {
      throw new ConversationError("thread_archived", "Archived threads cannot receive messages.");
    }
    if (
      previousThread?.data.externalThreadKey &&
      input.externalThreadKey &&
      previousThread.data.externalThreadKey !== input.externalThreadKey
    ) {
      throw new ConversationError(
        "external_thread_mismatch",
        "External thread identity does not match the canonical thread.",
      );
    }
    const workspace = effectiveWorkspaceId
      ? await requireActiveWorkspace(options.database, effectiveInput, effectiveWorkspaceId)
      : undefined;

    const now = options.now?.() ?? new Date();
    await assertRunAdmissible(options.database, usageScopeOf(effectiveInput), now);
    const timestamp = now.toISOString();
    const parentThreadId = input.traceContext?.parentThreadId;
    const { parentDelegation, parentRun, parentTrace } = await loadParentTraceContext(
      options.database,
      effectiveInput,
      parentThreadId,
    );
    const endUserKey = await submittedThreadSubject(options.database, input, previousThread);
    const [
      generatedThreadId,
      streamId,
      runId,
      messageId,
      streamEventId,
      threadEventId,
      runEventId,
      runEdgeId,
    ] = await Promise.all([
      input.threadId ? Promise.resolve(input.threadId) : options.generateId(),
      previousThread ? Promise.resolve(previousThread.data.streamId) : options.generateId(),
      options.generateId(),
      options.generateId(),
      options.generateId(),
      options.generateId(),
      options.generateId(),
      options.generateId(),
    ]);
    const { deployment, release, selection } = await loadDeploymentAndRelease(
      options.database,
      input,
      { thread: previousThread, threadId: generatedThreadId },
    );
    const responseFormat = effectiveResponseFormat(input, release.data.manifest);
    const media = await admitSubmittedInputMedia(
      options.database,
      input,
      release.data.manifest,
      now,
    );
    const traceId = input.traceContext?.traceId ?? options.generateTraceId?.() ?? createTraceId();
    const spanId = options.generateSpanId?.() ?? createSpanId();
    const captureMode = parentTrace?.data.captureMode ?? input.captureMode ?? DEFAULT_CAPTURE_MODE;
    const sequence = previousThread ? previousThread.data.version + 1 : 0;
    const thread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          ...previousThread?.data,
          agentDeploymentId: previousThread?.data.agentDeploymentId ?? input.agentDeploymentId,
          archived: false,
          // A thread keeps the channel it was created on, such as a console chat's `console`.
          channel:
            previousThread?.data.channel ?? normalizeText(input.channel ?? "api", "Channel", 64),
          createdAt: previousThread?.data.createdAt ?? timestamp,
          createdBy: previousThread?.data.createdBy ?? input.actor,
          environmentId: input.environmentId,
          ...(endUserKey ? { endUserKey } : {}),
          ...((previousThread?.data.externalThreadKey ?? input.externalThreadKey)
            ? {
                externalThreadKey:
                  previousThread?.data.externalThreadKey ?? input.externalThreadKey!,
              }
            : {}),
          id: generatedThreadId,
          organizationId: input.organizationId,
          pinned: previousThread?.data.pinned ?? false,
          ...selection.threadPin,
          projectId: input.projectId,
          streamId,
          title: submittedThreadTitle(previousThread, normalizedTitle),
          updatedAt: timestamp,
          version: sequence,
          ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
        },
        itemType: "thread" as const,
      }),
    );
    const message = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: input.agentDeploymentId,
          body: normalizedContent,
          contentHash: createHash("sha256").update(normalizedContent).digest("hex"),
          createdAt: timestamp,
          environmentId: input.environmentId,
          id: messageId,
          ...(media.attached ? { inputArtifacts: media.attached } : {}),
          ...media.omissions,
          ...(input.messageMetadata ? { metadata: input.messageMetadata } : {}),
          organizationId: input.organizationId,
          projectId: input.projectId,
          role: "user" as const,
          runId,
          sequence,
          ...(input.messageSource ? { source: input.messageSource } : {}),
          streamEventId,
          threadId: generatedThreadId,
        },
        itemType: "message" as const,
      }),
    );
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: deployment.data.id,
          agentReleaseId: release.data.id,
          attempt: 0,
          captureMode,
          createdAt: timestamp,
          environmentId: input.environmentId,
          executor: normalizeText(input.executor ?? "hosted", "Executor", 64),
          id: runId,
          idempotencyKey: normalizedIdempotencyKey,
          ...(input.initiatingCaller ? { initiatingCaller: input.initiatingCaller } : {}),
          ...(media.attached ? { inputArtifacts: media.attached } : {}),
          ...(responseFormat ? { responseFormat } : {}),
          organizationId: input.organizationId,
          priority: input.priority ?? 50,
          projectId: input.projectId,
          redactionPolicyVersion: OBSERVABILITY_REDACTION_POLICY_VERSION,
          releaseSelection: selection.releaseSelection,
          ...(input.responsePublication ? { responsePublication: input.responsePublication } : {}),
          ...(normalizedRunContext ? { runContext: normalizedRunContext } : {}),
          queuedAt: timestamp,
          schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
          spanId,
          status: "queued" as const,
          threadId: generatedThreadId,
          trigger: normalizeText(input.trigger ?? "api", "Trigger", 64),
          traceId,
          ...(input.traceContext ? { parentSpanId: input.traceContext.parentSpanId } : {}),
          updatedAt: timestamp,
          userMessageId: messageId,
          userMessageSequence: sequence,
          version: 0,
          ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
        },
        itemType: "run" as const,
      }),
    );
    const { runDelegation, runEdge, trace } = observabilityRecordsForRun({
      input,
      ...(parentDelegation ? { parentDelegation } : {}),
      ...(parentTrace ? { parentTrace } : {}),
      run,
      runEdgeId,
      timestamp,
    });
    const lookup = Schema.decodeUnknownSync(RunLookupRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          environmentId: input.environmentId,
          idempotencyKey: normalizedIdempotencyKey,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId,
          threadId: generatedThreadId,
        },
        itemType: "run-lookup" as const,
      }),
    );
    const idempotencyExpiresAt = new Date(PERMANENT_IDEMPOTENCY_EXPIRES_AT);
    const idempotency = Schema.decodeUnknownSync(IdempotencyRecord)(
      withCanonicalRecordKeys({
        data: {
          commandHash: hash,
          createdAt: timestamp,
          expiresAt: idempotencyExpiresAt.toISOString(),
          idempotencyKey: conversationIdempotencyKey(effectiveInput, normalizedIdempotencyKey),
          organizationId: input.organizationId,
          resourceIds: [generatedThreadId, runId, messageId, streamEventId],
          response: {
            messageSequence: sequence,
            ...(input.actor.id ? { streamActorId: input.actor.id } : {}),
            streamActorType: streamActor(input.actor).type,
          },
          status: "completed" as const,
          threadId: generatedThreadId,
          version: 0,
        },
        itemType: "idempotency" as const,
        ttl: Math.floor(idempotencyExpiresAt.getTime() / 1000),
      }),
    );
    const threadEvent = makeSemanticEventRecord({
      actor: input.actor,
      aggregateId: generatedThreadId,
      aggregateType: "thread",
      aggregateVersion: sequence + 1,
      environmentId: input.environmentId,
      eventId: threadEventId,
      eventType: "user-message.accepted",
      occurredAt: now,
      organizationId: input.organizationId,
      payload: conversationMessageIsTransient(message.data.metadata)
        ? internalSemanticEventPayload({ messageId, runId, sequence })
        : { messageId, runId, sequence },
      projectId: input.projectId,
    });
    const runEvent = makeSemanticEventRecord({
      actor: input.actor,
      aggregateId: runId,
      aggregateType: "run",
      aggregateVersion: 1,
      environmentId: input.environmentId,
      eventId: runEventId,
      eventType: "run.requested",
      occurredAt: now,
      organizationId: input.organizationId,
      payload: {
        agentDeploymentId: input.agentDeploymentId,
        agentReleaseId: release.data.id,
        releaseSelection: selection.releaseSelection,
        idempotencyKey: normalizedIdempotencyKey,
        status: "queued",
        spanId,
        threadId: generatedThreadId,
        traceId,
        userMessageId: messageId,
        userMessageSequence: sequence,
      },
      projectId: input.projectId,
    });
    try {
      await transactWithSemanticEvents(
        options.database,
        [
          previousThread
            ? { kind: "put", previousRecord: previousThread, record: thread }
            : { kind: "put", record: thread },
          { kind: "put", record: message },
          { kind: "put", record: run },
          parentTrace
            ? { kind: "put", previousRecord: parentTrace, record: trace }
            : { kind: "put", record: trace },
          ...(runEdge ? [{ kind: "put" as const, record: runEdge }] : []),
          ...(runDelegation ? [{ kind: "put" as const, record: runDelegation }] : []),
          ...(parentRun
            ? [
                {
                  conditionExpression: "attribute_exists(pk)",
                  key: { pk: parentRun.pk, sk: parentRun.sk },
                  kind: "condition-check" as const,
                  table: "execution" as const,
                },
              ]
            : []),
          { kind: "put", record: lookup },
          { kind: "put", record: idempotency },
          ...runnableControlChecks(deployment, release),
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
        [threadEvent, runEvent],
      );
    } catch (cause) {
      const reconciled = await reconcileSubmission(
        options.database,
        effectiveInput,
        normalizedIdempotencyKey,
        hash,
      );
      if (!reconciled) {
        if (cause instanceof InboxMailErasedError) throw cause;
        const latestControls = await loadDeploymentAndRelease(options.database, input, {
          thread: previousThread,
          threadId: generatedThreadId,
        });
        if (
          (latestControls.deployment.data.version !== deployment.data.version ||
            latestControls.release.data.id !== release.data.id ||
            latestControls.release.data.version !== release.data.version) &&
          threadConflictAttempts < MAX_THREAD_CONFLICT_RETRIES
        ) {
          return submitTurn(input, threadConflictAttempts + 1);
        }
        if (workspace && effectiveWorkspaceId) {
          const latestWorkspace = await requireActiveWorkspace(
            options.database,
            effectiveInput,
            effectiveWorkspaceId,
          );
          if (
            latestWorkspace.data.version !== workspace.data.version &&
            threadConflictAttempts < MAX_THREAD_CONFLICT_RETRIES
          ) {
            return submitTurn(input, threadConflictAttempts + 1);
          }
        }
        if (parentTrace && input.traceContext) {
          const latestParent = await loadParentTraceContext(
            options.database,
            effectiveInput,
            parentThreadId,
          );
          if (
            latestParent.parentTrace?.data.version !== parentTrace.data.version &&
            threadConflictAttempts < MAX_THREAD_CONFLICT_RETRIES
          ) {
            return submitTurn(input, threadConflictAttempts + 1);
          }
        }
        if (input.threadId && threadConflictAttempts < MAX_THREAD_CONFLICT_RETRIES) {
          const latestThread = await loadThread(options.database, input);
          if (
            previousThread
              ? latestThread?.data.version !== previousThread.data.version
              : latestThread !== undefined
          ) {
            return submitTurn(input, threadConflictAttempts + 1);
          }
        }
        throw new ConversationError("write_failed", "Conversation turn could not be persisted.", {
          cause,
        });
      }
      await options.enqueueRun(
        {
          deduplicationId: reconciled.run.data.id,
          message: reconciled.queueMessage,
          messageGroupId: queueGroupId(reconciled.queueMessage),
        },
        input.signal,
      );
      await appendAcceptedEvent(
        reconciled.streamEvent,
        reconciled.message.data.metadata,
        input.signal,
      );
      return reconciled;
    }
    const accepted = createThreadStreamEvent({
      actor: streamActor(input.actor),
      environmentId: input.environmentId,
      eventId: streamEventId,
      eventType: "user-message.accepted",
      messageId,
      occurredAt: now,
      organizationId: input.organizationId,
      payload: {
        messageId,
        role: "user",
        runId,
        sequence,
        threadId: generatedThreadId,
      },
      projectId: input.projectId,
      runId,
      threadId: generatedThreadId,
    });
    const queued = queueMessage(run, message);
    await options.enqueueRun(
      {
        deduplicationId: runId,
        message: queued,
        messageGroupId: queueGroupId(queued),
      },
      input.signal,
    );
    await appendAcceptedEvent(accepted, message.data.metadata, input.signal);
    return {
      created: true,
      message,
      omittedInputArtifacts: media.omitted,
      queueMessage: queued,
      run,
      streamEvent: accepted,
      thread,
    };
  }

  return {
    submitTurn: (input: SubmitConversationTurnInput) => submitTurn(input, 0),
  };
}

export async function readConversationHistory(
  database: DynamoDatabaseService,
  scope: ThreadStreamScope,
  options: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly upperSk?: string;
  } = {},
): Promise<ThreadHistoryPage<ConversationMessage>> {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new ConversationError(
      "invalid_limit",
      `History limit must be between 1 and ${MAX_HISTORY_LIMIT}.`,
    );
  }
  const persistence = makeConversationPersistence(database);
  const items: ConversationMessage[] = [];
  let cursor = options.cursor;
  const snapshot =
    !options.cursor && !options.upperSk
      ? await conversationHistorySnapshot(database, scope)
      : undefined;
  let upperSk = options.upperSk ?? snapshot?.upperSk;
  try {
    for (let page = 0; page < MAX_TRANSIENT_HISTORY_SCAN_PAGES; page += 1) {
      const result = await persistence.listMessages(
        { organizationId: scope.organizationId, threadId: scope.threadId },
        {
          ...(cursor ? { cursor } : {}),
          limit: Math.max(1, limit - items.length),
          ...(upperSk ? { upperSk } : {}),
        },
      );
      upperSk ??= result.upperSk;
      items.push(
        ...result.items.filter(
          (item): item is ConversationMessage =>
            item.itemType === "message" &&
            item.data.organizationId === scope.organizationId &&
            item.data.projectId === scope.projectId &&
            item.data.environmentId === scope.environmentId &&
            item.data.threadId === scope.threadId &&
            !conversationMessageIsTransient(item.data.metadata),
        ),
      );
      cursor = result.nextCursor;
      if (items.length >= limit || !cursor) break;
    }
  } catch (cause) {
    if (cause instanceof InvalidConversationHistoryCursorError) {
      throw new ConversationError("invalid_cursor", "Conversation cursor is invalid.", { cause });
    }
    throw cause;
  }
  return {
    items,
    ...(upperSk ? { snapshotUpperSk: upperSk } : {}),
    ...(cursor ? { nextCursor: cursor } : {}),
  };
}

const STREAM_HISTORY_RESPONSE_PAGE_SIZE = 15;

export async function createConversationStreamSession(input: {
  readonly claims: ThreadStreamSessionClaims;
  readonly createReadUrl: (offset: string, scope: ThreadStreamScope) => string;
  readonly database: DynamoDatabaseService;
  readonly scope: ThreadStreamScope;
  readonly transport: DurableStreamTransport;
}): Promise<{
  readonly history: ThreadHistoryPage<ConversationMessage>;
  readonly session: ThreadStreamSession;
}> {
  const snapshotState: {
    value?: Awaited<ReturnType<typeof conversationHistorySnapshot>>;
  } = {};
  const result = await createOffsetBeforeHistorySession<ConversationMessage>({
    canonicalMessageId: (message) => message.data.id,
    claims: input.claims,
    createReadUrl: input.createReadUrl,
    finalizedMessageId: (message) =>
      message.data.role === "assistant" ? message.data.id : undefined,
    historyMode: "page",
    historyItemBytes: (message) =>
      new TextEncoder().encode(JSON.stringify(message.data)).byteLength,
    maxHistoryItems: STREAM_HISTORY_RESPONSE_PAGE_SIZE,
    maxHistoryPages: 1,
    replaySeedMode: "history-page",
    readHistoryPage: async (scope, cursor) => {
      if (!cursor) snapshotState.value = await conversationHistorySnapshot(input.database, scope);
      const page = await readConversationHistory(input.database, scope, {
        ...(cursor ? { cursor } : {}),
        limit: STREAM_HISTORY_RESPONSE_PAGE_SIZE,
        ...(!cursor && snapshotState.value ? { upperSk: snapshotState.value.upperSk } : {}),
      });
      return page;
    },
    scope: input.scope,
    transport: input.transport,
  });
  return {
    ...result,
    history: {
      ...result.history,
      ...(snapshotState.value ? { snapshotUpperSk: snapshotState.value.upperSk } : {}),
    },
    session: {
      ...result.session,
      replayState: {
        ...result.session.replayState,
        ...(snapshotState.value
          ? { historyThroughSequence: snapshotState.value.throughSequence }
          : {}),
      },
    },
  };
}
