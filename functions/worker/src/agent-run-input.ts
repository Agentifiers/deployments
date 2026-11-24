/* eslint-disable no-await-in-loop -- Worker transitions and stream events are ordered side effects. */

import { agentManifestAllowsTrigger } from "@deployments-ai/agent-manifest";
import {
  conversationMessageIsNonReplayable,
  conversationMessageIsTransient,
} from "@deployments-ai/conversations";
import {
  type RuntimeCompletedToolCall,
  type RuntimeMemoryMode,
  type RuntimePendingAction,
  type RuntimeConversationMessage,
} from "@deployments-ai/agent-runtime";
import type { MemoryReviewMode } from "@deployments-ai/memory";
import { makeSemanticEventRecord } from "@deployments-ai/events";
import { createThreadStreamEvent, threadStreamEventJson } from "@deployments-ai/streaming";
import { Ulid, type PlatformRecord, type TransactionOperation } from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { AgentRunWorkerRecordError, messageCharacterUpperBound } from "./records.ts";
import { prefetch } from "./prefetch.ts";
import type {
  AgentDeploymentRecordValue,
  AgentReleaseRecordValue,
  AgentRunWorkerDependencies,
  MessageRecordValue,
  RunRecordValue,
  ThreadRecordValue,
} from "./types.ts";

export const TERMINAL_STATUSES = new Set(["canceled", "completed", "failed"]);
export const TERMINAL_PROGRESS_EVENT_TYPES = new Set([
  "run.canceled",
  "run.completed",
  "run.failed",
]);
/** A crashed worker's run becomes reclaimable within this window plus queue visibility. */
export const DEFAULT_RUNNING_CLAIM_TIMEOUT_MS = 3 * 60_000;
export const MAX_COMPLETION_ATTEMPTS = 32;
export const MAX_AGENT_RUN_ATTEMPTS = 30;
export const MAX_AGENT_RUN_CHECKPOINTS = 64;

/**
 * Checkpoint and shutdown-interruption requeues are planned progress (both advance
 * `checkpointCount`), so only the other claims burn retry attempts.
 */
export function agentRunRetryAttemptsExhausted(run: RunRecordValue): boolean {
  return run.data.attempt - (run.data.checkpointCount ?? 0) >= MAX_AGENT_RUN_ATTEMPTS;
}

export function agentRunRetryExhaustedError() {
  return new AgentRunWorkerRecordError(
    "run_retry_limit_exhausted",
    `Agent run failed after reaching the ${MAX_AGENT_RUN_ATTEMPTS}-attempt retry limit.`,
  );
}
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type RuntimeLeaseRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "runtime-lease" }
>;

export interface ClaimedRunState {
  readonly lease: RuntimeLeaseRecordValue;
  readonly run: RunRecordValue;
}

export interface CompletedRunPlan {
  readonly body: string;
  readonly bodyRef?: NonNullable<MessageRecordValue["data"]["bodyRef"]>;
  readonly completedToolCalls: readonly RuntimeCompletedToolCall[];
  readonly messageId: Ulid;
  readonly messageMetadata?: Readonly<Record<string, import("@deployments-ai/db").DynamoValue>>;
  readonly runEventId: Ulid;
  readonly streamEventId: Ulid;
  readonly threadEventId: Ulid;
  readonly timelineId: Ulid;
  readonly timestamp: Date;
  readonly usageOperations: readonly TransactionOperation[];
}

export interface CompletedToolCallPersistence {
  readonly events: readonly ReturnType<typeof makeSemanticEventRecord>[];
  readonly operations: readonly TransactionOperation[];
}

export type ReconcileCanceledRunClaim = (
  state: ClaimedRunState,
) => Promise<RunRecordValue | undefined>;

export type ReleaseRunClaim = <Result>(
  release: (state: ClaimedRunState) => Promise<Result>,
  reconcileCancellation?: ReconcileCanceledRunClaim,
) => Promise<Result>;

export type WithRunClaimSnapshot = <Result>(
  operation: (state: ClaimedRunState) => Promise<Result>,
) => Promise<Result>;

export type AcknowledgeExternalCancellation = () => Promise<RunRecordValue | undefined>;

export type ClaimedRunOutcome =
  | { readonly kind: "canceled"; readonly run: RunRecordValue }
  | {
      readonly kind: "completed";
      readonly contextCheckpointMode: "auto" | "off";
      readonly memoryMode: RuntimeMemoryMode;
      readonly memoryModelId: string;
      readonly memoryReviewMode?: MemoryReviewMode;
      readonly message: MessageRecordValue;
      readonly run: RunRecordValue;
    }
  | { readonly cause: unknown; readonly kind: "failed"; readonly run: RunRecordValue }
  | { readonly cause: unknown; readonly kind: "retryable"; readonly run: RunRecordValue }
  | { readonly kind: "checkpointed"; readonly run: RunRecordValue }
  | { readonly kind: "interrupted"; readonly run: RunRecordValue }
  | {
      readonly kind: "paused";
      readonly pendingAction: RuntimePendingAction;
      readonly run: RunRecordValue;
      readonly status: "waiting-for-approval" | "waiting-for-tool";
    };

export function inlineFinalizedMessageAppendBytes(input: {
  readonly body: string;
  readonly contentHash: string;
  readonly messageId: Ulid;
  readonly run: RunRecordValue;
  readonly streamEventId: Ulid;
  readonly timestamp: Date;
}): number {
  const event = createThreadStreamEvent({
    actor: { type: "agent" },
    environmentId: input.run.data.environmentId,
    eventId: input.streamEventId,
    eventType: "assistant-message.finalized",
    messageId: input.messageId,
    occurredAt: input.timestamp,
    organizationId: input.run.data.organizationId,
    payload: {
      body: input.body,
      contentHash: input.contentHash,
      sequence: Number.MAX_SAFE_INTEGER,
    },
    projectId: input.run.data.projectId,
    runId: input.run.data.id,
    threadId: input.run.data.threadId,
  });
  return new TextEncoder().encode(`[${threadStreamEventJson(event)}]`).byteLength;
}

export class AgentRunClaimActiveError extends Error {
  constructor(readonly runId: Ulid) {
    super(`Run ${runId} has an active claim and must be retried.`);
    this.name = "AgentRunClaimActiveError";
  }
}

export class CompletionNotCommittedError extends Error {
  constructor(readonly persistenceCause: unknown) {
    super("Agent run completion was confirmed not to have committed.");
    this.name = "CompletionNotCommittedError";
  }
}

export class ExternalCancellationReconciledError extends Error {
  constructor(readonly run: RunRecordValue) {
    super(`Externally canceled run ${run.data.id} was durably reconciled.`);
    this.name = "ExternalCancellationReconciledError";
  }
}

export class CodedRunFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodedRunFailure";
  }
}

export function now(dependencies: AgentRunWorkerDependencies): Date {
  return dependencies.now?.() ?? new Date();
}

export function stableCompletionMessageId(runId: Ulid): Ulid {
  const entropy = createHash("sha256")
    .update(`deployments-ai:assistant-message:${runId}`)
    .digest()
    .subarray(0, 10);
  let value = 0n;
  for (const byte of entropy) value = (value << 8n) | BigInt(byte);
  let encodedEntropy = "";
  for (let index = 0; index < 16; index += 1) {
    encodedEntropy = CROCKFORD_BASE32[Number(value & 31n)]! + encodedEntropy;
    value >>= 5n;
  }
  return Schema.decodeUnknownSync(Ulid)(`${runId.slice(0, 10)}${encodedEntropy}`);
}

export function metadata(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

export function pendingActionCorrelation(action: RuntimePendingAction) {
  return {
    kind: action.kind,
    toolCallId: action.toolCallId,
    toolName: action.toolName,
    ...(action.kind === "approval"
      ? { approvalId: action.approvalId }
      : { externalOperationId: action.externalOperationId }),
  };
}

async function messageBody(
  message: MessageRecordValue,
  dependencies: AgentRunWorkerDependencies,
  signal: AbortSignal | undefined,
  unavailableCode: "message_body_unavailable" | "prompt_body_unavailable",
): Promise<string> {
  if (message.data.body !== undefined) return message.data.body;
  if (!message.data.bodyRef || !dependencies.readMessageBody) {
    throw new AgentRunWorkerRecordError(
      unavailableCode,
      unavailableCode === "prompt_body_unavailable"
        ? "Prompt body is not available to the worker."
        : `Message ${message.data.id} body is not available to the worker.`,
    );
  }
  return dependencies.readMessageBody(message, signal);
}

const MAX_CONCURRENT_HISTORY_BODY_READS = 8;

export async function boundedRecentMessages(
  messages: readonly MessageRecordValue[],
  maximumCharacters: number,
  dependencies: AgentRunWorkerDependencies,
  signal?: AbortSignal,
  checkpoint?: {
    readonly threadId: Ulid;
    readonly throughMessageCharacterOffset?: number | undefined;
    readonly throughSequence: number;
  },
): Promise<readonly RuntimeConversationMessage[]> {
  const selected: RuntimeConversationMessage[] = [];
  let remaining = maximumCharacters;
  // The loader orders validated predecessor threads before the current thread. Sequence
  // numbers are local to each thread and must never reorder one lineage segment over another.
  const candidates = messages.filter(
    (message) =>
      !conversationMessageIsTransient(message.data.metadata) &&
      !conversationMessageIsNonReplayable(message.data.metadata),
  );
  let next = candidates.length - 1;
  while (next >= 0) {
    const wave: MessageRecordValue[] = [];
    let estimated = 0;
    let reads = 0;
    do {
      const message = candidates[next]!;
      next -= 1;
      wave.push(message);
      if (message.data.body === undefined) reads += 1;
      estimated += messageCharacterUpperBound(message) ?? Number.POSITIVE_INFINITY;
    } while (next >= 0 && estimated < remaining && reads < MAX_CONCURRENT_HISTORY_BODY_READS);
    const waveReads = new AbortController();
    const readSignal = signal ? AbortSignal.any([signal, waveReads.signal]) : waveReads.signal;
    const bodies = wave.map((message) =>
      prefetch(messageBody(message, dependencies, readSignal, "message_body_unavailable")),
    );
    try {
      for (const [index, message] of wave.entries()) {
        const body = await bodies[index]!;
        // A partial checkpoint has already summarized the leading portion of one oversized message.
        // Continue from that offset while still allowing fully covered recent messages to overlap the
        // checkpoint as exact conversation history.
        const content =
          checkpoint?.throughMessageCharacterOffset !== undefined &&
          message.data.threadId === checkpoint.threadId &&
          message.data.sequence === checkpoint.throughSequence
            ? body.slice(checkpoint.throughMessageCharacterOffset)
            : body;
        if (!content) continue;
        if (content.length > remaining) {
          if (selected.length === 0) {
            selected.unshift({
              content: content.slice(0, remaining),
              createdAt: message.data.createdAt,
              messageId: message.data.id,
              ...(message.data.inputArtifacts
                ? { inputArtifacts: message.data.inputArtifacts, threadId: message.data.threadId }
                : {}),
              role: message.data.role,
              sequence: message.data.sequence,
            });
          }
          return selected;
        }
        selected.unshift({
          content,
          createdAt: message.data.createdAt,
          messageId: message.data.id,
          ...(message.data.inputArtifacts
            ? { inputArtifacts: message.data.inputArtifacts, threadId: message.data.threadId }
            : {}),
          role: message.data.role,
          sequence: message.data.sequence,
        });
        remaining -= content.length;
        if (remaining === 0) return selected;
      }
    } finally {
      waveReads.abort();
    }
  }
  return selected;
}

export function validatePins(
  run: RunRecordValue,
  thread: ThreadRecordValue,
  deployment: AgentDeploymentRecordValue,
  release: AgentReleaseRecordValue,
): void {
  validateThreadPin(run, thread);
  const runScope = {
    environmentId: run.data.environmentId,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
  };
  for (const [label, record] of [
    ["Agent deployment", deployment],
    ["Agent release", release],
  ] as const) {
    if (
      record.data.organizationId !== runScope.organizationId ||
      record.data.projectId !== runScope.projectId ||
      record.data.environmentId !== runScope.environmentId
    ) {
      throw new AgentRunWorkerRecordError(
        "pinned_scope_mismatch",
        `${label} scope does not match the run scope.`,
      );
    }
  }
  // A run keeps the release it was admitted with. Retargets, canary promotion, and canary abort
  // move the deployment's selectable releases forward without invalidating in-flight runs.
  if (
    deployment.data.id !== run.data.agentDeploymentId ||
    release.data.id !== run.data.agentReleaseId ||
    deployment.data.agentDefinitionId !== release.data.agentDefinitionId
  ) {
    throw new AgentRunWorkerRecordError(
      "release_pin_mismatch",
      "Run, deployment, and release pins are inconsistent.",
    );
  }
  if (deployment.data.currentState !== "ready" || deployment.data.desiredState !== "running") {
    throw new AgentRunWorkerRecordError(
      "deployment_not_ready",
      "Agent deployment is not ready for execution.",
    );
  }
  if (release.data.status !== "active") {
    throw new AgentRunWorkerRecordError(
      "release_not_active",
      "Pinned agent release is not active.",
    );
  }
  if (!agentManifestAllowsTrigger(release.data.manifest, run.data.trigger)) {
    throw new AgentRunWorkerRecordError(
      "trigger_not_allowed",
      `Pinned agent release does not allow the ${run.data.trigger} trigger.`,
    );
  }
}

export function validateThreadPin(run: RunRecordValue, thread: ThreadRecordValue): void {
  if (thread.data.archived) {
    throw new AgentRunWorkerRecordError(
      "thread_archived",
      "Archived threads cannot execute agent runs.",
    );
  }
  if (
    thread.data.organizationId !== run.data.organizationId ||
    thread.data.projectId !== run.data.projectId ||
    thread.data.environmentId !== run.data.environmentId
  ) {
    throw new AgentRunWorkerRecordError(
      "pinned_scope_mismatch",
      "Thread scope does not match the run scope.",
    );
  }
  if (thread.data.workspaceId !== run.data.workspaceId) {
    throw new AgentRunWorkerRecordError(
      "pinned_workspace_mismatch",
      "Thread workspace scope does not match the run workspace scope.",
    );
  }
  if (
    thread.data.agentDeploymentId !== run.data.agentDeploymentId &&
    run.data.parentSpanId === undefined
  ) {
    throw new AgentRunWorkerRecordError(
      "thread_deployment_mismatch",
      "Thread and run deployment pins differ.",
    );
  }
}

export async function selectedPrompt(
  trigger: MessageRecordValue,
  dependencies: AgentRunWorkerDependencies,
  signal?: AbortSignal,
): Promise<string> {
  const body = await messageBody(trigger, dependencies, signal, "prompt_body_unavailable");
  if (!body) {
    throw new AgentRunWorkerRecordError(
      "prompt_body_unavailable",
      "Prompt body must not be empty.",
    );
  }
  return body;
}

export function assertPromptBinding(
  selected: MessageRecordValue | undefined,
  requestedId: Ulid,
  run: RunRecordValue,
): asserts selected is MessageRecordValue {
  if (!selected || selected.data.id !== requestedId || selected.data.role !== "user") {
    throw new AgentRunWorkerRecordError(
      "prompt_message_not_found",
      "Run user message was not found.",
    );
  }
  if (
    selected.data.runId !== run.data.id ||
    selected.data.agentDeploymentId !== run.data.agentDeploymentId
  ) {
    throw new AgentRunWorkerRecordError(
      "prompt_message_not_bound",
      "Run user message is not bound to the run and deployment.",
    );
  }
}

export function permanentTriggerBindingError(cause: unknown): cause is AgentRunWorkerRecordError {
  return (
    cause instanceof AgentRunWorkerRecordError &&
    [
      "prompt_message_not_bound",
      "prompt_message_not_found",
      "trigger_message_scope_mismatch",
    ].includes(cause.code)
  );
}
