import { Ulid } from "@deployments-ai/db";
import { SpanId, TraceId } from "@deployments-ai/observability";
import { agentRunQueueMessageGroupId, type AgentRunQueueMessage } from "@deployments-ai/worker";
import { createSqsAgentRunQueueEnqueue } from "@deployments-ai/worker/sqs";
import { Schema } from "effect";

const RUN_QUEUE_URL_ENV = "DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL";

export interface RunRequestedEvent {
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly "detail-type"?: string;
}

type RunEnqueue = ReturnType<typeof createSqsAgentRunQueueEnqueue>;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function ulid(value: unknown, label: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(text(value, label));
  } catch (cause) {
    throw new Error(`${label} must be a canonical ULID.`, { cause });
  }
}

function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("run.requested userMessageSequence must be a non-negative safe integer.");
  }
  return Number(value);
}

function traceId(value: unknown): TraceId {
  try {
    return Schema.decodeUnknownSync(TraceId)(text(value, "run.requested traceId"));
  } catch (cause) {
    throw new Error("run.requested traceId must be a W3C trace identifier.", { cause });
  }
}

function spanId(value: unknown): SpanId {
  try {
    return Schema.decodeUnknownSync(SpanId)(text(value, "run.requested spanId"));
  } catch (cause) {
    throw new Error("run.requested spanId must be a W3C span identifier.", { cause });
  }
}

export function runQueueMessageFromEvent(event: RunRequestedEvent): AgentRunQueueMessage {
  const detail = record(event.detail, "run.requested detail");
  if (event["detail-type"] !== "run.requested" || detail.eventType !== "run.requested") {
    throw new Error("Run dispatcher accepts only run.requested semantic events.");
  }
  const payload = record(detail.payload, "run.requested payload");
  return {
    environmentId: ulid(detail.environmentId, "run.requested environmentId"),
    idempotencyKey: text(payload.idempotencyKey, "run.requested idempotencyKey"),
    organizationId: ulid(detail.organizationId, "run.requested organizationId"),
    projectId: ulid(detail.projectId, "run.requested projectId"),
    runId: ulid(
      payload.runId ?? detail.aggregateId,
      payload.runId === undefined ? "run.requested aggregateId" : "run.requested runId",
    ),
    spanId: spanId(payload.spanId),
    threadId: ulid(payload.threadId, "run.requested threadId"),
    traceId: traceId(payload.traceId),
    userMessageId: ulid(payload.userMessageId, "run.requested userMessageId"),
    userMessageSequence: sequence(payload.userMessageSequence),
  };
}

export function createRunRequestedHandler(enqueueRun: RunEnqueue) {
  return async (event: RunRequestedEvent) => {
    const message = runQueueMessageFromEvent(event);
    const payload = record(
      record(event.detail, "run.requested detail").payload,
      "run.requested payload",
    );
    const dispatchId =
      payload.dispatchId === undefined
        ? message.runId
        : ulid(payload.dispatchId, "run.requested dispatchId");
    await enqueueRun({
      deduplicationId: dispatchId,
      message,
      messageGroupId: agentRunQueueMessageGroupId(message),
    });
  };
}

let handlerPromise: Promise<ReturnType<typeof createRunRequestedHandler>> | undefined;

async function runtimeHandler() {
  const queueUrl = process.env[RUN_QUEUE_URL_ENV]?.trim();
  if (!queueUrl) throw new Error(`${RUN_QUEUE_URL_ENV} is required.`);
  return createRunRequestedHandler(createSqsAgentRunQueueEnqueue({ queueUrl }));
}

export async function handler(event: RunRequestedEvent) {
  const pending = (handlerPromise ??= runtimeHandler());
  try {
    return await (
      await pending
    )(event);
  } catch (cause) {
    if (handlerPromise === pending) handlerPromise = undefined;
    throw cause;
  }
}
