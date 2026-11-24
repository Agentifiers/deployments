import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";
import type {
  AgentRunQueueEnqueue,
  AgentRunQueueEnqueueInput,
  AgentRunQueueDelivery,
  AgentRunQueueMessage,
  AgentRunQueueRetry,
  AgentRunQueueVisibilityExtension,
} from "./types.ts";
import { agentRunQueueMessageGroupId, agentRunRecoveryQueueMessageGroupId } from "./types.ts";

const MAX_VISIBILITY_TIMEOUT_SECONDS = 12 * 60 * 60;
const MAX_SQS_FIFO_IDENTIFIER_BYTES = 128;
const MAX_SQS_MESSAGE_BYTES = 1024 * 1024;

export interface SqsQueueVisibilityExtensionOptions {
  readonly client?: Pick<SQSClient, "send">;
  readonly clientConfig?: SQSClientConfig;
  readonly queueUrl: string;
  readonly visibilityTimeoutSeconds: number;
}

export interface SqsAgentRunQueueEnqueueOptions {
  readonly client?: Pick<SQSClient, "send">;
  readonly clientConfig?: SQSClientConfig;
  readonly queueUrl: string;
}

function queueUrl(value: string): string {
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (cause) {
    throw new Error("Agent run SQS queue URL must be an absolute URL.", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent run SQS queue URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Agent run SQS queue URL must not contain credentials.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const ipv4 = hostname.split(".").map(Number);
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    (ipv4.length === 4 &&
      ipv4[0] === 127 &&
      ipv4.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255));
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Agent run SQS queue URL must use HTTPS outside loopback development.");
  }
  if (url.search || url.hash) {
    throw new Error("Agent run SQS queue URL must not contain a query or fragment.");
  }
  return candidate;
}

function visibilityTimeoutSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_VISIBILITY_TIMEOUT_SECONDS) {
    throw new Error(
      `Agent run SQS visibility timeout must be an integer from 1 to ${MAX_VISIBILITY_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return value;
}

function retryVisibilityTimeoutSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VISIBILITY_TIMEOUT_SECONDS) {
    throw new Error(
      `Agent run SQS retry visibility timeout must be an integer from 0 to ${MAX_VISIBILITY_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return value;
}

/** Validates an agent-run queue URL and requires the FIFO queue the worker's lanes depend on. */
export function agentRunFifoQueueUrl(value: string): string {
  const candidate = queueUrl(value);
  const name = new URL(candidate).pathname.split("/").filter(Boolean).at(-1);
  if (!name?.endsWith(".fifo")) {
    throw new Error("Agent run SQS queue URL must target a FIFO queue ending in .fifo.");
  }
  return candidate;
}

function fifoIdentifier(label: string, value: string): string {
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    !normalized ||
    hasControlCharacter ||
    new TextEncoder().encode(normalized).byteLength > MAX_SQS_FIFO_IDENTIFIER_BYTES
  ) {
    throw new Error(
      `Agent run SQS ${label} must contain at most ${MAX_SQS_FIFO_IDENTIFIER_BYTES} UTF-8 bytes without control characters.`,
    );
  }
  return normalized;
}

export function createSqsAgentRunQueueEnqueue(
  options: SqsAgentRunQueueEnqueueOptions,
): AgentRunQueueEnqueue {
  const targetQueueUrl = agentRunFifoQueueUrl(options.queueUrl);
  const client = options.client ?? new SQSClient(options.clientConfig ?? {});

  return async (input: AgentRunQueueEnqueueInput, signal?: AbortSignal): Promise<void> => {
    const messageGroupId = fifoIdentifier("messageGroupId", input.messageGroupId);
    const expectedMessageGroupId = agentRunQueueMessageGroupId(input.message);
    const recoveryMessageGroupId = agentRunRecoveryQueueMessageGroupId(input.message);
    if (messageGroupId !== expectedMessageGroupId && messageGroupId !== recoveryMessageGroupId) {
      throw new Error("Agent run SQS messageGroupId does not match the message thread scope.");
    }
    const deduplicationId = fifoIdentifier("deduplicationId", input.deduplicationId);
    const body = JSON.stringify(input.message);
    if (new TextEncoder().encode(body).byteLength > MAX_SQS_MESSAGE_BYTES) {
      throw new Error(
        `Agent run SQS message body must not exceed ${MAX_SQS_MESSAGE_BYTES} UTF-8 bytes.`,
      );
    }
    await client.send(
      new SendMessageCommand({
        MessageBody: body,
        MessageDeduplicationId: deduplicationId,
        MessageGroupId: messageGroupId,
        QueueUrl: targetQueueUrl,
      }),
      signal ? { abortSignal: signal } : undefined,
    );
  };
}

export function createSqsQueueVisibilityExtension(
  options: SqsQueueVisibilityExtensionOptions,
): AgentRunQueueVisibilityExtension {
  const targetQueueUrl = queueUrl(options.queueUrl);
  const timeout = visibilityTimeoutSeconds(options.visibilityTimeoutSeconds);
  const client = options.client ?? new SQSClient(options.clientConfig ?? {});

  return Object.assign(
    async (
      delivery: AgentRunQueueDelivery,
      _message: AgentRunQueueMessage,
      signal?: AbortSignal,
    ) => {
      if (delivery.receiptHandle.length === 0) {
        throw new Error("Agent run SQS delivery receipt handle is required.");
      }
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: targetQueueUrl,
          ReceiptHandle: delivery.receiptHandle,
          VisibilityTimeout: timeout,
        }),
        signal ? { abortSignal: signal } : undefined,
      );
    },
    { renewalIntervalMs: Math.max(1, Math.floor((timeout * 1_000) / 3)) },
  );
}

export function createSqsQueueRetry(
  options: Pick<SqsQueueVisibilityExtensionOptions, "client" | "clientConfig" | "queueUrl">,
): AgentRunQueueRetry {
  const targetQueueUrl = queueUrl(options.queueUrl);
  const client = options.client ?? new SQSClient(options.clientConfig ?? {});
  return async (delivery, _message, retryAfterSeconds) => {
    if (delivery.receiptHandle.length === 0) {
      throw new Error("Agent run SQS delivery receipt handle is required.");
    }
    const timeout = retryVisibilityTimeoutSeconds(retryAfterSeconds);
    await client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: targetQueueUrl,
        ReceiptHandle: delivery.receiptHandle,
        VisibilityTimeout: timeout,
      }),
    );
  };
}
