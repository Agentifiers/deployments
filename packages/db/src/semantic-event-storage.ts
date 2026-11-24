import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import { key } from "./keys.ts";
import { SemanticEventData, SemanticEventRecord } from "./records/events.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";

type SemanticEvent = typeof SemanticEventData.Type;
type SemanticEventRecordValue = typeof SemanticEventRecord.Type;

/** Payload flag for audit-only events that must never fan out to customer webhooks. */
export const INTERNAL_SEMANTIC_EVENT_PAYLOAD_KEY = "deploymentsAiInternal";

export function internalSemanticEventPayload(
  payload: SemanticEvent["payload"],
): SemanticEvent["payload"] {
  return { ...payload, [INTERNAL_SEMANTIC_EVENT_PAYLOAD_KEY]: true };
}

export interface ReplaySemanticEventsOptions {
  readonly aggregateId: Ulid;
  readonly aggregateType: string;
  readonly exclusiveStartKey?: Readonly<Record<string, unknown>>;
  readonly fromVersion?: number;
  readonly limit?: number;
  readonly organizationId: Ulid;
  readonly toVersion?: number;
}

export interface ReplaySemanticEventsResult {
  readonly events: readonly SemanticEventRecordValue[];
  readonly lastEvaluatedKey?: Readonly<Record<string, unknown>>;
}

export interface CreateSemanticEventRecordOptions {
  readonly actor?: SemanticEvent["actor"];
  readonly aggregateId: Ulid;
  readonly aggregateType: string;
  readonly aggregateVersion: number;
  readonly environmentId?: Ulid;
  readonly eventId: Ulid;
  readonly eventType: string;
  readonly occurredAt?: Date | string;
  readonly organizationId: Ulid;
  readonly payload: SemanticEvent["payload"];
  readonly projectId?: Ulid;
  readonly traceId?: string;
}

function occurredAt(value: Date | string | undefined) {
  return typeof value === "string" ? value : (value ?? new Date()).toISOString();
}

function versionKey(version: number) {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError("Aggregate versions must be non-negative safe integers.");
  }
  return String(version).padStart(16, "0");
}

export function makeSemanticEventRecord(
  options: CreateSemanticEventRecordOptions,
): SemanticEventRecordValue {
  const data = Schema.decodeUnknownSync(SemanticEventData)({
    ...(options.actor ? { actor: options.actor } : {}),
    aggregateId: options.aggregateId,
    aggregateType: options.aggregateType,
    aggregateVersion: options.aggregateVersion,
    ...(options.environmentId ? { environmentId: options.environmentId } : {}),
    eventId: options.eventId,
    eventType: options.eventType,
    occurredAt: occurredAt(options.occurredAt),
    organizationId: options.organizationId,
    payload: options.payload,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
  });
  return Schema.decodeUnknownSync(SemanticEventRecord)(
    withCanonicalRecordKeys({
      data,
      itemType: "semantic-event",
    }),
  );
}

function semanticEventTransaction(
  operations: readonly TransactionOperation[],
  events: readonly SemanticEventRecordValue[],
): TransactionOperation[] {
  for (const operation of operations) {
    if (operation.kind !== "condition-check" && operation.record.itemType === "semantic-event") {
      throw new TypeError(
        "Semantic event puts and deletes must use the events argument so append-only sequencing is enforced.",
      );
    }
  }

  const aggregatePartitions = new Set<string>();
  for (const event of events) {
    if (aggregatePartitions.has(event.pk)) {
      throw new TypeError("One transaction may append at most one semantic event per aggregate.");
    }
    aggregatePartitions.add(event.pk);
  }

  return [
    ...operations,
    ...events.map((record): TransactionOperation => ({ kind: "put", record })),
  ];
}

export function transactWithSemanticEvents(
  database: DynamoDatabaseService,
  operations: readonly TransactionOperation[],
  events: readonly SemanticEventRecordValue[],
  clientRequestToken?: string,
  signal?: AbortSignal,
) {
  return database.transactWrite(
    semanticEventTransaction(operations, events),
    clientRequestToken,
    signal,
  );
}

export function transactWithSemanticEventsForErasure(
  database: DynamoDatabaseService,
  operations: readonly TransactionOperation[],
  events: readonly SemanticEventRecordValue[],
  erasureOwner: { readonly operationId: string; readonly organizationId: string },
) {
  const transaction = semanticEventTransaction(operations, events);
  if (!database.transactWriteForErasure) {
    throw new Error("Erasure-aware transaction persistence is unavailable.");
  }
  return database.transactWriteForErasure(transaction, erasureOwner);
}

export async function replaySemanticEvents(
  database: DynamoDatabaseService,
  options: ReplaySemanticEventsOptions,
): Promise<ReplaySemanticEventsResult> {
  const fromVersion = options.fromVersion ?? 0;
  const toVersion = options.toVersion ?? Number.MAX_SAFE_INTEGER;
  const expressionAttributeValues = {
    ":from": key("SEMANTIC-EVENT", versionKey(fromVersion)),
    ":pk": key(
      "ORG",
      options.organizationId,
      "AGGREGATE",
      options.aggregateType,
      options.aggregateId,
    ),
    ":to": key("SEMANTIC-EVENT", versionKey(toVersion)),
  };

  const result = await database.queryRecords("events", {
    ...(options.exclusiveStartKey ? { ExclusiveStartKey: options.exclusiveStartKey } : {}),
    ExpressionAttributeValues: expressionAttributeValues,
    ConsistentRead: true,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
    Limit: options.limit ?? 100,
    ScanIndexForward: true,
  });
  return {
    events: result.items.filter(
      (record): record is SemanticEventRecordValue => record.itemType === "semantic-event",
    ),
    ...(result.lastEvaluatedKey ? { lastEvaluatedKey: result.lastEvaluatedKey } : {}),
  };
}
