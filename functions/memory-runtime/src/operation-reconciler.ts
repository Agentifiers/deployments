import { SendMessageCommand, SQSClient, type SendMessageCommandInput } from "@aws-sdk/client-sqs";
import {
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  memoryRuntimePersistence,
} from "@deployments-ai/db";
import { runtimeDatabase } from "./runtime.ts";
import { memoryIndexMessageGroup, type MemoryIndexEvent } from "./index-dispatcher.ts";

const sqs = new SQSClient({});
const OPERATION_SHARDS = 16;
const OPERATIONS_PER_SHARD = 25;
const INDEX_REDISPATCH_INTERVAL_MS = 5 * 60_000;
const INDEX_JOB_RECOVERY_STATUSES = ["queued", "running", "failed"] as const;
type Operation = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;
type IndexJob = Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;

function indexJobEvent(job: IndexJob): MemoryIndexEvent {
  return {
    detail: {
      environmentId: job.data.environmentId,
      organizationId: job.data.organizationId,
      payload: {
        idempotencyKey: job.data.idempotencyKey,
        memoryId: job.data.memoryId,
        ...(job.data.targetId ? { targetId: job.data.targetId } : {}),
      },
      projectId: job.data.projectId,
      ...(job.data.workspaceId ? { workspaceId: job.data.workspaceId } : {}),
    },
  };
}

export function memoryIndexRecoveryMessage(
  queueUrl: string,
  event: MemoryIndexEvent,
): SendMessageCommandInput {
  return {
    MessageBody: JSON.stringify(event),
    ...(queueUrl.endsWith(".fifo") ? { MessageGroupId: memoryIndexMessageGroup(event) } : {}),
    QueueUrl: queueUrl,
  };
}

export async function reconcileDueMemoryIndexJobs(args: {
  readonly database: DynamoDatabaseService;
  readonly dispatch: (event: MemoryIndexEvent) => Promise<void>;
  readonly now: Date;
}) {
  let dispatched = 0;
  const now = args.now.toISOString();
  for (const status of INDEX_JOB_RECOVERY_STATUSES) {
    for (let shard = 0; shard < OPERATION_SHARDS; shard += 1) {
      const page = await memoryRuntimePersistence.find(args.database, "execution", {
        ConsistentRead: false,
        ExpressionAttributeValues: {
          ":due": key("00000000", now, "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
          ":pk": key("QUEUE", "MEMORY-INDEX-JOB", status, String(shard).padStart(2, "0")),
        },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk <= :due",
        Limit: OPERATIONS_PER_SHARD,
      });
      for (const candidate of page.items) {
        const job = await memoryRuntimePersistence.read(
          args.database,
          "execution",
          { pk: candidate.pk, sk: candidate.sk },
          true,
        );
        if (job === undefined) continue;
        const leaseExpiresAt =
          job.itemType === "memory-index-job" && job.data.leaseExpiresAt
            ? Date.parse(job.data.leaseExpiresAt)
            : Number.NaN;
        if (
          job.itemType !== "memory-index-job" ||
          job.data.status !== status ||
          !job.data.targetId ||
          !job.data.nextDueAt ||
          job.data.nextDueAt > now ||
          (status === "running" &&
            (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > args.now.getTime()))
        ) {
          continue;
        }
        await args.dispatch(indexJobEvent(job));
        const deferred = withCanonicalRecordKeys({
          data: {
            ...job.data,
            nextDueAt: new Date(args.now.getTime() + INDEX_REDISPATCH_INTERVAL_MS).toISOString(),
            updatedAt: now,
            version: job.data.version + 1,
          },
          itemType: "memory-index-job" as const,
        }) as IndexJob;
        try {
          await memoryRuntimePersistence.commit(args.database, [
            { kind: "put", previousRecord: job, record: deferred },
          ]);
        } catch {
          // The durable queue send already succeeded. A worker claim or the next sweep resolves races.
        }
        dispatched += 1;
      }
    }
  }
  return { dispatched };
}

export async function reconcileDueMemorySearchOperations(args: {
  readonly database: DynamoDatabaseService;
  readonly dispatch: (operation: Operation) => Promise<void>;
  readonly now: Date;
}) {
  let dispatched = 0;
  for (let shard = 0; shard < OPERATION_SHARDS; shard += 1) {
    const page = await memoryRuntimePersistence.find(args.database, "control", {
      ConsistentRead: false,
      ExpressionAttributeValues: {
        ":due": key(args.now.toISOString(), "9999999999999999", "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
        ":pk": key("MEMORY-SEARCH-OPERATION", String(shard)),
      },
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND gsi1sk <= :due",
      Limit: OPERATIONS_PER_SHARD,
    });
    for (const record of page.items) {
      if (
        record.itemType !== "memory-search-provisioning" ||
        !record.data.nextAction ||
        !record.data.nextActionAt ||
        record.data.nextActionAt > args.now.toISOString() ||
        record.data.status === "completed" ||
        record.data.status === "aborted"
      ) {
        continue;
      }
      await args.dispatch(record);
      dispatched += 1;
    }
  }
  return { dispatched };
}

export async function handler() {
  const operationQueueUrl = process.env.DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL?.trim();
  const indexQueueUrl = process.env.DEPLOYMENTS_AI_MEMORY_INDEX_QUEUE_URL?.trim();
  if (!operationQueueUrl) throw new Error("DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL is required.");
  if (!indexQueueUrl) throw new Error("DEPLOYMENTS_AI_MEMORY_INDEX_QUEUE_URL is required.");
  const database = runtimeDatabase();
  const [operations, indexJobs] = await Promise.all([
    reconcileDueMemorySearchOperations({
      database,
      dispatch: async (operation) => {
        await sqs.send(
          new SendMessageCommand({
            MessageBody: JSON.stringify({
              actionGeneration: operation.data.actionGeneration,
              nextAction: operation.data.nextAction,
              operationId: operation.data.id,
              organizationId: operation.data.organizationId,
            }),
            QueueUrl: operationQueueUrl,
          }),
        );
      },
      now: new Date(),
    }),
    reconcileDueMemoryIndexJobs({
      database,
      dispatch: async (event) => {
        await sqs.send(new SendMessageCommand(memoryIndexRecoveryMessage(indexQueueUrl, event)));
      },
      now: new Date(),
    }),
  ]);
  return { indexJobs, operations };
}
