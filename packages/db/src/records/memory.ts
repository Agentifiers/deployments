import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  BlobReference,
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  ObservabilitySourceContext,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";
import { RunStatus } from "./conversations.ts";
import { ExecutionPurpose } from "./execution-bindings.ts";
import { MemorySearchProviderId } from "./memory-search.ts";
const status = Schema.Literals(["active", "archived", "disabled"]);

export const MemorySpaceRecord = makeRecordSchema("memory-space", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  description: Schema.optional(Schema.String),
  id: Ulid,
  /** The workspace's default space, created for workspace-memory agents; at most one per workspace. */
  isDefault: Schema.optional(Schema.Boolean),
  kind: Schema.Literals(["agent", "organization", "shared", "workspace"]),
  name: Schema.String,
  retentionDays: Schema.optional(Schema.Number),
  status,
});

export const MemorySpaceGrantRecord = makeRecordSchema("memory-space-grant", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDefinitionId: Ulid,
  grantedByPrincipalId: Schema.optional(Ulid),
  id: Ulid,
  memorySpaceId: Ulid,
  permission: Schema.Literals(["read", "read-write"]),
  revokedAt: Schema.optional(Schema.String),
});

export const MemoryPolicyRecord = makeRecordSchema("memory-policy", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  activeRecallEnabled: Schema.Boolean,
  activeRecallRolloutPercent: Schema.Number,
  id: Ulid,
  processingConfig: Schema.optional(Metadata),
  retentionDays: Schema.optional(Schema.Number),
  scope: Schema.Literals(["environment", "organization", "workspace"]),
  sensitivityMode: Schema.Literals(["restricted", "standard", "strict"]),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      if (record.data.scope === "workspace" && record.data.workspaceId === undefined) {
        return { path: ["data", "workspaceId"], issue: "Workspace policies require workspaceId." };
      }
      return record.data.scope !== "workspace" && record.data.workspaceId !== undefined
        ? {
            path: ["data", "workspaceId"],
            issue: "Only workspace policies may include workspaceId.",
          }
        : undefined;
    }),
  ),
);

/**
 * Environment-scoped pointer to a run, rewritten with every run put. The `run*`-named mirrors let
 * the environment run feed filter before reading runs; they are optional so locators stored before
 * the feed existed still decode, and they never feed key derivation (`status` would).
 */
export const RunLocatorRecord = makeRecordSchema("run-locator", {
  ...tenantScopeFields,
  agentReleaseId: Schema.optional(Ulid),
  createdAt: Timestamp,
  executionPurpose: Schema.optional(ExecutionPurpose),
  id: Ulid,
  runPk: NonEmptyString,
  runSk: NonEmptyString,
  runStatus: Schema.optional(RunStatus),
  threadId: Schema.optional(Ulid),
});

export const BrainMemoryEvidenceProvenance = Schema.Struct({
  brainId: Ulid,
  chunkId: Schema.String,
  coordinates: Schema.optional(
    Schema.Struct({
      end: NonNegativeSafeInteger,
      kind: Schema.Literals(["unicode-scalar", "utf8-byte"]),
      start: NonNegativeSafeInteger,
    }),
  ),
  documentId: Ulid,
  documentVersionId: Ulid,
  renditionId: Ulid,
  sourceId: Ulid,
});
type BrainMemoryEvidenceProvenanceValue = typeof BrainMemoryEvidenceProvenance.Type;

export const BrainMemoryProvenance = Schema.Array(BrainMemoryEvidenceProvenance).pipe(
  Schema.check(
    Schema.isMinLength(1, { message: "Derived Brain memory requires at least one citation." }),
    Schema.isMaxLength(20, { message: "Derived Brain memory supports at most 20 citations." }),
    Schema.isUnique({
      equivalence: (
        left: BrainMemoryEvidenceProvenanceValue,
        right: BrainMemoryEvidenceProvenanceValue,
      ) =>
        left.brainId === right.brainId &&
        left.documentId === right.documentId &&
        left.documentVersionId === right.documentVersionId &&
        left.renditionId === right.renditionId &&
        left.chunkId === right.chunkId,
      message: "Derived Brain memory citations must be unique.",
    }),
  ),
);

export const MemoryRecord = makeRecordSchema("memory", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDefinitionId: Schema.optional(Ulid),
  archivedAt: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  bodyRef: Schema.optional(BlobReference),
  brainProvenance: Schema.optional(BrainMemoryProvenance),
  contentHash: Schema.String,
  deletedAt: Schema.optional(Schema.String),
  id: Ulid,
  idempotencyKey: Schema.optional(Schema.String),
  importance: Schema.optional(Schema.Number),
  memorySpaceId: Ulid,
  memoryType: Schema.optional(
    Schema.Literals(["episode", "fact", "preference", "procedure", "summary"]),
  ),
  metadata: Schema.optional(Metadata),
  observability: Schema.optional(ObservabilitySourceContext),
  entityKeys: Schema.optional(Schema.Array(Schema.String)),
  retentionExpiresAt: Schema.optional(Timestamp),
  /** Kept verbatim: personal and health data were neither redacted nor held for review. */
  retainsPersonalData: Schema.optional(Schema.Boolean),
  reviewStatus: Schema.Literals(["approved", "pending", "rejected", "unreviewed"]),
  reviewerApprovedContentHash: Schema.optional(Schema.String),
  scope: Schema.Literals(["agent", "organization", "thread", "workspace"]),
  searchKey: Schema.String,
  sensitivity: Schema.Literals(["confidential", "internal", "public", "restricted"]),
  source: Schema.String,
  sourceQuality: Schema.optional(Schema.Number),
  sourceRunId: Schema.optional(Ulid),
  status: Schema.Literals(["active", "archived", "deleted"]),
  supersededByMemoryId: Schema.optional(Ulid),
  threadId: Schema.optional(Ulid),
  supersedesMemoryId: Schema.optional(Ulid),
  validFrom: Schema.optional(Timestamp),
  validUntil: Schema.optional(Timestamp),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      if (
        record.data.importance !== undefined &&
        (!Number.isFinite(record.data.importance) ||
          record.data.importance < 0 ||
          record.data.importance > 1)
      ) {
        return { path: ["data", "importance"], issue: "importance must be between 0 and 1." };
      }
      if (
        record.data.sourceQuality !== undefined &&
        (!Number.isFinite(record.data.sourceQuality) ||
          record.data.sourceQuality < 0 ||
          record.data.sourceQuality > 1)
      ) {
        return {
          path: ["data", "sourceQuality"],
          issue: "sourceQuality must be between 0 and 1.",
        };
      }
      if (
        record.data.validFrom !== undefined &&
        record.data.validUntil !== undefined &&
        record.data.validFrom >= record.data.validUntil
      ) {
        return { path: ["data", "validUntil"], issue: "validUntil must follow validFrom." };
      }
      if (record.data.supersedesMemoryId === record.data.id) {
        return {
          path: ["data", "supersedesMemoryId"],
          issue: "A memory cannot supersede itself.",
        };
      }
      if (record.data.supersededByMemoryId === record.data.id) {
        return {
          path: ["data", "supersededByMemoryId"],
          issue: "A memory cannot be superseded by itself.",
        };
      }
      switch (record.data.scope) {
        case "agent":
          return record.data.agentDefinitionId
            ? undefined
            : {
                path: ["data", "agentDefinitionId"],
                issue: "Agent memories require agentDefinitionId.",
              };
        case "thread":
          return record.data.threadId
            ? undefined
            : { path: ["data", "threadId"], issue: "Thread memories require threadId." };
        case "workspace":
          return record.data.workspaceId
            ? undefined
            : {
                path: ["data", "workspaceId"],
                issue: "Workspace memories require workspaceId.",
              };
        case "organization":
          return undefined;
      }
    }),
  ),
);

export const MemoryIndexStateRecord = makeRecordSchema("memory-index-state", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  attemptId: Schema.String,
  contentHash: Schema.String,
  indexedAt: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  memoryId: Ulid,
  namespace: Schema.String,
  embeddingProfileId: Schema.optional(Ulid),
  placementGeneration: Schema.optional(NonNegativeSafeInteger),
  provider: MemorySearchProviderId,
  providerRef: Schema.optional(Schema.String),
  schemaGeneration: Schema.optional(NonNegativeSafeInteger),
  status: Schema.Literals(["deleted", "failed", "pending", "ready", "stale", "suppressed"]),
  synchronizationGeneration: NonNegativeSafeInteger,
  synchronizedVersion: Schema.Number,
  targetId: Schema.optional(Ulid),
});

/** Where a scheduled index verification walk resumes in one target's index-state index. */
export const MemoryIndexStatePosition = Schema.Struct({
  gsi2pk: Schema.String,
  gsi2sk: Schema.String,
  pk: Schema.String,
  sk: Schema.String,
});

export const MemoryIndexVerificationPassRecord = makeRecordSchema(
  "memory-index-verification-pass",
  {
    ...mutableResourceFields,
    ...workspaceScopeFields,
    /** The pass covers index states last updated before this instant. */
    cutoff: Timestamp,
    indexStatus: Schema.Literals(["deleted", "ready", "suppressed"]),
    resumeAfter: Schema.optional(MemoryIndexStatePosition),
    targetId: Ulid,
  },
);
