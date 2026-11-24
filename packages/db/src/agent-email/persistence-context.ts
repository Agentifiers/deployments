import type {
  AgentEmailDomainEvent,
  AgentEmailDraftRecord,
  AgentEmailMessageRecord,
  AgentEmailThreadRecord,
  AgentEmailUsageEventRecord,
} from "@deployments-ai/agent-email";
import { Schema } from "effect";
import {
  boundedAgentEmailThreadParticipants,
  type AgentEmailAttachmentBlob,
  type AgentEmailDraftBodyReferences,
  type AgentEmailMessageBodyReferences,
  type AgentEmailPlatformScope,
} from "./record-mapping.ts";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { DynamoValue } from "../record-schema.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { InboxMailErasedError } from "../thread-erasure/fences.ts";
import {
  makeAgentEmailMailSubjects,
  type AgentEmailEndUserKeys,
  type AgentEmailMailSubjects,
} from "./mail-subjects.ts";

export class AgentEmailPersistenceError extends Schema.TaggedErrorClass<AgentEmailPersistenceError>()(
  "AgentEmailPersistenceError",
  {
    cause: Schema.Unknown,
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export class AgentEmailQuotaExceededError extends Schema.TaggedErrorClass<AgentEmailQuotaExceededError>()(
  "AgentEmailQuotaExceededError",
  {
    limit: Schema.Number,
    message: Schema.String,
    usage: Schema.Number,
  },
) {}

export interface PersistAgentEmailMessageInput {
  readonly attachments?: readonly AgentEmailAttachmentBlob[];
  readonly bodyReferences?: AgentEmailMessageBodyReferences;
  readonly dailyQuota?: {
    readonly expiresAt: string;
    readonly limit: number;
    readonly observedUsage: number;
    readonly window: string;
  };
  readonly draftTransition?: {
    readonly next: AgentEmailDraftRecord;
    readonly previous: Extract<PlatformRecord, { readonly itemType: "inbox-draft" }>;
  };
  readonly event: AgentEmailDomainEvent;
  readonly message: AgentEmailMessageRecord;
  readonly thread?: AgentEmailThreadRecord;
  readonly usage: readonly AgentEmailUsageEventRecord[];
}

export interface AgentEmailDraftBodyReferenceUpdate {
  readonly htmlBodyRef?: AgentEmailDraftBodyReferences["htmlBodyRef"] | null;
  readonly textBodyRef?: AgentEmailDraftBodyReferences["textBodyRef"] | null;
}

export interface AgentEmailMessageBodyReferenceUpdate {
  readonly htmlBodyRef?: AgentEmailMessageBodyReferences["htmlBodyRef"] | null;
  readonly rawReference?: AgentEmailMessageBodyReferences["rawReference"] | null;
  readonly textBodyRef?: AgentEmailMessageBodyReferences["textBodyRef"] | null;
}

export type AgentEmailPolicyInboxUpdate = Ulid | null | undefined;
export type AgentEmailInboxPlacementUpdate = Ulid | null | undefined;

function failure(operation: string, cause: unknown) {
  return new AgentEmailPersistenceError({
    cause,
    message: `Agent email ${operation} failed${
      cause instanceof Error && cause.message ? `: ${cause.message}` : "."
    }`,
    operation,
  });
}

async function run<A>(operation: string, promise: Promise<A>): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof InboxMailErasedError) throw cause;
    throw failure(operation, cause);
  }
}

function updateVersion<Current extends PlatformRecord>(next: Current, previous: Current): Current {
  return {
    ...next,
    data: {
      ...next.data,
      version: Number((previous.data as { readonly version?: number }).version ?? 0) + 1,
    },
  };
}

function mergeThreadRecord(
  previous: Extract<PlatformRecord, { readonly itemType: "inbox-thread" }>,
  incoming: Extract<PlatformRecord, { readonly itemType: "inbox-thread" }>,
) {
  const incomingIsLatest = incoming.data.lastMessageAt >= previous.data.lastMessageAt;
  const clientId = previous.data.clientId ?? incoming.data.clientId;
  return {
    ...incoming,
    data: {
      ...incoming.data,
      ...(clientId ? { clientId } : {}),
      createdAt: previous.data.createdAt,
      lastMessageAt: incomingIsLatest ? incoming.data.lastMessageAt : previous.data.lastMessageAt,
      messageCount: previous.data.messageCount + 1,
      participants: boundedAgentEmailThreadParticipants(
        [...previous.data.participants, ...incoming.data.participants],
        incoming.data.participants,
      ),
      subject: incomingIsLatest ? incoming.data.subject : previous.data.subject,
      threadKey: previous.data.threadKey,
      updatedAt:
        incoming.data.updatedAt >= previous.data.updatedAt
          ? incoming.data.updatedAt
          : previous.data.updatedAt,
    },
  } satisfies Extract<PlatformRecord, { readonly itemType: "inbox-thread" }>;
}

function semanticEventRecord(
  scope: AgentEmailPlatformScope,
  event: AgentEmailDomainEvent,
  aggregateVersion: number,
): Extract<PlatformRecord, { readonly itemType: "semantic-event" }> {
  return makeSemanticEventRecord({
    aggregateId: event.aggregateId as Ulid,
    aggregateType: event.aggregateType,
    aggregateVersion,
    environmentId: scope.environmentId,
    eventId: event.eventId as Ulid,
    eventType: event.eventType,
    occurredAt: event.payload.occurredAt,
    organizationId: scope.organizationId,
    payload: JSON.parse(JSON.stringify(event.payload)) as Readonly<Record<string, DynamoValue>>,
    projectId: scope.projectId,
  });
}

function queryByEnvironment(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  environmentId: Ulid,
  itemType: PlatformRecord["itemType"],
  exclusiveStartKey?: Record<string, unknown>,
) {
  return database.queryRecords(table, {
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
    ExpressionAttributeValues: {
      ":pk": `ENV#${environmentId}`,
      ":sk": `${itemType.toUpperCase()}#`,
    },
    IndexName: "gsi2",
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
  });
}

function queryAggregate(
  database: DynamoDatabaseService,
  table: "execution",
  partitionKey: string,
  itemType: PlatformRecord["itemType"],
  exclusiveStartKey?: Record<string, unknown>,
  consistentRead = false,
) {
  return database.queryRecords(table, {
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    ...(consistentRead ? { ConsistentRead: true } : {}),
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: { ":pk": partitionKey, ":sk": `${itemType.toUpperCase()}#` },
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
  });
}

function querySemanticEvents(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  aggregateId: string,
  exclusiveStartKey?: Record<string, unknown>,
) {
  return database.queryRecords("events", {
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    ConsistentRead: true,
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: {
      ":pk": key("ORG", organizationId, "AGGREGATE", "agent_email", aggregateId),
      ":sk": key("SEMANTIC-EVENT"),
    },
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
  });
}

function queryExpiredRawMessages(
  database: DynamoDatabaseService,
  scope: AgentEmailPlatformScope,
  expiresAt: string,
  limit: number,
  exclusiveStartKey?: Record<string, unknown>,
) {
  return database.queryRecords("execution", {
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
    ExpressionAttributeValues: {
      ":pk": key("INBOX-RAW-RETENTION", scope.organizationId, scope.projectId, scope.environmentId),
      ":sk": `${key(expiresAt)}#\uffff`,
    },
    IndexName: "gsi1",
    KeyConditionExpression: "#pk = :pk AND #sk <= :sk",
    Limit: limit,
  });
}

function only<ItemType extends PlatformRecord["itemType"]>(
  records: readonly PlatformRecord[],
  itemType: ItemType,
) {
  return records.filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: ItemType }> =>
      record.itemType === itemType,
  );
}

type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export interface AgentEmailRepositoryContext {
  readonly allPages: (
    operation: string,
    query: (
      exclusiveStartKey?: Record<string, unknown>,
    ) => ReturnType<DynamoDatabaseService["queryRecords"]>,
  ) => Promise<PlatformRecord[]>;
  readonly createWithEvent: <Resource extends PlatformRecord>(
    resource: Resource,
    event: AgentEmailDomainEvent,
    extra?: readonly TransactionOperation[],
  ) => Promise<Resource>;
  readonly database: DynamoDatabaseService;
  readonly failure: typeof failure;
  readonly getDomain: (id: string) => Promise<RecordOf<"inbox-domain"> | undefined>;
  readonly getDraft: (
    inboxId: string,
    draftId: string,
  ) => Promise<RecordOf<"inbox-draft"> | undefined>;
  readonly getEnvironmentRecord: <ItemType extends PlatformRecord["itemType"]>(
    itemType: ItemType,
    id: string,
    table?: "control" | "execution",
    consistentRead?: boolean,
  ) => Promise<RecordOf<ItemType> | undefined>;
  readonly getInbox: (
    id: string,
    consistentRead?: boolean,
  ) => Promise<RecordOf<"inbox"> | undefined>;
  readonly getMessage: (
    inboxId: string,
    messageId: string,
  ) => Promise<RecordOf<"inbox-message"> | undefined>;
  readonly getOrganizationRecord: <ItemType extends PlatformRecord["itemType"]>(
    itemType: ItemType,
    id: string,
  ) => Promise<RecordOf<ItemType> | undefined>;
  readonly getThread: (
    inboxId: string,
    threadId: string,
  ) => Promise<RecordOf<"inbox-thread"> | undefined>;
  readonly inScope: (record: PlatformRecord | undefined) => boolean;
  readonly mailSubjects: AgentEmailMailSubjects;
  readonly mergeThreadRecord: typeof mergeThreadRecord;
  readonly only: typeof only;
  readonly queryAggregate: typeof queryAggregate;
  readonly queryByEnvironment: typeof queryByEnvironment;
  readonly queryExpiredRawMessages: typeof queryExpiredRawMessages;
  readonly run: typeof run;
  readonly scope: AgentEmailPlatformScope;
  readonly updateVersion: typeof updateVersion;
  readonly updateWithEvent: <Current extends PlatformRecord>(
    previous: Current,
    next: Current,
    event: AgentEmailDomainEvent,
    extra?: readonly TransactionOperation[],
  ) => Promise<Current>;
}

export function makeAgentEmailRepositoryContext(
  database: DynamoDatabaseService,
  scope: AgentEmailPlatformScope,
  endUserKeys?: AgentEmailEndUserKeys,
): AgentEmailRepositoryContext {
  const environmentPartition = `ORG#${scope.organizationId}#ENV#${scope.environmentId}`;

  function inScope(record: PlatformRecord | undefined) {
    if (!record) return false;
    const data = record.data as {
      readonly environmentId?: string;
      readonly organizationId?: string;
      readonly projectId?: string;
    };
    return (
      data.organizationId === scope.organizationId &&
      data.projectId === scope.projectId &&
      data.environmentId === scope.environmentId
    );
  }

  async function getOrganizationRecord<ItemType extends PlatformRecord["itemType"]>(
    itemType: ItemType,
    id: string,
  ): Promise<RecordOf<ItemType> | undefined> {
    const result = await run(
      `get-${itemType}`,
      database.getRecord(tableForItemType(itemType), {
        pk: `ORG#${scope.organizationId}`,
        sk: `${itemType.toUpperCase()}#${id}`,
      }),
    );
    const value = result;
    return value?.itemType === itemType &&
      (value.data as { readonly organizationId?: string }).organizationId === scope.organizationId
      ? (value as RecordOf<ItemType>)
      : undefined;
  }

  async function allPages(
    operation: string,
    query: (
      exclusiveStartKey?: Record<string, unknown>,
    ) => ReturnType<DynamoDatabaseService["queryRecords"]>,
  ) {
    const items: PlatformRecord[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await run(operation, query(exclusiveStartKey));
      items.push(...result.items);
      exclusiveStartKey = result.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  async function getEnvironmentRecord<ItemType extends PlatformRecord["itemType"]>(
    itemType: ItemType,
    id: string,
    table: "control" | "execution" = "control",
    consistentRead = true,
  ): Promise<RecordOf<ItemType> | undefined> {
    const result = await run(
      `get-${itemType}`,
      database.getRecord(
        table,
        {
          pk: environmentPartition,
          sk: `${itemType.toUpperCase()}#${id}`,
        },
        consistentRead,
      ),
    );
    const value = result;
    return value?.itemType === itemType && inScope(value)
      ? (value as RecordOf<ItemType>)
      : undefined;
  }

  async function createWithEvent<Resource extends PlatformRecord>(
    resource: Resource,
    event: AgentEmailDomainEvent,
    extra: readonly TransactionOperation[] = [],
  ): Promise<Resource> {
    const eventState = await semanticEventState(event);
    if (eventState.applied) return getCommittedResource(resource, event.eventId);
    const operations: TransactionOperation[] = [{ kind: "put", record: resource }, ...extra];
    await run(
      "create-with-event",
      transactWithSemanticEvents(
        database,
        operations,
        [semanticEventRecord(scope, event, eventState.nextAggregateVersion)],
        event.eventId,
      ),
    );
    return resource;
  }

  async function updateWithEvent<Current extends PlatformRecord>(
    previous: Current,
    next: Current,
    event: AgentEmailDomainEvent,
    extra: readonly TransactionOperation[] = [],
  ): Promise<Current> {
    const eventState = await semanticEventState(event);
    if (eventState.applied) return getCommittedResource(next, event.eventId);
    await run(
      "update-with-event",
      transactWithSemanticEvents(
        database,
        [{ kind: "put", previousRecord: previous, record: next }, ...extra],
        [semanticEventRecord(scope, event, eventState.nextAggregateVersion)],
        event.eventId,
      ),
    );
    return next;
  }

  async function getCommittedResource<Resource extends PlatformRecord>(
    resource: Resource,
    eventId: string,
  ): Promise<Resource> {
    const result = await run(
      "get-committed-resource",
      database.getRecord(tableForItemType(resource.itemType), {
        pk: resource.pk,
        sk: resource.sk,
      }),
    );
    const committed = result;
    if (!committed || committed.itemType !== resource.itemType || !inScope(committed)) {
      throw failure(
        "event-backed-write",
        new Error(`Committed ${resource.itemType} resource is missing for event ${eventId}.`),
      );
    }
    return committed as Resource;
  }

  async function semanticEventState(event: AgentEmailDomainEvent) {
    const events = await allPages("find-agent-email-event", (exclusiveStartKey) =>
      querySemanticEvents(database, scope.organizationId, event.aggregateId, exclusiveStartKey),
    );
    const aggregateEvents = only(events, "semantic-event").filter(
      (record) =>
        record.data.aggregateType === event.aggregateType &&
        record.data.aggregateId === event.aggregateId &&
        record.data.organizationId === scope.organizationId &&
        record.data.projectId === scope.projectId &&
        record.data.environmentId === scope.environmentId,
    );
    return {
      applied: aggregateEvents.some((record) => record.data.eventId === event.eventId),
      nextAggregateVersion:
        aggregateEvents.reduce(
          (latest, record) => Math.max(latest, record.data.aggregateVersion),
          0,
        ) + 1,
    };
  }

  async function getDomain(id: string) {
    return getEnvironmentRecord("inbox-domain", id);
  }

  async function getInbox(id: string, consistentRead = true) {
    const result = await run(
      "get-inbox",
      database.getRecord(
        "control",
        {
          pk: `ORG#${scope.organizationId}#INBOX#${id}`,
          sk: `INBOX#${id}`,
        },
        consistentRead,
      ),
    );
    const value = result;
    return value?.itemType === "inbox" && inScope(value) ? value : undefined;
  }

  async function getMessage(inboxId: string, messageId: string) {
    const result = await run(
      "get-message",
      database.getRecord("execution", {
        pk: `ORG#${scope.organizationId}#INBOX#${inboxId}`,
        sk: `INBOX-MESSAGE#${messageId}`,
      }),
    );
    const value = result;
    return value?.itemType === "inbox-message" && inScope(value) ? value : undefined;
  }

  async function getDraft(inboxId: string, draftId: string) {
    const result = await run(
      "get-draft",
      database.getRecord(
        "execution",
        {
          pk: `ORG#${scope.organizationId}#INBOX#${inboxId}`,
          sk: `INBOX-DRAFT#${draftId}`,
        },
        true,
      ),
    );
    const value = result;
    return value?.itemType === "inbox-draft" && inScope(value) ? value : undefined;
  }

  async function getThread(inboxId: string, threadId: string) {
    const result = await run(
      "get-thread",
      database.getRecord("execution", {
        pk: `ORG#${scope.organizationId}#INBOX#${inboxId}`,
        sk: `INBOX-THREAD#${threadId}`,
      }),
    );
    const value = result;
    return value?.itemType === "inbox-thread" && inScope(value) ? value : undefined;
  }

  async function inboxAddress(inboxId: string) {
    return (await getInbox(inboxId))?.data.address;
  }

  return {
    allPages,
    createWithEvent,
    database,
    failure,
    getDomain,
    getDraft,
    getEnvironmentRecord,
    getInbox,
    getMessage,
    getOrganizationRecord,
    getThread,
    inScope,
    mailSubjects: makeAgentEmailMailSubjects(database, scope, inboxAddress, endUserKeys),
    mergeThreadRecord,
    only,
    queryAggregate,
    queryByEnvironment,
    queryExpiredRawMessages,
    run,
    scope,
    updateVersion,
    updateWithEvent,
  };
}
