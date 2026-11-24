import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  ActorReference,
  BlobReference,
  MAX_DYNAMODB_ITEM_BYTES,
  Metadata,
  NonNegativeSafeInteger,
  Timestamp,
  dynamoItemByteSize,
  makeRecordSchema,
  mutableResourceFields,
  stateVersionFields,
  tenantScopeFields,
} from "../record-schema.ts";
import { MONITOR_EVENTS_RECORD_SCHEMAS } from "./monitors.ts";

export const SEMANTIC_EVENT_SOURCE = "deployments-ai.platform";
export const MAX_SEMANTIC_EVENTBRIDGE_ENTRY_BYTES = 256 * 1_024;
export const MAX_SEMANTIC_AGGREGATE_TYPE_LENGTH = 128;
export const MAX_SEMANTIC_TRACE_ID_LENGTH = 256;

const encoder = new TextEncoder();

export function semanticEventBridgeDetailBytes(detail: { readonly eventType: string }) {
  return (
    encoder.encode(SEMANTIC_EVENT_SOURCE).byteLength +
    encoder.encode(detail.eventType).byteLength +
    encoder.encode(JSON.stringify(detail)).byteLength
  );
}

export const SemanticEventType = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) => {
      if (input.trim().length === 0) return "Semantic event types must not be empty.";
      if (input !== input.trim()) {
        return "Semantic event types must not contain surrounding whitespace.";
      }
      return input.length <= 128
        ? undefined
        : "Semantic event types must not exceed 128 characters.";
    }),
  ),
);

export const SemanticAggregateType = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) => {
      if (input.trim().length === 0) return "Semantic aggregate types must not be empty.";
      if (input !== input.trim()) {
        return "Semantic aggregate types must not contain surrounding whitespace.";
      }
      return input.length <= MAX_SEMANTIC_AGGREGATE_TYPE_LENGTH
        ? undefined
        : `Semantic aggregate types must not exceed ${MAX_SEMANTIC_AGGREGATE_TYPE_LENGTH} characters.`;
    }),
  ),
);

export const SemanticTraceId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) =>
      input.length <= MAX_SEMANTIC_TRACE_ID_LENGTH
        ? undefined
        : `Semantic trace IDs must not exceed ${MAX_SEMANTIC_TRACE_ID_LENGTH} characters.`,
    ),
  ),
);

export const SemanticAggregateVersion = NonNegativeSafeInteger.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Semantic aggregate versions must start at 1.",
    }),
  ),
);

const semanticEventDataFields = {
  actor: Schema.optional(ActorReference),
  aggregateId: Ulid,
  aggregateType: SemanticAggregateType,
  aggregateVersion: SemanticAggregateVersion,
  environmentId: Schema.optional(Ulid),
  eventId: Ulid,
  eventType: SemanticEventType,
  occurredAt: Timestamp,
  organizationId: Ulid,
  payload: Metadata,
  projectId: Schema.optional(Ulid),
  traceId: Schema.optional(SemanticTraceId),
};

export const SemanticEventData = Schema.Struct(semanticEventDataFields).pipe(
  Schema.refine(
    (detail): detail is typeof detail =>
      semanticEventBridgeDetailBytes(detail) < MAX_SEMANTIC_EVENTBRIDGE_ENTRY_BYTES,
    {
      identifier: "SemanticEventBridgeSize",
      message: "Semantic event detail must leave delivery failure-envelope headroom.",
    },
  ),
);

export const SemanticEventRecord = makeRecordSchema("semantic-event", semanticEventDataFields, {
  retentionTtl: true,
}).pipe(
  Schema.refine(
    (record): record is typeof record => dynamoItemByteSize(record) <= MAX_DYNAMODB_ITEM_BYTES,
    {
      identifier: "SemanticEventDynamoItemSize",
      message: "Semantic event records must fit in one DynamoDB item.",
    },
  ),
  Schema.refine(
    (record): record is typeof record =>
      semanticEventBridgeDetailBytes(record.data) < MAX_SEMANTIC_EVENTBRIDGE_ENTRY_BYTES,
    {
      identifier: "SemanticEventBridgeSize",
      message: "Semantic event detail must fit in one EventBridge PutEvents entry.",
    },
  ),
);

export const WebhookDeliveryStatus = Schema.Literals([
  "delivered",
  "failed",
  "pending",
  "retrying",
  "sending",
]);

export const WebhookDeliveryFailureReason = Schema.Literals([
  "attempts-exhausted",
  "endpoint-inactive",
  "event-unavailable",
  "non-retryable",
  "organization-suspended",
]);

export const WebhookDeliveryRecord = makeRecordSchema(
  "webhook-delivery",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    aggregateId: Ulid,
    aggregateType: SemanticAggregateType,
    aggregateVersion: SemanticAggregateVersion,
    attempt: NonNegativeSafeInteger,
    claimExpiresAt: Schema.optional(Timestamp),
    claimId: Schema.optional(Ulid),
    eventId: Ulid,
    eventType: SemanticEventType,
    failureReason: Schema.optional(WebhookDeliveryFailureReason),
    id: Ulid,
    lastAttemptAt: Schema.optional(Timestamp),
    lastError: Schema.optional(Schema.String),
    /** Set when an operator re-arms a terminal delivery; cleared by the attempt it requested. */
    manualRetryRequestedAt: Schema.optional(Timestamp),
    /** Attempt number at which the current schedule stops; a manual retry raises it by one. */
    maxAttempts: NonNegativeSafeInteger,
    nextAttemptAt: Schema.optional(Timestamp),
    responseCode: Schema.optional(Schema.Number),
    responseHeaders: Schema.optional(Metadata),
    retentionExpiresAt: Timestamp,
    status: WebhookDeliveryStatus,
    webhookEndpointId: Ulid,
  },
  { expiresAtField: "retentionExpiresAt" },
);

/** Immutable record of one delivery attempt, partitioned under its delivery. */
export const WebhookDeliveryAttemptRecord = makeRecordSchema(
  "webhook-delivery-attempt",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    attempt: NonNegativeSafeInteger,
    completedAt: Timestamp,
    durationMs: NonNegativeSafeInteger,
    error: Schema.optional(Schema.String),
    eventId: Ulid,
    manual: Schema.Boolean,
    nextAttemptAt: Schema.optional(Timestamp),
    outcome: Schema.Literals(["delivered", "failed", "retrying"]),
    responseBodyExcerpt: Schema.optional(Schema.String),
    responseCode: Schema.optional(Schema.Number),
    responseHeaders: Schema.optional(Metadata),
    retentionExpiresAt: Timestamp,
    startedAt: Timestamp,
    webhookDeliveryId: Ulid,
    webhookEndpointId: Ulid,
  },
  { expiresAtField: "retentionExpiresAt" },
);

export const IdempotencyRecord = makeRecordSchema(
  "idempotency",
  {
    ...stateVersionFields,
    commandHash: Schema.String,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    idempotencyKey: Schema.String,
    organizationId: Schema.optional(Ulid),
    principalId: Schema.optional(Ulid),
    response: Schema.optional(Metadata),
    responseEncoding: Schema.optional(Schema.Literals(["envelope-v1", "protected-envelope-v1"])),
    resourceIds: Schema.Array(Ulid),
    status: Schema.Literals(["completed", "failed", "in-progress"]),
    threadId: Schema.optional(Ulid),
  },
  { expiresAtField: "expiresAt" },
).pipe(
  Schema.refine(
    (record): record is typeof record =>
      record.data.organizationId !== undefined || record.data.principalId !== undefined,
    {
      identifier: "IdempotencyOwner",
      message: "Idempotency records require an organization or principal owner.",
    },
  ),
);

export const ConsumerCheckpointRecord = makeRecordSchema("consumer-checkpoint", {
  ...mutableResourceFields,
  consumer: Schema.String,
  cursor: Schema.String,
  lastEventId: Schema.optional(Ulid),
  shardId: Schema.String,
  status: Schema.Literals(["active", "blocked", "replaying"]),
});

export const DeliveryDeduplicationRecord = makeRecordSchema(
  "delivery-deduplication",
  {
    consumer: Schema.String,
    deliveredAt: Schema.String,
    eventId: Ulid,
    expiresAt: Timestamp,
    resultHash: Schema.optional(Schema.String),
  },
  { expiresAtField: "expiresAt" },
);

export const ReplayRequestRecord = makeRecordSchema("replay-request", {
  ...mutableResourceFields,
  completedAt: Schema.optional(Schema.String),
  consumer: Schema.String,
  fromEventId: Schema.optional(Ulid),
  id: Ulid,
  requestedByPrincipalId: Ulid,
  scope: Metadata,
  startedAt: Schema.optional(Schema.String),
  status: Schema.Literals(["canceled", "completed", "failed", "pending", "running"]),
  toEventId: Schema.optional(Ulid),
});

/**
 * Customer-visible audit history. Environment activity carries the full tenant scope and lives
 * in the environment partition; organization-level administration (organization, membership,
 * invitations, project and environment lifecycle, governance) omits `environmentId` and lives
 * in the organization partition so each event appears in exactly one audit list.
 */
export const AuditEventRecord = makeRecordSchema("audit-event", {
  action: Schema.String,
  actor: ActorReference,
  changes: Schema.optional(Metadata),
  environmentId: Schema.optional(Ulid),
  eventId: Ulid,
  occurredAt: Timestamp,
  organizationId: Ulid,
  projectId: Schema.optional(Ulid),
  resourceId: Schema.optional(Ulid),
  resourceType: Schema.optional(Schema.String),
  sourceIpHash: Schema.optional(Schema.String),
  userAgentHash: Schema.optional(Schema.String),
}).pipe(
  Schema.refine(
    (record): record is typeof record =>
      record.data.environmentId === undefined || record.data.projectId !== undefined,
    {
      identifier: "AuditEventScope",
      message: "Environment audit events require their project scope.",
    },
  ),
);

export const ImmutableAuditExportRecord = makeRecordSchema("immutable-audit-export", {
  algorithm: Schema.Literal("sha256-chain-v1"),
  archive: BlobReference,
  createdAt: Timestamp,
  createdByPrincipalId: Ulid,
  firstEventAt: Schema.optional(Timestamp),
  id: Ulid,
  lastEventAt: Schema.optional(Timestamp),
  object: BlobReference,
  organizationId: Ulid,
  recordCount: NonNegativeSafeInteger,
  retainedUntil: Timestamp,
  rootHash: Schema.String,
  signature: Schema.String,
  signatureKeyId: Schema.String,
  signaturePublicKey: Schema.String,
});

export const CommandRecord = makeRecordSchema("command", {
  ...mutableResourceFields,
  actor: ActorReference,
  commandId: Ulid,
  commandType: Schema.String,
  error: Schema.optional(Metadata),
  organizationId: Ulid,
  payloadHash: Schema.String,
  result: Schema.optional(Metadata),
  status: Schema.Literals(["accepted", "completed", "failed", "running"]),
});

export const ProjectionStateRecord = makeRecordSchema("projection-state", {
  ...mutableResourceFields,
  consumer: Schema.String,
  lastAggregateVersion: Schema.Number,
  lastEventId: Ulid,
  projectionId: Ulid,
  projectionType: Schema.String,
  state: Metadata,
});

export const ProviderWebhookReplayClaimRecord = makeRecordSchema(
  "provider-webhook-replay-claim",
  {
    ...stateVersionFields,
    claimedAt: Schema.String,
    expiresAt: Timestamp,
    installationId: Ulid,
    providerEventIdOrHash: Schema.String,
    replayNamespace: Schema.String,
    status: Schema.Literals(["claimed", "completed", "failed"]),
  },
  { expiresAtField: "expiresAt" },
);

export const EVENTS_RECORD_SCHEMAS = {
  ...MONITOR_EVENTS_RECORD_SCHEMAS,
  "audit-event": AuditEventRecord,
  command: CommandRecord,
  "consumer-checkpoint": ConsumerCheckpointRecord,
  "delivery-deduplication": DeliveryDeduplicationRecord,
  idempotency: IdempotencyRecord,
  "immutable-audit-export": ImmutableAuditExportRecord,
  "projection-state": ProjectionStateRecord,
  "provider-webhook-replay-claim": ProviderWebhookReplayClaimRecord,
  "replay-request": ReplayRequestRecord,
  "semantic-event": SemanticEventRecord,
  "webhook-delivery": WebhookDeliveryRecord,
  "webhook-delivery-attempt": WebhookDeliveryAttemptRecord,
} as const;

export const EventsRecord = Schema.Union(Object.values(EVENTS_RECORD_SCHEMAS));
export type EventsRecord = typeof EventsRecord.Type;
