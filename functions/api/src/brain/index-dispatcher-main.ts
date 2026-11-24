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

export interface BrainIndexSemanticEvent {
  readonly eventId?: string;
  readonly organizationId?: string;
  readonly payload?: {
    readonly documentId?: string;
    readonly indexJobIdempotencyKey?: string;
  };
}

const sqs = new SQSClient({});
interface BrainIndexSweepEvent {
  readonly kind: "brain-index-dispatch-sweep";
}

function required(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`Brain index event ${label} is required.`);
  return normalized;
}

export function brainIndexQueueMessage(event: BrainIndexSemanticEvent) {
  return {
    documentId: required(event.payload?.documentId, "documentId"),
    idempotencyKey: required(event.payload?.indexJobIdempotencyKey, "indexJobIdempotencyKey"),
    organizationId: required(event.organizationId, "organizationId"),
  };
}

export function brainIndexMessageGroup(message: ReturnType<typeof brainIndexQueueMessage>) {
  return createHash("sha256")
    .update(`${message.organizationId}\0${message.documentId}`)
    .digest("hex");
}

export async function handleBrainIndexSemanticEvent(
  event: BrainIndexSemanticEvent,
  send: Pick<SQSClient, "send"> = sqs,
) {
  const message = brainIndexQueueMessage(event);
  await send.send(
    new SendMessageCommand({
      MessageBody: JSON.stringify(message),
      MessageDeduplicationId: required(event.eventId, "eventId"),
      MessageGroupId: brainIndexMessageGroup(message),
      QueueUrl: required(process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL, "queue URL"),
    }),
  );
}

export async function dispatchDueBrainIndexJobs(
  database: DynamoDatabaseService,
  now: Date,
  send: Pick<SQSClient, "send"> = sqs,
) {
  const queueUrl = required(process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL, "queue URL");
  const due = [];
  for (const status of ["failed", "queued", "running"] as const) {
    for (let shard = 0; shard < 16; shard += 1) {
      const page = await apiPersistence.find(database, "execution", {
        ConsistentRead: false,
        ExpressionAttributeValues: {
          ":due": key("99999999", now.toISOString(), "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
          ":pk": key("QUEUE", "BRAIN-INDEX-JOB", status, String(shard).padStart(2, "0")),
        },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk <= :due",
        Limit: 25,
      });
      for (const candidate of page.items) {
        const current = await apiPersistence.read(
          database,
          "execution",
          { pk: candidate.pk, sk: candidate.sk },
          true,
        );
        if (current?.itemType !== "brain-index-job" || current.data.status !== status) continue;
        const isDue =
          status === "running"
            ? !!current.data.leaseExpiresAt && current.data.leaseExpiresAt <= now.toISOString()
            : !!current.data.nextDueAt && current.data.nextDueAt <= now.toISOString();
        if (!isDue) continue;
        due.push(current);
      }
    }
  }
  for (let offset = 0; offset < due.length; offset += 10) {
    const batch = due.slice(offset, offset + 10);
    const response = await send.send(
      new SendMessageBatchCommand({
        Entries: batch.map((job) => ({
          Id: job.data.id,
          MessageBody: JSON.stringify({
            documentId: job.data.documentId,
            idempotencyKey: job.data.idempotencyKey,
            organizationId: job.data.organizationId,
          }),
          MessageDeduplicationId: createHash("sha256")
            .update(`${job.data.id}:${job.data.version}`)
            .digest("hex"),
          MessageGroupId: brainIndexMessageGroup({
            documentId: job.data.documentId,
            idempotencyKey: job.data.idempotencyKey,
            organizationId: job.data.organizationId,
          }),
        })),
        QueueUrl: queueUrl,
      }),
    );
    if (response.Failed?.length) throw new Error("Brain index recovery dispatch was partial.");
  }
  return { dispatched: due.length };
}

let database: DynamoDatabaseService | undefined;

export function brainIndexEventDetail(
  event:
    | BrainIndexSemanticEvent
    | BrainIndexSweepEvent
    | { readonly detail: BrainIndexSemanticEvent },
) {
  return "detail" in event ? event.detail : event;
}

export function handler(
  event:
    | BrainIndexSemanticEvent
    | BrainIndexSweepEvent
    | { readonly detail: BrainIndexSemanticEvent },
) {
  const detail = brainIndexEventDetail(event);
  if ("kind" in detail && detail.kind === "brain-index-dispatch-sweep") {
    database ??= makeDynamoDatabase(
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }),
      tableNamesFromEnvironment(process.env),
    );
    return dispatchDueBrainIndexJobs(database, new Date());
  }
  return handleBrainIndexSemanticEvent(detail as BrainIndexSemanticEvent);
}
