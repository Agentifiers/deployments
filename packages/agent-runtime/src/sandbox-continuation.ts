/* eslint-disable no-await-in-loop -- Runtime side effects must preserve agent-request order. */

import {
  ATTACHMENT_READ_TOOL,
  DEFAULT_AGENT_MODEL_GENERATIONS,
  DEFAULT_AGENT_TOOL_CALLS,
  MAX_AGENT_MODEL_GENERATIONS,
  MAX_AGENT_MODEL_TOOLS,
  MAX_AGENT_TOOL_CALLS,
} from "@deployments-ai/agent-manifest";
import {
  SandboxAllocationCleanupError,
  SandboxAllocationLeaseError,
  SandboxAllocationUnknownError,
  type SandboxLease,
} from "@deployments-ai/sandbox-hosts";
import Ajv, { type ValidateFunction } from "ajv";
import {
  RuntimeArtifactPersistenceError,
  RuntimeArtifactPublicationError,
  RuntimeAsyncSandboxCommandError,
} from "./errors.ts";
import { agentRunSandboxOwner } from "./execution-pins.ts";
import { validateGenerationReasoning } from "./generation-reasoning.ts";
import { boundedRuntimeError } from "./redaction.ts";
import { boundedSandboxFailureMessage, recordArtifacts } from "./runtime-artifacts.ts";
import type { RuntimeExecutionState } from "./runtime-core.ts";
import {
  DEFAULT_CAPTURE_BYTES,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_COUNT,
  MAX_TOTAL_CAPTURE_BYTES,
  appendProgress,
  canonicalToolInput,
  executionContext,
  now,
  progressContext,
  runtimeArtifactBytes,
  throwIfCanceled,
  toolPersistenceBytes,
} from "./runtime-core.ts";
import { handleSandboxAllocationFailure } from "./runtime-sandbox-allocation-recovery.ts";
import { transientArtifactBytes } from "./runtime-transient-artifacts.ts";
import type { RuntimeSandboxPlan } from "./sandbox-plan.ts";
import {
  assertSandboxLeaseIdentity,
  assertSandboxLeaseReady,
  commandArtifact,
  isAsyncExecResult,
} from "./sandbox-plan.ts";
import { readBoundedStream } from "./runtime-streams.ts";
import type { RuntimeRequestingModelGeneration } from "./model-generation-types.ts";
import type {
  AgentRunInput,
  AgentRuntimeDependencies,
  RuntimeArtifact,
  RuntimeModelContinuation,
  RuntimeModelContinuationRecord,
  RuntimeModelGenerationResult,
  RuntimeModelToolCallSlot,
  RuntimeToolDefinition,
  RuntimeToolRequest,
} from "./types.ts";

/** Per-run model generation cap: the release-pinned value, bounded by the manifest hard ceiling. */
export function modelGenerationLimit(input: Pick<AgentRunInput, "maxModelGenerations">): number {
  return Math.min(
    input.maxModelGenerations ?? DEFAULT_AGENT_MODEL_GENERATIONS,
    MAX_AGENT_MODEL_GENERATIONS,
  );
}

/** Per-run cap on completed model-generated tool calls, bounded by the manifest hard ceiling. */
export function modelToolCallLimit(input: Pick<AgentRunInput, "maxToolCalls">): number {
  return Math.min(input.maxToolCalls ?? DEFAULT_AGENT_TOOL_CALLS, MAX_AGENT_TOOL_CALLS);
}

export const MAX_MODEL_TOOL_CALLS_PER_GENERATION = 8;
export const MAX_MODEL_CONTINUATION_PERSISTENCE_BYTES = 192 * 1024;
const MAX_MODEL_TOOL_CALL_ID_BYTES = 1_024;
const modelToolSchemaValidator = new Ajv({ allErrors: true, strict: false });
const modelToolInputValidators = new WeakMap<object, ValidateFunction>();

const MODEL_TOOL_IDEMPOTENCY_KEY_PATTERN = /^(.+):model-tool:(0|[1-9]\d*):(0|[1-9]\d*)$/u;

function modelToolIdempotencyKey(
  runId: string,
  modelCallIndex: number,
  toolCallIndex: number,
): string {
  return `${runId}:model-tool:${modelCallIndex}:${toolCallIndex}`;
}

/**
 * Derives canonical model-call provenance from persisted model tool requests. Every completed
 * generation requested at least one tool, so generations are contiguous from zero through
 * `modelCallCount - 1`, and each generation's calls are dense from tool-call index zero. A
 * request's requesting-generation link must name its slot's generation, and every call of one
 * generation names the same requesting attempt.
 */
export function modelToolCallSlots(
  runId: string,
  requests: readonly RuntimeToolRequest[],
  modelCallCount: number,
): readonly RuntimeModelToolCallSlot[] {
  const slots: RuntimeModelToolCallSlot[] = [];
  for (const [index, request] of requests.entries()) {
    const match = MODEL_TOOL_IDEMPOTENCY_KEY_PATTERN.exec(request.idempotencyKey);
    const modelCallIndex = match ? Number(match[2]) : Number.NaN;
    const toolCallIndex = match ? Number(match[3]) : Number.NaN;
    const previous = slots.at(-1);
    const sameGeneration = previous !== undefined && modelCallIndex === previous.modelCallIndex;
    const ordered =
      match?.[1] === runId &&
      Number.isSafeInteger(modelCallIndex) &&
      Number.isSafeInteger(toolCallIndex) &&
      toolCallIndex < MAX_MODEL_TOOL_CALLS_PER_GENERATION &&
      (request.modelCallIndex === undefined || request.modelCallIndex === modelCallIndex) &&
      (!sameGeneration || request.modelAttemptId === requests[index - 1]!.modelAttemptId) &&
      (previous === undefined
        ? modelCallIndex === 0 && toolCallIndex === 0
        : sameGeneration
          ? toolCallIndex === previous.toolCallIndex + 1
          : modelCallIndex === previous.modelCallIndex + 1 && toolCallIndex === 0);
    const final = index === requests.length - 1;
    if (!ordered || (final && modelCallIndex !== modelCallCount - 1)) {
      throw new Error(
        `Runtime model tool ${request.toolName} idempotencyKey does not match its canonical call slot.`,
      );
    }
    slots.push({ idempotencyKey: request.idempotencyKey, modelCallIndex, toolCallIndex });
  }
  return slots;
}

export function modelToolInputValidator(definition: RuntimeToolDefinition): ValidateFunction {
  const schema = definition.inputSchema;
  if (!schema || schema.type !== "object") {
    throw new Error(
      `Runtime model tool ${definition.toolName} requires a code-owned object schema.`,
    );
  }
  let validate = modelToolInputValidators.get(schema);
  if (validate) return validate;
  try {
    validate = modelToolSchemaValidator.compile(schema);
  } catch (cause) {
    throw new Error(`Runtime model tool ${definition.toolName} has an invalid input schema.`, {
      cause,
    });
  }
  modelToolInputValidators.set(schema, validate);
  return validate;
}

export async function resolveModelTools(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
): Promise<readonly RuntimeToolDefinition[]> {
  const names = input.modelToolNames ?? [];
  if (names.length === 0) return [];
  const declaredModelTools = names.filter((name) => name !== ATTACHMENT_READ_TOOL);
  if (declaredModelTools.length > MAX_AGENT_MODEL_TOOLS) {
    throw new Error(`Agent runtime supports at most ${MAX_AGENT_MODEL_TOOLS} model tools.`);
  }
  if (!dependencies.resolveToolDefinition) {
    throw new Error("Model-native tool calling requires a resolveToolDefinition port.");
  }
  const unique = new Set<string>();
  const definitions: RuntimeToolDefinition[] = [];
  let catalogBytes = 0;
  for (const name of names) {
    if (unique.has(name)) throw new Error(`Runtime model tool ${name} is duplicated.`);
    unique.add(name);
    const definition = await dependencies.resolveToolDefinition(name, input);
    if (!definition || definition.toolName !== name) {
      throw new Error(`Runtime model tool ${name} is not registered.`);
    }
    if (!definition.inputSchema || definition.inputSchema.type !== "object") {
      throw new Error(`Runtime model tool ${name} requires a code-owned object input schema.`);
    }
    modelToolInputValidator(definition);
    catalogBytes += new TextEncoder().encode(JSON.stringify(definition)).byteLength;
    definitions.push(definition);
  }
  if (catalogBytes > 512 * 1024) {
    throw new Error("Runtime model tool catalog exceeds 524288 UTF-8 bytes.");
  }
  return definitions;
}

/** Validates a continued request's requesting-generation link: both fields or neither. */
function requestingModelGeneration(
  request: Readonly<Record<string, unknown>>,
  index: number,
): RuntimeRequestingModelGeneration {
  const { modelAttemptId, modelCallIndex } = request;
  if (modelAttemptId === undefined && modelCallIndex === undefined) return {};
  if (
    typeof modelAttemptId !== "string" ||
    !modelAttemptId.trim() ||
    new TextEncoder().encode(modelAttemptId).byteLength > MAX_MODEL_TOOL_CALL_ID_BYTES ||
    typeof modelCallIndex !== "number" ||
    !Number.isSafeInteger(modelCallIndex) ||
    modelCallIndex < 0
  ) {
    throw new Error(
      `Runtime model continuation tool request ${index} must name both its requesting model attempt and generation, or neither.`,
    );
  }
  return { modelAttemptId, modelCallIndex };
}

export function validateRuntimeModelContinuationRecord(
  value: unknown,
): RuntimeModelContinuationRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime model continuation must be an object.");
  }
  const continuation = value as Readonly<Record<string, unknown>>;
  if (
    !Number.isSafeInteger(continuation.modelCallCount) ||
    (continuation.modelCallCount as number) < 1 ||
    (continuation.modelCallCount as number) >= MAX_AGENT_MODEL_GENERATIONS
  ) {
    throw new Error(
      `Runtime model continuation modelCallCount must be between 1 and ${MAX_AGENT_MODEL_GENERATIONS - 1}.`,
    );
  }
  if (!Array.isArray(continuation.toolRequests) || continuation.toolRequests.length === 0) {
    throw new Error("Runtime model continuation must contain at least one tool request.");
  }
  if (continuation.toolRequests.length > MAX_AGENT_TOOL_CALLS) {
    throw new Error(`Runtime model continuation exceeds ${MAX_AGENT_TOOL_CALLS} tool requests.`);
  }
  if (continuation.toolRequests.length < (continuation.modelCallCount as number)) {
    throw new Error(
      "Runtime model continuation must contain at least one tool request per completed model generation.",
    );
  }
  const responseDepthMode = continuation.responseDepthMode;
  if (
    responseDepthMode !== undefined &&
    responseDepthMode !== "default" &&
    responseDepthMode !== "detailed"
  ) {
    throw new Error("Runtime model continuation responseDepthMode is invalid.");
  }
  const idempotencyKeys = new Set<string>();
  let persistenceBytes = 0;
  const toolRequests = continuation.toolRequests.map((raw, index): RuntimeToolRequest => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Runtime model continuation tool request ${index} must be an object.`);
    }
    const request = raw as Readonly<Record<string, unknown>>;
    if (request.effect !== "execute" && request.effect !== "read" && request.effect !== "write") {
      throw new Error(`Runtime model continuation tool request ${index} has an invalid effect.`);
    }
    if (
      typeof request.toolName !== "string" ||
      !request.toolName.trim() ||
      typeof request.idempotencyKey !== "string" ||
      !request.idempotencyKey.trim() ||
      typeof request.inputSummary !== "string" ||
      !request.inputSummary.trim() ||
      !Array.isArray(request.requiredScopes) ||
      !request.requiredScopes.every((scope) => typeof scope === "string")
    ) {
      throw new Error(`Runtime model continuation tool request ${index} is malformed.`);
    }
    if (idempotencyKeys.has(request.idempotencyKey)) {
      throw new Error("Runtime model continuation contains duplicate idempotency keys.");
    }
    idempotencyKeys.add(request.idempotencyKey);
    const requester = requestingModelGeneration(request, index);
    const toolInput = canonicalToolInput(
      request.input as Readonly<Record<string, unknown>> | undefined,
    );
    const normalized: RuntimeToolRequest = {
      effect: request.effect,
      idempotencyKey: request.idempotencyKey,
      ...(toolInput ? { input: toolInput } : {}),
      inputSummary: request.inputSummary,
      ...requester,
      requiredScopes: request.requiredScopes,
      toolName: request.toolName,
    };
    persistenceBytes += toolPersistenceBytes({
      effect: normalized.effect,
      idempotencyKey: normalized.idempotencyKey,
      ...(normalized.input ? { input: normalized.input } : {}),
      inputSummary: normalized.inputSummary,
      requiredScopes: normalized.requiredScopes ?? [],
      toolName: normalized.toolName,
    });
    return normalized;
  });
  if (persistenceBytes > MAX_MODEL_CONTINUATION_PERSISTENCE_BYTES) {
    throw new Error(
      `Runtime model continuation exceeds ${MAX_MODEL_CONTINUATION_PERSISTENCE_BYTES} persistence bytes.`,
    );
  }
  return {
    modelCallCount: continuation.modelCallCount as number,
    ...(responseDepthMode !== undefined ? { responseDepthMode } : {}),
    toolRequests,
  };
}

export function validateRuntimeModelContinuation(
  value: unknown,
): RuntimeModelContinuation | undefined {
  const record = validateRuntimeModelContinuationRecord(value);
  if (!record) return undefined;
  return {
    ...record,
    generationReasoning: validateGenerationReasoning(
      (value as Readonly<Record<string, unknown>>).generationReasoning,
      record.modelCallCount,
    ),
  };
}

/** Names the page a model-requested tool reads, so a failing call shows its target in logs and records. */
function modelToolInputSummary(
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
) {
  const url = typeof input?.url === "string" ? input.url.trim() : "";
  return url
    ? `Model requested ${toolName} for ${url.slice(0, 512)}.`
    : `Model requested ${toolName}.`;
}

/** Builds the generation's tool requests, each linked to the attempt whose result requested it. */
export function runtimeModelToolRequests(
  input: AgentRunInput,
  result: RuntimeModelGenerationResult,
  tools: readonly RuntimeToolDefinition[],
  requester: Required<RuntimeRequestingModelGeneration>,
): readonly RuntimeToolRequest[] {
  const { modelAttemptId, modelCallIndex } = requester;
  const calls = result.toolCalls ?? [];
  if (calls.length === 0) return [];
  if (calls.length > MAX_MODEL_TOOL_CALLS_PER_GENERATION) {
    throw new Error(
      `Agent runtime accepts at most ${MAX_MODEL_TOOL_CALLS_PER_GENERATION} model-native tool calls per generation.`,
    );
  }
  const toolByName = new Map(tools.map((tool) => [tool.toolName, tool] as const));
  return calls.map((call, index) => {
    const definition = toolByName.get(call.toolName);
    if (!definition) throw new Error(`Model requested unavailable runtime tool ${call.toolName}.`);
    const callIdBytes = new TextEncoder().encode(call.modelToolCallId).byteLength;
    if (!call.modelToolCallId.trim() || callIdBytes > MAX_MODEL_TOOL_CALL_ID_BYTES) {
      throw new Error(
        `Model tool call identifiers must contain 1 to ${MAX_MODEL_TOOL_CALL_ID_BYTES} UTF-8 bytes.`,
      );
    }
    const toolInput = canonicalToolInput(call.input);
    if (!modelToolInputValidator(definition)(toolInput ?? {})) {
      throw new Error(
        `Runtime model tool ${call.toolName} input does not match its code-owned schema.`,
      );
    }
    return {
      effect: definition.effect,
      idempotencyKey: modelToolIdempotencyKey(input.runId, modelCallIndex, index),
      ...(toolInput ? { input: toolInput } : {}),
      inputSummary: modelToolInputSummary(call.toolName, toolInput),
      modelAttemptId,
      modelCallIndex,
      requiredScopes: definition.requiredScopes,
      toolName: call.toolName,
    };
  });
}

export function captureMaximumBytes(value: number | undefined): number {
  const maximumBytes = value ?? DEFAULT_CAPTURE_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_CAPTURE_BYTES
  ) {
    throw new Error(
      `Sandbox capture maximum size must be an integer from 1 to ${MAX_CAPTURE_BYTES} bytes.`,
    );
  }
  return maximumBytes;
}

export function sandboxReservation(
  field: "minMemoryMiB" | "minVcpu",
  value: number | undefined,
  maximum: number,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(
      `Sandbox ${field} must be a positive finite number no greater than ${maximum}.`,
    );
  }
}

export async function sandboxArtifacts(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  plan: RuntimeSandboxPlan,
  artifactIndexOffset: number,
  state: RuntimeExecutionState,
): Promise<readonly RuntimeArtifact[]> {
  if (plan.commands.length === 0) return [];
  const provider = plan.provider!;
  if (
    artifactIndexOffset + state.transientArtifacts.length + plan.requestedCaptureCount >
    MAX_CAPTURE_COUNT
  ) {
    throw new Error(`Sandbox capture count exceeds the per-run limit of ${MAX_CAPTURE_COUNT}.`);
  }

  await throwIfCanceled(input, dependencies, "sandbox provisioning");
  await appendProgress(input, dependencies, {
    eventType: "sandbox.provisioning-started",
    level: "info",
    message: "Sandbox provisioning started.",
  });
  let lease: SandboxLease;
  try {
    lease = await provider.create({
      allocationId: input.runId,
      ...agentRunSandboxOwner(input),
      environmentId: input.environmentId,
      isolationMode: "run-ephemeral",
      organizationId: input.organizationId,
      observability: {
        captureMode: input.captureMode,
        ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
        runSpanId: input.spanId,
        sessionId: input.threadId,
        traceId: input.traceId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
      projectId: input.projectId,
      runId: input.runId,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.sandboxPolicy.accessPolicyRef
        ? { accessPolicyRef: input.sandboxPolicy.accessPolicyRef }
        : {}),
      ...(input.sandboxPolicy.imageRef ? { imageRef: input.sandboxPolicy.imageRef } : {}),
      ...(input.sandboxPolicy.minMemoryMiB !== undefined
        ? { minMemoryMiB: input.sandboxPolicy.minMemoryMiB }
        : {}),
      ...(input.sandboxPolicy.minVcpu !== undefined
        ? { minVcpu: input.sandboxPolicy.minVcpu }
        : {}),
      ...(input.sandboxPolicy.poolKey ? { poolKey: input.sandboxPolicy.poolKey } : {}),
    });
  } catch (cause) {
    if (
      cause instanceof SandboxAllocationLeaseError ||
      cause instanceof SandboxAllocationCleanupError ||
      cause instanceof SandboxAllocationUnknownError
    ) {
      await handleSandboxAllocationFailure(input, dependencies, provider, cause);
    }
    throw cause;
  }
  const artifacts: RuntimeArtifact[] = [];
  let capturedBytes = state.artifactBytes + transientArtifactBytes(state);
  let executionError: unknown;
  let leaseCreationRecorded = false;
  let leaseIdentityValidated = false;
  try {
    assertSandboxLeaseIdentity(input, lease);
    leaseIdentityValidated = true;
    assertSandboxLeaseReady(input, lease, now(dependencies));
    await dependencies.recordSandboxLease!({
      context: progressContext(input),
      lease,
      phase: "created",
    });
    leaseCreationRecorded = true;
    await appendProgress(input, dependencies, {
      eventType: "sandbox.ready",
      level: "info",
      message: "Sandbox is ready.",
      metadata: { provider: lease.provider },
    });
    for (const [index, command] of plan.commands.entries()) {
      await throwIfCanceled(input, dependencies, `sandbox command ${index + 1}`);
      const label = command.label ?? `Sandbox command ${index + 1}`;
      await appendProgress(input, dependencies, {
        eventType: "sandbox.command.started",
        level: "info",
        message: `${label} started.`,
        metadata: { commandIndex: index },
      });
      const result = await provider.exec({
        command: command.command,
        lease,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(command.cwd ? { cwd: command.cwd } : {}),
        ...(command.env ? { env: command.env } : {}),
        ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
      });
      if (isAsyncExecResult(result)) throw new RuntimeAsyncSandboxCommandError(result.operationId);
      if (command.captureOutput) {
        const artifact = commandArtifact(command, index, result);
        capturedBytes += new TextEncoder().encode(String(artifact.content)).byteLength;
        if (capturedBytes > MAX_TOTAL_CAPTURE_BYTES) {
          throw new Error("Sandbox captures exceed the per-run total byte limit.");
        }
        artifacts.push(artifact);
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `${label} failed with exit code ${result.exitCode}: ${boundedRuntimeError(result.stderr, "Sandbox command failed")}`,
        );
      }
      for (const capture of command.captureFiles ?? []) {
        const remainingBytes = MAX_TOTAL_CAPTURE_BYTES - capturedBytes;
        if (remainingBytes <= 0) {
          throw new Error("Sandbox captures exceed the per-run total byte limit.");
        }
        const maximumBytes = Math.min(captureMaximumBytes(capture.maxBytes), remainingBytes);
        const body = await readBoundedStream(
          await provider.download({
            lease,
            path: capture.path,
            ...(input.signal ? { signal: input.signal } : {}),
          }),
          maximumBytes,
          capture.path,
        );
        capturedBytes += body.byteLength;
        const artifact: RuntimeArtifact = {
          content: body,
          ...(capture.contentType ? { contentType: capture.contentType } : {}),
          fileName: capture.fileName ?? capture.path.split("/").at(-1) ?? `artifact-${index + 1}`,
          label: capture.label ?? capture.path,
          metadata: { path: capture.path },
          type: "generated_file",
        };
        artifacts.push(artifact);
      }
      await appendProgress(input, dependencies, {
        eventType: "sandbox.command.completed",
        level: "info",
        message: `${label} completed.`,
        metadata: { commandIndex: index, durationMs: result.durationMs },
      });
    }
  } catch (cause) {
    executionError = cause;
  }

  if (!leaseIdentityValidated) {
    const mismatchError = executionError ?? new Error("Sandbox lease validation failed.");
    try {
      await dependencies.reportSandboxLeaseMismatch!({
        expected: executionContext(input),
        lease,
      });
    } catch (reportCause) {
      throw new AggregateError(
        [mismatchError, reportCause],
        "Sandbox lease mismatch reporting failed.",
      );
    }
    throw mismatchError;
  }

  let cleanupCompletedAt: number | undefined;
  let cleanupError: unknown;
  try {
    await provider.destroy({ lease });
    cleanupCompletedAt = now(dependencies);
    const destroyed = { ...lease, status: "destroyed" as const };
    await dependencies.recordSandboxLease!({
      context: progressContext(input),
      lease: destroyed,
      phase: "destroyed",
    });
    await appendProgress(input, dependencies, {
      eventType: "sandbox.destroyed",
      level: "info",
      message: "Sandbox was destroyed.",
      metadata: { provider: lease.provider },
    });
  } catch (cause) {
    if (cleanupCompletedAt === undefined) {
      const failures: unknown[] = [cause];
      if (!leaseCreationRecorded) {
        try {
          if (!dependencies.recordSandboxAllocationRecovery) {
            throw new Error("Sandbox allocation recovery persistence is not configured.");
          }
          await dependencies.recordSandboxAllocationRecovery({
            ...progressContext(input),
            identityVerified: true,
            kind: "lease",
            lease,
            provider: provider.name,
          });
        } catch (recoveryCause) {
          failures.push(recoveryCause);
        }
      }
      cleanupError =
        failures.length === 1
          ? cause
          : new AggregateError(failures, "Live sandbox lease recovery persistence failed.");
    } else {
      const failures: unknown[] = [cause];
      try {
        if (!dependencies.recordSandboxAllocationRecovery) {
          throw new Error("Sandbox allocation recovery persistence is not configured.");
        }
        await dependencies.recordSandboxAllocationRecovery({
          ...progressContext(input),
          cleanupCompletedAt,
          identityVerified: true,
          kind: "lease",
          lease,
          provider: provider.name,
        });
      } catch (recoveryCause) {
        failures.push(recoveryCause);
      }
      cleanupError =
        failures.length === 1
          ? cause
          : new AggregateError(failures, "Destroyed sandbox lease recovery persistence failed.");
    }
  }

  let artifactError: unknown;
  if (executionError !== undefined || cleanupError !== undefined) {
    const pendingPublicationCount = state.pendingArtifactPublicationIndexes.length;
    try {
      await recordArtifacts(
        input,
        dependencies,
        artifacts,
        artifactIndexOffset,
        (artifact, index, publicationPending) => {
          state.artifacts.push(artifact);
          state.artifactBytes += runtimeArtifactBytes(artifact);
          state.artifactIndexCursor += 1;
          if (publicationPending) state.pendingArtifactPublicationIndexes.push(index);
        },
        { continueAfterPersistedPublicationFailure: true },
      );
    } catch (cause) {
      artifactError = cause;
    }
    state.sandboxCompleted = true;
    state.sandboxFailureMessage = boundedSandboxFailureMessage(
      [
        executionError === undefined
          ? undefined
          : `Sandbox execution failed: ${boundedRuntimeError(executionError, "Sandbox execution failed.")}`,
        cleanupError === undefined
          ? undefined
          : `Sandbox cleanup failed: ${boundedRuntimeError(cleanupError, "Sandbox cleanup failed.")}`,
        artifactError === undefined
          ? undefined
          : `Sandbox artifact handling failed: ${boundedRuntimeError(artifactError, "Sandbox artifact handling failed.")}`,
      ].filter((message): message is string => message !== undefined),
    );
    if (state.pendingArtifactPublicationIndexes.length > pendingPublicationCount) {
      throw new RuntimeArtifactPublicationError(
        "Sandbox failed after artifacts were persisted without stream publication.",
        {
          artifactPersisted: true,
          cause: new AggregateError(
            [executionError, cleanupError, artifactError].filter(
              (failure) => failure !== undefined,
            ),
          ),
        },
      );
    }
    if (artifactError !== undefined) {
      throw new RuntimeArtifactPersistenceError(state.sandboxFailureMessage, {
        cause: new AggregateError(
          [executionError, cleanupError, artifactError].filter((failure) => failure !== undefined),
        ),
      });
    }
  }
  const failures = [executionError, cleanupError, artifactError].filter(
    (failure) => failure !== undefined,
  );
  if (failures.length > 1) {
    throw new AggregateError(failures, "Sandbox execution and cleanup failed.");
  }
  if (executionError !== undefined) throw executionError;
  if (cleanupError !== undefined) throw cleanupError;
  return artifacts;
}
