import { failureChain } from "./failure-log.ts";
import { Ulid } from "@deployments-ai/db";
import { SpanId, TraceId } from "@deployments-ai/observability";
import { Schema } from "effect";
import { processAgentRun } from "./agent-run.ts";
import { hasControlCharacter } from "./control-characters.ts";
import type {
  AgentRunQueueMessage,
  AgentRunQueueDelivery,
  AgentRunWorkerDependencies,
  ProcessAgentRunResult,
} from "./types.ts";
import { agentRunQueueMessageGroupId, agentRunRecoveryQueueMessageGroupId } from "./types.ts";
import {
  EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON,
  THREAD_CONTINUITY_RECOVERY_REASON,
} from "./types.ts";

export { agentRunQueueMessageGroupId } from "./types.ts";

/** One received SQS FIFO message of the agent-run queue. */
export interface QueueRecord extends AgentRunQueueDelivery {
  readonly body: string;
  readonly messageGroupId?: string;
}

/**
 * Outcome of one delivery: `processed` must be deleted from the queue; `returned` was handed back
 * with a visibility reset (or, without a retry port, is left to its visibility timeout).
 */
export type AgentRunQueueDisposition = "processed" | "returned";

const ACTIVE_CLAIM_RETRY_AFTER_SECONDS = 60;
const MAX_QUEUE_IDEMPOTENCY_KEY_BYTES = 256;
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent run queue body must be a JSON object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(input: Readonly<Record<string, unknown>>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Agent run queue ${field} is required.`);
  return value.trim();
}

function ulid(input: Readonly<Record<string, unknown>>, field: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(text(input, field));
  } catch (cause) {
    throw new Error(`Agent run queue ${field} must be a canonical ULID.`, { cause });
  }
}

function traceId(input: Readonly<Record<string, unknown>>): TraceId {
  try {
    return Schema.decodeUnknownSync(TraceId)(text(input, "traceId"));
  } catch (cause) {
    throw new Error("Agent run queue traceId must be a W3C trace identifier.", { cause });
  }
}

function spanId(input: Readonly<Record<string, unknown>>): SpanId {
  try {
    return Schema.decodeUnknownSync(SpanId)(text(input, "spanId"));
  } catch (cause) {
    throw new Error("Agent run queue spanId must be a W3C span identifier.", { cause });
  }
}

function idempotencyKey(input: Readonly<Record<string, unknown>>): string {
  const value = text(input, "idempotencyKey");
  if (
    new TextEncoder().encode(value).length > MAX_QUEUE_IDEMPOTENCY_KEY_BYTES ||
    hasControlCharacter(value)
  ) {
    throw new Error(
      `Agent run queue idempotencyKey must contain at most ${MAX_QUEUE_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes without control characters.`,
    );
  }
  return value;
}

function messageSequence(input: Readonly<Record<string, unknown>>): number {
  const value = input.userMessageSequence;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Agent run queue userMessageSequence must be a non-negative safe integer.");
  }
  return Number(value);
}

function recoveryReason(input: Readonly<Record<string, unknown>>) {
  const value = input.recoveryReason;
  if (value === undefined) return undefined;
  if (
    value !== EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON &&
    value !== THREAD_CONTINUITY_RECOVERY_REASON
  ) {
    throw new Error("Agent run queue recoveryReason is invalid.");
  }
  return value;
}

export function parseAgentRunQueueMessage(body: string): AgentRunQueueMessage {
  const input = record(JSON.parse(body) as unknown);
  const recovery = recoveryReason(input);
  return {
    environmentId: ulid(input, "environmentId"),
    idempotencyKey: idempotencyKey(input),
    organizationId: ulid(input, "organizationId"),
    projectId: ulid(input, "projectId"),
    ...(recovery ? { recoveryReason: recovery } : {}),
    runId: ulid(input, "runId"),
    spanId: spanId(input),
    threadId: ulid(input, "threadId"),
    traceId: traceId(input),
    userMessageId: ulid(input, "userMessageId"),
    userMessageSequence: messageSequence(input),
  };
}

export async function processAgentRunQueueRecord(
  record: QueueRecord,
  dependencies: AgentRunWorkerDependencies,
): Promise<ProcessAgentRunResult> {
  return processAgentRun(parseAgentRunQueueMessage(record.body), dependencies, {
    messageId: record.messageId,
    receiptHandle: record.receiptHandle,
    ...(record.receiveCount === undefined ? {} : { receiveCount: record.receiveCount }),
  });
}

function validQueueMessage(record: QueueRecord): AgentRunQueueMessage | undefined {
  if (!record.messageGroupId) return undefined;
  try {
    const message = parseAgentRunQueueMessage(record.body);
    return record.messageGroupId === agentRunQueueMessageGroupId(message) ||
      record.messageGroupId === agentRunRecoveryQueueMessageGroupId(message)
      ? message
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Processes one delivery of the agent-run FIFO queue. A malformed record, a requeue outcome, a
 * deferral at the organization's concurrent-run limit, a failure, or a draining host hands the
 * record back with a visibility reset; SQS keeps the rest of its message group behind it, so FIFO
 * order holds on redelivery.
 */
export async function processAgentRunQueueDelivery(
  record: QueueRecord,
  dependencies: AgentRunWorkerDependencies,
  draining: () => boolean = () => false,
): Promise<AgentRunQueueDisposition> {
  const message = validQueueMessage(record);
  const handBack = async (retryAfterSeconds: number): Promise<AgentRunQueueDisposition> => {
    try {
      await dependencies.retryQueueMessage?.(record, message, retryAfterSeconds);
    } catch (cause) {
      await dependencies.reportQueueVisibilityFailure?.(record, message, cause);
    }
    return "returned";
  };
  if (draining()) {
    console.info("Agent run queue record handed back; the worker host is draining.", {
      messageId: record.messageId,
      runId: message?.runId,
    });
    return handBack(0);
  }
  if (!message) return handBack(ACTIVE_CLAIM_RETRY_AFTER_SECONDS);
  const startedAt = performance.now();
  let retryAfterSeconds: number;
  try {
    const result = await processAgentRunQueueRecord(record, dependencies);
    // One line per delivery outcome. Reasons are fixed worker strings; a retryable failure adds its
    // error class, the bounded, redacted message the run already persists, and the class names
    // down its cause chain, never cause messages.
    const failure = result.action === "requeued" ? result.failure : undefined;
    (failure ? console.warn : console.info)("Agent run queue record processed.", {
      action: result.action,
      durationMs: Math.round(performance.now() - startedAt),
      ...(failure ? { failure } : {}),
      messageId: record.messageId,
      ...("reason" in result ? { reason: result.reason } : {}),
      receiveCount: record.receiveCount,
      runId: message.runId,
    });
    if (
      result.action === "completed" ||
      result.action === "paused" ||
      result.action === "skipped"
    ) {
      return "processed";
    }
    if (!dependencies.retryQueueMessage) {
      throw new Error("Retryable queue outcomes require a visibility reset dependency.");
    }
    retryAfterSeconds = result.retryAfterSeconds;
  } catch (error) {
    console.error("Agent run queue record failed; it will be retried.", {
      failure: failureChain(error),
      messageId: record.messageId,
      receiveCount: record.receiveCount,
      runId: message.runId,
    });
    retryAfterSeconds = ACTIVE_CLAIM_RETRY_AFTER_SECONDS;
  }
  return handBack(retryAfterSeconds);
}
