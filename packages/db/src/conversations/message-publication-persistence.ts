import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";

type MessageRecordValue = Extract<PlatformRecord, { readonly itemType: "message" }>;
type MessagePublicationRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "message-publication" }
>;
type RunRecordValue = Extract<PlatformRecord, { readonly itemType: "run" }>;
type RuntimeLeaseRecordValue = Extract<PlatformRecord, { readonly itemType: "runtime-lease" }>;
type SemanticEventRecordValue = Extract<PlatformRecord, { readonly itemType: "semantic-event" }>;
type ThreadRecordValue = Extract<PlatformRecord, { readonly itemType: "thread" }>;

interface PublicationScope {
  readonly organizationId: string;
  readonly runId: string;
  readonly threadId: string;
}

interface PublicationTransitionBase {
  readonly event: SemanticEventRecordValue;
  readonly previousThread: ThreadRecordValue;
  readonly publication: MessagePublicationRecordValue;
  readonly run: RunRecordValue;
  readonly sourceMessage: MessageRecordValue;
  readonly thread: ThreadRecordValue;
}

export interface ReserveConversationMessagePublicationCommit extends PublicationTransitionBase {
  readonly lease: RuntimeLeaseRecordValue;
}

export interface CommitConversationMessagePublication extends PublicationTransitionBase {
  readonly lease: RuntimeLeaseRecordValue;
  readonly message: MessageRecordValue;
  readonly previousPublication: MessagePublicationRecordValue;
}

export interface FinalizeConversationMessagePublication extends PublicationTransitionBase {
  readonly lease: RuntimeLeaseRecordValue;
  readonly previousPublication: MessagePublicationRecordValue;
}

export interface ReleaseConversationMessagePublicationCommit extends PublicationTransitionBase {
  readonly lease?: RuntimeLeaseRecordValue;
  readonly previousPublication: MessagePublicationRecordValue;
}

function sourceMessageCondition(source: MessageRecordValue): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :message AND #data.#id = :messageId AND #data.#runId = :runId AND #data.#role = :assistant AND #data.#contentHash = :contentHash",
    expressionAttributeNames: {
      "#contentHash": "contentHash",
      "#data": "data",
      "#id": "id",
      "#itemType": "itemType",
      "#role": "role",
      "#runId": "runId",
    },
    expressionAttributeValues: {
      ":assistant": "assistant",
      ":contentHash": source.data.contentHash,
      ":message": "message",
      ":messageId": source.data.id,
      ":runId": source.data.runId,
    },
    key: { pk: source.pk, sk: source.sk },
    kind: "condition-check",
    table: "execution",
  };
}

function completedPublishableRunCondition(run: RunRecordValue): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :run AND #data.#id = :runId AND #data.#version = :version AND #data.#status = :completed AND (#data.#trigger = :heartbeat OR #data.#trigger = :schedule OR #data.#responsePublication = :external)",
    expressionAttributeNames: {
      "#data": "data",
      "#id": "id",
      "#itemType": "itemType",
      "#status": "status",
      "#trigger": "trigger",
      "#responsePublication": "responsePublication",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":completed": "completed",
      ":external": "external",
      ":heartbeat": "heartbeat",
      ":run": "run",
      ":runId": run.data.id,
      ":schedule": "schedule",
      ":version": run.data.version,
    },
    key: { pk: run.pk, sk: run.sk },
    kind: "condition-check",
    table: "execution",
  };
}

function exactLeaseDelete(lease: RuntimeLeaseRecordValue): TransactionOperation {
  return {
    conditionExpression:
      "#data.#owner = :owner AND #data.#runId = :runId AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#owner": "owner",
      "#runId": "runId",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":owner": lease.data.owner,
      ":runId": lease.data.runId,
      ":version": lease.data.version,
    },
    kind: "delete",
    record: lease,
  };
}

function exactLeaseCondition(lease: RuntimeLeaseRecordValue): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :lease AND #data.#owner = :owner AND #data.#runId = :runId AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#owner": "owner",
      "#runId": "runId",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":lease": "runtime-lease",
      ":owner": lease.data.owner,
      ":runId": lease.data.runId,
      ":version": lease.data.version,
    },
    key: { pk: lease.pk, sk: lease.sk },
    kind: "condition-check",
    table: "execution",
  };
}

function transitionConditions(input: PublicationTransitionBase): readonly TransactionOperation[] {
  return [sourceMessageCondition(input.sourceMessage), completedPublishableRunCondition(input.run)];
}

export function makeConversationMessagePublicationPersistence(database: DynamoDatabaseService) {
  return {
    async load(scope: PublicationScope): Promise<MessagePublicationRecordValue | undefined> {
      const value = await database.getRecord(
        "execution",
        {
          pk: key("ORG", scope.organizationId, "THREAD", scope.threadId),
          sk: key("MESSAGE-PUBLICATION", scope.runId),
        },
        true,
      );
      if (value === undefined) return undefined;
      if (value.itemType !== "message-publication") {
        throw new Error("Message publication key contains an unexpected record.");
      }
      return value;
    },

    async loadThreadExecutionLease(threadId: string): Promise<RuntimeLeaseRecordValue | undefined> {
      const value = await database.getRecord(
        "execution",
        {
          pk: key("RUNTIME-LEASE", threadId),
          sk: key("RUNTIME-LEASE", `agent-run-thread/${threadId}`),
        },
        true,
      );
      if (value === undefined) return undefined;
      if (value.itemType !== "runtime-lease") {
        throw new Error("Thread execution lease key contains an unexpected record.");
      }
      return value;
    },

    async reserve(
      input: ReserveConversationMessagePublicationCommit,
      signal?: AbortSignal,
    ): Promise<void> {
      await transactWithSemanticEvents(
        database,
        [
          { kind: "put", previousRecord: input.previousThread, record: input.thread },
          { kind: "put", record: input.publication },
          { kind: "put", record: input.lease },
          ...transitionConditions(input),
        ],
        [input.event],
        undefined,
        signal,
      );
    },

    async commit(input: CommitConversationMessagePublication, signal?: AbortSignal): Promise<void> {
      await transactWithSemanticEvents(
        database,
        [
          { kind: "put", previousRecord: input.previousThread, record: input.thread },
          {
            kind: "put",
            previousRecord: input.previousPublication,
            record: input.publication,
          },
          { kind: "put", record: input.message },
          exactLeaseCondition(input.lease),
          ...transitionConditions(input),
        ],
        [input.event],
        undefined,
        signal,
      );
    },

    async finalize(
      input: FinalizeConversationMessagePublication,
      signal?: AbortSignal,
    ): Promise<void> {
      await transactWithSemanticEvents(
        database,
        [
          { kind: "put", previousRecord: input.previousThread, record: input.thread },
          {
            kind: "put",
            previousRecord: input.previousPublication,
            record: input.publication,
          },
          exactLeaseDelete(input.lease),
          ...transitionConditions(input),
        ],
        [input.event],
        undefined,
        signal,
      );
    },

    async release(
      input: ReleaseConversationMessagePublicationCommit,
      signal?: AbortSignal,
    ): Promise<void> {
      await transactWithSemanticEvents(
        database,
        [
          { kind: "put", previousRecord: input.previousThread, record: input.thread },
          {
            kind: "put",
            previousRecord: input.previousPublication,
            record: input.publication,
          },
          ...(input.lease ? [exactLeaseDelete(input.lease)] : []),
          ...transitionConditions(input),
        ],
        [input.event],
        undefined,
        signal,
      );
    },
  };
}
