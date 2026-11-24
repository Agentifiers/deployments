import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  ApprovalRecord,
  MessageRecord,
  MeterEventRecord,
  RunRecord,
  ThreadRecord,
  TimelineEventRecord,
  ToolCallRecord,
  Ulid,
  meterEventFundingDimensions,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import type {
  RuntimeCompletedToolCall,
  RuntimePendingAction,
  RuntimeRequestingModelGeneration,
  RuntimeUsageEntry,
} from "@deployments-ai/agent-runtime";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ApprovalRecordValue,
  MessageRecordValue,
  RunRecordValue,
  ThreadRecordValue,
  TimelineEventRecordValue,
  ToolCallRecordValue,
} from "./types.ts";
import { AgentRunWorkerRecordError, MAX_INLINE_ASSISTANT_MESSAGE_BYTES } from "./record-readers.ts";

function observabilitySourceContext(run: RunRecordValue) {
  return {
    captureMode: run.data.captureMode,
    ...(run.data.parentSpanId ? { parentSpanId: run.data.parentSpanId } : {}),
    runSpanId: run.data.spanId,
    sessionId: run.data.threadId,
    traceId: run.data.traceId,
    ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
  };
}

/** Both requesting-generation fields of a model-requested tool call; empty for tool-plan calls. */
export function requestingModelGeneration(call: {
  readonly modelAttemptId?: string | undefined;
  readonly modelCallIndex?: number | undefined;
}): RuntimeRequestingModelGeneration {
  return call.modelAttemptId !== undefined && call.modelCallIndex !== undefined
    ? { modelAttemptId: call.modelAttemptId, modelCallIndex: call.modelCallIndex }
    : {};
}

export function advancedThread(previous: ThreadRecordValue, now: Date): ThreadRecordValue {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "thread" as const,
    }),
  );
}

export function assistantMessageRecord(input: {
  readonly body: string;
  readonly bodyRef?: NonNullable<MessageRecordValue["data"]["bodyRef"]>;
  readonly id: Ulid;
  readonly metadata?: MessageRecordValue["data"]["metadata"];
  readonly run: RunRecordValue;
  readonly sequence: number;
  readonly streamEventId: Ulid;
  readonly now: Date;
}): MessageRecordValue {
  const bodyBytes = new TextEncoder().encode(input.body).byteLength;
  const contentHash = createHash("sha256").update(input.body).digest("hex");
  if (bodyBytes > MAX_INLINE_ASSISTANT_MESSAGE_BYTES && !input.bodyRef) {
    throw new AgentRunWorkerRecordError(
      "assistant_body_too_large",
      `Assistant message exceeds the ${MAX_INLINE_ASSISTANT_MESSAGE_BYTES}-byte inline limit and requires a message body writer.`,
    );
  }
  if (
    input.bodyRef &&
    (input.bodyRef.byteSize !== bodyBytes ||
      input.bodyRef.sha256.toLowerCase().replace(/^sha256:/u, "") !== contentHash)
  ) {
    throw new AgentRunWorkerRecordError(
      "assistant_body_reference_mismatch",
      "Assistant message body reference does not match the generated content.",
    );
  }
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(input.run.data.agentDeploymentId
          ? { agentDeploymentId: input.run.data.agentDeploymentId }
          : {}),
        ...(input.bodyRef ? { bodyRef: input.bodyRef } : { body: input.body }),
        contentHash,
        createdAt: input.now.toISOString(),
        environmentId: input.run.data.environmentId,
        id: input.id,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        organizationId: input.run.data.organizationId,
        projectId: input.run.data.projectId,
        role: "assistant" as const,
        runId: input.run.data.id,
        sequence: input.sequence,
        streamEventId: input.streamEventId,
        threadId: input.run.data.threadId,
      },
      itemType: "message" as const,
    }),
  );
}

export function timelineRecord(input: {
  readonly eventType: string;
  readonly id: Ulid;
  readonly run: RunRecordValue;
  readonly sequence: number;
  readonly now: Date;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}): TimelineEventRecordValue {
  return Schema.decodeUnknownSync(TimelineEventRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(input.data ? { data: input.data } : {}),
        createdAt: input.now.toISOString(),
        environmentId: input.run.data.environmentId,
        eventType: input.eventType,
        id: input.id,
        organizationId: input.run.data.organizationId,
        projectId: input.run.data.projectId,
        runId: input.run.data.id,
        sequence: input.sequence,
        threadId: input.run.data.threadId,
      },
      itemType: "timeline-event" as const,
    }),
  );
}

export function pausedToolCallRecord(input: {
  readonly action: RuntimePendingAction;
  readonly now: Date;
  readonly previous?: ToolCallRecordValue;
  readonly run: RunRecordValue;
}): ToolCallRecordValue {
  const action = input.action;
  const previous = input.previous;
  if (previous) {
    if (
      action.kind !== "tool" ||
      previous.data.status !== "pending" ||
      previous.data.authorizationFingerprint !==
        action.executionBinding?.authorizationFingerprint ||
      previous.data.connectionId !== action.executionBinding?.connectionId ||
      previous.data.destinationsHash !== action.executionBinding?.destinationsHash ||
      previous.data.externalAccountId !== action.executionBinding?.externalAccountId ||
      previous.data.inputHash !== action.executionBinding?.inputHash ||
      previous.data.toolAdapterId !== action.executionBinding?.toolAdapterId ||
      previous.data.toolPlanFingerprint !== action.executionBinding?.toolPlanFingerprint ||
      previous.data.effect !== action.effect ||
      previous.data.idempotencyKey !== action.idempotencyKey ||
      !isDeepStrictEqual(previous.data.input, action.input) ||
      previous.data.inputSummary !== action.inputSummary ||
      previous.data.modelAttemptId !== action.modelAttemptId ||
      previous.data.modelCallIndex !== action.modelCallIndex ||
      previous.data.policyReason !== action.policyReason ||
      !isDeepStrictEqual(previous.data.requiredScopes, action.requiredScopes) ||
      previous.data.toolName !== action.toolName
    ) {
      throw new AgentRunWorkerRecordError(
        "pending_tool_call_mismatch",
        `Pending tool call ${action.toolCallId} does not match its canonical record.`,
      );
    }
  }
  const timestamp = input.now.toISOString();
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous?.data,
        ...(action.kind === "approval" ? { approvalId: action.approvalId } : {}),
        ...(action.executionBinding
          ? {
              authorizationFingerprint: action.executionBinding.authorizationFingerprint,
              connectionId: action.executionBinding.connectionId,
              ...(action.executionBinding.destinationsHash
                ? { destinationsHash: action.executionBinding.destinationsHash }
                : {}),
              externalAccountId: action.executionBinding.externalAccountId,
              ...(action.executionBinding.inputHash
                ? { inputHash: action.executionBinding.inputHash }
                : {}),
              ...(action.executionBinding.toolAdapterId
                ? { toolAdapterId: action.executionBinding.toolAdapterId }
                : {}),
              ...(action.executionBinding.toolPlanFingerprint
                ? { toolPlanFingerprint: action.executionBinding.toolPlanFingerprint }
                : {}),
            }
          : {}),
        ...(action.kind === "tool" ? { externalOperationId: action.externalOperationId } : {}),
        ...(action.kind === "tool" && action.client
          ? {
              executionType: "client" as const,
              expiresAt: action.client.expiresAt,
              ...(action.client.outputSchema ? { outputSchema: action.client.outputSchema } : {}),
            }
          : {}),
        createdAt: previous?.data.createdAt ?? timestamp,
        effect: action.effect,
        id: action.toolCallId,
        idempotencyKey: action.idempotencyKey,
        ...(action.input ? { input: action.input } : {}),
        inputSummary: action.inputSummary,
        ...requestingModelGeneration(action),
        organizationId: input.run.data.organizationId,
        observability: observabilitySourceContext(input.run),
        policyAction:
          previous?.data.policyAction ??
          (action.kind === "approval" ? "require-approval" : "allow"),
        policyReason: action.policyReason,
        projectId: input.run.data.projectId,
        requiredScopes: [...action.requiredScopes],
        runId: input.run.data.id,
        ...(action.kind === "tool" ? { startedAt: previous?.data.startedAt ?? timestamp } : {}),
        status: action.kind === "approval" ? "waiting" : "running",
        threadId: input.run.data.threadId,
        toolName: action.toolName,
        updatedAt: timestamp,
        version: previous ? previous.data.version + 1 : 0,
        environmentId: input.run.data.environmentId,
      },
      itemType: "tool-call" as const,
    }),
  );
}

/**
 * Whether a completed call is the same request as its canonical record. Output is not part of
 * the identity: an approved call's pending record has none yet, and a succeeded record's output
 * is compared separately.
 */
export function completedToolCallMatches(
  previous: ToolCallRecordValue,
  call: RuntimeCompletedToolCall,
): boolean {
  return (
    previous.data.approvalId === call.approvalId &&
    previous.data.authorizationFingerprint === call.executionBinding?.authorizationFingerprint &&
    previous.data.connectionId === call.executionBinding?.connectionId &&
    previous.data.destinationsHash === call.executionBinding?.destinationsHash &&
    previous.data.externalAccountId === call.executionBinding?.externalAccountId &&
    previous.data.inputHash === call.executionBinding?.inputHash &&
    previous.data.toolAdapterId === call.executionBinding?.toolAdapterId &&
    previous.data.toolPlanFingerprint === call.executionBinding?.toolPlanFingerprint &&
    previous.data.effect === call.effect &&
    previous.data.externalOperationId === call.externalOperationId &&
    previous.data.idempotencyKey === call.idempotencyKey &&
    isDeepStrictEqual(previous.data.input, call.input) &&
    previous.data.inputSummary === call.inputSummary &&
    previous.data.modelAttemptId === call.modelAttemptId &&
    previous.data.modelCallIndex === call.modelCallIndex &&
    previous.data.policyAction === call.policyAction &&
    previous.data.policyReason === call.policyReason &&
    previous.data.refreshTransientArtifacts === call.refreshTransientArtifacts &&
    isDeepStrictEqual(previous.data.requiredScopes, call.requiredScopes) &&
    previous.data.toolName === call.toolName
  );
}

export function completedToolCallRecord(input: {
  readonly call: RuntimeCompletedToolCall;
  readonly now: Date;
  readonly previous?: ToolCallRecordValue;
  readonly run: RunRecordValue;
}): ToolCallRecordValue {
  const { call, previous } = input;
  if (previous && !completedToolCallMatches(previous, call)) {
    throw new AgentRunWorkerRecordError(
      "completed_tool_call_mismatch",
      `Completed tool call ${call.toolCallId} does not match its canonical record.`,
    );
  }
  if (previous?.data.status === "succeeded") {
    if (
      previous.data.outputSummary !== call.outputSummary ||
      !isDeepStrictEqual(previous.data.output, call.output)
    ) {
      throw new AgentRunWorkerRecordError(
        "completed_tool_call_mismatch",
        `Completed tool call ${call.toolCallId} output does not match its canonical record.`,
      );
    }
    return previous;
  }
  if (previous && previous.data.status !== "pending") {
    throw new AgentRunWorkerRecordError(
      "completed_tool_call_state_mismatch",
      `Tool call ${call.toolCallId} cannot complete from ${previous.data.status}.`,
    );
  }
  const timestamp = input.now.toISOString();
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous?.data,
        ...(call.approvalId ? { approvalId: call.approvalId } : {}),
        ...(call.executionBinding
          ? {
              authorizationFingerprint: call.executionBinding.authorizationFingerprint,
              connectionId: call.executionBinding.connectionId,
              ...(call.executionBinding.destinationsHash
                ? { destinationsHash: call.executionBinding.destinationsHash }
                : {}),
              externalAccountId: call.executionBinding.externalAccountId,
              ...(call.executionBinding.inputHash
                ? { inputHash: call.executionBinding.inputHash }
                : {}),
              ...(call.executionBinding.toolAdapterId
                ? { toolAdapterId: call.executionBinding.toolAdapterId }
                : {}),
              ...(call.executionBinding.toolPlanFingerprint
                ? { toolPlanFingerprint: call.executionBinding.toolPlanFingerprint }
                : {}),
            }
          : {}),
        completedAt: timestamp,
        createdAt: previous?.data.createdAt ?? timestamp,
        effect: call.effect,
        environmentId: input.run.data.environmentId,
        ...(call.externalOperationId ? { externalOperationId: call.externalOperationId } : {}),
        id: call.toolCallId,
        idempotencyKey: call.idempotencyKey,
        ...(call.input ? { input: call.input } : {}),
        inputSummary: call.inputSummary,
        ...requestingModelGeneration(call),
        organizationId: input.run.data.organizationId,
        observability: observabilitySourceContext(input.run),
        ...(call.outputSummary ? { outputSummary: call.outputSummary } : {}),
        ...(call.output ? { output: call.output } : {}),
        policyAction: call.policyAction,
        policyReason: call.policyReason,
        ...(call.refreshTransientArtifacts ? { refreshTransientArtifacts: true } : {}),
        projectId: input.run.data.projectId,
        requiredScopes: [...call.requiredScopes],
        runId: input.run.data.id,
        startedAt: previous?.data.startedAt ?? timestamp,
        status: "succeeded" as const,
        threadId: input.run.data.threadId,
        toolName: call.toolName,
        updatedAt: timestamp,
        version: previous ? previous.data.version + 1 : 0,
      },
      itemType: "tool-call" as const,
    }),
  );
}

export function pendingApprovalRecord(input: {
  readonly action: Extract<RuntimePendingAction, { readonly kind: "approval" }>;
  readonly now: Date;
  readonly run: RunRecordValue;
}): ApprovalRecordValue {
  const action = input.action;
  return Schema.decodeUnknownSync(ApprovalRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: input.now.toISOString(),
        environmentId: input.run.data.environmentId,
        escalationCount: 0,
        id: action.approvalId,
        organizationId: input.run.data.organizationId,
        observability: observabilitySourceContext(input.run),
        projectId: input.run.data.projectId,
        request: {
          ...(action.destinations ? { destinations: [...action.destinations] } : {}),
          effect: action.effect,
          inputSummary: action.inputSummary,
          requiredScopes: [...action.requiredScopes],
          toolName: action.toolName,
        },
        ...(input.run.data.executionBindingId === undefined
          ? { requestedByAgentDeploymentId: input.run.data.agentDeploymentId }
          : {
              executionBindingId: input.run.data.executionBindingId,
              executionPurpose: input.run.data.executionPurpose,
            }),
        runId: input.run.data.id,
        status: "pending",
        threadId: input.run.data.threadId,
        toolCallId: action.toolCallId,
        updatedAt: input.now.toISOString(),
        version: 0,
      },
      itemType: "approval" as const,
    }),
  );
}

export function canonicalUsageTimestamp(
  value: number | string,
  field: string,
  idempotencyKey: string,
): string {
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Runtime usage ${field} is invalid for ${idempotencyKey}.`,
    );
  }
  const timestamp = new Date(milliseconds);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Runtime usage ${field} is outside the supported timestamp range for ${idempotencyKey}.`,
    );
  }
  return timestamp.toISOString();
}

export function usageText(
  value: string | undefined,
  field: string,
  idempotencyKey: string,
): string {
  const normalized = value?.trim();
  const hasControlCharacter = Array.from(normalized ?? "").some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasControlCharacter) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Runtime usage ${field} is invalid for ${idempotencyKey}.`,
    );
  }
  return normalized;
}

export function canonicalRuntimeUsageIdempotencyKey(runId: Ulid, value: string): string {
  const idempotencyKey = usageText(value, "idempotencyKey", "unknown");
  if (new TextEncoder().encode(idempotencyKey).byteLength > 512) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      "Runtime usage idempotencyKey exceeds 512 UTF-8 bytes.",
    );
  }
  return idempotencyKey.startsWith(`${runId}:`) ? idempotencyKey : `${runId}:${idempotencyKey}`;
}

export function runtimeUsageRecord(input: {
  readonly entry: RuntimeUsageEntry;
  readonly id: Ulid;
  readonly run: RunRecordValue;
}): Extract<PlatformRecord, { readonly itemType: "meter-event" }> {
  const idempotencyKey = canonicalRuntimeUsageIdempotencyKey(
    input.run.data.id,
    input.entry.idempotencyKey,
  );
  if (input.entry.runId !== undefined && input.entry.runId !== input.run.data.id) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Runtime usage runId does not match run ${input.run.data.id}.`,
    );
  }
  if (!Number.isSafeInteger(input.entry.quantity) || input.entry.quantity < 0) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Runtime usage quantity is invalid for ${idempotencyKey}.`,
    );
  }
  if (
    input.entry.costUsdMicros !== undefined &&
    (!Number.isSafeInteger(input.entry.costUsdMicros) || input.entry.costUsdMicros < 0)
  ) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Runtime usage cost is invalid for ${idempotencyKey}.`,
    );
  }
  if (
    input.entry.costUsdNanoDollars !== undefined &&
    (!Number.isSafeInteger(input.entry.costUsdNanoDollars) || input.entry.costUsdNanoDollars < 0)
  ) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Runtime usage nanodollar cost is invalid for ${idempotencyKey}.`,
    );
  }
  for (const [field, value] of [
    ["inputTokens", input.entry.inputTokens],
    ["cachedInputTokens", input.entry.cachedInputTokens],
    ["cacheWriteInputTokens", input.entry.cacheWriteInputTokens],
    ["outputTokens", input.entry.outputTokens],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new AgentRunWorkerRecordError(
        "invalid_usage_entry",
        `Runtime usage ${field} is invalid for ${idempotencyKey}.`,
      );
    }
  }
  const metric = usageText(input.entry.type, "type", idempotencyKey);
  const unit = usageText(input.entry.unit, "unit", idempotencyKey);
  if (metric === "model_tokens") {
    if (unit !== "tokens") {
      throw new AgentRunWorkerRecordError(
        "invalid_usage_entry",
        `Runtime model usage must use tokens for ${idempotencyKey}.`,
      );
    }
    usageText(input.entry.modelId, "modelId", idempotencyKey);
    usageText(input.entry.provider, "provider", idempotencyKey);
    if (!input.entry.payer) {
      throw new AgentRunWorkerRecordError(
        "invalid_usage_entry",
        `Runtime model usage must say who paid for ${idempotencyKey}.`,
      );
    }
  }
  if (metric === "worker_ms" && unit !== "ms") {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Runtime worker usage must use milliseconds for ${idempotencyKey}.`,
    );
  }
  const startedAt =
    input.entry.startedAt === undefined
      ? undefined
      : canonicalUsageTimestamp(input.entry.startedAt, "startedAt", idempotencyKey);
  return Schema.decodeUnknownSync(MeterEventRecord)(
    withCanonicalRecordKeys({
      data: {
        dimensions: {
          ...(input.run.data.agentReleaseId !== undefined
            ? { agentReleaseId: input.run.data.agentReleaseId }
            : {}),
          ...(input.run.data.releaseSelection
            ? { releaseSelection: input.run.data.releaseSelection }
            : {}),
          ...(input.entry.cachedInputTokens !== undefined
            ? { cachedInputTokens: input.entry.cachedInputTokens }
            : {}),
          ...(input.entry.cacheWriteInputTokens !== undefined
            ? { cacheWriteInputTokens: input.entry.cacheWriteInputTokens }
            : {}),
          ...(input.entry.costUsdNanoDollars !== undefined
            ? { costUsdNanoDollars: input.entry.costUsdNanoDollars }
            : {}),
          ...(input.entry.costUsdMicros !== undefined
            ? { costUsdMicros: input.entry.costUsdMicros }
            : {}),
          ...(metric === "model_tokens" && input.entry.payer
            ? meterEventFundingDimensions(input.entry.payer)
            : {}),
          ...(input.run.data.executionBindingId !== undefined
            ? {
                executionBindingId: input.run.data.executionBindingId,
                purpose: input.run.data.executionPurpose,
              }
            : {}),
          ...(input.entry.inputTokens !== undefined
            ? { inputTokens: input.entry.inputTokens }
            : {}),
          ...(input.entry.modelId
            ? { modelId: usageText(input.entry.modelId, "modelId", idempotencyKey) }
            : {}),
          ...(input.entry.provider
            ? { provider: usageText(input.entry.provider, "provider", idempotencyKey) }
            : {}),
          ...(input.entry.outputTokens !== undefined
            ? { outputTokens: input.entry.outputTokens }
            : {}),
          ...(startedAt ? { startedAt } : {}),
        },
        environmentId: input.run.data.environmentId,
        id: input.id,
        idempotencyKey,
        metric,
        occurredAt: canonicalUsageTimestamp(input.entry.occurredAt, "occurredAt", idempotencyKey),
        organizationId: input.run.data.organizationId,
        observability: observabilitySourceContext(input.run),
        projectId: input.run.data.projectId,
        quantity: input.entry.quantity,
        runId: input.run.data.id,
        source: usageText(input.entry.source, "source", idempotencyKey),
        unit,
        ...(input.run.data.workspaceId ? { workspaceId: input.run.data.workspaceId } : {}),
      },
      itemType: "meter-event" as const,
    }),
  );
}

export const RecordSchemas = {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  ApprovalRecord,
  MessageRecord,
  RunRecord,
  ThreadRecord,
  TimelineEventRecord,
  ToolCallRecord,
} as const;
