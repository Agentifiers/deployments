import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  BlobReference,
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import { EndUserKey } from "./conversation-erasure.ts";

export const GOVERNANCE_OPERATION_KINDS = [
  "audit-export",
  "end-user-erasure",
  "tenant-erasure",
  "tenant-export",
  "thread-erasure",
] as const;
export const GovernanceOperationKind = Schema.Literals(GOVERNANCE_OPERATION_KINDS);
export type GovernanceOperationKind = typeof GovernanceOperationKind.Type;

export const CONVERSATION_ERASURE_PHASES = [
  "planning",
  "mail",
  "fencing",
  "automations",
  "memory",
  "canonical",
  "ingress",
  "streams",
  "objects",
  "observability",
  "finalizing",
] as const;
export const ConversationErasurePhase = Schema.Literals(CONVERSATION_ERASURE_PHASES);
export type ConversationErasurePhase = typeof ConversationErasurePhase.Type;

export const ConversationErasureTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: Ulid }),
  Schema.Struct({ endUserKey: Schema.optional(EndUserKey), kind: Schema.Literal("end-user") }),
]);
export type ConversationErasureTarget = typeof ConversationErasureTarget.Type;

export const ConversationErasureCounts = Schema.Struct({
  automationsArchived: NonNegativeSafeInteger,
  emailMessagesErased: NonNegativeSafeInteger,
  emailThreadsErased: NonNegativeSafeInteger,
  ingressRecordsDeleted: NonNegativeSafeInteger,
  memoriesErased: NonNegativeSafeInteger,
  objectsStaged: NonNegativeSafeInteger,
  recordsDeleted: NonNegativeSafeInteger,
  runsCanceled: NonNegativeSafeInteger,
  streamsDeleted: NonNegativeSafeInteger,
  threadsErased: NonNegativeSafeInteger,
  threadsPlanned: NonNegativeSafeInteger,
});
export type ConversationErasureCounts = typeof ConversationErasureCounts.Type;

export const ConversationErasureState = Schema.Struct({
  counts: ConversationErasureCounts,
  environmentId: Ulid,
  phase: ConversationErasurePhase,
  target: ConversationErasureTarget,
});
export type ConversationErasureState = typeof ConversationErasureState.Type;

/**
 * Where a tenant erasure stands across invocations. `survey` looks for active work under the
 * fence; `delete` pages the inventory, where `counted` marks the page at `cursor` whose records
 * `recordsDeleted` already counts although their deletion may not have finished, ending at
 * `counted.through` (absent: the end of the inventory); `final` has counted the audit events and
 * legacy idempotency records it deletes last.
 */
export const TenantErasureProgress = Schema.Union([
  Schema.Struct({ cursor: Schema.optional(NonEmptyString), phase: Schema.Literal("survey") }),
  Schema.Struct({
    counted: Schema.optional(Schema.Struct({ through: Schema.optional(NonEmptyString) })),
    cursor: Schema.optional(NonEmptyString),
    pass: NonNegativeSafeInteger,
    passChanged: Schema.Boolean,
    phase: Schema.Literal("delete"),
    recordsDeleted: NonNegativeSafeInteger,
  }),
  Schema.Struct({ phase: Schema.Literal("final"), recordsDeleted: NonNegativeSafeInteger }),
]);
export type TenantErasureProgress = typeof TenantErasureProgress.Type;

export const RetentionPolicyRecord = makeRecordSchema("retention-policy", {
  ...mutableResourceFields,
  auditDays: NonNegativeSafeInteger,
  artifactDays: NonNegativeSafeInteger,
  eventDays: NonNegativeSafeInteger,
  id: Ulid,
  messageDays: NonNegativeSafeInteger,
  organizationId: Ulid,
  runDays: NonNegativeSafeInteger,
  threadDays: NonNegativeSafeInteger,
  updatedByPrincipalId: Ulid,
});

export const GovernanceOperationRecord = makeRecordSchema("governance-operation", {
  ...mutableResourceFields,
  archive: Schema.optional(BlobReference),
  auditRetainedUntil: Schema.optional(Timestamp),
  auditSignature: Schema.optional(NonEmptyString),
  auditSignatureKeyId: Schema.optional(NonEmptyString),
  auditSignaturePublicKey: Schema.optional(NonEmptyString),
  brainSearchErasureReceipt: Schema.optional(Metadata),
  canonicalDeletedAt: Schema.optional(Timestamp),
  completedAt: Schema.optional(Timestamp),
  conversationErasure: Schema.optional(ConversationErasureState),
  cursor: Schema.optional(Metadata),
  dispatchReadyAt: Schema.optional(Timestamp),
  erasureAuditRootHash: Schema.optional(NonEmptyString),
  erasureProgress: Schema.optional(Metadata),
  memorySearchErasureReceipt: Schema.optional(Metadata),
  observabilityErasureProgress: Schema.optional(Metadata),
  observabilityErasureReceipt: Schema.optional(Metadata),
  error: Schema.optional(Metadata),
  expiresAt: Schema.optional(Timestamp),
  id: Ulid,
  idempotencyKey: NonEmptyString,
  kind: GovernanceOperationKind,
  leaseExpiresAt: Schema.optional(Timestamp),
  organizationId: Ulid,
  output: Schema.optional(BlobReference),
  outputSha256: Schema.optional(NonEmptyString),
  requestedByPrincipalId: Ulid,
  startedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["canceled", "completed", "failed", "pending", "running"]),
  summary: Schema.optional(Metadata),
});

/**
 * Create-only pointer that orders an organization's governance operations newest first. It is
 * written in the same transaction that creates (erasure) or makes dispatch-ready (exports) the
 * operation and is never updated; status is always read from the canonical operation.
 */
export const GovernanceOperationHistoryRecord = makeRecordSchema("governance-operation-history", {
  createdAt: Timestamp,
  kind: GovernanceOperationKind,
  operationId: Ulid,
  organizationId: Ulid,
});

export const ErasureFenceRecord = makeRecordSchema("erasure-fence", {
  createdAt: Timestamp,
  id: Ulid,
  leaseExpiresAt: Schema.optional(Timestamp),
  operationId: Ulid,
  organizationId: Ulid,
});

export const RetentionCleanupRecord = makeRecordSchema("retention-cleanup", {
  createdAt: Timestamp,
  id: NonEmptyString,
  notBefore: Schema.optional(Timestamp),
  organizationId: Ulid,
  references: Schema.Array(
    Schema.Struct({
      bucket: NonEmptyString,
      deleteAllVersions: Schema.Boolean,
      key: NonEmptyString,
      versionId: Schema.optional(NonEmptyString),
    }),
  ),
  sourceItemType: NonEmptyString,
  sourcePk: NonEmptyString,
  sourceResourceId: Schema.optional(NonEmptyString),
  sourceSk: NonEmptyString,
  sourceTable: Schema.Literals(["control", "events", "execution", "usage"]),
  threadIds: Schema.optional(Schema.Array(Ulid).pipe(Schema.check(Schema.isMinLength(1)))),
});

/**
 * One organization's pending raise of retention item TTLs after its `runs` or `events` period got
 * longer. `policyVersion` names the policy that started it; `dueAt` is when the dispatch sweep may
 * next run it, which doubles as the lease of a run in progress.
 */
export const RetentionRestampRecord = makeRecordSchema("retention-restamp", {
  ...mutableResourceFields,
  cursor: Schema.optional(NonEmptyString),
  dueAt: Timestamp,
  id: Ulid,
  organizationId: Ulid,
  phase: Schema.Literals(["soonest", "all"]),
  policyVersion: NonNegativeSafeInteger,
});

export const ErasureReceiptRecord = makeRecordSchema("erasure-receipt", {
  auditRootHash: NonEmptyString,
  completedAt: Timestamp,
  id: Ulid,
  memorySearch: Schema.optional(Schema.Struct({ backupsExpireBy: Timestamp })),
  organizationHash: NonEmptyString,
  observability: Schema.optional(
    Schema.Struct({
      backupsExpireBy: Timestamp,
      clickhouseRowsDeleted: NonNegativeSafeInteger,
      icebergRowsDeleted: NonNegativeSafeInteger,
      physicalRemovalBy: Timestamp,
    }),
  ),
  recordsDeleted: NonNegativeSafeInteger,
  requestedByPrincipalHash: NonEmptyString,
});
