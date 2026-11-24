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
  stateVersionFields,
} from "../record-schema.ts";
import { BrainSearchProviderId } from "./brain-search.ts";

const BrainIndexJobComponent = Schema.Struct({
  componentId: Ulid,
  kind: Schema.Literals(["dense", "entity", "exact", "lexical"]),
  status: Schema.Literals(["failed", "pending", "ready", "suppressed"]),
});

export const BrainIndexJobRecord = makeRecordSchema("brain-index-job", {
  ...mutableResourceFields,
  attempt: NonNegativeSafeInteger,
  brainId: Ulid,
  completedAt: Schema.optional(Timestamp),
  components: Schema.Array(BrainIndexJobComponent),
  documentId: Ulid,
  documentVersionId: Ulid,
  embeddingProfileId: Ulid,
  error: Schema.optional(NonEmptyString),
  expectedContentHash: Schema.optional(NonEmptyString),
  expectedProjectionGeneration: NonNegativeSafeInteger,
  id: Ulid,
  idempotencyKey: NonEmptyString,
  leaseExpiresAt: Schema.optional(Timestamp),
  leaseOwner: Schema.optional(NonEmptyString),
  nextDueAt: Schema.optional(Timestamp),
  operation: Schema.Literals(["index", "suppress"]),
  organizationId: Ulid,
  placementGeneration: NonNegativeSafeInteger,
  priority: NonNegativeSafeInteger,
  provider: BrainSearchProviderId,
  renditionId: Schema.optional(Ulid),
  schemaGeneration: NonNegativeSafeInteger,
  skipReason: Schema.optional(NonEmptyString),
  sourceId: Ulid,
  startedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["failed", "queued", "running", "succeeded"]),
  targetId: Ulid,
});

export const BrainQueryAttemptRecord = makeRecordSchema(
  "brain-query-attempt",
  {
    ...stateVersionFields,
    authorizedBrainCount: NonNegativeSafeInteger,
    candidateCount: NonNegativeSafeInteger,
    canonicalDropCount: NonNegativeSafeInteger,
    contextTokens: Schema.optional(NonNegativeSafeInteger),
    createdAt: Timestamp,
    emittedCount: NonNegativeSafeInteger,
    feedback: Schema.optional(NonEmptyString),
    feedbackAt: Schema.optional(Timestamp),
    environmentId: Schema.optional(Ulid),
    id: Ulid,
    latencyMs: Schema.optional(NonNegativeSafeInteger),
    organizationId: Ulid,
    placementGeneration: NonNegativeSafeInteger,
    projectId: Schema.optional(Ulid),
    provider: BrainSearchProviderId,
    purpose: NonEmptyString,
    queryHash: NonEmptyString,
    rerankLatencyMs: Schema.optional(NonNegativeSafeInteger),
    runId: Schema.optional(Ulid),
    schemaGeneration: NonNegativeSafeInteger,
    status: Schema.Literals(["completed", "failed", "running", "skipped"]),
    targetId: Ulid,
    threadId: Schema.optional(Ulid),
    toolCallId: Schema.optional(Ulid),
    usefulness: Schema.optional(Schema.Literals(["harmful", "neutral", "useful"])),
  },
  { retentionTtl: true },
);

export const BrainRetrievalRecord = makeRecordSchema(
  "brain-retrieval",
  {
    ...stateVersionFields,
    brainId: Ulid,
    chunkId: NonEmptyString,
    contextTokens: Schema.optional(NonNegativeSafeInteger),
    createdAt: Timestamp,
    documentId: Ulid,
    documentVersionId: Ulid,
    environmentId: Schema.optional(Ulid),
    id: Ulid,
    injected: Schema.Boolean,
    organizationId: Ulid,
    projectId: Schema.optional(Ulid),
    provider: BrainSearchProviderId,
    purpose: NonEmptyString,
    queryAttemptId: Ulid,
    rank: NonNegativeSafeInteger,
    renditionId: Ulid,
    runId: Schema.optional(Ulid),
    score: Schema.Number,
    sourceId: Ulid,
    threadId: Schema.optional(Ulid),
    toolCallId: Schema.optional(Ulid),
    usefulness: Schema.optional(Schema.Literals(["harmful", "neutral", "useful"])),
  },
  { retentionTtl: true },
);

export const BrainContentCleanupRecord = makeRecordSchema("brain-content-cleanup", {
  ...mutableResourceFields,
  bodyRef: Schema.optional(BlobReference),
  brainId: Ulid,
  bucket: NonEmptyString,
  error: Schema.optional(NonEmptyString),
  id: Ulid,
  nextDueAt: Timestamp,
  objectKey: NonEmptyString,
  organizationId: Ulid,
  quiescenceStartedAt: Schema.optional(Timestamp),
  reason: NonEmptyString,
  stagingId: Schema.optional(Ulid),
  status: Schema.Literals(["deleting", "pending", "verified"]),
  ticketId: Schema.optional(Ulid),
  verificationCount: NonNegativeSafeInteger,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const bodyRef = record.data.bodyRef;
      if (!bodyRef) return undefined;
      return bodyRef.versionId &&
        bodyRef.bucket === record.data.bucket &&
        bodyRef.key === record.data.objectKey
        ? undefined
        : "Brain content cleanup body reference must match its exact target.";
    }),
  ),
);

export const BrainDuplicatePassRecord = makeRecordSchema("brain-duplicate-pass", {
  ...mutableResourceFields,
  brainId: Ulid,
  contentFingerprint: NonEmptyString,
  duplicateGroups: NonNegativeSafeInteger,
  organizationId: Ulid,
});

export const BrainSyncJobRecord = makeRecordSchema("brain-sync-job", {
  ...mutableResourceFields,
  attempt: NonNegativeSafeInteger,
  brainId: Ulid,
  authorizingGrantId: Ulid,
  completedAt: Schema.optional(Timestamp),
  connectionCredentialGeneration: NonNegativeSafeInteger,
  connectionId: Ulid,
  error: Schema.optional(NonEmptyString),
  id: Ulid,
  idempotencyKey: NonEmptyString,
  leaseExpiresAt: Schema.optional(Timestamp),
  leaseOwner: Schema.optional(NonEmptyString),
  nextDueAt: Timestamp,
  organizationId: Ulid,
  priority: NonNegativeSafeInteger,
  requestedByPrincipalId: Ulid,
  sourceId: Ulid,
  startedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["failed", "queued", "running", "succeeded"]),
  syncCursor: Schema.optional(NonEmptyString),
});

export const BrainErasureJobRecord = makeRecordSchema("brain-erasure-job", {
  ...mutableResourceFields,
  brainId: Ulid,
  completedAt: Schema.optional(Timestamp),
  contentQuiescenceStartedAt: Schema.optional(Timestamp),
  contentVerificationCount: NonNegativeSafeInteger,
  erasureGeneration: NonNegativeSafeInteger,
  error: Schema.optional(NonEmptyString),
  failedAttempts: Schema.optional(NonNegativeSafeInteger),
  id: Ulid,
  leaseExpiresAt: Schema.optional(Timestamp),
  leaseOwner: Schema.optional(NonEmptyString),
  nextDueAt: Timestamp,
  organizationId: Ulid,
  phase: Schema.Literals(["draining", "purging", "verifying"]),
  priority: NonNegativeSafeInteger,
  recordsDeleted: Schema.optional(NonNegativeSafeInteger),
  requestedByPrincipalId: Ulid,
  searchReceipt: Schema.optional(Metadata),
  startedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["completed", "failed", "pending", "running"]),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const leased =
        record.data.leaseOwner !== undefined && record.data.leaseExpiresAt !== undefined;
      if ((record.data.status === "running") !== leased) {
        return "Only running Brain erasure jobs carry a complete lease.";
      }
      if (record.data.status === "failed" && !record.data.error) {
        return "A failed Brain erasure job must keep its last error.";
      }
      return record.data.status === "completed" &&
        (!record.data.completedAt ||
          record.data.phase !== "verifying" ||
          record.data.recordsDeleted === undefined ||
          !record.data.searchReceipt ||
          record.data.contentVerificationCount < 2)
        ? "Completed Brain erasure requires content, canonical, and search absence evidence."
        : undefined;
    }),
  ),
);

export const BrainReviewItemRecord = makeRecordSchema("brain-review-item", {
  ...mutableResourceFields,
  brainId: Ulid,
  decision: Schema.optional(Schema.Literals(["approve", "merge", "reject"])),
  documentId: Schema.optional(Ulid),
  entityId: Schema.optional(Ulid),
  id: Ulid,
  kind: Schema.Literals([
    "contradiction",
    "duplicate-document",
    "entity-merge",
    "extraction",
    "summary",
  ]),
  organizationId: Ulid,
  proposal: Metadata,
  reason: NonEmptyString,
  resolvedAt: Schema.optional(Timestamp),
  resolvedByPrincipalId: Schema.optional(Ulid),
  status: Schema.Literals(["open", "resolved"]),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const resolution = [
        record.data.decision,
        record.data.resolvedAt,
        record.data.resolvedByPrincipalId,
      ].filter((value) => value !== undefined).length;
      return record.data.status === "resolved"
        ? resolution === 3
          ? undefined
          : "Resolved Brain review items require a decision, time, and principal."
        : resolution === 0
          ? undefined
          : "Open Brain review items cannot carry resolution fields.";
    }),
  ),
);
