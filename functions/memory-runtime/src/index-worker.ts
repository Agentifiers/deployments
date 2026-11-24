import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Schema } from "effect";
import { makeOrganizationHoldReader, Ulid, type OrganizationHoldReader } from "@deployments-ai/db";
import type { MemoryPlatform } from "@deployments-ai/memory";
import { admitConsistently } from "@deployments-ai/organization-admission";
import {
  logQueueRecordFailure,
  queuePayload,
  queueScope,
  text,
  type QueueRecordLike,
} from "./queue.ts";
import { dueDeliveryDelaySeconds, failedDeliveryDelaySeconds } from "./queue-redelivery.ts";
import { runtimeDatabase, runtimeMemoryPlatform } from "./runtime.ts";

export interface MemoryIndexQueueRecord extends QueueRecordLike {
  readonly attributes: { readonly ApproximateReceiveCount: string };
  readonly receiptHandle: string;
}

export interface MemoryIndexQueueEvent {
  readonly Records: readonly MemoryIndexQueueRecord[];
}

export interface MemoryIndexQueueDependencies {
  /** Hides the message until its next attempt is due; the queue's redrive policy is a backstop. */
  readonly changeVisibility: (receiptHandle: string, visibilitySeconds: number) => Promise<void>;
  readonly now: () => Date;
  readonly platform: MemoryPlatform;
  readonly random: () => number;
  readonly standing: OrganizationHoldReader;
}

const sqs = new SQSClient({});

/** Runs the record's job and returns its retry time when the job is not yet runnable. */
async function indexRecord(
  record: MemoryIndexQueueRecord,
  { platform, standing }: MemoryIndexQueueDependencies,
) {
  const payload = queuePayload(record);
  const scope = queueScope(payload);
  const { decision } = await admitConsistently({
    activity: "background.process",
    organizationId: Schema.decodeUnknownSync(Ulid)(scope.organizationId),
    standing,
  });
  if (decision.kind === "suspended") return undefined;
  const job = await platform.processIndexJob(scope, {
    idempotencyKey: text(payload.idempotencyKey, "idempotencyKey"),
    memoryId: Schema.decodeUnknownSync(Ulid)(text(payload.memoryId, "memoryId")),
    ...(typeof payload.targetId === "string"
      ? { targetId: Schema.decodeUnknownSync(Ulid)(payload.targetId) }
      : {}),
    workerId: process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? record.messageId,
  });
  return job.data.status === "failed" ? job.data.retryAt : undefined;
}

async function runtimeDependencies(): Promise<MemoryIndexQueueDependencies> {
  const queueUrl = text(
    process.env.DEPLOYMENTS_AI_MEMORY_INDEX_QUEUE_URL,
    "DEPLOYMENTS_AI_MEMORY_INDEX_QUEUE_URL",
  );
  return {
    changeVisibility: async (receiptHandle, visibilitySeconds) => {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilitySeconds,
        }),
      );
    },
    now: () => new Date(),
    platform: await runtimeMemoryPlatform(),
    random: Math.random,
    standing: makeOrganizationHoldReader(runtimeDatabase()),
  };
}

/**
 * Indexes one memory per record. A record whose job failed or is waiting out a retry due within
 * five minutes stays on the queue and returns when the job is next runnable, so retries do not
 * wait for the queue's visibility timeout or the reconciler sweep. A retry due later is left to
 * the operation reconciler, which also sends a suspended organization's job again once it is due.
 */
export async function handleMemoryIndexQueue(
  event: MemoryIndexQueueEvent,
  dependencies?: MemoryIndexQueueDependencies,
) {
  const resolved = dependencies ?? (await runtimeDependencies());
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let visibilitySeconds: number | undefined;
    try {
      const retryAt = await indexRecord(record, resolved);
      visibilitySeconds =
        retryAt === undefined ? undefined : dueDeliveryDelaySeconds(retryAt, resolved.now());
    } catch (cause) {
      logQueueRecordFailure(record, cause);
      visibilitySeconds = failedDeliveryDelaySeconds(
        Number(record.attributes.ApproximateReceiveCount),
        resolved.random,
      );
    }
    if (visibilitySeconds === undefined) continue;
    await resolved.changeVisibility(record.receiptHandle, visibilitySeconds).catch((cause) => {
      console.error("Memory index redelivery delay was not applied.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: record.messageId,
      });
    });
    failures.push({ itemIdentifier: record.messageId });
  }
  return { batchItemFailures: failures };
}

export const handler = (event: MemoryIndexQueueEvent) => handleMemoryIndexQueue(event);
