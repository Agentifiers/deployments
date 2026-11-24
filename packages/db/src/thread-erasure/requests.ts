import type { DynamoDatabaseService } from "../client-types.ts";
import { operationRecord } from "../governance/dynamo-store.ts";
import { governanceOperationHistoryRecord } from "../governance/operation-history.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import type { Ulid } from "../ids.ts";
import type {
  ConversationErasureStore,
  RequestEndUserErasureResult,
  RequestThreadErasureResult,
} from "./contracts.ts";
import {
  EMPTY_COUNTS,
  conversationOperation,
  lifecycleEvent,
  readOperationRecord,
  resumeOnReplay,
} from "./operations.ts";
import {
  inboxThreadFencePuts,
  linkedInboxThreads,
  type InboxThreadTarget,
} from "./mail-planning.ts";
import { endUserErasureFenceKey, threadTombstoneKey } from "./record-keys.ts";

type ThreadRecord = Extract<PlatformRecord, { readonly itemType: "thread" }>;
type RunRecord = Extract<PlatformRecord, { readonly itemType: "run" }>;

const MAX_REQUEST_ATTEMPTS = 4;
/**
 * Inbox thread fences the thread erasure request writes in its own transaction, which stays under
 * DynamoDB's 100 operations.
 */
export const MAX_REQUEST_INBOX_THREAD_FENCES = 40;
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting-for-approval",
  "waiting-for-tool",
]);

export interface ErasureRequestContext {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Ulid;
  readonly now: () => Date;
}

function inboxThreadsByFencingPhase(threads: readonly InboxThreadTarget[]) {
  return {
    fencedAtPlanning: threads.slice(MAX_REQUEST_INBOX_THREAD_FENCES),
    fencedAtRequest: threads.slice(0, MAX_REQUEST_INBOX_THREAD_FENCES),
  };
}

export async function listActiveRuns(
  database: DynamoDatabaseService,
  organizationId: string,
  threadId: string,
): Promise<readonly RunRecord[]> {
  const runs: RunRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords("execution", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": key("ORG", organizationId, "THREAD", threadId),
        ":run": "RUN#",
      },
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :run)",
    });
    for (const record of page.items) {
      if (record.itemType === "run" && ACTIVE_RUN_STATUSES.has(record.data.status)) {
        runs.push(record);
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return runs;
}

export async function readThreadTombstone(
  database: DynamoDatabaseService,
  organizationId: string,
  threadId: string,
) {
  const record = await database.getRecord(
    "execution",
    threadTombstoneKey(organizationId, threadId),
  );
  return record?.itemType === "thread-tombstone" ? record : undefined;
}

export async function readThread(
  database: DynamoDatabaseService,
  organizationId: string,
  threadId: string,
): Promise<ThreadRecord | undefined> {
  const record = await database.getRecord("execution", {
    pk: key("ORG", organizationId, "THREAD", threadId),
    sk: key("THREAD", threadId),
  });
  return record?.itemType === "thread" ? record : undefined;
}

export function tombstoneRecord(
  thread: Pick<ThreadRecord["data"], "environmentId" | "id" | "organizationId" | "projectId">,
  operationId: Ulid,
  erasedAt: string,
) {
  return withCanonicalRecordKeys({
    data: {
      environmentId: thread.environmentId,
      erasedAt,
      operationId,
      organizationId: thread.organizationId,
      projectId: thread.projectId,
      threadId: thread.id,
    },
    itemType: "thread-tombstone" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "thread-tombstone" }>;
}

export function erasureItemRecord(input: {
  readonly fencedAt?: string;
  readonly now: string;
  readonly operationId: Ulid;
  readonly thread: Pick<
    ThreadRecord["data"],
    "environmentId" | "id" | "organizationId" | "projectId"
  >;
}) {
  return withCanonicalRecordKeys({
    data: {
      createdAt: input.now,
      environmentId: input.thread.environmentId,
      ...(input.fencedAt ? { fencedAt: input.fencedAt } : {}),
      ingressRouteIds: [],
      operationId: input.operationId,
      organizationId: input.thread.organizationId,
      projectId: input.thread.projectId,
      recordsDeleted: 0,
      runIds: [],
      stage: input.fencedAt ? ("fenced" as const) : ("planned" as const),
      threadId: input.thread.id,
      updatedAt: input.now,
      version: 1,
    },
    itemType: "conversation-erasure-item" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "conversation-erasure-item" }>;
}

export async function requestThreadErasure(
  context: ErasureRequestContext,
  input: Parameters<ConversationErasureStore["requestThreadErasure"]>[0],
): Promise<RequestThreadErasureResult> {
  const { database } = context;
  const { organizationId, environmentId, projectId } = input.scope;
  for (let attempt = 1; ; attempt += 1) {
    const now = context.now().toISOString();
    const tombstone = await readThreadTombstone(database, organizationId, input.threadId);
    if (tombstone) {
      if (
        tombstone.data.environmentId !== environmentId ||
        tombstone.data.projectId !== projectId
      ) {
        return { kind: "not-found" };
      }
      const record = await readOperationRecord(
        database,
        organizationId,
        tombstone.data.operationId,
      );
      if (!record) throw new Error("Thread tombstone names a missing erasure operation.");
      if (record.data.kind !== "thread-erasure") return { kind: "not-found" };
      return { kind: "replayed", operation: await resumeOnReplay(database, record, now) };
    }
    const thread = await readThread(database, organizationId, input.threadId);
    if (
      !thread ||
      thread.data.environmentId !== environmentId ||
      thread.data.projectId !== projectId
    ) {
      return { kind: "not-found" };
    }
    if (thread.data.executionBindingId) return { kind: "not-erasable" };
    if ((await listActiveRuns(database, organizationId, input.threadId)).length > 0) {
      return { kind: "thread-active" };
    }
    const operationId = context.generateId();
    const operation = conversationOperation({
      createdAt: now,
      id: operationId,
      idempotencyKey: `thread-erasure:${input.threadId}`,
      kind: "thread-erasure",
      organizationId,
      requester: input.requester,
      state: {
        counts: { ...EMPTY_COUNTS, threadsPlanned: 1 },
        environmentId,
        phase: "mail",
        target: { kind: "thread", threadId: input.threadId },
      },
    });
    const { fencedAtRequest } = inboxThreadsByFencingPhase(
      await linkedInboxThreads(database, organizationId, input.threadId),
    );
    const inboxThreadFences = await inboxThreadFencePuts(database, operation, fencedAtRequest, now);
    try {
      await transactWithSemanticEvents(
        database,
        [
          { kind: "delete", record: thread },
          { kind: "put", record: tombstoneRecord(thread.data, operationId, now) },
          { kind: "put", record: operationRecord(operation) },
          { kind: "put", record: governanceOperationHistoryRecord(operation) },
          {
            kind: "put",
            record: erasureItemRecord({
              fencedAt: now,
              now,
              operationId,
              thread: thread.data,
            }),
          },
          ...inboxThreadFences,
        ],
        [
          lifecycleEvent({
            eventId: context.generateId(),
            occurredAt: now,
            operation,
            payload: { threadId: input.threadId },
            requester: input.requester,
            stage: "erasure-requested",
          }),
        ],
      );
      return { kind: "created", operation };
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause) || attempt >= MAX_REQUEST_ATTEMPTS) throw cause;
    }
  }
}

export async function requestEndUserErasure(
  context: ErasureRequestContext,
  input: Parameters<ConversationErasureStore["requestEndUserErasure"]>[0],
): Promise<RequestEndUserErasureResult> {
  const { database } = context;
  const { endUserKey, environmentId, organizationId } = input;
  for (let attempt = 1; ; attempt += 1) {
    const now = context.now().toISOString();
    const fence = await database.getRecord(
      "control",
      endUserErasureFenceKey(organizationId, environmentId, endUserKey),
    );
    if (fence?.itemType === "end-user-erasure-fence") {
      const record = await readOperationRecord(database, organizationId, fence.data.operationId);
      if (!record) throw new Error("End-user erasure fence names a missing operation.");
      return { kind: "replayed", operation: await resumeOnReplay(database, record, now) };
    }
    const operationId = context.generateId();
    const operation = conversationOperation({
      createdAt: now,
      id: operationId,
      idempotencyKey: `end-user-erasure:${operationId}`,
      kind: "end-user-erasure",
      organizationId,
      requester: input.requester,
      state: {
        counts: EMPTY_COUNTS,
        environmentId,
        phase: "planning",
        target: { endUserKey, kind: "end-user" },
      },
    });
    try {
      await transactWithSemanticEvents(
        database,
        [
          {
            kind: "put",
            record: withCanonicalRecordKeys({
              data: { createdAt: now, endUserKey, environmentId, operationId, organizationId },
              itemType: "end-user-erasure-fence" as const,
            }) as Extract<PlatformRecord, { readonly itemType: "end-user-erasure-fence" }>,
          },
          { kind: "put", record: operationRecord(operation) },
          { kind: "put", record: governanceOperationHistoryRecord(operation) },
        ],
        [
          lifecycleEvent({
            eventId: context.generateId(),
            occurredAt: now,
            operation,
            payload: {},
            requester: input.requester,
            stage: "erasure-requested",
          }),
        ],
      );
      return { kind: "created", operation };
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause) || attempt >= MAX_REQUEST_ATTEMPTS) throw cause;
    }
  }
}
