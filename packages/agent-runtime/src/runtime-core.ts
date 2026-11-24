/* eslint-disable no-await-in-loop -- Runtime side effects must preserve agent-request order. */

import {
  AgentResponseDepthPolicy,
  AgentInputArtifacts,
  AgentResponseFormat,
  MAX_AGENT_MODEL_FALLBACKS,
  MAX_AGENT_TOOL_CALLS,
  MAX_AGENT_TOOL_IDEMPOTENCY_KEY_CHARACTERS,
  MAX_AGENT_TOOL_REQUESTS,
} from "@deployments-ai/agent-manifest";
import { MAX_GENERATION_REASONING_BYTES, Ulid } from "@deployments-ai/db";
import { Buffer } from "node:buffer";
import { Schema } from "effect";
import { RuntimeRunCanceledError } from "./errors.ts";
import { agentRunExecutionPins } from "./execution-pins.ts";
import { boundedRuntimeError } from "./redaction.ts";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeDependencies,
  RuntimeArtifact,
  RuntimeBrainEvidenceContextItem,
  RuntimeCompletedToolCall,
  RuntimeGenerationReasoning,
  RuntimeMemoryContextItem,
  RuntimePendingAction,
  RuntimeProgressEvent,
  RuntimeToolExecutionBinding,
  RuntimeToolRequest,
  RuntimeUsageEntry,
} from "./types.ts";

export const DEFAULT_CAPTURE_BYTES = 5 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
export const MAX_CAPTURE_COUNT = 32;
export const MAX_COMMAND_OUTPUT_CHARACTERS = 1024 * 1024;
export const MAX_TOTAL_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_EXTERNAL_OPERATION_ID_BYTES = 512;
const MAX_MODEL_ATTEMPTS = MAX_AGENT_MODEL_FALLBACKS + 1;
export const MAX_TOOL_IDEMPOTENCY_KEY_CHARACTERS = MAX_AGENT_TOOL_IDEMPOTENCY_KEY_CHARACTERS;
const MAX_TOOL_INPUT_BYTES = 128 * 1024;
export const MAX_RUNTIME_TOOL_PERSISTENCE_BYTES = 1024 * 1024;
// A run can accumulate more tools across durable continuations than one terminal transaction can
// create. The completed-run transaction reserves 27 expanded operations for terminal state,
// channel delivery, semantic events, and tenant fences. Each newly completed tool expands to four
// operations, one additional predecessor check is reserved for a continued pending tool, and
// terminally unpersisted usage entries expand to two operations apiece. Across executions a run
// holds its release-pinned tool requests plus at most the hard ceiling of model-generated calls.
export const MAX_RUNTIME_TOOL_REQUESTS = MAX_AGENT_TOOL_REQUESTS + MAX_AGENT_TOOL_CALLS;
export const MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS = 17;
const MAX_COMPLETED_RUN_FIXED_OPERATIONS = 27;
const MAX_CONTINUED_RUN_FIXED_OPERATIONS = 19;
const MAX_COMPLETED_TOOL_OPERATIONS = 4;
const MAX_CONTINUED_TOOL_PREDECESSOR_OPERATIONS = 1;
const MAX_RUNTIME_USAGE_OPERATIONS = 2;
const MAX_GENERATION_REASONING_OPERATIONS = 2;
const DYNAMODB_TRANSACTION_OPERATION_LIMIT = 100;
export const MAX_UNPERSISTED_REASONING_BYTES = 224 * 1024;
const textEncoder = new TextEncoder();

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function boundedExternalOperationId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Asynchronous tool execution did not include an externalOperationId.");
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.startsWith("unknown:") ||
    hasControlCharacter(value) ||
    new TextEncoder().encode(normalized).byteLength > MAX_EXTERNAL_OPERATION_ID_BYTES
  ) {
    throw new Error(
      `Asynchronous tool externalOperationId must contain at most ${MAX_EXTERNAL_OPERATION_ID_BYTES} UTF-8 bytes without control characters and must not use the reserved unknown: prefix.`,
    );
  }
  return normalized;
}

export function recoveryExternalOperationId(toolCallId: string): string {
  return `unknown:${toolCallId}`;
}

export function canonicalToolInput(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (
      serialized === undefined ||
      new TextEncoder().encode(serialized).byteLength > MAX_TOOL_INPUT_BYTES
    ) {
      throw new Error("invalid tool input");
    }
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid tool input");
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new Error(
      `Runtime tool input must be JSON-compatible and at most ${MAX_TOOL_INPUT_BYTES} UTF-8 bytes.`,
    );
  }
}

export function toolPersistenceBytes(input: {
  readonly effect: RuntimeToolRequest["effect"];
  readonly idempotencyKey: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly inputSummary: string;
  readonly requiredScopes: readonly string[];
  readonly toolName: string;
}): number {
  return new TextEncoder().encode(JSON.stringify(input)).byteLength;
}

function configuredModelIds(input: AgentRunInput): readonly string[] {
  const modelIds = [
    ...new Set(
      [input.modelId, ...(input.modelFallbackIds ?? [])]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (modelIds.length === 0) throw new Error("Agent runtime requires at least one model.");
  if (modelIds.length > MAX_MODEL_ATTEMPTS) {
    throw new Error(`Agent runtime supports at most ${MAX_MODEL_ATTEMPTS} model attempts.`);
  }
  return modelIds;
}

export function configuredModelAttempts(input: AgentRunInput): readonly string[] {
  const modelIds = configuredModelIds(input);
  // A configured fallback is already the recovery path. Single-route agents get one bounded
  // redispatch so an unusable or transient provider response can cross the same durable
  // invocation-and-metering boundary as every other model attempt.
  return modelIds.length === 1 ? [modelIds[0]!, modelIds[0]!] : modelIds;
}

export function now(dependencies: AgentRuntimeDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

export function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export function progressContext(input: AgentRunInput) {
  return {
    ...agentRunExecutionPins(input),
    agentManifestHash: input.agentManifestHash,
    captureMode: input.captureMode,
    environmentId: input.environmentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    spanId: input.spanId,
    threadId: input.threadId,
    traceId: input.traceId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

export async function appendProgress(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  event: Omit<RuntimeProgressEvent, keyof ReturnType<typeof progressContext> | "occurredAt">,
): Promise<void> {
  if (!dependencies.appendProgress) return;
  try {
    await dependencies.appendProgress({
      ...progressContext(input),
      ...event,
      occurredAt: iso(now(dependencies)),
    });
  } catch {
    return;
  }
}

export async function throwIfCanceled(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  phase: string,
): Promise<void> {
  if (input.signal?.aborted || (await dependencies.shouldCancel?.(input.runId))) {
    throw new RuntimeRunCanceledError(phase);
  }
}

export async function isCanceled(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
): Promise<boolean> {
  return Boolean(input.signal?.aborted || (await dependencies.shouldCancel?.(input.runId)));
}

export function runtimeUsage(
  input: AgentRunInput,
  startedAt: number,
  completedAt: number,
  status: AgentRunResult["completionStatus"] | "failed",
): RuntimeUsageEntry {
  return {
    idempotencyKey: `${input.runId}:execution:${input.runExecutionVersion}:attempt:${input.runAttempt}:worker-ms:${status}`,
    occurredAt: completedAt,
    quantity: Math.max(0, completedAt - startedAt),
    runId: input.runId,
    source: "agent-runtime",
    startedAt,
    type: "worker_ms",
    unit: "ms",
  };
}

export function validateRunAttempt(input: AgentRunInput): void {
  if (!Number.isSafeInteger(input.runAttempt) || input.runAttempt < 0) {
    throw new Error("Agent runtime runAttempt must be a non-negative safe integer.");
  }
  for (const field of ["maxModelGenerations", "maxToolCalls"] as const) {
    const value = input[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`Agent runtime ${field} must be a positive safe integer.`);
    }
  }
  if ((input.toolRequests?.length ?? 0) > MAX_AGENT_TOOL_REQUESTS) {
    throw new Error(
      `Runtime tool request count exceeds the release-pinned limit of ${MAX_AGENT_TOOL_REQUESTS}.`,
    );
  }
  if (!Number.isSafeInteger(input.runExecutionVersion) || input.runExecutionVersion < 0) {
    throw new Error("Agent runtime runExecutionVersion must be a non-negative safe integer.");
  }
  if (input.responseDepthPolicy !== undefined) {
    Schema.decodeUnknownSync(AgentResponseDepthPolicy)(input.responseDepthPolicy);
  }
  if (input.responseFormat !== undefined)
    Schema.decodeUnknownSync(AgentResponseFormat)(input.responseFormat);
  if (input.inputMedia !== undefined)
    Schema.decodeUnknownSync(AgentInputArtifacts)(input.inputMedia.artifactIds);
}

export function pendingActionProgressMetadata(action: RuntimePendingAction) {
  return {
    kind: action.kind,
    toolCallId: action.toolCallId,
    toolName: action.toolName,
    ...(action.kind === "approval"
      ? { approvalId: action.approvalId }
      : { externalOperationId: action.externalOperationId }),
  };
}

export function executionContext(input: AgentRunInput) {
  return {
    ...progressContext(input),
    sandboxPolicy: input.sandboxPolicy,
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

async function recallMemories(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
): Promise<readonly RuntimeMemoryContextItem[]> {
  const explicit = input.relevantMemories ?? [];
  const memoryMode = input.memoryMode ?? "off";
  if (memoryMode === "off") return explicit;
  if (memoryMode === "workspace" && !input.workspaceId) {
    throw new Error("Runtime workspace memory mode requires a workspaceId.");
  }
  if (!dependencies.recallMemory) {
    throw new Error(`Runtime memory mode ${memoryMode} requires a recallMemory port.`);
  }

  await throwIfCanceled(input, dependencies, "memory recall");
  await appendProgress(input, dependencies, {
    eventType: "memory.recall.started",
    level: "info",
    message: "Runtime memory recall started.",
    metadata: { memoryMode },
  });
  let recalled: readonly RuntimeMemoryContextItem[];
  try {
    recalled = await dependencies.recallMemory({
      ...executionContext(input),
      memoryMode,
      prompt: input.prompt,
      recentMessages: input.recentMessages ?? [],
    });
  } catch (cause) {
    if (cause instanceof RuntimeRunCanceledError) throw cause;
    if (await isCanceled(input, dependencies)) {
      throw new RuntimeRunCanceledError("memory recall");
    }
    await appendProgress(input, dependencies, {
      eventType: "memory.recall.completed",
      level: "warn",
      message: "Runtime memory recall failed; continuing without recalled memory.",
      metadata: {
        degraded: true,
        error: boundedRuntimeError(cause, "Memory recall failed."),
        memoryMode,
        recalledCount: 0,
      },
    });
    return explicit;
  }
  await appendProgress(input, dependencies, {
    eventType: "memory.recall.completed",
    level: "info",
    message: "Runtime memory recall completed.",
    metadata: { recalledCount: recalled.length },
  });

  const byId = new Map(explicit.map((memory) => [memory.memoryId, memory]));
  for (const memory of recalled) byId.set(memory.memoryId, memory);
  return [...byId.values()];
}

export interface RuntimeKnowledgeContext {
  readonly brainEvidence: readonly RuntimeBrainEvidenceContextItem[];
  readonly memories: readonly RuntimeMemoryContextItem[];
}

export async function recallKnowledge(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
): Promise<RuntimeKnowledgeContext> {
  const memories = await recallMemories(input, dependencies);
  const brainRetrievalMode = input.brainRetrievalMode ?? "off";
  if (brainRetrievalMode === "off") return { brainEvidence: [], memories };
  if (!dependencies.recallBrain) {
    throw new Error(
      `Runtime Brain retrieval mode ${brainRetrievalMode} requires a recallBrain port.`,
    );
  }
  await throwIfCanceled(input, dependencies, "Brain evidence retrieval");
  await appendProgress(input, dependencies, {
    eventType: "brain.retrieval.started",
    level: "info",
    message: "Runtime Brain evidence retrieval started.",
    metadata: { brainRetrievalMode },
  });
  const recalled = await dependencies.recallBrain({
    ...executionContext(input),
    brainRetrievalMode,
    memories,
    prompt: input.prompt,
    recentMessages: input.recentMessages ?? [],
  });
  if (recalled.unmetEvidenceRequirement) {
    throw new Error(
      "The run requires live Brain evidence, but no authorized evidence is available.",
    );
  }
  const includeBrain = recalled.route === "brain" || recalled.route === "both";
  const includeMemory = recalled.route === "memory" || recalled.route === "both";
  if (!includeBrain && recalled.evidence.length > 0) {
    throw new Error("Brain retrieval returned evidence outside the selected retrieval route.");
  }
  await appendProgress(input, dependencies, {
    eventType: "brain.retrieval.completed",
    level: "info",
    message: "Runtime Brain evidence retrieval completed.",
    metadata: {
      evidenceCount: recalled.evidence.length,
      reasons: recalled.reasons,
      route: recalled.route,
    },
  });
  return {
    brainEvidence: includeBrain ? recalled.evidence : [],
    memories: includeMemory ? memories : [],
  };
}

export async function revalidateBrainEvidence(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  evidence: readonly RuntimeBrainEvidenceContextItem[],
) {
  if (evidence.length === 0) return evidence;
  if (!dependencies.revalidateBrainEvidence) {
    throw new Error("Runtime Brain evidence requires a live revalidation port.");
  }
  const current = await dependencies.revalidateBrainEvidence({
    ...executionContext(input),
    evidence,
  });
  const expected = evidence.map((item) =>
    [item.brainId, item.documentId, item.documentVersionId, item.renditionId, item.chunkId].join(
      ":",
    ),
  );
  const observed = current.map((item) =>
    [item.brainId, item.documentId, item.documentVersionId, item.renditionId, item.chunkId].join(
      ":",
    ),
  );
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error("Brain evidence changed or became inaccessible before model disclosure.");
  }
  return current;
}

export type ToolRequestResult =
  | {
      readonly status: "completed";
      readonly artifactBytes: number;
      readonly completed: readonly RuntimeCompletedToolCall[];
      readonly artifacts: readonly RuntimeArtifact[];
    }
  | {
      readonly status: "waiting-for-approval" | "waiting-for-tool";
      readonly artifactBytes: number;
      readonly assistantMessage: string;
      readonly completed: readonly RuntimeCompletedToolCall[];
      readonly artifacts: readonly RuntimeArtifact[];
      readonly pendingAction: RuntimePendingAction;
    };

export interface RuntimeExecutionState {
  artifactBytes: number;
  artifactIndexCursor: number;
  readonly artifacts: RuntimeArtifact[];
  readonly brainEvidence: RuntimeBrainEvidenceContextItem[];
  readonly completedToolCalls: RuntimeCompletedToolCall[];
  readonly generationReasoning: RuntimeGenerationReasoning[];
  modelId?: string;
  readonly pendingArtifactPublicationIndexes: number[];
  readonly persistedCompletedToolCallIds: ReadonlySet<string>;
  readonly persistedModelCallCount: number;
  readonly providerPersistedUsageIdempotencyKeys: Set<string>;
  readonly refreshedTransientToolCallIds: Set<string>;
  sandboxCompleted: boolean;
  sandboxFailureMessage?: string;
  readonly transientArtifacts: RuntimeArtifact[];
  readonly usage: RuntimeUsageEntry[];
}

type RuntimeTransactionCapacityState = Pick<
  RuntimeExecutionState,
  | "completedToolCalls"
  | "generationReasoning"
  | "persistedCompletedToolCallIds"
  | "persistedModelCallCount"
  | "providerPersistedUsageIdempotencyKeys"
  | "usage"
>;

interface RuntimeTransactionCapacityReservation {
  /** Tools a pending model generation may still add before the next persistence boundary. */
  readonly reservePendingTools?: number;
  readonly reserveUsageEntries?: number;
}

export function runtimeTransactionCapacityExceeded(
  state: RuntimeTransactionCapacityState,
  options: RuntimeTransactionCapacityReservation = {},
): boolean {
  const toolSlots =
    state.completedToolCalls.filter(
      (call) => !state.persistedCompletedToolCallIds.has(call.toolCallId),
    ).length + (options.reservePendingTools ?? 0);
  const usageSlots =
    state.usage.filter(
      (entry) => !state.providerPersistedUsageIdempotencyKeys.has(entry.idempotencyKey),
    ).length +
    (options.reserveUsageEntries ?? 0) +
    1;
  const pendingGenerations = (options.reservePendingTools ?? 0) > 0 ? 1 : 0;
  const unpersistedReasoning = state.generationReasoning.filter(
    (entry) => entry.modelCallIndex >= state.persistedModelCallCount,
  );
  const reasoningBytes = unpersistedReasoning.reduce(
    (total, entry) => total + textEncoder.encode(JSON.stringify(entry.details)).byteLength,
    pendingGenerations * MAX_GENERATION_REASONING_BYTES,
  );
  const toolAndUsageOperations =
    toolSlots * MAX_COMPLETED_TOOL_OPERATIONS +
    (toolSlots > 0 ? MAX_CONTINUED_TOOL_PREDECESSOR_OPERATIONS : 0) +
    usageSlots * MAX_RUNTIME_USAGE_OPERATIONS;
  const continuedOperationCount =
    MAX_CONTINUED_RUN_FIXED_OPERATIONS +
    toolAndUsageOperations +
    (unpersistedReasoning.length + pendingGenerations) * MAX_GENERATION_REASONING_OPERATIONS;
  return (
    toolSlots > MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS ||
    MAX_COMPLETED_RUN_FIXED_OPERATIONS + toolAndUsageOperations >
      DYNAMODB_TRANSACTION_OPERATION_LIMIT ||
    continuedOperationCount > DYNAMODB_TRANSACTION_OPERATION_LIMIT ||
    reasoningBytes > MAX_UNPERSISTED_REASONING_BYTES
  );
}

export function assertRuntimeTransactionCapacity(
  state: RuntimeTransactionCapacityState,
  options: RuntimeTransactionCapacityReservation = {},
) {
  if (runtimeTransactionCapacityExceeded(state, options)) {
    throw new Error(
      `Runtime model, tool, and usage effects exceed the terminal transaction capacity of ${DYNAMODB_TRANSACTION_OPERATION_LIMIT} operations.`,
    );
  }
}

export function runtimeArtifactBytes(artifact: RuntimeArtifact): number {
  return typeof artifact.content === "string"
    ? Buffer.byteLength(artifact.content, "utf8")
    : artifact.content.byteLength;
}

export function safeToolText(value: string, fallback: string): string {
  return boundedRuntimeError(value, fallback);
}

export function toolCorrelationId(
  value: unknown,
  field: "approvalId" | "connectionId" | "toolAdapterId" | "toolCallId",
): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new Error(`Tool policy ${field} must be a canonical ULID.`);
  }
}

export function toolApprovalDestinations(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((destination) => typeof destination === "string" && destination.trim() !== "")
  ) {
    throw new Error("Tool policy destinations must be a non-empty list of strings.");
  }
  return [...(value as readonly string[])];
}

export function toolExecutionBinding(value: unknown): RuntimeToolExecutionBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool policy executionBinding must be an object.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const connectionId = toolCorrelationId(record.connectionId, "connectionId");
  const toolAdapterId =
    record.toolAdapterId === undefined
      ? undefined
      : toolCorrelationId(record.toolAdapterId, "toolAdapterId");
  if (
    typeof record.externalAccountId !== "string" ||
    !record.externalAccountId.trim() ||
    hasControlCharacter(record.externalAccountId) ||
    new TextEncoder().encode(record.externalAccountId.trim()).byteLength > 2048
  ) {
    throw new Error(
      "Tool policy externalAccountId must contain at most 2048 UTF-8 bytes without control characters.",
    );
  }
  if (
    typeof record.authorizationFingerprint !== "string" ||
    !record.authorizationFingerprint.trim() ||
    hasControlCharacter(record.authorizationFingerprint) ||
    new TextEncoder().encode(record.authorizationFingerprint.trim()).byteLength > 512
  ) {
    throw new Error(
      "Tool policy authorizationFingerprint must contain at most 512 UTF-8 bytes without control characters.",
    );
  }
  if (
    record.toolPlanFingerprint !== undefined &&
    (typeof record.toolPlanFingerprint !== "string" ||
      !record.toolPlanFingerprint.trim() ||
      hasControlCharacter(record.toolPlanFingerprint) ||
      new TextEncoder().encode(record.toolPlanFingerprint.trim()).byteLength > 512)
  ) {
    throw new Error(
      "Tool policy toolPlanFingerprint must contain at most 512 UTF-8 bytes without control characters.",
    );
  }
  if (
    record.inputHash !== undefined &&
    (typeof record.inputHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.inputHash))
  ) {
    throw new Error("Tool policy inputHash must be a canonical SHA-256 digest.");
  }
  if (
    record.destinationsHash !== undefined &&
    (typeof record.destinationsHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(record.destinationsHash))
  ) {
    throw new Error("Tool policy destinationsHash must be a canonical SHA-256 digest.");
  }
  return {
    authorizationFingerprint: record.authorizationFingerprint.trim(),
    connectionId,
    ...(typeof record.destinationsHash === "string"
      ? { destinationsHash: record.destinationsHash }
      : {}),
    externalAccountId: record.externalAccountId.trim(),
    ...(typeof record.inputHash === "string" ? { inputHash: record.inputHash } : {}),
    ...(toolAdapterId ? { toolAdapterId } : {}),
    ...(typeof record.toolPlanFingerprint === "string"
      ? { toolPlanFingerprint: record.toolPlanFingerprint.trim() }
      : {}),
  };
}
