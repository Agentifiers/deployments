import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SendMessageBatchCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  key,
  makeDynamoDatabase,
  tableNamesFromEnvironment,
  type DynamoDatabaseService,
  apiPersistence,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";

interface BrainSourceSemanticEvent {
  readonly eventId?: string;
  readonly organizationId?: string;
  readonly payload?: {
    readonly brainId?: string;
    readonly sourceId?: string;
    readonly syncJobId?: string;
    readonly syncJobIdempotencyKey?: string;
  };
}

interface BrainSyncSweepEvent {
  readonly kind: "brain-sync-dispatch-sweep";
}

const sqs = new SQSClient({});

function required(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`Brain sync event ${label} is required.`);
  return normalized;
}

function group(organizationId: string, sourceId: string) {
  return createHash("sha256").update(`${organizationId}\0${sourceId}`).digest("hex");
}

function brainSyncQueueMessage(event: BrainSourceSemanticEvent) {
  return {
    brainId: required(event.payload?.brainId, "brainId"),
    idempotencyKey: required(event.payload?.syncJobIdempotencyKey, "syncJobIdempotencyKey"),
    organizationId: required(event.organizationId, "organizationId"),
    sourceId: required(event.payload?.sourceId, "sourceId"),
  };
}

async function dispatchSemanticEvent(
  event: BrainSourceSemanticEvent,
  send: Pick<SQSClient, "send"> = sqs,
) {
  const message = brainSyncQueueMessage(event);
  await send.send(
    new SendMessageCommand({
      MessageBody: JSON.stringify({
        brainId: message.brainId,
        idempotencyKey: message.idempotencyKey,
        organizationId: message.organizationId,
      }),
      MessageDeduplicationId: required(event.payload?.syncJobId, "syncJobId"),
      MessageGroupId: group(message.organizationId, message.sourceId),
      QueueUrl: required(process.env.DEPLOYMENTS_AI_BRAIN_SYNC_QUEUE_URL, "queue URL"),
    }),
  );
}

async function dueJobs(database: DynamoDatabaseService, now: string) {
  const records: {
    readonly brainId: string;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly organizationId: string;
    readonly sourceId: string;
  }[] = [];
  for (const status of ["queued", "failed", "running"] as const) {
    for (let shard = 0; shard < 16; shard += 1) {
      const partition = key("QUEUE", "BRAIN-SYNC-JOB", status, String(shard).padStart(2, "0"));
      const page = await apiPersistence.find(database, "execution", {
        ExpressionAttributeValues: { ":partition": partition },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :partition",
        Limit: 100,
      });
      for (const item of page.items) {
        const current = await apiPersistence.read(
          database,
          "execution",
          { pk: item.pk, sk: item.sk },
          true,
        );
        if (
          current?.itemType === "brain-sync-job" &&
          current.data.status === status &&
          (status === "running"
            ? !!current.data.leaseExpiresAt && current.data.leaseExpiresAt <= now
            : current.data.nextDueAt <= now)
        ) {
          records.push({
            brainId: current.data.brainId,
            id: current.data.id,
            idempotencyKey: current.data.idempotencyKey,
            organizationId: current.data.organizationId,
            sourceId: current.data.sourceId,
          });
        }
      }
    }
  }
  return records;
}

async function dispatchSweep(database: DynamoDatabaseService, send: Pick<SQSClient, "send"> = sqs) {
  const queueUrl = required(process.env.DEPLOYMENTS_AI_BRAIN_SYNC_QUEUE_URL, "queue URL");
  const jobs = await dueJobs(database, new Date().toISOString());
  for (let offset = 0; offset < jobs.length; offset += 10) {
    const batch = jobs.slice(offset, offset + 10);
    const response = await send.send(
      new SendMessageBatchCommand({
        Entries: batch.map((job) => ({
          Id: job.id,
          MessageBody: JSON.stringify({
            brainId: job.brainId,
            idempotencyKey: job.idempotencyKey,
            organizationId: job.organizationId,
          }),
          MessageDeduplicationId: job.id,
          MessageGroupId: group(job.organizationId, job.sourceId),
        })),
        QueueUrl: queueUrl,
      }),
    );
    if (response.Failed?.length) throw new Error("Brain sync queue batch dispatch was partial.");
  }
  return { dispatched: jobs.length };
}

let database: DynamoDatabaseService | undefined;

export function brainSyncEventDetail(
  event:
    | BrainSourceSemanticEvent
    | BrainSyncSweepEvent
    | { readonly detail: BrainSourceSemanticEvent },
) {
  return "detail" in event ? event.detail : event;
}

export function handler(
  event:
    | BrainSourceSemanticEvent
    | BrainSyncSweepEvent
    | { readonly detail: BrainSourceSemanticEvent },
) {
  const detail = brainSyncEventDetail(event);
  if ("kind" in detail && detail.kind === "brain-sync-dispatch-sweep") {
    database ??= makeDynamoDatabase(
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }),
      tableNamesFromEnvironment(process.env),
    );
    return dispatchSweep(database);
  }
  return dispatchSemanticEvent(detail as BrainSourceSemanticEvent);
}
