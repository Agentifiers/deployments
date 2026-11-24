import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { failureChain } from "./failure-log.ts";
import type { AgentRunQueueDisposition, QueueRecord } from "./queue.ts";
import { agentRunFifoQueueUrl } from "./sqs.ts";
import type { WorkerDrain } from "./worker-drain.ts";

const RECEIVE_WAIT_TIME_SECONDS = 20;
/** SQS `ReceiveMessage` returns at most ten messages per call. */
const MAX_RECEIVE_MESSAGES = 10;
const INITIAL_RECEIVE_BACKOFF_MS = 1_000;
const MAX_RECEIVE_BACKOFF_MS = 30_000;

export interface AgentRunQueuePollerOptions {
  readonly client: Pick<SQSClient, "send">;
  readonly drain: Pick<WorkerDrain, "deadline" | "started">;
  readonly generateAttemptId?: () => string;
  readonly maxConcurrentRuns: number;
  /** Processes one delivery; normally `processAgentRunQueueDelivery`. */
  readonly processRecord: (
    record: QueueRecord,
    draining: () => boolean,
  ) => Promise<AgentRunQueueDisposition>;
  readonly queueUrl: string;
  /** Waits between failed receives. Test seam for a fake clock. */
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface AgentRunQueuePoller {
  /** Received runs that are not yet deleted or handed back to the queue. */
  readonly inFlightRuns: () => number;
  /** Receives and processes until the host drains, then waits for in-flight runs to settle. */
  readonly run: () => Promise<void>;
}

function queueRecord(message: Message): QueueRecord | undefined {
  if (!message.MessageId || !message.ReceiptHandle) return undefined;
  const messageGroupId = message.Attributes?.MessageGroupId;
  const receiveCount = Number(message.Attributes?.ApproximateReceiveCount);
  return {
    body: message.Body ?? "",
    messageId: message.MessageId,
    ...(messageGroupId ? { messageGroupId } : {}),
    receiptHandle: message.ReceiptHandle,
    ...(Number.isSafeInteger(receiveCount) ? { receiveCount } : {}),
  };
}

/**
 * Long-lived consumer of the agent-run FIFO queue. Each run holds one slot until it is deleted
 * or handed back; receives happen only while slots are free and stop once the host drains.
 * Only the first message of each group in a receive runs. The rest of that group goes straight
 * back at visibility 0: SQS FIFO withholds them while the head is in flight, and only the
 * running message's visibility is renewed, so holding them would let them expire mid-wait.
 */
export function createAgentRunQueuePoller(
  options: AgentRunQueuePollerOptions,
): AgentRunQueuePoller {
  const queueUrl = agentRunFifoQueueUrl(options.queueUrl);
  if (!Number.isSafeInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns < 1) {
    throw new Error("Agent worker max concurrent runs must be a positive integer.");
  }
  const { client, drain } = options;
  const generateAttemptId = options.generateAttemptId ?? randomUUID;
  const sleep = options.sleep ?? ((delayMs: number) => delay(delayMs));
  const draining = () => drain.deadline() !== undefined;
  const work = new Set<Promise<void>>();
  let inFlight = 0;
  let slotFreed = Promise.withResolvers<void>();

  const track = (task: Promise<void>) => {
    work.add(task);
    void task.finally(() => work.delete(task));
  };

  // Failed hand-backs and deletes only delay redelivery; processing is idempotent per run.
  const handBack = async (record: QueueRecord) => {
    try {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: record.receiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch (cause) {
      console.error("Agent run queue message could not be handed back; it returns later.", {
        failure: failureChain(cause),
        messageId: record.messageId,
      });
    }
  };

  const remove = async (record: QueueRecord) => {
    try {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: record.receiptHandle }),
      );
    } catch (cause) {
      console.error("Agent run queue message could not be deleted; SQS will redeliver it.", {
        failure: failureChain(cause),
        messageId: record.messageId,
      });
    }
  };

  const dispatch = (records: readonly QueueRecord[]) => {
    const groups = new Set<string>();
    for (const record of records) {
      if (record.messageGroupId !== undefined && groups.has(record.messageGroupId)) {
        track(handBack(record));
        continue;
      }
      if (record.messageGroupId !== undefined) groups.add(record.messageGroupId);
      inFlight += 1;
      track(
        options
          .processRecord(record, draining)
          .then(async (disposition) => {
            if (disposition === "processed") await remove(record);
          })
          .catch((cause: unknown) => {
            console.error("Agent run queue delivery failed; SQS will redeliver it.", {
              failure: failureChain(cause),
              messageId: record.messageId,
            });
          })
          .finally(() => {
            inFlight -= 1;
            slotFreed.resolve();
            slotFreed = Promise.withResolvers<void>();
          }),
      );
    }
  };

  const run = async () => {
    let backoffMs = INITIAL_RECEIVE_BACKOFF_MS;
    // A retried receive reuses its attempt ID so SQS returns messages a lost response carried.
    let pending: { readonly attemptId: string; readonly maxMessages: number } | undefined;
    while (!draining()) {
      const freeSlots = options.maxConcurrentRuns - inFlight;
      if (freeSlots <= 0) {
        await Promise.race([slotFreed.promise, drain.started]);
        continue;
      }
      const receive = pending ?? {
        attemptId: generateAttemptId(),
        maxMessages: Math.min(MAX_RECEIVE_MESSAGES, freeSlots),
      };
      pending = receive;
      let messages: readonly Message[];
      try {
        const output = await client.send(
          new ReceiveMessageCommand({
            MaxNumberOfMessages: receive.maxMessages,
            MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
            QueueUrl: queueUrl,
            ReceiveRequestAttemptId: receive.attemptId,
            WaitTimeSeconds: RECEIVE_WAIT_TIME_SECONDS,
          }),
        );
        messages = output.Messages ?? [];
      } catch (cause) {
        console.error("Agent run queue receive failed; retrying after backoff.", {
          backoffMs,
          failure: failureChain(cause),
        });
        await Promise.race([sleep(backoffMs), drain.started]);
        backoffMs = Math.min(backoffMs * 2, MAX_RECEIVE_BACKOFF_MS);
        continue;
      }
      pending = undefined;
      backoffMs = INITIAL_RECEIVE_BACKOFF_MS;
      const records = messages.flatMap((message) => {
        const record = queueRecord(message);
        if (!record) console.error("Agent run queue returned a message without an ID or receipt.");
        return record ? [record] : [];
      });
      // Messages received after the drain started are handed back by `processRecord`.
      if (records.length > 0) dispatch(records);
    }
    while (work.size > 0) await Promise.all(work);
  };

  return { inFlightRuns: () => inFlight, run };
}
