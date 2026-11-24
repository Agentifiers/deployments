import type { Ulid } from "@deployments-ai/db";
import { makeSemanticEventRecord, type SemanticEventRecordValue } from "@deployments-ai/events";
import { SELF_HOSTED_WEB_TOOL_NAMES } from "@deployments-ai/tools";
import {
  FIRECRAWL_OPERATIONS,
  SelfHostedWebToolError,
  type SelfHostedWebToolCallRecord,
} from "./config.ts";

function requireSelfHostedWebToolCall(
  toolCall: SelfHostedWebToolCallRecord,
  expectedStatus: SelfHostedWebToolCallRecord["data"]["status"],
) {
  if (!registeredNames.has(toolCall.data.toolName)) {
    throw new SelfHostedWebToolError(
      `Tool call ${toolCall.data.id} is not a self-hosted web tool call.`,
    );
  }
  if (toolCall.data.status !== expectedStatus) {
    throw new SelfHostedWebToolError(
      `Self-hosted web tool event requires status ${expectedStatus}.`,
    );
  }
}

function requireToolCallEventVersion(value: number, minimum: number) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new SelfHostedWebToolError(
      `toolCallEventVersion must be a safe integer at least ${minimum}.`,
    );
  }
  return value;
}

interface SelfHostedWebToolEventOptions {
  readonly eventId: Ulid;
  readonly occurredAt: string;
  readonly toolCall: SelfHostedWebToolCallRecord;
  readonly traceId?: string;
}

function eventScope(options: SelfHostedWebToolEventOptions) {
  return {
    environmentId: options.toolCall.data.environmentId,
    occurredAt: options.occurredAt,
    organizationId: options.toolCall.data.organizationId,
    projectId: options.toolCall.data.projectId,
    ...(options.traceId ? { traceId: options.traceId } : {}),
  } as const;
}

export function makeSelfHostedWebToolRequestedSemanticEvent(
  options: SelfHostedWebToolEventOptions,
): SemanticEventRecordValue {
  requireSelfHostedWebToolCall(options.toolCall, "pending");
  if (options.toolCall.data.version !== 1) {
    throw new SelfHostedWebToolError(
      "Self-hosted web tool requested events require a version-1 tool call.",
    );
  }
  return makeSemanticEventRecord({
    ...eventScope(options),
    aggregateId: options.toolCall.data.id,
    aggregateType: "tool-call",
    aggregateVersion: 1,
    eventId: options.eventId,
    eventType: "tool-call.requested",
    payload: {
      inputSummary: "Execute self-hosted web tool.",
      runId: options.toolCall.data.runId,
      status: options.toolCall.data.status,
      toolCallId: options.toolCall.data.id,
      toolCallRecordVersion: options.toolCall.data.version,
      toolName: options.toolCall.data.toolName,
    },
  });
}

export function makeSelfHostedWebToolCompletedSemanticEvent(
  options: SelfHostedWebToolEventOptions & {
    readonly toolCallEventVersion: number;
  },
): SemanticEventRecordValue {
  requireSelfHostedWebToolCall(options.toolCall, "succeeded");
  return makeSemanticEventRecord({
    ...eventScope(options),
    aggregateId: options.toolCall.data.id,
    aggregateType: "tool-call",
    aggregateVersion: requireToolCallEventVersion(options.toolCallEventVersion, 2),
    eventId: options.eventId,
    eventType: "tool-call.completed",
    payload: {
      outputSummary: "Self-hosted web tool completed.",
      runId: options.toolCall.data.runId,
      status: options.toolCall.data.status,
      toolCallId: options.toolCall.data.id,
      toolCallRecordVersion: options.toolCall.data.version,
      toolName: options.toolCall.data.toolName,
    },
  });
}

export function makeSelfHostedWebToolFailedSemanticEvent(
  options: SelfHostedWebToolEventOptions & {
    readonly toolCallEventVersion: number;
  },
): SemanticEventRecordValue {
  requireSelfHostedWebToolCall(options.toolCall, "failed");
  return makeSemanticEventRecord({
    ...eventScope(options),
    aggregateId: options.toolCall.data.id,
    aggregateType: "tool-call",
    aggregateVersion: requireToolCallEventVersion(options.toolCallEventVersion, 2),
    eventId: options.eventId,
    eventType: "tool-call.failed",
    payload: {
      error: "Self-hosted web tool execution failed.",
      runId: options.toolCall.data.runId,
      status: options.toolCall.data.status,
      toolCallId: options.toolCall.data.id,
      toolCallRecordVersion: options.toolCall.data.version,
      toolName: options.toolCall.data.toolName,
    },
  });
}

const registeredNames = new Set<string>(SELF_HOSTED_WEB_TOOL_NAMES);
const operationNames = new Set<string>(Object.keys(FIRECRAWL_OPERATIONS));
if (
  registeredNames.size !== operationNames.size ||
  [...registeredNames].some((toolName) => !operationNames.has(toolName))
) {
  throw new Error("Self-hosted web tool catalog and Firecrawl operations are out of sync.");
}
