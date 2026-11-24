import type { BrainUploadLease, BrainUploadTicket } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { BrainContentCleanupRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  brainUlid,
  brainUploadLeasePlatformRecord,
  brainUploadTicketPlatformRecord,
} from "./record-mapping.ts";
import { updateBrainRecordOperations } from "./record-operations.ts";
import { brainUploadQuotaReleaseOperations } from "./upload-repository.ts";

const UPLOAD_EXPIRY_GRACE_MS = 5 * 60 * 1_000;

export async function expireBrainUploadTicket(input: {
  readonly bucket: string;
  readonly database: DynamoDatabaseService;
  readonly eventId: string;
  readonly lease?: BrainUploadLease;
  readonly now: string;
  readonly ticket: BrainUploadTicket;
}) {
  if (input.ticket.status === "consumed") return undefined;
  if (Date.parse(input.now) < Date.parse(input.ticket.expiresAt) + UPLOAD_EXPIRY_GRACE_MS) {
    return undefined;
  }
  if (
    input.lease?.status === "active" &&
    Date.parse(input.lease.expiresAt) > Date.parse(input.now)
  ) {
    return undefined;
  }
  if (
    input.ticket.status !== "issued" &&
    input.ticket.status !== "streaming" &&
    input.ticket.status !== "completed" &&
    input.ticket.status !== "rejected"
  ) {
    return undefined;
  }
  const expired: BrainUploadTicket = {
    ...input.ticket,
    status: "expired",
    updatedAt: input.now,
    version: input.ticket.version + 1,
  };
  const cleanup = Schema.decodeUnknownSync(BrainContentCleanupRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(input.ticket.bodyRef ? { bodyRef: input.ticket.bodyRef } : {}),
        brainId: brainUlid(input.ticket.brainId),
        bucket: input.bucket,
        createdAt: input.now,
        id: brainUlid(input.ticket.id),
        nextDueAt: input.now,
        objectKey: input.ticket.objectKey,
        organizationId: brainUlid(input.ticket.organizationId),
        reason: "expired-unconsumed-upload-ticket",
        status: "pending" as const,
        ticketId: brainUlid(input.ticket.id),
        updatedAt: input.now,
        verificationCount: 0,
        version: 0,
      },
      itemType: "brain-content-cleanup" as const,
    }),
  );
  const operations: TransactionOperation[] = [
    ...updateBrainRecordOperations(
      brainUploadTicketPlatformRecord(input.ticket),
      brainUploadTicketPlatformRecord(expired),
      input.now,
    ),
    { kind: "put", record: cleanup },
  ];
  if (input.lease?.status === "active") {
    operations.push(
      ...updateBrainRecordOperations(
        brainUploadLeasePlatformRecord(input.lease),
        brainUploadLeasePlatformRecord({
          ...input.lease,
          status: "expired",
          updatedAt: input.now,
          version: input.lease.version + 1,
        }),
        input.now,
      ),
    );
  }
  if (input.ticket.status === "issued" || input.ticket.status === "streaming") {
    operations.push(...(await brainUploadQuotaReleaseOperations(input.database, input.ticket)));
  }
  const event = makeSemanticEventRecord({
    actor: { type: "system" },
    aggregateId: brainUlid(input.ticket.id),
    aggregateType: "brain-upload-ticket",
    aggregateVersion: expired.version + 1,
    eventId: brainUlid(input.eventId),
    eventType: "brain-upload-ticket.expired",
    occurredAt: input.now,
    organizationId: brainUlid(input.ticket.organizationId),
    payload: {
      brainId: input.ticket.brainId,
      cleanupId: cleanup.data.id,
      ticketId: input.ticket.id,
    },
  });
  await transactWithSemanticEvents(input.database, operations, [event], input.eventId);
  return { cleanup, ticket: expired };
}
