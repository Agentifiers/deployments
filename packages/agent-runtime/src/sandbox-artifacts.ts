/* eslint-disable no-await-in-loop -- Runtime side effects must preserve agent-request order. */

import {
  RuntimeArtifactPersistenceError,
  RuntimeArtifactPublicationError,
  RuntimeArtifactValidationError,
  isRuntimeHostShutdown,
  RuntimeRunCanceledError,
  RuntimeToolPreparationRetryableError,
  RuntimeToolRecoveryRequiredError,
  withRuntimeExecutionFailureState,
} from "./errors.ts";
import { boundedRuntimeError } from "./redaction.ts";
import {
  artifactContinuation,
  boundedSandboxFailureMessage,
  continuedArtifacts,
  recordArtifacts,
  rehydrateContinuedArtifacts,
  retryPendingArtifactPublications,
  validateRuntimeArtifactContinuation,
} from "./runtime-artifacts.ts";
import type { RuntimeExecutionState } from "./runtime-core.ts";
import {
  appendProgress,
  canonicalToolInput,
  configuredModelAttempts,
  isCanceled,
  now,
  pendingActionProgressMetadata,
  recallKnowledge,
  runtimeArtifactBytes,
  runtimeTransactionCapacityExceeded,
  runtimeUsage,
  throwIfCanceled,
  validateRunAttempt,
} from "./runtime-core.ts";
import { executeToolRequests } from "./runtime-tools.ts";
import { prepareSandboxPlan } from "./sandbox-plan.ts";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeDependencies,
  RuntimeModelContinuation,
} from "./types.ts";

import {
  MAX_MODEL_TOOL_CALLS_PER_GENERATION,
  modelGenerationLimit,
  modelToolCallLimit,
  modelToolCallSlots,
  modelToolInputValidator,
  resolveModelTools,
  sandboxArtifacts,
  validateRuntimeModelContinuation,
} from "./sandbox-continuation.ts";
import { RuntimeAgentPlanTracker, runtimeToolPlanOutcome } from "./runtime-agent-plan.ts";
import { generateMessage, type RuntimeGeneratedMessage } from "./runtime-model-generation.ts";

export async function executeAgentRunImpl(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
): Promise<AgentRunResult> {
  validateRunAttempt(input);
  const modelContinuation = validateRuntimeModelContinuation(input.modelContinuation);
  const artifactPersistenceRequired =
    (input.toolRequests?.length ?? 0) > 0 ||
    (input.modelToolNames?.length ?? 0) > 0 ||
    (modelContinuation?.toolRequests.length ?? 0) > 0 ||
    (input.sandboxCommands ?? []).some(
      (command) => command.captureOutput || (command.captureFiles?.length ?? 0) > 0,
    );
  if (artifactPersistenceRequired && !dependencies.recordArtifact) {
    throw new RuntimeArtifactValidationError(
      "Artifact-capable runtime execution requires a recordArtifact port.",
    );
  }
  const startedAt = now(dependencies);
  const continued = input.artifactContinuation
    ? validateRuntimeArtifactContinuation(input.artifactContinuation)
    : undefined;
  const continuedRuntimeArtifacts = continuedArtifacts(continued);
  const state: RuntimeExecutionState = {
    artifactBytes: continued?.artifactBytes ?? 0,
    artifactIndexCursor: continued?.artifactIndexCursor ?? 0,
    artifacts: continuedRuntimeArtifacts,
    brainEvidence: [],
    completedToolCalls: [...(input.completedToolCalls ?? [])],
    generationReasoning: [...(modelContinuation?.generationReasoning ?? [])],
    pendingArtifactPublicationIndexes: [...(continued?.pendingArtifactPublicationIndexes ?? [])],
    persistedCompletedToolCallIds: new Set(
      (input.completedToolCalls ?? []).map((call) => call.toolCallId),
    ),
    persistedModelCallCount: modelContinuation?.modelCallCount ?? 0,
    providerPersistedUsageIdempotencyKeys: new Set(),
    refreshedTransientToolCallIds: new Set(),
    sandboxCompleted: continued?.sandboxCompleted === true,
    ...(continued?.sandboxFailureMessage
      ? { sandboxFailureMessage: continued.sandboxFailureMessage }
      : {}),
    transientArtifacts: [],
    usage: [],
  };
  const agentPlan = new RuntimeAgentPlanTracker(input, dependencies);
  let activeModelContinuation = modelContinuation;
  const interruptedResult = (): AgentRunResult => {
    const completedAt = now(dependencies);
    return {
      artifactContinuation: artifactContinuation(state),
      artifacts: state.artifacts,
      assistantMessage: "",
      brainEvidence: state.brainEvidence,
      completedToolCalls: state.completedToolCalls,
      completionStatus: "interrupted",
      ...(activeModelContinuation ? { modelContinuation: activeModelContinuation } : {}),
      ...(state.modelId ? { modelId: state.modelId } : {}),
      usage: [runtimeUsage(input, startedAt, completedAt, "interrupted"), ...state.usage],
    };
  };
  try {
    await dependencies.generateAssistantMessage.validateRunInput?.(input);
    const modelIds = configuredModelAttempts(input);
    const modelTools = await resolveModelTools(input, dependencies);
    const selectableModelToolNames = new Set(modelTools.map((tool) => tool.toolName));
    const continuationModelTools = await resolveModelTools(
      {
        ...input,
        modelToolNames: [
          ...new Set(
            (modelContinuation?.toolRequests ?? [])
              .map((request) => request.toolName)
              .filter((toolName) => !selectableModelToolNames.has(toolName)),
          ),
        ],
      },
      dependencies,
    );
    const modelToolsByName = new Map(
      [...modelTools, ...continuationModelTools].map((tool) => [tool.toolName, tool] as const),
    );
    if (modelContinuation) {
      modelToolCallSlots(
        input.runId,
        modelContinuation.toolRequests,
        modelContinuation.modelCallCount,
      );
    }
    for (const request of modelContinuation?.toolRequests ?? []) {
      const definition = modelToolsByName.get(request.toolName);
      if (!definition) {
        throw new Error(
          `Runtime model continuation references unavailable tool ${request.toolName}.`,
        );
      }
      const toolInput = canonicalToolInput(request.input);
      if (!modelToolInputValidator(definition)(toolInput ?? {})) {
        throw new Error(
          `Runtime model tool ${request.toolName} input does not match its code-owned schema.`,
        );
      }
      if (request.effect !== definition.effect) {
        throw new Error(
          `Runtime model tool ${request.toolName} effect does not match its code-owned definition.`,
        );
      }
      const declaredScopes = [
        ...new Set((request.requiredScopes ?? []).map((scope) => scope.trim())),
      ].sort();
      const definitionScopes = [
        ...new Set(
          definition.requiredScopes.map((scope) => scope.trim()).filter((scope) => Boolean(scope)),
        ),
      ].sort();
      if (JSON.stringify(declaredScopes) !== JSON.stringify(definitionScopes)) {
        throw new Error(
          `Runtime model tool ${request.toolName} requiredScopes do not match its code-owned definition.`,
        );
      }
    }
    await retryPendingArtifactPublications(input, dependencies, state);
    await throwIfCanceled(input, dependencies, "runtime start");
    if (state.sandboxFailureMessage) throw new Error(state.sandboxFailureMessage);
    const rehydratedArtifacts = await rehydrateContinuedArtifacts(input, dependencies, continued);
    if (rehydratedArtifacts)
      state.artifacts.splice(0, state.artifacts.length, ...rehydratedArtifacts);
    const sandboxPlan = prepareSandboxPlan(input, dependencies);
    await appendProgress(input, dependencies, {
      eventType: "run.started",
      level: "info",
      message: "Agent runtime started.",
      metadata: {
        agentDeploymentId: input.agentDeploymentId,
        agentReleaseId: input.agentReleaseId,
      },
    });
    await agentPlan.start();
    const knowledge = agentPlan.hasTask("gather-context")
      ? await agentPlan.perform("gather-context", () => recallKnowledge(input, dependencies))
      : await recallKnowledge(input, dependencies);
    state.brainEvidence.push(...knowledge.brainEvidence);
    const initialToolRequests = [
      ...(input.toolRequests ?? []),
      ...(modelContinuation?.toolRequests ?? []),
    ];
    const executeInitialTools = () =>
      executeToolRequests({ ...input, toolRequests: initialToolRequests }, dependencies, state);
    const tools =
      agentPlan.hasTask("use-tools") && initialToolRequests.length > 0
        ? await agentPlan.perform("use-tools", executeInitialTools, runtimeToolPlanOutcome)
        : await executeInitialTools();
    if (tools.status !== "completed") {
      const completedAt = now(dependencies);
      return {
        artifactContinuation: artifactContinuation(state),
        artifacts: tools.artifacts,
        assistantMessage: tools.assistantMessage,
        brainEvidence: knowledge.brainEvidence,
        completedToolCalls: tools.completed,
        completionStatus: tools.status,
        ...(modelContinuation ? { modelContinuation } : {}),
        pendingAction: tools.pendingAction,
        usage: [runtimeUsage(input, startedAt, completedAt, tools.status), ...state.usage],
      };
    }

    if (!state.sandboxCompleted) {
      const sandboxArtifactIndexOffset = state.artifactIndexCursor;
      const executeSandbox = () =>
        sandboxArtifacts(input, dependencies, sandboxPlan, sandboxArtifactIndexOffset, state);
      const sandbox = agentPlan.hasTask("run-sandbox")
        ? await agentPlan.perform("run-sandbox", executeSandbox)
        : await executeSandbox();
      state.sandboxCompleted = true;
      try {
        await recordArtifacts(
          input,
          dependencies,
          sandbox,
          sandboxArtifactIndexOffset,
          (artifact, index, publicationPending) => {
            state.artifacts.push(artifact);
            state.artifactBytes += runtimeArtifactBytes(artifact);
            state.artifactIndexCursor += 1;
            if (publicationPending) state.pendingArtifactPublicationIndexes.push(index);
          },
          { continueAfterPersistedPublicationFailure: true },
        );
      } catch (cause) {
        // Sandbox commands are not generally replay-safe; fail closed instead of rerunning them.
        if (cause instanceof RuntimeArtifactPublicationError && cause.artifactPersisted) {
          throw cause;
        }
        state.sandboxFailureMessage = boundedSandboxFailureMessage([
          `Completed sandbox artifacts could not be durably persisted: ${boundedRuntimeError(cause, "Sandbox artifact persistence failed.")}`,
        ]);
        if (state.pendingArtifactPublicationIndexes.length > 0) {
          throw new RuntimeArtifactPublicationError(
            "Sandbox artifact event publication must complete before terminalizing persistence failure.",
            { artifactPersisted: true, cause },
          );
        }
        throw new RuntimeArtifactPersistenceError(state.sandboxFailureMessage, {
          cause,
        });
      }
    }
    const maxModelGenerations = modelGenerationLimit(input);
    const maxToolCalls = modelToolCallLimit(input);
    let modelCallCount = modelContinuation?.modelCallCount ?? 0;
    let modelFallbackStartIndex = input.modelFallbackStartIndex ?? 0;
    const modelToolRequests = [...(modelContinuation?.toolRequests ?? [])];
    let model: RuntimeGeneratedMessage;
    await agentPlan.updateTask("produce-response", "in_progress");
    let responseDepthMode =
      input.responseDepthPolicy && !input.responseFormat
        ? modelContinuation?.responseDepthMode
        : undefined;
    if (input.responseDepthPolicy && !input.responseFormat && responseDepthMode === undefined) {
      const selection = await generateMessage(
        input,
        dependencies,
        knowledge.memories,
        knowledge.brainEvidence,
        [...state.artifacts, ...state.transientArtifacts],
        state,
        modelIds,
        modelTools,
        modelToolRequests,
        modelCallCount,
        0,
        { classifyResponseDepth: true },
      );
      responseDepthMode = selection.responseDepthMode;
      if (responseDepthMode === undefined) {
        throw new Error("Response depth classification did not select a mode.");
      }
    }
    while (true) {
      // Checkpoint only at a model tool-batch boundary that made progress in this execution.
      const checkpointRequested = input.checkpointRequested?.() === true;
      if (
        activeModelContinuation &&
        state.completedToolCalls.some(
          (call) => !state.persistedCompletedToolCallIds.has(call.toolCallId),
        ) &&
        (checkpointRequested ||
          runtimeTransactionCapacityExceeded(state, {
            reservePendingTools: modelTools.length > 0 ? MAX_MODEL_TOOL_CALLS_PER_GENERATION : 0,
            reserveUsageEntries: 1,
          }))
      ) {
        const completedAt = now(dependencies);
        return {
          artifactContinuation: artifactContinuation(state),
          artifacts: state.artifacts,
          assistantMessage: "",
          brainEvidence: knowledge.brainEvidence,
          completedToolCalls: state.completedToolCalls,
          completionStatus: "checkpointed",
          modelContinuation: activeModelContinuation,
          ...(state.modelId ? { modelId: state.modelId } : {}),
          usage: [runtimeUsage(input, startedAt, completedAt, "checkpointed"), ...state.usage],
        };
      }
      // A draining host takes the run back instead of starting another generation.
      if (checkpointRequested) return interruptedResult();
      model = await generateMessage(
        input,
        dependencies,
        knowledge.memories,
        knowledge.brainEvidence,
        [...state.artifacts, ...state.transientArtifacts],
        state,
        modelIds,
        modelTools,
        modelToolRequests,
        modelCallCount,
        modelFallbackStartIndex,
        responseDepthMode !== undefined ? { responseDepthMode } : {},
      );
      modelFallbackStartIndex = 0;
      const generatedRequests = model.toolRequests;
      modelCallCount += 1;
      if (generatedRequests.length === 0) break;
      if (modelCallCount >= maxModelGenerations) {
        throw new Error(
          `Agent runtime model generation limit of ${maxModelGenerations} was reached before tool execution.`,
        );
      }
      if (modelToolRequests.length + generatedRequests.length > maxToolCalls) {
        throw new Error(
          `Agent runtime tool call limit of ${maxToolCalls} would be exceeded by ${generatedRequests.length} requested model tool calls after ${modelToolRequests.length} completed.`,
        );
      }
      modelToolRequests.push(...generatedRequests);
      if (model.generationReasoning) state.generationReasoning.push(model.generationReasoning);
      const nextContinuation: RuntimeModelContinuation = {
        generationReasoning: state.generationReasoning,
        modelCallCount,
        ...(responseDepthMode !== undefined ? { responseDepthMode } : {}),
        toolRequests: modelToolRequests,
      };
      activeModelContinuation = nextContinuation;
      const nextTools = await agentPlan.perform(
        "use-tools",
        () =>
          executeToolRequests(
            { ...input, toolRequests: [...(input.toolRequests ?? []), ...modelToolRequests] },
            dependencies,
            state,
          ),
        runtimeToolPlanOutcome,
      );
      if (nextTools.status !== "completed") {
        const completedAt = now(dependencies);
        return {
          artifactContinuation: artifactContinuation(state),
          artifacts: nextTools.artifacts,
          assistantMessage: nextTools.assistantMessage,
          brainEvidence: knowledge.brainEvidence,
          completedToolCalls: nextTools.completed,
          completionStatus: nextTools.status,
          modelContinuation: nextContinuation,
          pendingAction: nextTools.pendingAction,
          usage: [runtimeUsage(input, startedAt, completedAt, nextTools.status), ...state.usage],
        };
      }
    }
    const completedAt = now(dependencies);
    await agentPlan.updateTask("produce-response", "completed");
    await agentPlan.skipPending();
    await appendProgress(input, dependencies, {
      eventType: "run.completed",
      level: "info",
      message: "Agent runtime completed.",
      metadata: {
        artifactCount: state.artifacts.length,
        modelId: model.modelId,
      },
    });
    return {
      artifactContinuation: artifactContinuation(state),
      artifacts: state.artifacts,
      assistantMessage: model.assistantMessage,
      brainEvidence: knowledge.brainEvidence,
      completedToolCalls: state.completedToolCalls,
      completionStatus: "completed",
      modelId: model.modelId,
      usage: [runtimeUsage(input, startedAt, completedAt, "completed"), ...state.usage],
    };
  } catch (cause) {
    if (cause instanceof RuntimeToolPreparationRetryableError) {
      await agentPlan.failActiveAndSkipPending("Agent runtime failed");
      const completedAt = now(dependencies);
      throw withRuntimeExecutionFailureState(cause, {
        artifactContinuation: artifactContinuation(state),
        completedToolCalls: state.completedToolCalls,
        ...(activeModelContinuation ? { modelContinuation: activeModelContinuation } : {}),
        usage: [runtimeUsage(input, startedAt, completedAt, "failed"), ...state.usage],
      });
    }
    if (
      cause instanceof RuntimeArtifactPublicationError &&
      (cause.artifactPersisted || state.pendingArtifactPublicationIndexes.length > 0)
    ) {
      await agentPlan.failActiveAndSkipPending("Agent runtime failed");
      const completedAt = now(dependencies);
      throw withRuntimeExecutionFailureState(cause, {
        artifactContinuation: artifactContinuation(state),
        completedToolCalls: state.completedToolCalls,
        ...(activeModelContinuation ? { modelContinuation: activeModelContinuation } : {}),
        usage: [runtimeUsage(input, startedAt, completedAt, "failed"), ...state.usage],
      });
    }
    if (cause instanceof RuntimeArtifactPersistenceError) {
      await agentPlan.failActiveAndSkipPending("Agent runtime failed");
      const completedAt = now(dependencies);
      throw withRuntimeExecutionFailureState(cause, {
        artifactContinuation: artifactContinuation(state),
        completedToolCalls: state.completedToolCalls,
        ...(activeModelContinuation ? { modelContinuation: activeModelContinuation } : {}),
        usage: [runtimeUsage(input, startedAt, completedAt, "failed"), ...state.usage],
      });
    }
    if (cause instanceof RuntimeToolRecoveryRequiredError) {
      const completedAt = now(dependencies);
      const error = boundedRuntimeError(
        cause.handlingCause,
        "Tool execution outcome requires reconciliation.",
      );
      await appendProgress(input, dependencies, {
        eventType: "tool.reconciliation-required",
        level: "error",
        message: cause.message,
        metadata: {
          error,
          ...pendingActionProgressMetadata(cause.pendingAction),
        },
      });
      await agentPlan.skipPending();
      return {
        artifactContinuation: artifactContinuation(state),
        artifacts: state.artifacts,
        assistantMessage: `${cause.message} ${error}`,
        brainEvidence: state.brainEvidence,
        completedToolCalls: state.completedToolCalls,
        completionStatus: "waiting-for-tool",
        ...(activeModelContinuation ? { modelContinuation: activeModelContinuation } : {}),
        pendingAction: cause.pendingAction,
        usage: [runtimeUsage(input, startedAt, completedAt, "waiting-for-tool"), ...state.usage],
      };
    }
    if (isRuntimeHostShutdown(input.signal)) {
      // An asynchronous tool that already started keeps the run paused on its callback.
      if (cause instanceof RuntimeRunCanceledError && cause.pendingAction?.kind === "tool") {
        const completedAt = now(dependencies);
        return {
          artifactContinuation: artifactContinuation(state),
          artifacts: state.artifacts,
          assistantMessage: `Tool ${cause.pendingAction.toolName} is waiting for asynchronous completion.`,
          brainEvidence: state.brainEvidence,
          completedToolCalls: state.completedToolCalls,
          completionStatus: "waiting-for-tool",
          ...(activeModelContinuation ? { modelContinuation: activeModelContinuation } : {}),
          pendingAction: cause.pendingAction,
          usage: [runtimeUsage(input, startedAt, completedAt, "waiting-for-tool"), ...state.usage],
        };
      }
      return interruptedResult();
    }
    const cancellation =
      cause instanceof RuntimeRunCanceledError
        ? cause
        : (await isCanceled(input, dependencies))
          ? new RuntimeRunCanceledError("the in-flight operation completed")
          : undefined;
    if (cancellation) {
      const completedAt = now(dependencies);
      await appendProgress(input, dependencies, {
        eventType: "run.canceled",
        level: "warn",
        message: cancellation.message,
        metadata: { phase: cancellation.phase },
      });
      await agentPlan.failActive(cancellation.message);
      await agentPlan.skipPending();
      return {
        artifactContinuation: artifactContinuation(state),
        artifacts: state.artifacts,
        assistantMessage: cancellation.message,
        brainEvidence: state.brainEvidence,
        completedToolCalls: state.completedToolCalls,
        completionStatus: "canceled",
        ...(activeModelContinuation ? { modelContinuation: activeModelContinuation } : {}),
        ...(state.modelId ? { modelId: state.modelId } : {}),
        ...(cancellation.pendingAction?.kind === "tool"
          ? { pendingAction: cancellation.pendingAction }
          : {}),
        usage: [runtimeUsage(input, startedAt, completedAt, "canceled"), ...state.usage],
      };
    }
    await appendProgress(input, dependencies, {
      eventType: "run.failed",
      level: "error",
      message: "Agent runtime failed.",
      metadata: { error: boundedRuntimeError(cause, "Agent runtime failed") },
    });
    await agentPlan.failActiveAndSkipPending("Agent runtime failed");
    const completedAt = now(dependencies);
    throw withRuntimeExecutionFailureState(cause, {
      artifactContinuation: artifactContinuation(state),
      completedToolCalls: state.completedToolCalls,
      ...(activeModelContinuation ? { modelContinuation: activeModelContinuation } : {}),
      usage: [runtimeUsage(input, startedAt, completedAt, "failed"), ...state.usage],
    });
  }
}
