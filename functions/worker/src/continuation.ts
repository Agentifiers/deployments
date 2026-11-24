import {
  AGENT_DELEGATE_TOOL_NAME,
  MAX_AGENT_TOOL_CALLS,
  MAX_AGENT_TOOL_REQUESTS,
} from "@deployments-ai/agent-manifest";
import {
  validateRuntimeModelContinuationRecord,
  validateRuntimeArtifactContinuation,
  type RuntimeArtifactContinuation,
  type RuntimeCompletedToolCall,
  type RuntimeModelContinuationRecord,
  type RuntimePendingAction,
  type RuntimeRetriedToolCall,
} from "@deployments-ai/agent-runtime";
import { RunRecord, Ulid, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { AgentRunWorkerRecordError, requestingModelGeneration } from "./records.ts";
import type { RunRecordValue, ToolCallRecordValue } from "./types.ts";

/** Manifest-pinned tool requests plus the hard ceiling of model-native tool calls per run. */
const MAX_RUN_COMPLETED_TOOL_CALLS = MAX_AGENT_TOOL_REQUESTS + MAX_AGENT_TOOL_CALLS;

type RunToolPendingReference = {
  readonly kind: "approval" | "tool";
  readonly toolCallId: Ulid;
};

export interface RunToolContinuation {
  readonly artifactContinuation?: RuntimeArtifactContinuation;
  readonly completedToolCallIds: readonly Ulid[];
  readonly modelContinuation?: RuntimeModelContinuationRecord;
  readonly pendingAction?: RunToolPendingReference;
  /** The read whose retryable failure requeued the run, so its next failure is counted. */
  readonly retriedToolCall?: RuntimeRetriedToolCall;
}

function retriedToolCall(value: unknown): RuntimeRetriedToolCall {
  const label = "Run tool continuation retriedToolCall";
  const item = record(value, label);
  if (!Number.isSafeInteger(item.failures) || (item.failures as number) < 1) {
    return invalid(`${label}.failures must be a positive integer.`);
  }
  return { failures: item.failures as number, idempotencyKey: text(item, "idempotencyKey", label) };
}

function invalid(message: string): never {
  throw new AgentRunWorkerRecordError("invalid_tool_continuation", message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: Readonly<Record<string, unknown>>, field: string, label: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.trim()) {
    return invalid(`${label}.${field} is required.`);
  }
  return candidate.trim();
}

function ulid(value: unknown, label: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    return invalid(`${label} must be a canonical ULID.`);
  }
}

function pendingReference(value: unknown): RunToolPendingReference {
  const label = "Run tool continuation pendingAction";
  const item = record(value, label);
  const kind = text(item, "kind", label);
  if (kind !== "approval" && kind !== "tool") {
    return invalid(`${label}.kind is invalid.`);
  }
  return { kind, toolCallId: ulid(item.toolCallId, `${label}.toolCallId`) };
}

function artifactContinuation(value: unknown): RuntimeArtifactContinuation {
  try {
    return validateRuntimeArtifactContinuation(value);
  } catch (cause) {
    return invalid(
      cause instanceof Error ? cause.message : "Run artifact continuation is invalid.",
    );
  }
}

function runtimeModelContinuation(value: unknown): RuntimeModelContinuationRecord {
  try {
    return (
      validateRuntimeModelContinuationRecord(value) ??
      invalid("Run model continuation must be present.")
    );
  } catch (cause) {
    return invalid(cause instanceof Error ? cause.message : "Run model continuation is invalid.");
  }
}

function normalizedContinuation(continuation: RunToolContinuation): RunToolContinuation {
  if (continuation.completedToolCallIds.length > MAX_RUN_COMPLETED_TOOL_CALLS) {
    return invalid(
      `Run tool continuation exceeds ${MAX_RUN_COMPLETED_TOOL_CALLS} completed calls.`,
    );
  }
  const completedToolCallIds = continuation.completedToolCallIds.map((toolCallId, index) =>
    ulid(toolCallId, `Run tool continuation completedToolCallIds[${index}]`),
  );
  if (new Set(completedToolCallIds).size !== completedToolCallIds.length) {
    return invalid("Run tool continuation contains duplicate completed tool-call IDs.");
  }
  const pendingAction = continuation.pendingAction
    ? pendingReference(continuation.pendingAction)
    : undefined;
  const modelContinuation = continuation.modelContinuation
    ? runtimeModelContinuation(continuation.modelContinuation)
    : undefined;
  if (pendingAction && completedToolCallIds.includes(pendingAction.toolCallId)) {
    return invalid("Pending and completed tool continuations must be distinct.");
  }
  return {
    ...(continuation.artifactContinuation
      ? { artifactContinuation: artifactContinuation(continuation.artifactContinuation) }
      : {}),
    completedToolCallIds,
    ...(modelContinuation ? { modelContinuation } : {}),
    ...(pendingAction ? { pendingAction } : {}),
    ...(continuation.retriedToolCall
      ? { retriedToolCall: retriedToolCall(continuation.retriedToolCall) }
      : {}),
  };
}

export function runToolContinuation(run: RunRecordValue): RunToolContinuation {
  const raw = run.data.toolContinuation;
  if (raw === undefined) return { completedToolCallIds: [] };
  const value = record(raw, "Run tool continuation");
  if (value.version !== 2 && value.version !== 3 && value.version !== 4) {
    return invalid("Run tool continuation version is unsupported.");
  }
  if (!Array.isArray(value.completedToolCallIds)) {
    return invalid("Run tool continuation completedToolCallIds must be an array.");
  }
  return normalizedContinuation({
    ...(value.artifactContinuation !== undefined
      ? { artifactContinuation: artifactContinuation(value.artifactContinuation) }
      : {}),
    completedToolCallIds: value.completedToolCallIds.map((toolCallId, index) =>
      ulid(toolCallId, `Run tool continuation completedToolCallIds[${index}]`),
    ),
    ...(value.modelContinuation !== undefined
      ? { modelContinuation: runtimeModelContinuation(value.modelContinuation) }
      : {}),
    ...(value.pendingAction !== undefined
      ? { pendingAction: pendingReference(value.pendingAction) }
      : {}),
    ...(value.retriedToolCall !== undefined
      ? { retriedToolCall: retriedToolCall(value.retriedToolCall) }
      : {}),
  });
}

export function withRunToolContinuationReferences(
  run: RunRecordValue,
  continuation: RunToolContinuation,
): RunRecordValue {
  const normalized = normalizedContinuation(continuation);
  const { toolContinuation: _toolContinuation, ...retained } = run.data;
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...retained,
        ...(normalized.completedToolCallIds.length > 0 ||
        normalized.pendingAction ||
        normalized.artifactContinuation ||
        normalized.modelContinuation ||
        normalized.retriedToolCall
          ? {
              toolContinuation: {
                ...(normalized.artifactContinuation
                  ? { artifactContinuation: normalized.artifactContinuation }
                  : {}),
                completedToolCallIds: normalized.completedToolCallIds,
                ...(normalized.modelContinuation
                  ? { modelContinuation: normalized.modelContinuation }
                  : {}),
                ...(normalized.pendingAction ? { pendingAction: normalized.pendingAction } : {}),
                ...(normalized.retriedToolCall
                  ? { retriedToolCall: normalized.retriedToolCall }
                  : {}),
                version: normalized.modelContinuation ? 4 : normalized.artifactContinuation ? 3 : 2,
              },
            }
          : {}),
      },
      itemType: "run" as const,
    }),
  );
}

export function withRunToolContinuation(
  run: RunRecordValue,
  completedToolCalls: readonly RuntimeCompletedToolCall[],
  pending?: RuntimePendingAction,
  continuedArtifacts?: RuntimeArtifactContinuation,
  modelContinuation?: RuntimeModelContinuationRecord,
  retriedToolCall?: RuntimeRetriedToolCall,
): RunRecordValue {
  return withRunToolContinuationReferences(run, {
    ...(continuedArtifacts ? { artifactContinuation: continuedArtifacts } : {}),
    completedToolCallIds: completedToolCalls.map((call) => call.toolCallId),
    ...(modelContinuation ? { modelContinuation } : {}),
    ...(pending ? { pendingAction: { kind: pending.kind, toolCallId: pending.toolCallId } } : {}),
    ...(retriedToolCall ? { retriedToolCall } : {}),
  });
}

export function completedContinuationAfterTool(
  run: RunRecordValue,
  toolCall: ToolCallRecordValue,
): RunToolContinuation {
  const continuation = runToolContinuation(run);
  const pending = continuation.pendingAction;
  if (!pending && run.data.toolContinuation === undefined) {
    return normalizedContinuation({ completedToolCallIds: [toolCall.data.id] });
  }
  if (pending?.kind !== "tool" || pending.toolCallId !== toolCall.data.id) {
    return invalid("Run tool continuation does not match the asynchronous tool result.");
  }
  return normalizedContinuation({
    ...(continuation.artifactContinuation
      ? { artifactContinuation: continuation.artifactContinuation }
      : {}),
    completedToolCallIds: [...continuation.completedToolCallIds, toolCall.data.id],
    ...(continuation.modelContinuation
      ? { modelContinuation: continuation.modelContinuation }
      : {}),
  });
}

export function continuationWithoutPendingAction(run: RunRecordValue): RunToolContinuation {
  const continuation = runToolContinuation(run);
  return normalizedContinuation({
    ...(continuation.artifactContinuation
      ? { artifactContinuation: continuation.artifactContinuation }
      : {}),
    completedToolCallIds: continuation.completedToolCallIds,
    ...(continuation.modelContinuation
      ? { modelContinuation: continuation.modelContinuation }
      : {}),
  });
}

export function runtimeCompletedToolCall(toolCall: ToolCallRecordValue): RuntimeCompletedToolCall {
  // Failed client and awaited sub-agent calls resume the run so the model can recover.
  const recoverableFailure =
    toolCall.data.status === "failed" &&
    (toolCall.data.executionType === "client" ||
      toolCall.data.toolName === AGENT_DELEGATE_TOOL_NAME);
  if (
    (toolCall.data.status !== "succeeded" && !recoverableFailure) ||
    !toolCall.data.idempotencyKey ||
    new Set([
      Boolean(toolCall.data.connectionId),
      Boolean(toolCall.data.authorizationFingerprint),
      Boolean(toolCall.data.externalAccountId),
    ]).size !== 1 ||
    (Boolean(toolCall.data.toolPlanFingerprint) && !toolCall.data.connectionId) ||
    (Boolean(toolCall.data.toolAdapterId) && !toolCall.data.connectionId) ||
    (toolCall.data.policyAction !== "allow" && toolCall.data.policyAction !== "require-approval") ||
    !toolCall.data.policyReason
  ) {
    return invalid(`Tool call ${toolCall.data.id} is not a canonical completed continuation.`);
  }
  return {
    ...(toolCall.data.approvalId ? { approvalId: toolCall.data.approvalId } : {}),
    ...(toolCall.data.connectionId &&
    toolCall.data.authorizationFingerprint &&
    toolCall.data.externalAccountId
      ? {
          executionBinding: {
            authorizationFingerprint: toolCall.data.authorizationFingerprint,
            connectionId: toolCall.data.connectionId,
            ...(toolCall.data.destinationsHash
              ? { destinationsHash: toolCall.data.destinationsHash }
              : {}),
            externalAccountId: toolCall.data.externalAccountId,
            ...(toolCall.data.inputHash ? { inputHash: toolCall.data.inputHash } : {}),
            ...(toolCall.data.toolAdapterId ? { toolAdapterId: toolCall.data.toolAdapterId } : {}),
            ...(toolCall.data.toolPlanFingerprint
              ? { toolPlanFingerprint: toolCall.data.toolPlanFingerprint }
              : {}),
          },
        }
      : {}),
    effect: toolCall.data.effect,
    ...(toolCall.data.externalOperationId
      ? { externalOperationId: toolCall.data.externalOperationId }
      : {}),
    idempotencyKey: toolCall.data.idempotencyKey,
    ...(toolCall.data.input ? { input: toolCall.data.input } : {}),
    inputSummary: toolCall.data.inputSummary,
    ...requestingModelGeneration(toolCall.data),
    ...(toolCall.data.outputSummary ? { outputSummary: toolCall.data.outputSummary } : {}),
    ...(toolCall.data.output
      ? { output: toolCall.data.output }
      : recoverableFailure
        ? {
            output: {
              error: toolCall.data.outputSummary ?? "Tool failed.",
              status: "failed",
            },
          }
        : {}),
    policyAction: toolCall.data.policyAction,
    policyReason: toolCall.data.policyReason,
    ...(toolCall.data.refreshTransientArtifacts ? { refreshTransientArtifacts: true } : {}),
    requiredScopes: toolCall.data.requiredScopes,
    toolCallId: toolCall.data.id,
    toolName: toolCall.data.toolName,
  };
}
