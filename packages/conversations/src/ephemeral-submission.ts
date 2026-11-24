import {
  AgentResponseFormat,
  canonicalResponseFormatJson,
  type AgentResponseFormat as AgentResponseFormatValue,
} from "@deployments-ai/agent-manifest";
import {
  IdempotencyRecord,
  MessageRecord,
  RunLookupRecord,
  RunRecord,
  ThreadRecord,
  executionBindingIsActive,
  makeExecutionBindingPersistence,
  usageScopeOf,
  withCanonicalRecordKeys,
  type RunInitiatingCaller,
  type Ulid,
} from "@deployments-ai/db";
import { internalSemanticEventPayload, makeSemanticEventRecord } from "@deployments-ai/events";
import {
  DEFAULT_CAPTURE_MODE,
  OBSERVABILITY_REDACTION_POLICY_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
  createSpanId,
  createTraceId,
} from "@deployments-ai/observability";
import { createThreadStreamEvent } from "@deployments-ai/streaming";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { appendAcceptedThreadEvent } from "./acceptance-stream.ts";
import { assertRunAdmissible } from "./run-admission.ts";
import {
  createExecutionBindingService,
  type ExecutionBinding,
  type ExecutionBindingAdmission,
  type ExecutionBindingScope,
} from "./ephemeral-execution.ts";
import {
  ConversationError,
  PERMANENT_IDEMPOTENCY_EXPIRES_AT,
  content,
  conversationIdempotencyKey,
  expected,
  normalizeText,
  queueGroupId,
  queueIdempotencyKey,
  queueMessage,
  reconcileSubmission,
  record,
  requireActiveWorkspace,
  streamActor,
  titleFromContent,
  type ConversationServiceOptions,
  type ConversationThread,
  type SubmitConversationTurnInput,
  type SubmitConversationTurnResult,
  type SubmittedConversationTurn,
} from "./submission.ts";
import { effectiveResponseFormat } from "./response-format-selection.ts";
import { rootTraceRecord } from "./trace-context.ts";

const MAX_THREAD_CONFLICT_RETRIES = 3;

export interface SubmitEphemeralTurnInput extends ExecutionBindingScope {
  readonly actor: SubmitConversationTurnInput["actor"];
  readonly content: string;
  readonly executionBindingId: Ulid;
  readonly idempotencyKey: string;
  readonly initiatingCaller?: RunInitiatingCaller;
  readonly responseFormat?: AgentResponseFormatValue;
  readonly signal?: AbortSignal;
  /** Continue an existing thread of the same binding; omit to start a new thread. */
  readonly threadId?: Ulid;
  readonly title?: string;
  readonly workspaceId?: Ulid;
}

export interface SubmitEphemeralTurnResult extends SubmittedConversationTurn {
  readonly binding: ExecutionBinding;
  readonly created: boolean;
}

function ephemeralCommandHash(
  input: SubmitEphemeralTurnInput,
  normalizedContent: string,
  normalizedTitle: string,
  workspaceId: Ulid | undefined,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actor: input.actor,
        content: normalizedContent,
        environmentId: input.environmentId,
        executionBindingId: input.executionBindingId,
        initiatingCaller: input.initiatingCaller ?? null,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ...(input.responseFormat !== undefined
          ? { responseFormat: canonicalResponseFormatJson(input.responseFormat) }
          : {}),
        threadId: input.threadId ?? null,
        title: normalizedTitle,
        workspaceId: workspaceId ?? null,
      }),
    )
    .digest("hex");
}

async function loadBoundThread(
  options: ConversationServiceOptions,
  input: SubmitEphemeralTurnInput,
): Promise<ConversationThread | undefined> {
  if (!input.threadId) return undefined;
  const thread = expected(
    await record(options.database, {
      kind: "thread",
      organizationId: input.organizationId,
      threadId: input.threadId,
    }),
    "thread",
    "Thread",
  );
  if (
    thread.data.projectId !== input.projectId ||
    thread.data.environmentId !== input.environmentId ||
    thread.data.executionBindingId !== input.executionBindingId ||
    (input.workspaceId !== undefined && thread.data.workspaceId !== input.workspaceId)
  ) {
    throw new ConversationError(
      "scope_mismatch",
      "Thread does not belong to the requested execution binding.",
    );
  }
  if (thread.data.archived) {
    throw new ConversationError("thread_archived", "Archived threads cannot receive messages.");
  }
  return thread;
}

/**
 * Accepts a preview or evaluation turn. Runs go through the normal worker queue and are readable
 * through the existing run/thread routes, but their threads, runs, and semantic events are
 * partitioned under the execution binding and never reach customer webhooks or channels.
 */
export function createEphemeralTurnService(
  options: ConversationServiceOptions & ExecutionBindingAdmission,
) {
  const bindings = createExecutionBindingService(options);
  const persistence = makeExecutionBindingPersistence(options.database);

  async function acceptExisting(
    existing: Extract<SubmitConversationTurnResult, { readonly created: false }>,
    binding: ExecutionBinding,
    signal: AbortSignal | undefined,
  ): Promise<SubmitEphemeralTurnResult> {
    await options.enqueueRun(
      {
        deduplicationId: existing.run.data.id,
        message: existing.queueMessage,
        messageGroupId: queueGroupId(existing.queueMessage),
      },
      signal,
    );
    await appendAcceptedThreadEvent(
      options,
      existing.streamEvent,
      existing.message.data.metadata,
      signal,
    );
    return { ...existing, binding };
  }

  async function submit(
    input: SubmitEphemeralTurnInput,
    threadConflictAttempts: number,
  ): Promise<SubmitEphemeralTurnResult> {
    const normalizedContent = content(input.content);
    if (input.responseFormat !== undefined) {
      try {
        Schema.decodeUnknownSync(AgentResponseFormat)(input.responseFormat);
      } catch (cause) {
        throw new ConversationError("invalid_run_input", "Response format is invalid.", { cause });
      }
    }
    const normalizedIdempotencyKey = queueIdempotencyKey(input.idempotencyKey);
    const normalizedTitle = normalizeText(
      input.title ?? titleFromContent(normalizedContent),
      "Title",
      120,
    );
    const binding = await bindings.getExecutionBinding(input);
    const previousThread = await loadBoundThread(options, input);
    const workspaceId = input.workspaceId ?? previousThread?.data.workspaceId;
    const scope = { ...input, ...(workspaceId ? { workspaceId } : {}) };
    const hash = ephemeralCommandHash(input, normalizedContent, normalizedTitle, workspaceId);
    const existing = await reconcileSubmission(
      options.database,
      scope,
      normalizedIdempotencyKey,
      hash,
    );
    if (existing) return acceptExisting(existing, binding, input.signal);

    const now = options.now?.() ?? new Date();
    if (!executionBindingIsActive(binding, now)) {
      throw new ConversationError(
        "execution_binding_expired",
        "Execution binding has expired and no longer accepts turns.",
      );
    }
    await assertRunAdmissible(options.database, usageScopeOf(scope), now);
    const responseFormat = effectiveResponseFormat(
      { ...input, trigger: binding.data.purpose },
      binding.data.manifest,
    );
    const workspace = workspaceId
      ? await requireActiveWorkspace(options.database, scope, workspaceId)
      : undefined;
    const timestamp = now.toISOString();
    const [threadId, streamId, runId, messageId, streamEventId, threadEventId, runEventId] =
      await Promise.all([
        previousThread ? Promise.resolve(previousThread.data.id) : options.generateId(),
        previousThread ? Promise.resolve(previousThread.data.streamId) : options.generateId(),
        options.generateId(),
        options.generateId(),
        options.generateId(),
        options.generateId(),
        options.generateId(),
      ]);
    const traceId = options.generateTraceId?.() ?? createTraceId();
    const spanId = options.generateSpanId?.() ?? createSpanId();
    const sequence = previousThread ? previousThread.data.version + 1 : 0;
    const pins = {
      executionBindingId: binding.data.id,
      executionPurpose: binding.data.purpose,
    };
    const thread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          ...previousThread?.data,
          ...pins,
          archived: false,
          channel: binding.data.purpose,
          createdAt: previousThread?.data.createdAt ?? timestamp,
          createdBy: previousThread?.data.createdBy ?? input.actor,
          environmentId: input.environmentId,
          id: threadId,
          organizationId: input.organizationId,
          pinned: previousThread?.data.pinned ?? false,
          projectId: input.projectId,
          streamId,
          title: previousThread?.data.title ?? normalizedTitle,
          updatedAt: timestamp,
          version: sequence,
          ...(workspaceId ? { workspaceId } : {}),
        },
        itemType: "thread" as const,
      }),
    );
    const message = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          body: normalizedContent,
          contentHash: createHash("sha256").update(normalizedContent).digest("hex"),
          createdAt: timestamp,
          environmentId: input.environmentId,
          id: messageId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          role: "user" as const,
          runId,
          sequence,
          streamEventId,
          threadId,
        },
        itemType: "message" as const,
      }),
    );
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...pins,
          ...(binding.data.source.type === "release"
            ? { agentReleaseId: binding.data.source.agentReleaseId }
            : {}),
          attempt: 0,
          captureMode: DEFAULT_CAPTURE_MODE,
          createdAt: timestamp,
          environmentId: input.environmentId,
          executor: "hosted",
          id: runId,
          idempotencyKey: normalizedIdempotencyKey,
          ...(input.initiatingCaller ? { initiatingCaller: input.initiatingCaller } : {}),
          ...(responseFormat ? { responseFormat } : {}),
          organizationId: input.organizationId,
          priority: 50,
          projectId: input.projectId,
          queuedAt: timestamp,
          redactionPolicyVersion: OBSERVABILITY_REDACTION_POLICY_VERSION,
          schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
          spanId,
          status: "queued" as const,
          threadId,
          traceId,
          trigger: binding.data.purpose,
          updatedAt: timestamp,
          userMessageId: messageId,
          userMessageSequence: sequence,
          version: 0,
          ...(workspaceId ? { workspaceId } : {}),
        },
        itemType: "run" as const,
      }),
    );
    const trace = rootTraceRecord(run, timestamp);
    const lookup = Schema.decodeUnknownSync(RunLookupRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          environmentId: input.environmentId,
          idempotencyKey: normalizedIdempotencyKey,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId,
          threadId,
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
          idempotencyKey: conversationIdempotencyKey(scope, normalizedIdempotencyKey),
          organizationId: input.organizationId,
          resourceIds: [threadId, runId, messageId, streamEventId],
          response: {
            messageSequence: sequence,
            ...(input.actor.id ? { streamActorId: input.actor.id } : {}),
            streamActorType: streamActor(input.actor).type,
          },
          status: "completed" as const,
          threadId,
          version: 0,
        },
        itemType: "idempotency" as const,
        ttl: Math.floor(idempotencyExpiresAt.getTime() / 1000),
      }),
    );
    const threadEvent = makeSemanticEventRecord({
      actor: input.actor,
      aggregateId: threadId,
      aggregateType: "thread",
      aggregateVersion: sequence + 1,
      environmentId: input.environmentId,
      eventId: threadEventId,
      eventType: "user-message.accepted",
      occurredAt: now,
      organizationId: input.organizationId,
      payload: internalSemanticEventPayload({ ...pins, messageId, runId, sequence }),
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
      payload: internalSemanticEventPayload({
        ...pins,
        idempotencyKey: normalizedIdempotencyKey,
        spanId,
        status: "queued",
        threadId,
        traceId,
        userMessageId: messageId,
        userMessageSequence: sequence,
      }),
      projectId: input.projectId,
    });
    const committed = await persistence.commitBoundTurn({
      at: now,
      binding,
      events: [threadEvent, runEvent],
      operations: [
        previousThread
          ? { kind: "put", previousRecord: previousThread, record: thread }
          : { kind: "put", record: thread },
        { kind: "put", record: message },
        { kind: "put", record: run },
        { kind: "put", record: trace },
        { kind: "put", record: lookup },
        { kind: "put", record: idempotency },
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
    });
    if (!committed) {
      const reconciled = await reconcileSubmission(
        options.database,
        scope,
        normalizedIdempotencyKey,
        hash,
      );
      if (reconciled) return acceptExisting(reconciled, binding, input.signal);
      if (threadConflictAttempts < MAX_THREAD_CONFLICT_RETRIES) {
        return submit(input, threadConflictAttempts + 1);
      }
      throw new ConversationError("write_failed", "Conversation turn could not be persisted.");
    }
    const accepted = createThreadStreamEvent({
      actor: streamActor(input.actor),
      environmentId: input.environmentId,
      eventId: streamEventId,
      eventType: "user-message.accepted",
      messageId,
      occurredAt: now,
      organizationId: input.organizationId,
      payload: { messageId, role: "user", runId, sequence, threadId },
      projectId: input.projectId,
      runId,
      threadId,
    });
    const queued = queueMessage(run, message);
    await options.enqueueRun(
      { deduplicationId: runId, message: queued, messageGroupId: queueGroupId(queued) },
      input.signal,
    );
    await appendAcceptedThreadEvent(options, accepted, message.data.metadata, input.signal);
    return {
      binding,
      created: true,
      message,
      queueMessage: queued,
      run,
      streamEvent: accepted,
      thread,
    };
  }

  return {
    ...bindings,
    submitEphemeralTurn: (input: SubmitEphemeralTurnInput) => submit(input, 0),
  };
}
