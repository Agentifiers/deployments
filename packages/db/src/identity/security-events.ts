import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import type { ActorReference, Metadata } from "../record-schema.ts";
import { IdentitySecurityEventRecord } from "../records/identity-auth.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";

type IdentitySecurityEvent = typeof IdentitySecurityEventRecord.Type;

export interface CreateIdentitySecurityEventOptions {
  readonly actor?: typeof ActorReference.Type;
  readonly aggregateId: Ulid;
  readonly aggregateType: string;
  readonly aggregateVersion: number;
  readonly eventId: Ulid;
  readonly eventType: string;
  readonly occurredAt?: Date | string;
  readonly payload?: typeof Metadata.Type;
  readonly principalId: Ulid;
  readonly traceId?: string;
}

export function makeIdentitySecurityEventRecord(
  options: CreateIdentitySecurityEventOptions,
): IdentitySecurityEvent {
  const timestamp =
    typeof options.occurredAt === "string"
      ? options.occurredAt
      : (options.occurredAt ?? new Date()).toISOString();
  return Schema.decodeUnknownSync(IdentitySecurityEventRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(options.actor ? { actor: options.actor } : {}),
        aggregateId: options.aggregateId,
        aggregateType: options.aggregateType,
        aggregateVersion: options.aggregateVersion,
        eventId: options.eventId,
        eventType: options.eventType,
        id: options.eventId,
        occurredAt: timestamp,
        payload: options.payload ?? {},
        principalId: options.principalId,
        ...(options.traceId ? { traceId: options.traceId } : {}),
        version: 1,
      },
      itemType: "identity-security-event",
    }),
  );
}

export function transactWithIdentitySecurityEvents(
  database: DynamoDatabaseService,
  operations: readonly TransactionOperation[],
  events: readonly IdentitySecurityEvent[],
  clientRequestToken?: string,
  signal?: AbortSignal,
) {
  if (
    operations.some(
      (operation) =>
        operation.kind !== "condition-check" &&
        operation.record.itemType === "identity-security-event",
    )
  ) {
    throw new TypeError("Identity security events must be passed through the events argument.");
  }
  if (new Set(events.map((event) => event.pk)).size !== events.length) {
    throw new TypeError("One transaction may append at most one identity event per aggregate.");
  }
  return database.transactWrite(
    [...operations, ...events.map((record) => ({ kind: "put" as const, record }))],
    clientRequestToken,
    signal,
  );
}
