import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { describe, expect, it } from "bun:test";
import {
  createSqsAgentRunQueueEnqueue,
  createSqsQueueRetry,
  createSqsQueueVisibilityExtension,
} from "./sqs.ts";
import {
  agentRunQueueMessageGroupId,
  agentRunRecoveryQueueMessageGroupId,
  type AgentRunQueueMessage,
} from "./types.ts";

const queueMessage = {
  environmentId: "01J00000000000000000000003",
  idempotencyKey: "agent-run:test",
  organizationId: "01J00000000000000000000001",
  projectId: "01J00000000000000000000002",
  runId: "01J00000000000000000000005",
  threadId: "01J00000000000000000000004",
  userMessageId: "01J00000000000000000000006",
  userMessageSequence: 0,
} as AgentRunQueueMessage;

describe("SQS agent run FIFO enqueue", () => {
  it("sends the exact queue message, lane, deduplication ID, and abort signal", async () => {
    const calls: Array<{ readonly command: SendMessageCommand; readonly options: unknown }> = [];
    const client = {
      send: async (command: SendMessageCommand, options?: unknown) => {
        calls.push({ command, options });
        return {};
      },
    } as Pick<SQSClient, "send">;
    const enqueue = createSqsAgentRunQueueEnqueue({
      client,
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
    });
    const abort = new AbortController();

    await enqueue(
      {
        deduplicationId: "approval-resume:01J00000000000000000000007:2",
        message: queueMessage,
        messageGroupId: agentRunQueueMessageGroupId(queueMessage),
      },
      abort.signal,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBeInstanceOf(SendMessageCommand);
    expect(calls[0]?.command.input).toEqual({
      MessageBody: JSON.stringify(queueMessage),
      MessageDeduplicationId: "approval-resume:01J00000000000000000000007:2",
      MessageGroupId: agentRunQueueMessageGroupId(queueMessage),
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
    });
    expect(calls[0]?.options).toEqual({ abortSignal: abort.signal });
  });

  it("rejects non-FIFO targets, wrong thread lanes, and invalid deduplication IDs", async () => {
    const client = { send: async () => ({}) } as Pick<SQSClient, "send">;
    expect(() =>
      createSqsAgentRunQueueEnqueue({
        client,
        queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs",
      }),
    ).toThrow("must target a FIFO queue");

    const enqueue = createSqsAgentRunQueueEnqueue({
      client,
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
    });
    expect(
      enqueue({
        deduplicationId: "resume-1",
        message: queueMessage,
        messageGroupId: "wrong-thread-lane",
      }),
    ).rejects.toThrow("does not match the message thread scope");
    expect(
      enqueue({
        deduplicationId: "x".repeat(129),
        message: queueMessage,
        messageGroupId: agentRunQueueMessageGroupId(queueMessage),
      }),
    ).rejects.toThrow("at most 128 UTF-8 bytes");
  });

  it("accepts the bounded recovery lane for an earlier run on the same thread", async () => {
    const calls: SendMessageCommand[] = [];
    const enqueue = createSqsAgentRunQueueEnqueue({
      client: {
        send: async (command: SendMessageCommand) => {
          calls.push(command);
          return {};
        },
      } as Pick<SQSClient, "send">,
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
    });

    await enqueue({
      deduplicationId: "queued-run-recovery-1",
      message: queueMessage,
      messageGroupId: agentRunRecoveryQueueMessageGroupId(queueMessage),
    });

    expect(calls[0]?.input.MessageGroupId).toBe(
      `${agentRunQueueMessageGroupId(queueMessage)}:recovery`,
    );
  });
});

describe("SQS queue visibility extension", () => {
  it("sends ChangeMessageVisibility with the exact delivery receipt and abort signal", async () => {
    const calls: Array<{
      readonly command: ChangeMessageVisibilityCommand;
      readonly options: unknown;
    }> = [];
    const client = {
      send: async (command: ChangeMessageVisibilityCommand, options?: unknown) => {
        calls.push({ command, options });
        return {};
      },
    } as Pick<SQSClient, "send">;
    const extend = createSqsQueueVisibilityExtension({
      client,
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
      visibilityTimeoutSeconds: 120,
    });
    const abort = new AbortController();

    await extend(
      { messageId: "delivery-1", receiptHandle: " opaque-receipt-handle " },
      queueMessage,
      abort.signal,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect(calls[0]?.command.input).toEqual({
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
      ReceiptHandle: " opaque-receipt-handle ",
      VisibilityTimeout: 120,
    });
    expect(calls[0]?.options).toEqual({ abortSignal: abort.signal });
    expect(extend.renewalIntervalMs).toBe(40_000);
  });

  it("supports loopback queue endpoints for local AWS emulation", () => {
    expect(() =>
      createSqsQueueVisibilityExtension({
        client: { send: async () => ({}) } as Pick<SQSClient, "send">,
        queueUrl: "http://127.0.0.1:4566/000000000000/agent-runs",
        visibilityTimeoutSeconds: 30,
      }),
    ).not.toThrow();
  });

  it("rejects unsafe queue URLs and invalid visibility durations", () => {
    const client = { send: async () => ({}) } as Pick<SQSClient, "send">;
    expect(() =>
      createSqsQueueVisibilityExtension({
        client,
        queueUrl: "http://sqs.example.com/agent-runs",
        visibilityTimeoutSeconds: 30,
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      createSqsQueueVisibilityExtension({
        client,
        queueUrl: "https://sqs.example.com/agent-runs?tenant=unsafe",
        visibilityTimeoutSeconds: 30,
      }),
    ).toThrow("query or fragment");
    expect(() =>
      createSqsQueueVisibilityExtension({
        client,
        queueUrl: "https://sqs.example.com/agent-runs",
        visibilityTimeoutSeconds: 43_201,
      }),
    ).toThrow("from 1 to 43200 seconds");
  });

  it("rejects an empty receipt handle before sending", async () => {
    let sends = 0;
    const extend = createSqsQueueVisibilityExtension({
      client: {
        send: async () => {
          sends += 1;
          return {};
        },
      } as Pick<SQSClient, "send">,
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs",
      visibilityTimeoutSeconds: 30,
    });

    expect(extend({ messageId: "delivery-1", receiptHandle: "" }, queueMessage)).rejects.toThrow(
      "receipt handle is required",
    );
    expect(sends).toBe(0);
  });
});

describe("SQS queue retry", () => {
  it("applies the requested retry delay to the exact failed delivery", async () => {
    const calls: ChangeMessageVisibilityCommand[] = [];
    const retry = createSqsQueueRetry({
      client: {
        send: async (command: ChangeMessageVisibilityCommand) => {
          calls.push(command);
          return {};
        },
      } as Pick<SQSClient, "send">,
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
    });

    await retry({ messageId: "delivery-1", receiptHandle: "retry-receipt" }, queueMessage, 5);

    expect(calls[0]?.input).toEqual({
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
      ReceiptHandle: "retry-receipt",
      VisibilityTimeout: 5,
    });
  });

  it("rejects invalid retry delays before sending", async () => {
    let sends = 0;
    const retry = createSqsQueueRetry({
      client: {
        send: async () => {
          sends += 1;
          return {};
        },
      } as Pick<SQSClient, "send">,
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo",
    });
    const delivery = { messageId: "delivery-1", receiptHandle: "retry-receipt" };

    for (const delay of [Number.NaN, 1.5, -1, 43_201]) {
      expect(retry(delivery, queueMessage, delay)).rejects.toThrow(
        "retry visibility timeout must be an integer from 0 to 43200 seconds",
      );
    }
    expect(sends).toBe(0);
  });
});
