/* eslint-disable no-await-in-loop -- Model attempts preserve accounting and fallback order. */

import { normalizeModelId } from "@deployments-ai/model-gateway";
import { validateStructuredResponse } from "@deployments-ai/agent-manifest";
import { stableSpanId } from "@deployments-ai/observability";
import { createHash } from "node:crypto";
import { RuntimeModelInvocationPersistenceError, RuntimeRunCanceledError } from "./errors.ts";
import {
  captureGenerationReasoning,
  replayReasoningForAttempt,
  type RuntimeGenerationReasoning,
} from "./generation-reasoning.ts";
import { safeResponseInterpretation } from "./model-response-diagnostics.ts";
import { boundedRuntimeError } from "./redaction.ts";
import { parseResponseDepthMode, responseDepthClassificationRequest } from "./response-depth.ts";
import type { RuntimeExecutionState } from "./runtime-core.ts";
import {
  appendProgress,
  assertRuntimeTransactionCapacity,
  executionContext,
  isCanceled,
  now,
  revalidateBrainEvidence,
  throwIfCanceled,
} from "./runtime-core.ts";
import {
  MAX_MODEL_TOOL_CALLS_PER_GENERATION,
  modelToolCallSlots,
  runtimeModelToolRequests,
} from "./sandbox-continuation.ts";
import type {
  RuntimeAssistantTextDelta,
  RuntimeAssistantTextStream,
  RuntimeModelInvocationAttempt,
} from "./model-generation-types.ts";
import type {
  AgentRunInput,
  AgentRuntimeDependencies,
  RuntimeArtifact,
  RuntimeBrainEvidenceContextItem,
  RuntimeMemoryContextItem,
  RuntimeModelGenerationRequest,
  RuntimeModelGenerationResult,
  RuntimeResponseDepthMode,
  RuntimeToolDefinition,
  RuntimeToolRequest,
  RuntimeUsageEntry,
} from "./types.ts";

const SAFE_STOP_REASONS = new Set([
  "cancelled",
  "content_filter",
  "end_turn",
  "eos",
  "error",
  "function_call",
  "length",
  "max_tokens",
  "stop",
  "tool_calls",
]);

function safeMetadataIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    new TextEncoder().encode(normalized).byteLength > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function providerRequestDigest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > 1_024) return undefined;
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

function safeStopReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return SAFE_STOP_REASONS.has(normalized) ? normalized : normalized ? "other" : undefined;
}

function canonicalResolvedModelId(
  result: RuntimeModelGenerationResult,
  requestedModelId: string,
  configuredModelIds: readonly string[],
): string {
  const canonicalConfiguredModelIds = configuredModelIds.map(normalizeModelId);
  const resolved = safeMetadataIdentifier(result.resolvedModelId);
  return resolved && canonicalConfiguredModelIds.includes(resolved)
    ? resolved
    : normalizeModelId(requestedModelId);
}

function canonicalModelUsageEntry(
  entry: RuntimeUsageEntry,
  requestedModelId: string,
  configuredModelIds: readonly string[],
): RuntimeUsageEntry {
  if (entry.type !== "model_tokens") return entry;
  const canonicalConfiguredModelIds = configuredModelIds.map(normalizeModelId);
  const canonicalRequestedModelId = normalizeModelId(requestedModelId);
  const configuredProviders = new Set(
    canonicalConfiguredModelIds.map((modelId) => modelId.slice(0, modelId.indexOf("/"))),
  );
  const modelId = safeMetadataIdentifier(entry.modelId);
  const provider = safeMetadataIdentifier(entry.provider);
  const requestedProvider = canonicalRequestedModelId.slice(
    0,
    canonicalRequestedModelId.indexOf("/"),
  );
  const { modelId: _modelId, provider: _provider, ...retained } = entry;
  return {
    ...retained,
    modelId:
      modelId && canonicalConfiguredModelIds.includes(modelId)
        ? modelId
        : canonicalRequestedModelId,
    ...(provider && configuredProviders.has(provider)
      ? { provider }
      : requestedProvider
        ? { provider: requestedProvider }
        : {}),
  };
}

async function persistModelInvocationAttempt(
  dependencies: AgentRuntimeDependencies,
  attempt: RuntimeModelInvocationAttempt,
) {
  if (!dependencies.recordModelInvocation) return;
  try {
    await dependencies.recordModelInvocation(attempt);
  } catch (cause) {
    throw new RuntimeModelInvocationPersistenceError(attempt, cause);
  }
}

async function flushAssistantText(
  stream: RuntimeAssistantTextStream | undefined,
  modelCallId: string,
) {
  if (!stream) return;
  try {
    await stream.flush(modelCallId);
  } catch {
    return;
  }
}

export type RuntimeGeneratedMessage = RuntimeModelGenerationResult & {
  readonly generationReasoning?: RuntimeGenerationReasoning;
  readonly modelId: string;
  readonly responseDepthMode?: RuntimeResponseDepthMode;
  readonly toolRequests: readonly RuntimeToolRequest[];
};

export async function generateMessage(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  memories: readonly RuntimeMemoryContextItem[],
  brainEvidence: readonly RuntimeBrainEvidenceContextItem[],
  artifacts: readonly RuntimeArtifact[],
  state: RuntimeExecutionState,
  modelIds: readonly string[],
  tools: readonly RuntimeToolDefinition[],
  modelToolRequests: readonly RuntimeToolRequest[],
  modelCallIndex: number,
  modelFallbackStartIndex = 0,
  options: {
    readonly classifyResponseDepth?: boolean;
    readonly responseDepthMode?: RuntimeResponseDepthMode;
  } = {},
): Promise<RuntimeGeneratedMessage> {
  const classificationPolicy = options.classifyResponseDepth
    ? input.responseDepthPolicy
    : undefined;
  if (options.classifyResponseDepth && !classificationPolicy) {
    throw new Error("Response depth classification requires a configured policy.");
  }
  if (
    !Number.isSafeInteger(modelFallbackStartIndex) ||
    modelFallbackStartIndex < 0 ||
    modelFallbackStartIndex > modelIds.length
  ) {
    throw new Error("Runtime model fallback recovery index is invalid.");
  }
  let lastError: unknown;
  let responseDepthMode = options.responseDepthMode;
  for (let attempt = modelFallbackStartIndex; attempt < modelIds.length; attempt += 1) {
    const modelId = modelIds[attempt]!;
    const sameModelRetry = attempt > 0 && modelIds[attempt - 1] === modelId;
    // Reserve the worst-case batch so a generation never requests tools that cannot be persisted.
    assertRuntimeTransactionCapacity(state, {
      reservePendingTools:
        !classificationPolicy && tools.length > 0 ? MAX_MODEL_TOOL_CALLS_PER_GENERATION : 0,
      reserveUsageEntries: 1,
    });
    const invocationKind = classificationPolicy ? "response-depth" : "assistant";
    const invocationId = `${input.runId}:execution:${input.runExecutionVersion}:${invocationKind}:${modelCallIndex}`;
    const attemptId = `${invocationId}:run-attempt:${input.runAttempt}:fallback:${attempt}`;
    const attemptSpanId = stableSpanId(input.traceId, `model:${attemptId}`);
    // Classification and structured output are intermediate machine text, and the Gemma 4 textual
    // tool protocol interleaves tool syntax with prose, so none of them streams to thread readers.
    const assistantTextStream =
      classificationPolicy || input.responseFormat || input.modelToolProtocol === "gemma4"
        ? undefined
        : dependencies.assistantTextStream;
    const attemptStartedAt = now(dependencies);
    const canonicalRequestedModelId = normalizeModelId(modelId);
    const requestedProvider = canonicalRequestedModelId.slice(
      0,
      canonicalRequestedModelId.indexOf("/"),
    );
    let result: RuntimeModelGenerationResult | undefined;
    let toolRequests: readonly RuntimeToolRequest[] = [];
    let resolvedModelId = modelId;
    const invocationAttempt = (
      status: RuntimeModelInvocationAttempt["status"],
      completedAt: number,
      cause?: unknown,
    ): RuntimeModelInvocationAttempt => {
      const usage = result?.usage?.find((entry) => entry.type === "model_tokens");
      const actualProvider = safeMetadataIdentifier(usage?.provider);
      const providerRequestId = providerRequestDigest(result?.metadata?.providerRequestId);
      const stopReason = safeStopReason(result?.metadata?.finishReason);
      return {
        ...executionContext(input),
        ...(result ? { actualModelId: resolvedModelId } : {}),
        ...(actualProvider ? { actualProvider } : {}),
        attemptId,
        ...(usage?.cachedInputTokens !== undefined
          ? { cachedTokens: usage.cachedInputTokens }
          : {}),
        completedAt: new Date(completedAt).toISOString(),
        ...(usage?.costUsdMicros !== undefined ? { costUsdMicros: usage.costUsdMicros } : {}),
        ...(cause !== undefined
          ? {
              errorClass:
                cause instanceof RuntimeRunCanceledError
                  ? "RuntimeRunCanceledError"
                  : cause instanceof Error
                    ? "Error"
                    : "UnknownError",
            }
          : {}),
        fallbackAttempt: attempt,
        ...(attempt > 0 ? { fallbackReason: "previous-model-attempt-failed" } : {}),
        internalEvaluator: false,
        ...(result?.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        invocationId,
        invocationKind,
        modelCallIndex,
        ...(result?.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        parentSpanId: input.spanId,
        ...(providerRequestId ? { providerRequestId } : {}),
        requestedModelId: modelId,
        ...(requestedProvider ? { requestedProvider } : {}),
        runAttempt: input.runAttempt,
        runExecutionVersion: input.runExecutionVersion,
        spanId: attemptSpanId,
        startedAt: new Date(attemptStartedAt).toISOString(),
        status,
        ...(stopReason ? { stopReason } : {}),
        streaming: assistantTextStream !== undefined,
        ...(usage?.idempotencyKey
          ? {
              totalTokens: usage.quantity,
              usageEntry: usage,
              usageIdempotencyKey: usage.idempotencyKey,
            }
          : {}),
      };
    };
    await throwIfCanceled(input, dependencies, `model generation attempt ${attempt + 1}`);
    await appendProgress(input, dependencies, {
      eventType: "model.generation.started",
      level: "info",
      message: `Model generation started with ${modelId}.`,
      metadata: {
        attempt,
        modelCallIndex,
        modelId,
        primaryModelId: input.modelId,
      },
    });
    try {
      const liveBrainEvidence = classificationPolicy
        ? []
        : await revalidateBrainEvidence(input, dependencies, brainEvidence);
      const media = input.inputMedia;
      if (media && !dependencies.loadInputArtifacts) {
        throw new Error("Private input artifact loading is not configured.");
      }
      const inputArtifacts = media
        ? await dependencies.loadInputArtifacts!({
            ...executionContext(input),
            media,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : undefined;
      if (
        media &&
        (!inputArtifacts ||
          inputArtifacts.length !== media.artifactIds.length ||
          inputArtifacts.some(
            (artifact, index) => artifact.artifactId !== media.artifactIds[index],
          ))
      ) {
        throw new Error(
          "Private input artifact loading did not return the complete requested media.",
        );
      }
      const request: RuntimeModelGenerationRequest = {
        ...executionContext(input),
        ...(input.attachmentIndex ? { attachmentIndex: input.attachmentIndex } : {}),
        brainEvidence: liveBrainEvidence,
        completedToolCalls: state.completedToolCalls,
        ...(input.conversationCheckpoint
          ? { conversationCheckpoint: input.conversationCheckpoint }
          : {}),
        ...(input.conversationTimingAnchor
          ? { conversationTimingAnchor: input.conversationTimingAnchor }
          : {}),
        instructions: input.instructions,
        ...(inputArtifacts && media
          ? { inputArtifacts, promptMessageId: media.promptMessageId }
          : {}),
        ...(input.inputOmissions ? { inputOmissions: input.inputOmissions } : {}),
        ...(input.unlistedInputOmissions
          ? { unlistedInputOmissions: input.unlistedInputOmissions }
          : {}),
        ...(input.responseFormat && !classificationPolicy
          ? { responseFormat: input.responseFormat }
          : {}),
        ...(input.historySelection ? { historySelection: input.historySelection } : {}),
        memories,
        ...(input.modelCatalog ? { modelCatalog: input.modelCatalog } : {}),
        modelCallId: attemptId,
        modelToolCallSlots: modelToolCallSlots(input.runId, modelToolRequests, modelCallIndex),
        modelId,
        ...(input.modelInputTokenBudget !== undefined
          ? { modelInputTokenBudget: input.modelInputTokenBudget }
          : {}),
        // The response-depth classifier allowlists its own fields, so these never reach it.
        ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
        ...(input.modelOutputTokenReserve !== undefined
          ? { modelOutputTokenReserve: input.modelOutputTokenReserve }
          : {}),
        ...(input.modelToolProtocol !== undefined
          ? { modelToolProtocol: input.modelToolProtocol }
          : {}),
        prompt: input.prompt,
        ...(input.promptCreatedAt ? { promptCreatedAt: input.promptCreatedAt } : {}),
        recentMessages: input.recentMessages ?? [],
        replayReasoning: replayReasoningForAttempt({
          attempt,
          history: state.generationReasoning,
          modelId,
          modelToolProtocol: input.modelToolProtocol,
        }),
        ...(input.responseDepthPolicy && !input.responseFormat
          ? { responseDepthPolicy: input.responseDepthPolicy }
          : {}),
        ...(responseDepthMode !== undefined ? { responseDepthMode } : {}),
        // Single-route recovery intentionally repeats one route. Mark that request from its stable
        // attempt position so crash recovery reconstructs the same corrective prompt without
        // persisting generated text or relying on process-local error state.
        ...(sameModelRetry ? { responseRecovery: "same-model-retry" as const } : {}),
        ...(assistantTextStream
          ? {
              onTextDelta: (delta: RuntimeAssistantTextDelta) => {
                try {
                  assistantTextStream.append(delta);
                } catch {
                  return;
                }
              },
            }
          : {}),
        sandboxArtifacts: artifacts,
        ...(input.runContext ? { runContext: input.runContext } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        skills: input.skills ?? [],
        tools,
        ...(input.toolResultImages !== undefined
          ? { toolResultImages: input.toolResultImages }
          : {}),
      };
      try {
        result = await dependencies.generateAssistantMessage(
          classificationPolicy
            ? responseDepthClassificationRequest(request, classificationPolicy)
            : request,
        );
      } finally {
        // Live text reaches readers before this generation's completed or failed progress event.
        await flushAssistantText(assistantTextStream, attemptId);
      }
      const canonicalUsage = result.usage?.map((entry) =>
        canonicalModelUsageEntry(entry, modelId, modelIds),
      );
      result = { ...result, ...(canonicalUsage ? { usage: canonicalUsage } : {}) };
      resolvedModelId = canonicalResolvedModelId(result, modelId, modelIds);
      state.modelId = resolvedModelId;
      state.usage.push(...(result.usage ?? []));
      await throwIfCanceled(input, dependencies, `model generation attempt ${attempt + 1}`);
      if (classificationPolicy) {
        responseDepthMode = parseResponseDepthMode(result.assistantMessage);
        if (result.responseError || !responseDepthMode || (result.toolCalls?.length ?? 0) > 0) {
          throw new Error("Model returned an invalid response depth selection.");
        }
      } else if (result.responseError) {
        throw new Error(result.responseError);
      }
      if (
        !classificationPolicy &&
        !result.assistantMessage.trim() &&
        (result.toolCalls?.length ?? 0) === 0
      ) {
        const interpretation = safeResponseInterpretation(result.metadata?.responseInterpretation);
        throw new Error(
          interpretation
            ? `Model returned an empty assistant message after ${interpretation.disposition}.`
            : "Model returned an empty assistant message.",
        );
      }
      if (!classificationPolicy && input.responseFormat && (result.toolCalls?.length ?? 0) === 0) {
        validateStructuredResponse(result.assistantMessage, input.responseFormat);
      }
      toolRequests = runtimeModelToolRequests(input, result, tools, {
        modelAttemptId: attemptId,
        modelCallIndex,
      });
    } catch (cause) {
      const cancellation =
        cause instanceof RuntimeRunCanceledError
          ? cause
          : (await isCanceled(input, dependencies))
            ? new RuntimeRunCanceledError(`model generation attempt ${attempt + 1}`)
            : undefined;
      const persistedAttempt = invocationAttempt(
        cancellation ? "canceled" : "failed",
        now(dependencies),
        cause,
      );
      await persistModelInvocationAttempt(dependencies, persistedAttempt);
      if (dependencies.recordModelInvocation && persistedAttempt.usageEntry) {
        state.providerPersistedUsageIdempotencyKeys.add(persistedAttempt.usageEntry.idempotencyKey);
      }
      if (cancellation) throw cancellation;
      lastError = cause;
      await appendProgress(input, dependencies, {
        eventType: "model.generation.failed",
        level: attempt === modelIds.length - 1 ? "error" : "warn",
        message: `Model generation failed with ${modelId}.`,
        metadata: {
          attempt,
          error: boundedRuntimeError(cause, "Model generation failed"),
          modelCallIndex,
          modelId,
          ...(safeResponseInterpretation(result?.metadata?.responseInterpretation)
            ? {
                responseInterpretation: safeResponseInterpretation(
                  result?.metadata?.responseInterpretation,
                ),
              }
            : {}),
        },
      });
      continue;
    }
    const persistedAttempt = invocationAttempt("succeeded", now(dependencies));
    await persistModelInvocationAttempt(dependencies, persistedAttempt);
    if (dependencies.recordModelInvocation && persistedAttempt.usageEntry) {
      state.providerPersistedUsageIdempotencyKeys.add(persistedAttempt.usageEntry.idempotencyKey);
    }
    assertRuntimeTransactionCapacity(state, {
      reservePendingTools: result.toolCalls?.length ?? 0,
    });
    const capture = classificationPolicy
      ? undefined
      : captureGenerationReasoning({
          details: result.reasoningDetails,
          modelCallIndex,
          modelToolProtocol: input.modelToolProtocol,
          producerAttemptId: attemptId,
          producerModelId: resolvedModelId,
          toolCalls: result.toolCalls ?? [],
        });
    await throwIfCanceled(input, dependencies, `model generation attempt ${attempt + 1}`);
    await appendProgress(input, dependencies, {
      eventType: "model.generation.completed",
      level: "info",
      message: `Model generation completed with ${resolvedModelId}.`,
      metadata: {
        attempt,
        ...(result.metadata?.contextPacking
          ? { contextPacking: result.metadata.contextPacking }
          : {}),
        modelCallIndex,
        modelId: resolvedModelId,
        ...(capture
          ? {
              reasoningCapture:
                capture.kind === "captured"
                  ? { bytes: capture.bytes, kind: capture.kind }
                  : capture,
            }
          : {}),
        requestedModelId: modelId,
        ...(safeResponseInterpretation(result.metadata?.responseInterpretation)
          ? {
              responseInterpretation: safeResponseInterpretation(
                result.metadata?.responseInterpretation,
              ),
            }
          : {}),
      },
    });
    return {
      ...result,
      assistantMessage: classificationPolicy ? "" : result.assistantMessage.trim(),
      ...(capture?.kind === "captured" ? { generationReasoning: capture.reasoning } : {}),
      ...(responseDepthMode !== undefined ? { responseDepthMode } : {}),
      modelId: resolvedModelId,
      toolRequests,
    };
  }
  throw lastError ?? new Error("No runtime model was configured.");
}
