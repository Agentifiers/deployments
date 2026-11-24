import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import type { ActorReference, DynamoValue } from "../record-schema.ts";
import { AuditEventRecord, type SemanticEventRecord } from "../records/events.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";

export type AuditEventRecordValue = Extract<PlatformRecord, { readonly itemType: "audit-event" }>;
type SemanticEventRecordValue = typeof SemanticEventRecord.Type;

/** Who performed an organization action. The ID is validated when the audit record decodes. */
export interface OrganizationAuditActor {
  readonly id: string;
  readonly operatorAccessGrantId?: string;
  readonly type: (typeof ActorReference.Type)["type"];
}

/**
 * One organization-level administrative action. Organization audit events never carry an
 * environment, so they are stored in the organization partition and stay out of every
 * environment audit list.
 */
export interface OrganizationAuditEventInput {
  readonly action: string;
  readonly actor: OrganizationAuditActor;
  readonly changes?: Readonly<Record<string, DynamoValue>>;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly resourceId?: string;
  readonly resourceType: string;
}

export interface OrganizationAuditEventPage {
  readonly items: readonly AuditEventRecordValue[];
  readonly lastEvaluatedKey?: Record<string, unknown>;
}

const AUDIT_EVENT_SORT_PREFIX = `${key("AUDIT-EVENT")}#`;

export function makeOrganizationAuditEventRecord(
  input: OrganizationAuditEventInput,
): AuditEventRecordValue {
  return Schema.decodeUnknownSync(AuditEventRecord)(
    withCanonicalRecordKeys({
      data: {
        action: input.action,
        actor: input.actor,
        ...(input.changes ? { changes: input.changes } : {}),
        eventId: input.eventId,
        occurredAt: input.occurredAt,
        organizationId: input.organizationId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        resourceType: input.resourceType,
      },
      itemType: "audit-event" as const,
    }),
  );
}

/**
 * Audits an organization-level administrative mutation from its primary semantic event in the
 * same transaction. The audit event reuses the semantic event ID (both are minted at commit
 * time) and omits any environment, so it is listed only by the organization audit log.
 */
export function organizationAuditOperationForEvent(
  event: SemanticEventRecordValue,
  actor: OrganizationAuditActor,
): TransactionOperation {
  return {
    kind: "put",
    record: makeOrganizationAuditEventRecord({
      action: event.data.eventType,
      actor,
      changes: event.data.payload,
      eventId: event.data.eventId,
      occurredAt: event.data.occurredAt,
      organizationId: event.data.organizationId,
      ...(event.data.projectId ? { projectId: event.data.projectId } : {}),
      resourceId: event.data.aggregateId,
      resourceType: event.data.aggregateType,
    }),
  };
}

/** Base-table partition that holds organization-level audit events. */
export function organizationAuditPartition(organizationId: string) {
  return key("ORG", organizationId);
}

/**
 * Reads one strongly consistent, newest-first physical page of organization-level audit events.
 * Event IDs are ULIDs minted when the action commits, so sort-key order is occurrence order.
 */
export async function listOrganizationAuditEventPage(
  database: DynamoDatabaseService,
  input: {
    readonly exclusiveStartKey?: Record<string, unknown>;
    readonly limit: number;
    readonly organizationId: string;
  },
): Promise<OrganizationAuditEventPage> {
  const result = await database.queryRecords("events", {
    ConsistentRead: true,
    ...(input.exclusiveStartKey ? { ExclusiveStartKey: input.exclusiveStartKey } : {}),
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: {
      ":pk": organizationAuditPartition(input.organizationId),
      ":prefix": AUDIT_EVENT_SORT_PREFIX,
    },
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    Limit: input.limit,
    ScanIndexForward: false,
  });
  return {
    items: result.items.filter(
      (record): record is AuditEventRecordValue =>
        record.itemType === "audit-event" &&
        record.data.organizationId === input.organizationId &&
        record.data.environmentId === undefined,
    ),
    ...(result.lastEvaluatedKey ? { lastEvaluatedKey: result.lastEvaluatedKey } : {}),
  };
}
