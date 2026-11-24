/* eslint-disable no-await-in-loop -- Runtime side effects must preserve agent-request order. */

import { isDeepStrictEqual } from "node:util";
import {
  RuntimeArtifactPublicationError,
  RuntimeArtifactValidationError,
  RuntimeRunCanceledError,
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
  RuntimeToolDeniedError,
  RuntimeToolRecoveryRequiredError,
} from "./errors.ts";
import { boundedRuntimeError } from "./redaction.ts";
import type { RuntimeRequestingModelGeneration } from "./model-generation-types.ts";
import type {
  AgentRunInput,
  AgentRuntimeDependencies,
  RuntimeArtifact,
  RuntimeApprovedToolCall,
  RuntimeCompletedToolCall,
  RuntimePendingAction,
  RuntimeToolDecision,
  RuntimeToolDefinition,
  RuntimeToolExecutionResult,
  RuntimeToolRequest,
} from "./types.ts";
import {
  MAX_RUNTIME_TOOL_PERSISTENCE_BYTES,
  MAX_RUNTIME_TOOL_REQUESTS,
  MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS,
  MAX_TOOL_IDEMPOTENCY_KEY_CHARACTERS,
  appendProgress,
  boundedExternalOperationId,
  canonicalToolInput,
  executionContext,
  hasControlCharacter,
  isCanceled,
  recoveryExternalOperationId,
  runtimeArtifactBytes,
  safeToolText,
  throwIfCanceled,
  toolApprovalDestinations,
  toolCorrelationId,
  toolExecutionBinding,
  toolPersistenceBytes,
} from "./runtime-core.ts";
import type { RuntimeExecutionState, ToolRequestResult } from "./runtime-core.ts";
import { recordArtifacts } from "./runtime-artifacts.ts";
import { runtimeArtifactId } from "./runtime-artifact-identity.ts";
import {
  pruneTransientArtifactAccess,
  refreshCompletedTransientArtifacts,
  validateTransientArtifacts,
} from "./runtime-transient-artifacts.ts";
import {
  appendToolExecutionFailure,
  appendToolExecutionResult,
  appendToolExecutionStarted,
} from "./runtime-tool-progress.ts";

export async function executeToolRequests(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  state: RuntimeExecutionState,
): Promise<ToolRequestResult> {
  const { artifacts, completedToolCalls: completed } = state;
  const requests = input.toolRequests ?? [];
  const requiresTransientRefresh = completed.some(
    (call) => call.refreshTransientArtifacts === true,
  );
  if (requests.length === 0 && !requiresTransientRefresh) {
    return { artifactBytes: state.artifactBytes, artifacts, completed, status: "completed" };
  }
  if (requests.length > MAX_RUNTIME_TOOL_REQUESTS) {
    throw new Error(
      `Runtime tool request count exceeds the per-run limit of ${MAX_RUNTIME_TOOL_REQUESTS}.`,
    );
  }
  const unpersistedRequestCount = requests.filter((request) => {
    const completedCall = completed.find((call) => call.idempotencyKey === request.idempotencyKey);
    return !completedCall || !state.persistedCompletedToolCallIds.has(completedCall.toolCallId);
  }).length;
  if (unpersistedRequestCount > MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS) {
    throw new Error(
      `Runtime tool request count exceeds the per-execution persistence limit of ${MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS}.`,
    );
  }
  if (
    !dependencies.resolveToolDefinition ||
    !dependencies.authorizeToolCall ||
    !dependencies.executeToolCall
  ) {
    throw new Error(
      "Runtime tool requests require definition, authorization, and execution ports.",
    );
  }
  const idempotencyKeys = new Set<string>();
  const toolCallIds = new Set(completed.map((call) => call.toolCallId));
  const completedIdempotencyKeys = new Set(
    completed.flatMap((call) => (call.idempotencyKey ? [call.idempotencyKey] : [])),
  );
  if (completedIdempotencyKeys.size !== completed.length) {
    throw new Error("Completed tool continuations must have unique idempotency keys.");
  }
  if (toolCallIds.size !== completed.length) {
    throw new Error("Completed tool continuations must have unique toolCallIds.");
  }
  const approvedByIdempotencyKey = new Map<string, RuntimeApprovedToolCall>();
  for (const approved of input.approvedToolCalls ?? []) {
    if (approvedByIdempotencyKey.has(approved.idempotencyKey)) {
      throw new Error(`Approved tool idempotencyKey ${approved.idempotencyKey} is duplicated.`);
    }
    approvedByIdempotencyKey.set(approved.idempotencyKey, approved);
  }
  const prepared: Array<{
    readonly canonicalScopes: readonly string[];
    readonly definition: RuntimeToolDefinition;
    readonly idempotencyKey: string;
    readonly input?: Readonly<Record<string, unknown>>;
    readonly inputSummary: string;
    readonly request: RuntimeToolRequest;
    readonly requester: RuntimeRequestingModelGeneration;
  }> = [];
  let aggregatePersistenceBytes = 0;
  for (const request of requests) {
    const idempotencyKey = request.idempotencyKey.trim();
    if (
      !idempotencyKey ||
      idempotencyKey.length > MAX_TOOL_IDEMPOTENCY_KEY_CHARACTERS ||
      hasControlCharacter(idempotencyKey)
    ) {
      throw new Error(
        `Tool idempotencyKey must contain 1 to ${MAX_TOOL_IDEMPOTENCY_KEY_CHARACTERS} non-control characters.`,
      );
    }
    if (idempotencyKeys.has(idempotencyKey)) {
      throw new Error(`Tool idempotencyKey ${idempotencyKey} is reused within the run.`);
    }
    idempotencyKeys.add(idempotencyKey);
    const definition = await dependencies.resolveToolDefinition(request.toolName, input);
    if (!definition || definition.toolName !== request.toolName) {
      throw new Error(`Runtime tool ${request.toolName} is not registered.`);
    }
    const canonicalScopes = [
      ...new Set(
        definition.requiredScopes.map((scope) => scope.trim()).filter((scope) => Boolean(scope)),
      ),
    ].sort();
    const declaredScopes = request.requiredScopes
      ? [...new Set(request.requiredScopes.map((scope) => scope.trim()))].sort()
      : undefined;
    if (request.effect !== definition.effect) {
      throw new Error(
        `Runtime tool ${request.toolName} expected ${definition.effect} effect but received ${request.effect}.`,
      );
    }
    if (declaredScopes && JSON.stringify(declaredScopes) !== JSON.stringify(canonicalScopes)) {
      throw new Error(
        `Runtime tool ${request.toolName} requiredScopes do not match its definition.`,
      );
    }
    const normalizedInput = canonicalToolInput(request.input);
    const preparedRequest = {
      canonicalScopes,
      definition,
      idempotencyKey,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      inputSummary: safeToolText(request.inputSummary, "Tool input unavailable."),
      request,
      requester: requestingModelGeneration(request),
    };
    aggregatePersistenceBytes += toolPersistenceBytes({
      effect: definition.effect,
      idempotencyKey,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      inputSummary: preparedRequest.inputSummary,
      requiredScopes: canonicalScopes,
      toolName: request.toolName,
    });
    if (aggregatePersistenceBytes > MAX_RUNTIME_TOOL_PERSISTENCE_BYTES) {
      throw new Error(
        `Runtime tool aggregate persistence payload exceeds ${MAX_RUNTIME_TOOL_PERSISTENCE_BYTES} UTF-8 bytes.`,
      );
    }
    prepared.push(preparedRequest);
  }
  const preparedByIdempotencyKey = new Map(
    prepared.map((request) => [request.idempotencyKey, request] as const),
  );
  for (const completedCall of completed) {
    const preparedRequest = preparedByIdempotencyKey.get(completedCall.idempotencyKey);
    if (!preparedRequest) {
      throw new Error(
        `Completed tool continuation ${completedCall.idempotencyKey} is not present in the pinned requests.`,
      );
    }
    const completedInput = canonicalToolInput(completedCall.input);
    if (
      completedCall.toolName !== preparedRequest.request.toolName ||
      completedCall.effect !== preparedRequest.definition.effect ||
      completedCall.inputSummary !== preparedRequest.inputSummary ||
      completedCall.modelAttemptId !== preparedRequest.requester.modelAttemptId ||
      completedCall.modelCallIndex !== preparedRequest.requester.modelCallIndex ||
      !isDeepStrictEqual(completedInput, preparedRequest.input) ||
      JSON.stringify([...completedCall.requiredScopes].sort()) !==
        JSON.stringify(preparedRequest.canonicalScopes)
    ) {
      throw new Error(
        `Completed tool continuation does not match ${preparedRequest.request.toolName}.`,
      );
    }
  }
  await refreshCompletedTransientArtifacts(input, dependencies, state);
  for (const {
    canonicalScopes,
    definition,
    idempotencyKey,
    input: toolInput,
    inputSummary,
    request,
    requester,
  } of prepared) {
    if (completedIdempotencyKeys.has(idempotencyKey)) {
      // A resumed run keeps its approvals for the whole execution: an approved call that already completed in an
      // earlier tool round of this execution has used its approval.
      approvedByIdempotencyKey.delete(idempotencyKey);
      continue;
    }
    await throwIfCanceled(input, dependencies, `tool ${request.toolName}`);
    const scopedRequest = {
      effect: definition.effect,
      idempotencyKey,
      ...(toolInput ? { input: toolInput } : {}),
      inputSummary,
      requiredScopes: canonicalScopes,
      toolName: request.toolName,
      ...executionContext(input),
    };
    const approved = approvedByIdempotencyKey.get(idempotencyKey);
    const approvedInput = approved ? canonicalToolInput(approved.input) : undefined;
    if (
      approved &&
      (approved.toolName !== request.toolName ||
        approved.effect !== definition.effect ||
        approved.inputSummary !== inputSummary ||
        !isDeepStrictEqual(approvedInput, toolInput) ||
        JSON.stringify([...approved.requiredScopes].sort()) !== JSON.stringify(canonicalScopes))
    ) {
      throw new Error(`Approved tool continuation does not match ${request.toolName}.`);
    }
    if (approved) approvedByIdempotencyKey.delete(idempotencyKey);
    const rawDecision = approved
      ? {
          action: "allow" as const,
          ...(approved.executionBinding ? { executionBinding: approved.executionBinding } : {}),
          reason: approved.policyReason,
          toolCallId: approved.toolCallId,
        }
      : await dependencies.authorizeToolCall(scopedRequest);
    const rawAction: unknown = rawDecision.action;
    if (rawAction !== "allow" && rawAction !== "deny" && rawAction !== "require-approval") {
      throw new Error(`Tool policy returned unsupported action ${String(rawAction)}.`);
    }
    const toolCallId = toolCorrelationId(rawDecision.toolCallId, "toolCallId");
    if (toolCallIds.has(toolCallId)) {
      throw new Error(`Tool policy reused toolCallId ${toolCallId} within the run.`);
    }
    toolCallIds.add(toolCallId);
    const approvalId =
      rawDecision.action === "require-approval"
        ? toolCorrelationId(rawDecision.approvalId, "approvalId")
        : undefined;
    const executionBinding = toolExecutionBinding(rawDecision.executionBinding);
    const destinations =
      rawDecision.action === "require-approval"
        ? toolApprovalDestinations(rawDecision.destinations)
        : undefined;
    const reason = safeToolText(rawDecision.reason, "Tool policy decision unavailable.");
    const decision: RuntimeToolDecision =
      rawDecision.action === "deny"
        ? { action: "deny", reason, toolCallId }
        : rawDecision.action === "require-approval"
          ? {
              action: "require-approval",
              approvalId: approvalId!,
              ...(destinations ? { destinations } : {}),
              ...(executionBinding ? { executionBinding } : {}),
              reason,
              toolCallId,
            }
          : {
              action: "allow",
              ...(executionBinding ? { executionBinding } : {}),
              reason,
              toolCallId,
            };
    await appendProgress(input, dependencies, {
      eventType: "tool.policy-decided",
      level: decision.action === "deny" ? "warn" : "info",
      message: `Tool policy decided ${decision.action} for ${request.toolName}.`,
      metadata: {
        action: decision.action,
        reason: decision.reason,
        toolCallId: decision.toolCallId,
        toolName: request.toolName,
      },
    });
    const approvalPendingAction: RuntimePendingAction | undefined =
      decision.action === "require-approval"
        ? {
            approvalId: approvalId!,
            ...(destinations ? { destinations } : {}),
            effect: scopedRequest.effect,
            ...(executionBinding ? { executionBinding } : {}),
            idempotencyKey: scopedRequest.idempotencyKey,
            ...(scopedRequest.input ? { input: scopedRequest.input } : {}),
            inputSummary: scopedRequest.inputSummary,
            ...requester,
            kind: "approval",
            policyReason: decision.reason,
            requiredScopes: scopedRequest.requiredScopes,
            toolCallId: decision.toolCallId,
            toolName: request.toolName,
          }
        : undefined;
    if (await isCanceled(input, dependencies)) {
      throw new RuntimeRunCanceledError(
        `tool ${request.toolName} authorization`,
        approvalPendingAction,
      );
    }
    if (decision.action === "deny") throw new RuntimeToolDeniedError(decision);
    if (decision.action === "require-approval") {
      return {
        artifactBytes: state.artifactBytes,
        artifacts,
        assistantMessage: `Tool ${request.toolName} is waiting for approval: ${decision.reason}`,
        completed,
        pendingAction: approvalPendingAction!,
        status: "waiting-for-approval",
      };
    }
    await appendToolExecutionStarted(input, dependencies, scopedRequest, decision);
    let result: RuntimeToolExecutionResult;
    try {
      result = await dependencies.executeToolCall({
        ...scopedRequest,
        ...(approved ? { approvalId: approved.approvalId } : {}),
        ...(state.brainEvidence.length > 0 ? { brainEvidence: [...state.brainEvidence] } : {}),
        ...(completed.length > 0 ? { completedToolCalls: [...completed] } : {}),
        decision,
        policyAction: approved ? "require-approval" : "allow",
        recordedArtifactIds: Array.from({ length: state.artifactIndexCursor }, (_, index) =>
          runtimeArtifactId(input.runId, index),
        ),
      });
    } catch (cause) {
      if (cause instanceof RuntimeToolExecutionKnownFailureError) {
        await appendToolExecutionFailure(input, dependencies, scopedRequest, decision);
        throw cause;
      }
      if (cause instanceof RuntimeToolPreparationRetryableError) {
        result = await boundedReadRetry(input, dependencies, scopedRequest, decision, cause);
      } else {
        throw new RuntimeToolRecoveryRequiredError(
          {
            effect: scopedRequest.effect,
            ...(executionBinding ? { executionBinding } : {}),
            externalOperationId: recoveryExternalOperationId(decision.toolCallId),
            idempotencyKey: scopedRequest.idempotencyKey,
            ...(scopedRequest.input ? { input: scopedRequest.input } : {}),
            inputSummary: scopedRequest.inputSummary,
            ...requester,
            kind: "tool",
            policyReason: decision.reason,
            requiredScopes: scopedRequest.requiredScopes,
            toolCallId: decision.toolCallId,
            toolName: request.toolName,
          },
          cause,
        );
      }
    }
    const outputSummary = result.outputSummary
      ? safeToolText(result.outputSummary, "Tool output unavailable.")
      : undefined;
    const output = result.output ? canonicalToolInput(result.output) : undefined;
    if (result.status !== "running" && result.status !== "completed") {
      throw new Error(`Tool execution returned unsupported status ${String(result.status)}.`);
    }
    let externalOperationId: string | undefined;
    if (result.status === "running") {
      try {
        externalOperationId = boundedExternalOperationId(result.externalOperationId);
      } catch (cause) {
        throw new RuntimeToolRecoveryRequiredError(
          {
            effect: scopedRequest.effect,
            ...(executionBinding ? { executionBinding } : {}),
            externalOperationId: recoveryExternalOperationId(decision.toolCallId),
            idempotencyKey: scopedRequest.idempotencyKey,
            ...(scopedRequest.input ? { input: scopedRequest.input } : {}),
            inputSummary: scopedRequest.inputSummary,
            ...requester,
            kind: "tool",
            policyReason: decision.reason,
            requiredScopes: scopedRequest.requiredScopes,
            toolCallId: decision.toolCallId,
            toolName: request.toolName,
          },
          cause,
        );
      }
    } else if (result.externalOperationId !== undefined) {
      try {
        externalOperationId = boundedExternalOperationId(result.externalOperationId);
      } catch (cause) {
        await appendProgress(input, dependencies, {
          eventType: "tool.correlation.ignored",
          level: "warn",
          message: `Completed tool ${request.toolName} returned invalid optional operation correlation.`,
          metadata: {
            error: boundedRuntimeError(cause, "Invalid optional operation correlation."),
            toolCallId: decision.toolCallId,
            toolName: request.toolName,
          },
        });
      }
    }
    const pendingAction: RuntimePendingAction | undefined =
      result.status === "running"
        ? {
            ...(result.client ? { client: result.client } : {}),
            effect: scopedRequest.effect,
            ...(executionBinding ? { executionBinding } : {}),
            externalOperationId: externalOperationId!,
            idempotencyKey: scopedRequest.idempotencyKey,
            ...(scopedRequest.input ? { input: scopedRequest.input } : {}),
            inputSummary: scopedRequest.inputSummary,
            ...requester,
            kind: "tool",
            policyReason: decision.reason,
            requiredScopes: scopedRequest.requiredScopes,
            toolCallId: decision.toolCallId,
            toolName: request.toolName,
          }
        : undefined;
    const completedCall: RuntimeCompletedToolCall | undefined =
      result.status === "completed"
        ? {
            ...(approved ? { approvalId: approved.approvalId } : {}),
            effect: scopedRequest.effect,
            ...(executionBinding ? { executionBinding } : {}),
            ...(externalOperationId ? { externalOperationId } : {}),
            idempotencyKey,
            ...(scopedRequest.input ? { input: scopedRequest.input } : {}),
            inputSummary: scopedRequest.inputSummary,
            ...requester,
            ...(outputSummary ? { outputSummary } : {}),
            ...(output ? { output } : {}),
            policyAction: approved ? "require-approval" : "allow",
            policyReason: decision.reason,
            ...(result.transientArtifacts?.length ? { refreshTransientArtifacts: true } : {}),
            requiredScopes: scopedRequest.requiredScopes,
            toolCallId: decision.toolCallId,
            toolName: request.toolName,
          }
        : undefined;
    const resultArtifacts = result.artifacts ?? [];
    const transientResultArtifacts = result.transientArtifacts ?? [];
    const recordedResultArtifacts: RuntimeArtifact[] = [];
    let artifactRecordingStarted = false;
    const retainRecordedArtifactPrefix = () => {
      if (!artifactRecordingStarted) return;
      artifacts.push(...recordedResultArtifacts);
      state.artifactBytes += recordedResultArtifacts.reduce(
        (total, artifact) => total + runtimeArtifactBytes(artifact),
        0,
      );
      state.artifactIndexCursor += recordedResultArtifacts.length;
    };
    try {
      const resultArtifactBytes = resultArtifacts.reduce(
        (total, artifact) => total + runtimeArtifactBytes(artifact),
        0,
      );
      validateTransientArtifacts(
        state,
        transientResultArtifacts,
        resultArtifacts.length,
        resultArtifactBytes,
      );
      const artifactIndexOffset = state.artifactIndexCursor;
      artifactRecordingStarted = true;
      await recordArtifacts(
        input,
        dependencies,
        resultArtifacts,
        artifactIndexOffset,
        (artifact, index, publicationPending) => {
          recordedResultArtifacts.push(artifact);
          if (publicationPending) state.pendingArtifactPublicationIndexes.push(index);
        },
      );
      artifacts.push(...recordedResultArtifacts);
      state.artifactBytes += resultArtifactBytes;
      state.artifactIndexCursor += resultArtifacts.length;
      if (result.status === "completed" && scopedRequest.toolName === "artifact.archive") {
        pruneTransientArtifactAccess(state, scopedRequest.input?.artifactId);
      }
      state.transientArtifacts.push(...transientResultArtifacts);
      if (completedCall && transientResultArtifacts.length > 0) {
        state.refreshedTransientToolCallIds.add(completedCall.toolCallId);
      }
      if (completedCall) completed.push(completedCall);
      await appendToolExecutionResult(input, dependencies, scopedRequest, decision, result);
      if (pendingAction) {
        if (await isCanceled(input, dependencies)) {
          throw new RuntimeRunCanceledError(
            `asynchronous tool ${request.toolName} started`,
            pendingAction,
          );
        }
        return {
          artifactBytes: state.artifactBytes,
          artifacts,
          assistantMessage:
            outputSummary ?? `Tool ${request.toolName} is waiting for asynchronous completion.`,
          completed,
          pendingAction,
          status: "waiting-for-tool",
        };
      }
    } catch (cause) {
      if (pendingAction && !(cause instanceof RuntimeRunCanceledError)) {
        retainRecordedArtifactPrefix();
        throw new RuntimeToolRecoveryRequiredError(pendingAction, cause);
      }
      if (cause instanceof RuntimeArtifactPublicationError) {
        if (cause.artifactPersisted) {
          retainRecordedArtifactPrefix();
          if (completedCall) completed.push(completedCall);
        }
        throw cause;
      }
      if (completedCall && cause instanceof RuntimeArtifactValidationError) {
        retainRecordedArtifactPrefix();
        completed.push(completedCall);
        await appendProgress(input, dependencies, {
          eventType: "tool.artifacts.failed",
          level: "error",
          message: `Completed tool ${request.toolName} artifact handling failed.`,
          metadata: {
            error: boundedRuntimeError(cause, "Completed tool artifact handling failed."),
            toolCallId: completedCall.toolCallId,
            toolName: completedCall.toolName,
          },
        });
        continue;
      }
      throw cause;
    }
  }
  if (approvedByIdempotencyKey.size > 0) {
    throw new Error("Approved tool continuation is not present in the pinned requests.");
  }
  return { artifactBytes: state.artifactBytes, artifacts, completed, status: "completed" };
}

/** Run attempts one read gets for retryable failures before the model is told it failed. */
export const MAX_RETRYABLE_READ_FAILURES = 3;

/**
 * Each retry replays the same call before the model runs again, so a read that keeps failing would
 * requeue the run until its attempt limit. A read that has failed this often completes with the
 * error instead, and the model chooses what to do next. A mutation keeps retrying the run: its
 * outcome may be unknown, and only the run's own limit is safe for it.
 */
async function boundedReadRetry(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  request: RuntimeToolRequest,
  decision: RuntimeToolDecision,
  cause: RuntimeToolPreparationRetryableError,
): Promise<RuntimeToolExecutionResult> {
  const message = boundedRuntimeError(cause.preparationCause, "The tool could not run.");
  const failures =
    (input.retriedToolCall?.idempotencyKey === request.idempotencyKey
      ? input.retriedToolCall.failures
      : 0) + 1;
  const retry = request.effect !== "read" || failures < MAX_RETRYABLE_READ_FAILURES;
  await appendProgress(input, dependencies, {
    eventType: retry ? "tool.retry-scheduled" : "tool.retries-exhausted",
    level: "warn",
    message: retry
      ? `Tool ${request.toolName} failed and the run will retry it: ${message}`
      : `Tool ${request.toolName} failed ${failures} times and its error goes to the model: ${message}`,
    metadata: {
      failures,
      inputSummary: request.inputSummary,
      toolCallId: decision.toolCallId,
      toolName: request.toolName,
    },
  });
  if (request.effect !== "read") throw cause;
  if (retry) {
    throw new RuntimeToolPreparationRetryableError(cause.toolName, cause.preparationCause, {
      failures,
      idempotencyKey: request.idempotencyKey,
    });
  }
  return {
    output: { error: { code: "retries_exhausted", message } },
    outputSummary: `${request.toolName} failed ${failures} times: ${message}`,
    status: "completed",
  };
}

/** A model-requested tool names both its requesting attempt and generation; others name neither. */
function requestingModelGeneration(request: RuntimeToolRequest): RuntimeRequestingModelGeneration {
  const { modelAttemptId, modelCallIndex } = request;
  if (modelAttemptId === undefined && modelCallIndex === undefined) return {};
  if (modelAttemptId === undefined || modelCallIndex === undefined) {
    throw new Error(
      `Runtime tool ${request.toolName} must name both its requesting model attempt and generation, or neither.`,
    );
  }
  return { modelAttemptId, modelCallIndex };
}
