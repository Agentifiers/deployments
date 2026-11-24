import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { GovernanceOperation } from "../governance/contracts.ts";
import { operationRecord } from "../governance/dynamo-store.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import type { ConversationErasureItem, FenceItemResult } from "./contracts.ts";
import { listMailItems, planEndUserMail, type ConversationThreadTarget } from "./mail-planning.ts";
import { lifecycleEvent, parseUlid, readOperationRecord } from "./operations.ts";
import { commitInBatches, only, queryPartition } from "./queries.ts";
import { conversationErasureItemPartition, endUserPartition } from "./record-keys.ts";
import {
  erasureItemRecord,
  listActiveRuns,
  readThread,
  readThreadTombstone,
  tombstoneRecord,
  type ErasureRequestContext,
} from "./requests.ts";

const MAX_FENCE_ATTEMPTS = 4;

function conversationState(operation: GovernanceOperation) {
  if (!operation.conversationErasure) {
    throw new Error(`Governance operation ${operation.id} is not a conversation erasure.`);
  }
  return operation.conversationErasure;
}

export async function listItems(
  database: DynamoDatabaseService,
  operation: GovernanceOperation,
): Promise<readonly ConversationErasureItem[]> {
  return only(
    await queryPartition(
      database,
      "control",
      conversationErasureItemPartition(operation.organizationId, operation.id),
      "CONVERSATION-ERASURE-ITEM#",
    ),
    "conversation-erasure-item",
  );
}

export async function planEndUserItems(
  context: ErasureRequestContext,
  operation: GovernanceOperation,
): Promise<number> {
  const state = conversationState(operation);
  if (state.target.kind !== "end-user" || !state.target.endUserKey) {
    throw new Error("Only an end-user erasure with its subject key can be planned.");
  }
  const subject = { endUserKey: state.target.endUserKey, environmentId: state.environmentId };
  const indexed = only(
    await queryPartition(
      context.database,
      "control",
      endUserPartition(operation.organizationId, subject.environmentId, subject.endUserKey),
      "END-USER-THREAD#",
    ),
    "end-user-thread",
  );
  const threads = new Map<string, ConversationThreadTarget>();
  for (const { data } of indexed) {
    threads.set(data.threadId, {
      environmentId: data.environmentId,
      id: data.threadId,
      organizationId: data.organizationId,
      projectId: data.projectId,
    });
  }
  for (const thread of await planEndUserMail(context, operation, subject)) {
    threads.set(thread.id, thread);
  }
  const planned = new Set(
    (await listItems(context.database, operation)).map((item) => item.data.threadId),
  );
  const now = context.now().toISOString();
  const creates = [...threads.values()].flatMap((thread): TransactionOperation[] =>
    planned.has(thread.id)
      ? []
      : [
          {
            kind: "put",
            record: erasureItemRecord({ now, operationId: parseUlid(operation.id), thread }),
          },
        ],
  );
  await commitInBatches(context.database, creates);
  return planned.size + creates.length;
}

export async function replaceItem(
  database: DynamoDatabaseService,
  item: ConversationErasureItem,
  changes: Partial<ConversationErasureItem["data"]>,
  now: string,
): Promise<ConversationErasureItem> {
  const next = withCanonicalRecordKeys({
    ...item,
    data: { ...item.data, ...changes, updatedAt: now, version: item.data.version + 1 },
  }) as ConversationErasureItem;
  await database.transactWrite([{ kind: "put", previousRecord: item, record: next }]);
  return next;
}

export async function fenceItem(
  context: ErasureRequestContext,
  operation: GovernanceOperation,
  initial: ConversationErasureItem,
): Promise<FenceItemResult> {
  const { database } = context;
  const { organizationId, threadId } = initial.data;
  let item = initial;
  for (let attempt = 1; ; attempt += 1) {
    const now = context.now().toISOString();
    if (item.data.stage !== "planned") return { item, kind: "fenced" };
    const tombstone = await readThreadTombstone(database, organizationId, threadId);
    if (tombstone) {
      return {
        item: await replaceItem(
          database,
          item,
          { fencedAt: tombstone.data.erasedAt, stage: "fenced" },
          now,
        ),
        kind: "fenced",
      };
    }
    const runs = await listActiveRuns(database, organizationId, threadId);
    if (runs.length > 0) return { kind: "runs-active", runs };
    const thread = await readThread(database, organizationId, threadId);
    const fenced = withCanonicalRecordKeys({
      ...item,
      data: {
        ...item.data,
        fencedAt: now,
        stage: "fenced" as const,
        updatedAt: now,
        version: item.data.version + 1,
      },
    }) as ConversationErasureItem;
    const tombstoneFor = thread?.data ?? {
      environmentId: item.data.environmentId,
      id: threadId,
      organizationId,
      projectId: item.data.projectId,
    };
    try {
      await database.transactWrite([
        ...(thread ? [{ kind: "delete" as const, record: thread }] : []),
        {
          kind: "put",
          record: tombstoneRecord(tombstoneFor, item.data.operationId, now),
        },
        { kind: "put", previousRecord: item, record: fenced },
      ]);
      return { item: fenced, kind: "fenced" };
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause) || attempt >= MAX_FENCE_ATTEMPTS) throw cause;
      const current = (await listItems(database, operation)).find(
        (candidate) => candidate.data.threadId === threadId,
      );
      if (!current) throw cause;
      item = current;
    }
  }
}

export async function finalizeOperation(
  context: ErasureRequestContext,
  operation: GovernanceOperation,
): Promise<GovernanceOperation> {
  const { database } = context;
  const state = conversationState(operation);
  const items = [
    ...(await listItems(database, operation)),
    ...(await listMailItems(database, operation)),
  ];
  await commitInBatches(
    database,
    items.map((record): TransactionOperation => ({ kind: "delete", record })),
  );
  const previous = await readOperationRecord(database, operation.organizationId, operation.id);
  if (!previous) throw new Error(`Governance operation ${operation.id} disappeared.`);
  const now = context.now().toISOString();
  const { leaseExpiresAt: _leaseExpiresAt, ...current } = operation;
  const completed: GovernanceOperation = {
    ...current,
    completedAt: now,
    conversationErasure: {
      ...state,
      phase: "finalizing",
      target: state.target.kind === "end-user" ? { kind: "end-user" } : state.target,
    },
    status: "completed",
    summary: { ...state.counts },
    updatedAt: now,
    version: operation.version + 1,
  };
  const fence =
    state.target.kind === "end-user" && state.target.endUserKey
      ? await database.getRecord("control", {
          pk: endUserPartition(
            operation.organizationId,
            state.environmentId,
            state.target.endUserKey,
          ),
          sk: key("END-USER-ERASURE-FENCE"),
        })
      : undefined;
  await transactWithSemanticEvents(
    database,
    [
      { kind: "put", previousRecord: previous, record: operationRecord(completed) },
      ...(fence ? [{ kind: "delete" as const, record: fence }] : []),
    ],
    [
      lifecycleEvent({
        eventId: context.generateId(),
        occurredAt: now,
        operation,
        payload: state.target.kind === "thread" ? { threadId: state.target.threadId } : {},
        stage: "erased",
      }),
    ],
  );
  return completed;
}
