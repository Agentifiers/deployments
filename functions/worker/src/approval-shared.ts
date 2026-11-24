import {
  ApprovalRecord,
  RunRecord,
  RuntimeLeaseRecord,
  ToolCallRecord,
  Ulid,
  activeExecutionBindingCondition,
  executionBindingIsActive,
  makeExecutionBindingPersistence,
  makeOrganizationDataBoundaryReader,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  workerPersistence,
} from "@deployments-ai/db";
import { createThreadStreamEvent, type ThreadStreamEvent } from "@deployments-ai/streaming";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { loadRunApproval, loadRunToolCall, loadThreadRunById } from "./records.ts";
import type {
  AgentRunQueueEnqueue,
  AgentRunQueueEnqueueInput,
  AgentRunQueueMessage,
  ApprovalRecordValue,
  RunRecordValue,
  ToolCallRecordValue,
} from "./types.ts";
import { agentRunQueueMessageGroupId } from "./types.ts";
import { runToolContinuation, type RunToolContinuation } from "./continuation.ts";

export interface ResolveRunApprovalInput {
  readonly approvalId: Ulid;
  readonly decision: "approved" | "rejected";
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  /** The person who resolves the approval; absent when an API key (a service) resolves it. */
  readonly resolvedByPrincipalId?: Ulid;
  readonly runId: Ulid;
  readonly threadId: Ulid;
}

export type ApprovalRunEnqueueInput = AgentRunQueueEnqueueInput;

export interface ResolveRunApprovalDependencies {
  readonly appendThreadEvent?: (event: ThreadStreamEvent) => Promise<void>;
  readonly completePublicationBarrier?: (barrier: RuntimeLeaseRecordValue) => Promise<void>;
  readonly database: DynamoDatabaseService;
  readonly enqueueRun?: AgentRunQueueEnqueue;
  readonly enqueueTerminalRun?: AgentRunQueueEnqueue;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}

export interface ResolveRunApprovalResult {
  readonly approval: ApprovalRecordValue;
  readonly decision: ApprovalResolutionDecision;
  readonly queueMessage?: AgentRunQueueMessage;
  readonly run: RunRecordValue;
  readonly toolCall: ToolCallRecordValue;
}

export interface ResolveRunToolResultInput {
  readonly environmentId: Ulid;
  readonly externalOperationId?: string;
  readonly organizationId: Ulid;
  readonly outcome: "completed" | "failed";
  /** Structured result (JSON object, at most 96 KiB); required for completed client tools. */
  readonly output?: Readonly<Record<string, unknown>>;
  readonly outputSummary?: string;
  readonly projectId: Ulid;
  readonly runId: Ulid;
  readonly threadId: Ulid;
  readonly toolCallId: Ulid;
}

export interface ResolveRunToolResult {
  readonly outcome: ResolveRunToolResultInput["outcome"];
  readonly queueMessage?: AgentRunQueueMessage;
  readonly run: RunRecordValue;
  readonly toolCall: ToolCallRecordValue;
}

export class ApprovalResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalResolutionError";
  }
}

export type ApprovalResolutionDecision = ResolveRunApprovalInput["decision"] | "expired";
export type RuntimeLeaseRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "runtime-lease" }
>;

const CALLBACK_PUBLICATION_LEASE_MS = 15 * 60_000;

export function now(dependencies: ResolveRunApprovalDependencies): Date {
  return dependencies.now?.() ?? new Date();
}

/**
 * Inside a restricted data boundary only a person resolves approvals. The boundary is read only
 * for a service resolver, and a failed read propagates, so the resolution fails closed.
 */
export async function assertResolverAdmitted(
  input: ResolveRunApprovalInput,
  dependencies: ResolveRunApprovalDependencies,
): Promise<void> {
  if (input.resolvedByPrincipalId !== undefined) return;
  const boundary = await makeOrganizationDataBoundaryReader(dependencies.database).read(
    input.organizationId,
  );
  if (boundary.profile === "open") return;
  throw new ApprovalResolutionError(
    "approval_requires_human",
    `Only a person can resolve approvals inside this organization's ${boundary.profile} data boundary; an API key cannot.`,
  );
}

/** Evaluation bindings reject approval-gated tool calls by policy, so approvals never resume them. */
export function assertApprovalResolvable(run: RunRecordValue): void {
  if (run.data.executionPurpose !== "evaluation") return;
  throw new ApprovalResolutionError(
    "evaluation_approval_unsupported",
    "Evaluation runs reject approval-gated tool calls; their approvals cannot be resolved.",
  );
}

/**
 * Conditions a resume must carry. Customer runs have none here (the worker fences the deployment
 * at claim time); preview runs resume only while their execution binding is still active.
 */
export async function resumeExecutionConditions(
  run: RunRecordValue,
  dependencies: ResolveRunApprovalDependencies,
  at: Date,
): Promise<readonly TransactionOperation[]> {
  if (run.data.executionBindingId === undefined) return [];
  const binding = await makeExecutionBindingPersistence(dependencies.database).get({
    environmentId: run.data.environmentId,
    executionBindingId: run.data.executionBindingId,
    organizationId: run.data.organizationId,
  });
  if (!binding || !executionBindingIsActive(binding, at)) {
    throw new ApprovalResolutionError(
      "execution_binding_expired",
      "The run's execution binding has expired, so the run cannot resume.",
    );
  }
  return [activeExecutionBindingCondition(binding, at)];
}

export function resolvedApproval(
  previous: ApprovalRecordValue,
  input: ResolveRunApprovalInput,
  decision: ApprovalResolutionDecision,
  timestamp: Date,
): ApprovalRecordValue {
  return Schema.decodeUnknownSync(ApprovalRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        resolvedAt: timestamp.toISOString(),
        ...(decision !== "expired" && input.resolvedByPrincipalId
          ? { resolvedByPrincipalId: input.resolvedByPrincipalId }
          : {}),
        status: decision,
        updatedAt: timestamp.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "approval" as const,
    }),
  );
}

export function resolvedToolCall(
  previous: ToolCallRecordValue,
  decision: ApprovalResolutionDecision,
  timestamp: Date,
): ToolCallRecordValue {
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        ...(decision !== "approved"
          ? {
              completedAt: timestamp.toISOString(),
              outputSummary:
                decision === "expired" ? "Tool approval expired." : "Tool approval was rejected.",
              status: "failed" as const,
            }
          : { status: "pending" as const }),
        updatedAt: timestamp.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "tool-call" as const,
    }),
  );
}

export function approvedToolContinuation(
  run: RunRecordValue,
  toolCall: ToolCallRecordValue,
  _approval: ApprovalRecordValue,
): RunToolContinuation {
  const continuation = runToolContinuation(run);
  const pending = continuation.pendingAction;
  if (pending) {
    if (pending.kind !== "approval" || pending.toolCallId !== toolCall.data.id) {
      throw new ApprovalResolutionError(
        "invalid_tool_continuation",
        "Run tool continuation does not match the approved tool call.",
      );
    }
    return continuation;
  }
  if (!toolCall.data.idempotencyKey) {
    throw new ApprovalResolutionError(
      "invalid_tool_continuation",
      "Approved tool call is missing its idempotency key.",
    );
  }
  return {
    ...(continuation.artifactContinuation
      ? { artifactContinuation: continuation.artifactContinuation }
      : {}),
    completedToolCallIds: continuation.completedToolCallIds,
    ...(continuation.modelContinuation
      ? { modelContinuation: continuation.modelContinuation }
      : {}),
    pendingAction: {
      kind: "approval",
      toolCallId: toolCall.data.id,
    },
  };
}

export function resumedRun(previous: RunRecordValue, timestamp: Date): RunRecordValue {
  const {
    claimedAt: _claimedAt,
    claimedBy: _claimedBy,
    completedAt: _completedAt,
    error: _error,
    heartbeatAt: _heartbeatAt,
    ...retained
  } = previous.data;
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...retained,
        queuedAt: timestamp.toISOString(),
        status: "queued" as const,
        updatedAt: timestamp.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
}

export function reconciledCanceledRun(previous: RunRecordValue, timestamp: Date): RunRecordValue {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        heartbeatAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
}

export function requireRunEnqueue(
  dependencies: ResolveRunApprovalDependencies,
): AgentRunQueueEnqueue {
  if (dependencies.enqueueRun) return dependencies.enqueueRun;
  throw new ApprovalResolutionError(
    "run_enqueue_unavailable",
    "Resuming a run requires an agent run queue enqueue adapter.",
  );
}

export function queueMessage(run: RunRecordValue): AgentRunQueueMessage {
  if (run.data.userMessageId === undefined || run.data.userMessageSequence === undefined) {
    throw new ApprovalResolutionError(
      "run_trigger_missing",
      `Run ${run.data.id} does not retain its trigger message binding.`,
    );
  }
  return {
    environmentId: run.data.environmentId,
    idempotencyKey: run.data.idempotencyKey,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    runId: run.data.id,
    spanId: run.data.spanId,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
    userMessageId: run.data.userMessageId,
    userMessageSequence: run.data.userMessageSequence,
  };
}

export function callbackPublicationBarrier(
  run: RunRecordValue,
  owner: string,
  timestamp: Date,
): RuntimeLeaseRecordValue {
  return Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: timestamp.toISOString(),
        environmentId: run.data.environmentId,
        expiresAt: new Date(timestamp.getTime() + CALLBACK_PUBLICATION_LEASE_MS).toISOString(),
        id: run.data.threadId,
        leaseKey: `agent-run-thread/${run.data.threadId}`,
        organizationId: run.data.organizationId,
        owner,
        projectId: run.data.projectId,
        runId: run.data.id,
        threadId: run.data.threadId,
        version: 0,
      },
      itemType: "runtime-lease" as const,
    }),
  );
}

export function approvalPublicationOwner(approval: ApprovalRecordValue): string {
  return `approval-resolution/${approval.data.id}/${approval.data.version}`;
}

export function toolPublicationOwner(
  toolCall: ToolCallRecordValue,
  outcome: ResolveRunToolResultInput["outcome"],
): string {
  return `tool-resolution/${toolCall.data.id}/${toolCall.data.version}/${outcome}`;
}

async function loadPublicationBarrier(
  run: RunRecordValue,
  dependencies: ResolveRunApprovalDependencies,
): Promise<RuntimeLeaseRecordValue | undefined> {
  const probe = callbackPublicationBarrier(run, "callback-probe", now(dependencies));
  return loadPublicationBarrierByKey(probe, dependencies);
}

async function loadPublicationBarrierByKey(
  key: Pick<RuntimeLeaseRecordValue, "pk" | "sk">,
  dependencies: ResolveRunApprovalDependencies,
): Promise<RuntimeLeaseRecordValue | undefined> {
  const found = await workerPersistence.read(
    dependencies.database,
    "execution",
    { pk: key.pk, sk: key.sk },
    true,
  );
  if (found === undefined) return undefined;
  if (found.itemType !== "runtime-lease") {
    throw new ApprovalResolutionError(
      "thread_publication_barrier_invalid",
      "Thread publication barrier key contains an unexpected record.",
    );
  }
  return found;
}

export async function assertPublicationBarrierReleased(
  run: RunRecordValue,
  dependencies: ResolveRunApprovalDependencies,
): Promise<void> {
  const found = await loadPublicationBarrier(run, dependencies);
  if (!found) return;
  throw new ApprovalResolutionError(
    "thread_publication_pending",
    `Thread ${run.data.threadId} still has unpublished run activity.`,
  );
}

export function acquirePublicationBarrier(barrier: RuntimeLeaseRecordValue): TransactionOperation {
  return {
    conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    kind: "put",
    record: barrier,
  };
}

function releasePublicationBarrier(barrier: RuntimeLeaseRecordValue): TransactionOperation {
  return {
    conditionExpression: "#data.#owner = :owner AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#owner": "owner",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":owner": barrier.data.owner,
      ":version": barrier.data.version,
    },
    kind: "delete",
    record: barrier,
  };
}

async function releasePublishedBarrier(
  barrier: RuntimeLeaseRecordValue,
  dependencies: ResolveRunApprovalDependencies,
): Promise<void> {
  const operation = releasePublicationBarrier(barrier);
  const transactionToken = createHash("sha256")
    .update(JSON.stringify(operation))
    .digest("hex")
    .slice(0, 36);
  try {
    await workerPersistence.commit(dependencies.database, [operation], transactionToken);
  } catch (cause) {
    const found = await loadPublicationBarrierByKey(barrier, dependencies);
    if (!found) return;
    if (found.data.owner !== barrier.data.owner || found.data.version !== barrier.data.version) {
      return;
    }
    throw cause;
  }
}

export async function completePublishedBarrier(
  barrier: RuntimeLeaseRecordValue,
  dependencies: ResolveRunApprovalDependencies,
): Promise<void> {
  if (dependencies.completePublicationBarrier) {
    await dependencies.completePublicationBarrier(barrier);
    return;
  }
  await releasePublishedBarrier(barrier, dependencies);
}

/**
 * Returns the replayed resolution's own publication barrier when its publication is unfinished.
 * The barrier is created atomically with the resolution and only disappears once publication
 * completes or a worker takes it over and replays it, so a missing or foreign thread lease (for
 * example the worker now executing the resumed run) means there is nothing left to publish.
 */
export async function matchingPublicationBarrier(
  run: RunRecordValue,
  owner: string,
  dependencies: ResolveRunApprovalDependencies,
): Promise<RuntimeLeaseRecordValue | undefined> {
  const barrier = await loadPublicationBarrier(run, dependencies);
  if (barrier?.data.owner === owner && barrier.data.runId === run.data.id) return barrier;
  return undefined;
}

export function resolutionMatches(
  approval: ApprovalRecordValue,
  decision: ApprovalResolutionDecision,
): boolean {
  return approval.data.status === decision;
}

export function boundedExternalOperationId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const hasControl = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    !normalized ||
    normalized.startsWith("unknown:") ||
    hasControl ||
    new TextEncoder().encode(normalized).byteLength > 512
  ) {
    throw new ApprovalResolutionError(
      "invalid_external_operation_id",
      "externalOperationId must contain at most 512 UTF-8 bytes without control characters and must not use the reserved unknown: prefix.",
    );
  }
  return normalized;
}

export async function loadResolutionState(
  input: ResolveRunApprovalInput,
  dependencies: ResolveRunApprovalDependencies,
): Promise<{
  readonly approval: ApprovalRecordValue;
  readonly run: RunRecordValue;
  readonly toolCall: ToolCallRecordValue;
}> {
  const run = await loadThreadRunById(dependencies.database, input, input.runId);
  if (!run) throw new ApprovalResolutionError("run_not_found", "Run was not found.");
  const approval = await loadRunApproval(dependencies.database, run, input.approvalId);
  if (!approval) throw new ApprovalResolutionError("approval_not_found", "Approval was not found.");
  if (!approval.data.toolCallId) {
    throw new ApprovalResolutionError(
      "approval_tool_call_missing",
      "Approval is not bound to a tool call.",
    );
  }
  const toolCall = await loadRunToolCall(dependencies.database, run, approval.data.toolCallId);
  if (!toolCall) {
    throw new ApprovalResolutionError("tool_call_not_found", "Approval tool call was not found.");
  }
  if (toolCall.data.approvalId !== approval.data.id) {
    throw new ApprovalResolutionError(
      "approval_tool_call_mismatch",
      "Approval and tool call bindings do not match.",
    );
  }
  return { approval, run, toolCall };
}

export async function publishResolution(
  dependencies: ResolveRunApprovalDependencies,
  state: ResolveRunApprovalResult,
  barrier: RuntimeLeaseRecordValue | undefined,
): Promise<void> {
  const terminalQueueMessage =
    state.decision !== "approved" &&
    dependencies.enqueueTerminalRun &&
    state.run.data.userMessageId !== undefined &&
    state.run.data.userMessageSequence !== undefined
      ? queueMessage(state.run)
      : undefined;
  const enqueueRun = state.queueMessage ? requireRunEnqueue(dependencies) : undefined;
  if (!barrier) return;
  const appendThreadEvent = dependencies.appendThreadEvent;
  if (!appendThreadEvent) {
    throw new ApprovalResolutionError(
      "thread_publication_unavailable",
      "Approval resolution publication requires a thread stream adapter.",
    );
  }
  await appendThreadEvent(
    createThreadStreamEvent({
      actor: state.approval.data.resolvedByPrincipalId
        ? { id: state.approval.data.resolvedByPrincipalId, type: "user" }
        : { type: "service" },
      approvalId: state.approval.data.id,
      environmentId: state.run.data.environmentId,
      eventId: `approval-resolved:${state.approval.data.id}:${state.approval.data.version}`,
      eventType: "approval.resolved",
      occurredAt: state.approval.data.resolvedAt ?? state.approval.data.updatedAt,
      organizationId: state.run.data.organizationId,
      payload: {
        decision: state.decision,
        status: state.approval.data.status,
      },
      projectId: state.run.data.projectId,
      runId: state.run.data.id,
      threadId: state.run.data.threadId,
      toolCallId: state.toolCall.data.id,
    }),
  );
  if (state.decision !== "approved") {
    await appendThreadEvent(
      createThreadStreamEvent({
        actor: { type: "service" },
        environmentId: state.run.data.environmentId,
        eventId: `run-terminal:${state.run.data.id}:${state.run.data.version}:failed`,
        eventType: "run.failed",
        occurredAt: state.run.data.completedAt ?? state.run.data.updatedAt,
        organizationId: state.run.data.organizationId,
        payload: {
          ...(state.run.data.error ? { error: state.run.data.error } : {}),
          status: state.run.data.status,
          threadId: state.run.data.threadId,
        },
        projectId: state.run.data.projectId,
        runId: state.run.data.id,
        threadId: state.run.data.threadId,
      }),
    );
  }
  if (state.queueMessage && enqueueRun) {
    await enqueueRun({
      deduplicationId: `approval-resume:${state.approval.data.id}:${state.approval.data.version}`,
      message: state.queueMessage,
      messageGroupId: agentRunQueueMessageGroupId(state.queueMessage),
    });
  }
  if (terminalQueueMessage && dependencies.enqueueTerminalRun) {
    await dependencies.enqueueTerminalRun({
      deduplicationId: `approval-terminal:${state.approval.data.id}:${state.approval.data.version}`,
      message: terminalQueueMessage,
      messageGroupId: agentRunQueueMessageGroupId(terminalQueueMessage),
    });
  }
  await completePublishedBarrier(barrier, dependencies);
}

export function replayResult(
  input: ResolveRunApprovalInput,
  state: Awaited<ReturnType<typeof loadResolutionState>>,
): ResolveRunApprovalResult {
  const persistedDecision = state.approval.data.status;
  if (persistedDecision === "pending") {
    throw new ApprovalResolutionError(
      "approval_resolution_missing",
      "Approval resolution did not persist.",
    );
  }
  if (persistedDecision !== "expired" && !resolutionMatches(state.approval, input.decision)) {
    throw new ApprovalResolutionError(
      "approval_already_resolved",
      `Approval is already ${state.approval.data.status}.`,
    );
  }
  return {
    ...state,
    decision: persistedDecision,
    ...(persistedDecision === "approved" && state.run.data.status === "queued"
      ? { queueMessage: queueMessage(state.run) }
      : {}),
  };
}
