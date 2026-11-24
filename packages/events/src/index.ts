import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  ConsumerCheckpointRecord,
  DeliveryDeduplicationRecord,
  SemanticEventData,
  SemanticEventRecord,
  INTERNAL_SEMANTIC_EVENT_PAYLOAD_KEY,
  makeSemanticEventRecord as makeDbSemanticEventRecord,
  replaySemanticEvents as replayDbSemanticEvents,
  transactWithSemanticEvents as transactDbWithSemanticEvents,
  decodePlatformRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type IdGeneratorService,
  type PlatformRecord,
  type RecordDecodeError,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Effect, Schema } from "effect";
import type { ChannelEventType } from "./channels.ts";
import type { ProviderEventType } from "./providers.ts";

export type { Ulid } from "@deployments-ai/db";
export { internalSemanticEventPayload } from "@deployments-ai/db";

export { CHANNEL_EVENT_TYPES, type ChannelEventType } from "./channels.ts";
export { PROVIDER_EVENT_TYPES, type ProviderEventType } from "./providers.ts";

export const PLATFORM_EVENT_SOURCE = "deployments-ai.platform";
export const MAX_EVENTBRIDGE_BATCH_SIZE = 10;

export const CrudAction = Schema.Literals(["created", "updated", "deleted"]);
export type CrudAction = typeof CrudAction.Type;

export type SemanticEventRecordValue = typeof SemanticEventRecord.Type;
export type SemanticEvent = typeof SemanticEventData.Type;
export type ConsumerCheckpointRecordValue = typeof ConsumerCheckpointRecord.Type;
export type DeliveryDeduplicationRecordValue = typeof DeliveryDeduplicationRecord.Type;

export interface CreateSemanticEventOptions {
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

export type GenerateSemanticEventOptions = Omit<CreateSemanticEventOptions, "eventId">;

export interface CreateCrudSemanticEventOptions extends Omit<
  CreateSemanticEventOptions,
  "eventType"
> {
  readonly action: CrudAction;
  readonly entity: string;
}

export interface SemanticEventBridgeEntry {
  readonly Detail: string;
  readonly DetailType: string;
  readonly EventBusName: string;
  readonly Source: string;
}

export interface DynamoStreamRecordLike {
  readonly dynamodb?: {
    readonly NewImage?: Record<string, AttributeValue>;
    readonly SequenceNumber?: string;
  };
  readonly eventID?: string;
  readonly eventName?: string;
  readonly eventSourceARN?: string;
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

export type AggregateDeliveryDecision =
  | { readonly kind: "duplicate"; readonly lastAggregateVersion: number }
  | { readonly kind: "gap"; readonly expectedAggregateVersion: number }
  | { readonly kind: "next" };

export class SemanticEventStreamDecodeError extends Schema.TaggedErrorClass<SemanticEventStreamDecodeError>()(
  "SemanticEventStreamDecodeError",
  {
    cause: Schema.Unknown,
    eventId: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

const CRUD_OPERATION_TO_ACTION: Readonly<Record<string, CrudAction | undefined>> = {
  CREATE: "created",
  DELETE: "deleted",
  INSERT: "created",
  PATCH: "updated",
  POST: "created",
  PUT: "updated",
  UPDATE: "updated",
  UPSERT: "updated",
};

function occurredAt(value: Date | string | undefined) {
  return typeof value === "string" ? value : (value ?? new Date()).toISOString();
}

export function normalizeEntityName(entity: string) {
  return entity.trim().replaceAll("_", "-").replaceAll(/\s+/g, "-").toLowerCase();
}

export function crudActionForOperation(operation: string) {
  return CRUD_OPERATION_TO_ACTION[operation.trim().toUpperCase()];
}

export function parseSemanticEvent(value: unknown) {
  return Schema.decodeUnknownSync(SemanticEventData)(value);
}

export function semanticEventIsInternal(event: SemanticEvent | SemanticEventRecordValue): boolean {
  const detail = "itemType" in event ? event.data : event;
  return detail.payload[INTERNAL_SEMANTIC_EVENT_PAYLOAD_KEY] === true;
}

export function crudEventType(entity: string, action: CrudAction) {
  const normalizedEntity = normalizeEntityName(entity);
  if (!normalizedEntity) throw new TypeError("Semantic event entities must not be empty.");
  return `${normalizedEntity}.${action}`;
}

export function makeSemanticEventRecord(
  options: CreateSemanticEventOptions,
): SemanticEventRecordValue {
  return makeDbSemanticEventRecord(options);
}

export function makeChannelSemanticEventRecord(
  options: Omit<CreateSemanticEventOptions, "eventType"> & {
    readonly eventType: ChannelEventType;
  },
) {
  return makeSemanticEventRecord(options);
}

export function makeProviderSemanticEventRecord(
  options: Omit<CreateSemanticEventOptions, "eventType"> & {
    readonly eventType: ProviderEventType;
  },
) {
  return makeSemanticEventRecord(options);
}

export function generateSemanticEventRecord(
  idGenerator: IdGeneratorService,
  options: GenerateSemanticEventOptions,
): SemanticEventRecordValue {
  return makeSemanticEventRecord({ ...options, eventId: idGenerator.generate() });
}

export function makeCrudSemanticEventRecord(
  options: CreateCrudSemanticEventOptions,
): SemanticEventRecordValue {
  return makeSemanticEventRecord({
    ...options,
    eventType: crudEventType(options.entity, options.action),
  });
}

export function semanticEventBridgeEntry(
  event: SemanticEvent | SemanticEventRecordValue,
  eventBusName: string,
): SemanticEventBridgeEntry {
  const detail = "itemType" in event ? event.data : event;
  return {
    Detail: JSON.stringify(detail),
    DetailType: detail.eventType,
    EventBusName: eventBusName,
    Source: PLATFORM_EVENT_SOURCE,
  };
}

export function transactWithSemanticEvents(
  database: DynamoDatabaseService,
  operations: readonly TransactionOperation[],
  events: readonly SemanticEventRecordValue[],
  clientRequestToken?: string,
  signal?: AbortSignal,
) {
  return transactDbWithSemanticEvents(database, operations, events, clientRequestToken, signal);
}

export function replaySemanticEvents(
  database: DynamoDatabaseService,
  options: ReplaySemanticEventsOptions,
): Promise<ReplaySemanticEventsResult> {
  return replayDbSemanticEvents(database, options);
}

export function classifyAggregateDelivery(
  event: SemanticEvent,
  lastAggregateVersion: number,
): AggregateDeliveryDecision {
  if (!Number.isSafeInteger(lastAggregateVersion) || lastAggregateVersion < 0) {
    throw new RangeError("Projection aggregate versions must be non-negative safe integers.");
  }
  if (event.aggregateVersion <= lastAggregateVersion) {
    return { kind: "duplicate", lastAggregateVersion };
  }
  const expectedAggregateVersion = lastAggregateVersion + 1;
  if (event.aggregateVersion !== expectedAggregateVersion) {
    return { expectedAggregateVersion, kind: "gap" };
  }
  return { kind: "next" };
}

export function makeDeliveryDeduplicationRecord(options: {
  readonly consumer: string;
  readonly deliveredAt: Date | string;
  readonly eventId: Ulid;
  readonly expiresAt: Date | string;
  readonly resultHash?: string;
}): DeliveryDeduplicationRecordValue {
  const expiresAt = occurredAt(options.expiresAt);
  return Schema.decodeUnknownSync(DeliveryDeduplicationRecord)(
    withCanonicalRecordKeys({
      data: {
        consumer: options.consumer,
        deliveredAt: occurredAt(options.deliveredAt),
        eventId: options.eventId,
        expiresAt,
        ...(options.resultHash ? { resultHash: options.resultHash } : {}),
      },
      itemType: "delivery-deduplication",
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }),
  );
}

export function makeConsumerCheckpointRecord(options: {
  readonly consumer: string;
  readonly cursor: string;
  readonly lastEventId?: Ulid;
  readonly now?: Date | string;
  readonly shardId: string;
  readonly status?: ConsumerCheckpointRecordValue["data"]["status"];
  readonly version?: number;
}): ConsumerCheckpointRecordValue {
  const timestamp = occurredAt(options.now);
  return Schema.decodeUnknownSync(ConsumerCheckpointRecord)(
    withCanonicalRecordKeys({
      data: {
        consumer: options.consumer,
        createdAt: timestamp,
        cursor: options.cursor,
        ...(options.lastEventId ? { lastEventId: options.lastEventId } : {}),
        shardId: options.shardId,
        status: options.status ?? "active",
        updatedAt: timestamp,
        version: options.version ?? 1,
      },
      itemType: "consumer-checkpoint",
    }),
  );
}

export function semanticEventRecordFromStreamRecord(
  record: DynamoStreamRecordLike,
): Effect.Effect<
  SemanticEventRecordValue | undefined,
  SemanticEventStreamDecodeError | RecordDecodeError
> {
  if (record.eventName !== "INSERT") return Effect.succeed(undefined);
  if (!record.dynamodb?.NewImage) {
    return Effect.fail(
      new SemanticEventStreamDecodeError({
        eventId: record.eventID,
        cause: record,
        message: "DynamoDB INSERT stream record is missing NewImage.",
      }),
    );
  }

  return Effect.try({
    catch: (cause) =>
      new SemanticEventStreamDecodeError({
        eventId: record.eventID,
        cause,
        message: "DynamoDB stream image could not be unmarshalled.",
      }),
    try: () => unmarshall(record.dynamodb?.NewImage ?? {}),
  }).pipe(
    Effect.flatMap(decodePlatformRecord),
    Effect.map((platformRecord: PlatformRecord) =>
      platformRecord.itemType === "semantic-event" ? platformRecord : undefined,
    ),
  );
}
