import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import { HoldReason } from "./organization-standing.ts";

export const MemorySearchProviderId = Schema.Literal("aws-native");
export type MemorySearchProviderId = typeof MemorySearchProviderId.Type;

export const MemorySearchProjectionClass = Schema.Literals(["customer", "synthetic-evidence"]);

export const MemorySearchTarget = Schema.Struct({
  componentIds: Schema.Array(Ulid),
  embeddingProfileId: Ulid,
  location: Metadata,
  providerId: MemorySearchProviderId,
  schemaGeneration: NonNegativeSafeInteger,
  targetId: Ulid,
});
export type MemorySearchTarget = typeof MemorySearchTarget.Type;

const operationLeaseFields = {
  actionGeneration: NonNegativeSafeInteger,
  dispatchCheckpoint: Schema.optional(Schema.String),
  eventVersion: NonNegativeSafeInteger,
  leaseExpiresAt: Schema.optional(Timestamp),
  leaseOwner: Schema.optional(Schema.String),
  nextAction: Schema.optional(Schema.Literals(["abort-provisioning", "provision-components"])),
  nextActionAt: Schema.optional(Timestamp),
  operationShard: NonNegativeSafeInteger,
} as const;

export const MemoryEmbeddingProfileRecord = makeRecordSchema("memory-embedding-profile", {
  ...mutableResourceFields,
  dimensions: NonNegativeSafeInteger,
  distanceMetric: Schema.Literals(["cosine", "dot-product", "euclidean"]),
  gatewayModel: Schema.String,
  gatewayRoute: Schema.String,
  id: Ulid,
  normalization: Schema.Literals(["l2", "none"]),
  processingBoundary: Schema.Literals(["aws", "platform-approved"]),
  status: Schema.Literals(["active", "retired"]),
});

export const MemorySearchGenerationRecord = makeRecordSchema("memory-search-generation", {
  ...mutableResourceFields,
  componentKind: Schema.Literals(["dense", "lexical", "namespace"]),
  generation: NonNegativeSafeInteger,
  id: Ulid,
  location: Metadata,
  providerId: MemorySearchProviderId,
  status: Schema.Literals(["active", "maintenance", "retired", "retiring", "rolling-over"]),
});

export const MemorySearchComponentRecord = makeRecordSchema("memory-search-component", {
  ...mutableResourceFields,
  componentKind: Schema.Literals(["dense", "lexical", "namespace"]),
  embeddingProfileId: Schema.optional(Ulid),
  generationId: Ulid,
  id: Ulid,
  location: Metadata,
  providerId: MemorySearchProviderId,
  schemaGeneration: NonNegativeSafeInteger,
  status: Schema.Literals(["active", "provisioning", "retired", "retiring"]),
});

export const MemorySearchPlacementRecord = makeRecordSchema("memory-search-placement", {
  ...mutableResourceFields,
  candidateTarget: Schema.optional(MemorySearchTarget),
  generation: NonNegativeSafeInteger,
  operationId: Schema.optional(Ulid),
  organizationId: Ulid,
  phase: Schema.Literals(["active", "provisioning", "unconfigured"]),
  readTarget: Schema.optional(MemorySearchTarget),
  writeTargets: Schema.Array(MemorySearchTarget),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const data = record.data;
      if (data.writeTargets.length > 1) {
        return { path: ["data", "writeTargets"], issue: "At most one write target is allowed." };
      }
      const nonServing = data.phase === "unconfigured" || data.phase === "provisioning";
      if (nonServing && (data.readTarget !== undefined || data.writeTargets.length !== 0)) {
        return {
          path: ["data", "readTarget"],
          issue: "Non-serving placement phases cannot expose read or write targets.",
        };
      }
      if (!nonServing && (data.readTarget === undefined || data.writeTargets.length === 0)) {
        return {
          path: ["data", "readTarget"],
          issue: "Serving placement phases require read and write targets.",
        };
      }
      if (
        !nonServing &&
        !data.writeTargets.some((target) => target.targetId === data.readTarget?.targetId)
      ) {
        return {
          path: ["data", "writeTargets"],
          issue: "Serving placements must keep the read target writable.",
        };
      }
      if (data.phase === "unconfigured" && (data.candidateTarget || data.operationId)) {
        return {
          path: ["data", "candidateTarget"],
          issue: "Unconfigured placements cannot own a candidate or operation.",
        };
      }
      if (data.phase === "provisioning" && (!data.candidateTarget || !data.operationId)) {
        return {
          path: ["data", "candidateTarget"],
          issue: "Provisioning placements require a candidate and operation.",
        };
      }
      if (
        data.phase === "active" &&
        (data.candidateTarget === undefined) !== (data.operationId === undefined)
      ) {
        return {
          path: ["data", "candidateTarget"],
          issue: "Active placement migrations require both a candidate and operation.",
        };
      }
      const targetIds = data.writeTargets.map((target) => target.targetId);
      return new Set(targetIds).size === targetIds.length
        ? undefined
        : { path: ["data", "writeTargets"], issue: "Write targets must be unique." };
    }),
  ),
);

const operationStatus = Schema.Literals([
  "aborted",
  "completed",
  "failed",
  "pending",
  "running",
  "waiting",
]);

export const MemorySearchProvisioningRecord = makeRecordSchema("memory-search-provisioning", {
  ...mutableResourceFields,
  ...operationLeaseFields,
  backupErasureEligibleAt: Schema.optional(Timestamp),
  evidenceManifestId: Schema.optional(Ulid),
  id: Ulid,
  organizationId: Ulid,
  phase: Schema.String,
  placementGeneration: NonNegativeSafeInteger,
  providerPurgeStartedAt: Schema.optional(Timestamp),
  providerPurgeState: Schema.optional(Metadata),
  status: operationStatus,
  target: MemorySearchTarget,
});

export const MemorySearchEvidenceManifestRecord = makeRecordSchema(
  "memory-search-evidence-manifest",
  {
    ...mutableResourceFields,
    componentLocations: Schema.Array(Metadata),
    evidenceKeys: Schema.Array(Schema.String),
    id: Ulid,
    operationId: Ulid,
    organizationId: Ulid,
    status: Schema.Literals(["clean", "cleanup-pending", "manifested"]),
    targetId: Ulid,
  },
);

export const MemoryDirectoryEntryRecord = makeRecordSchema("memory-directory-entry", {
  ...mutableResourceFields,
  contentHash: Schema.String,
  directoryShard: NonNegativeSafeInteger,
  environmentId: Ulid,
  memoryId: Ulid,
  memoryVersion: NonNegativeSafeInteger,
  organizationId: Ulid,
  projectId: Ulid,
  status: Schema.Literals(["active", "archived", "deleted", "tombstone"]),
  workspaceId: Schema.optional(Ulid),
});

export const MemoryDirectoryShardRecord = makeRecordSchema("memory-directory-shard", {
  ...mutableResourceFields,
  count: NonNegativeSafeInteger,
  directoryShard: NonNegativeSafeInteger,
  mutationWatermark: NonNegativeSafeInteger,
  organizationId: Ulid,
});

export const MemorySearchMutationFenceRecord = makeRecordSchema("memory-search-mutation-fence", {
  ...mutableResourceFields,
  epoch: NonNegativeSafeInteger,
  expiresAt: Schema.optional(Timestamp),
  operationId: Schema.optional(Ulid),
  organizationId: Ulid,
  status: Schema.Literals(["closed", "open"]),
});

export const MemoryProviderMutationGateRecord = makeRecordSchema("memory-provider-mutation-gate", {
  ...mutableResourceFields,
  drainEpoch: NonNegativeSafeInteger,
  operationId: Schema.optional(Ulid),
  organizationId: Ulid,
  status: Schema.Literals(["closed", "draining", "open"]),
  targetId: Ulid,
});

export const MemoryProviderMutationClaimRecord = makeRecordSchema(
  "memory-provider-mutation-claim",
  {
    ...mutableResourceFields,
    ambiguityUntil: Schema.optional(Timestamp),
    attemptEpoch: NonNegativeSafeInteger,
    claimAttemptId: Schema.String,
    messageGroup: Schema.String,
    mutationTuple: Schema.String,
    organizationId: Ulid,
    status: Schema.Literals(["ambiguous", "applied", "claimed", "failed"]),
    targetId: Ulid,
  },
);

export const MemorySearchGenerationTargetRecord = makeRecordSchema(
  "memory-search-generation-target",
  {
    ...mutableResourceFields,
    generationId: Ulid,
    keyVersion: NonNegativeSafeInteger,
    membershipShard: NonNegativeSafeInteger,
    providerId: MemorySearchProviderId,
    targetDigest: Schema.String,
  },
);

export const MemorySearchGenerationTargetShardRecord = makeRecordSchema(
  "memory-search-generation-target-shard",
  {
    ...mutableResourceFields,
    count: NonNegativeSafeInteger,
    generationId: Ulid,
    membershipShard: NonNegativeSafeInteger,
    mutationWatermark: NonNegativeSafeInteger,
  },
);

export const MemorySearchGenerationLiveTargetRecord = makeRecordSchema(
  "memory-search-generation-live-target",
  {
    ...mutableResourceFields,
    componentId: Ulid,
    generationId: Ulid,
    liveShard: NonNegativeSafeInteger,
    operationId: Schema.optional(Ulid),
    organizationId: Ulid,
    placementGeneration: NonNegativeSafeInteger,
    referenceRole: Schema.Literals(["candidate", "cleanup", "read", "retained", "write"]),
    targetId: Ulid,
  },
);

export const MemorySearchGenerationLiveShardRecord = makeRecordSchema(
  "memory-search-generation-live-shard",
  {
    ...mutableResourceFields,
    count: NonNegativeSafeInteger,
    generationId: Ulid,
    liveShard: NonNegativeSafeInteger,
    mutationWatermark: NonNegativeSafeInteger,
  },
);

export const MemorySearchPhysicalOwnerRecord = makeRecordSchema("memory-search-physical-owner", {
  ...mutableResourceFields,
  componentKind: Schema.Literals(["dense", "lexical"]),
  componentId: Ulid,
  organizationId: Ulid,
  physicalLocationHash: Schema.String,
  referenceCount: NonNegativeSafeInteger,
  targetId: Ulid,
});

export const MemorySearchTargetIdentityRecord = makeRecordSchema("memory-search-target-identity", {
  ...mutableResourceFields,
  identityHash: Schema.String,
  targetId: Ulid,
});

export const MemorySearchTargetRecordRecord = makeRecordSchema("memory-search-target-record", {
  ...mutableResourceFields,
  organizationId: Ulid,
  recordItemType: Schema.Literals([
    "memory-index-job",
    "memory-index-state",
    "memory-provider-mutation-claim",
    "memory-provider-mutation-gate",
    "memory-shadow-job",
  ]),
  recordPk: Schema.String,
  recordSk: Schema.String,
  recordTable: Schema.Literals(["control", "execution"]),
  targetId: Ulid,
});

export const MemoryProviderPurgeCheckpointRecord = makeRecordSchema(
  "memory-provider-purge-checkpoint",
  {
    ...mutableResourceFields,
    backupErasureEligibleAt: Timestamp,
    operationId: Ulid,
    organizationId: Ulid,
    providerId: MemorySearchProviderId,
    providerReceipt: Metadata,
    providerPurgeStartedAt: Timestamp,
    targetId: Ulid,
  },
);

export const MemoryTargetCleanupReceiptRecord = makeRecordSchema("memory-target-cleanup-receipt", {
  ...mutableResourceFields,
  acceptedAt: Timestamp,
  backupErasureEligibleAt: Schema.optional(Timestamp),
  componentReceipts: Schema.Array(Metadata),
  generationId: Ulid,
  id: Ulid,
  keyVersion: NonNegativeSafeInteger,
  organizationId: Ulid,
  targetId: Ulid,
  targetDigest: Schema.String,
});

export const MemoryErasureTargetReceiptRecord = makeRecordSchema("memory-erasure-target-receipt", {
  ...mutableResourceFields,
  acceptedAt: Timestamp,
  backupErasureEligibleAt: Schema.optional(Timestamp),
  componentReceipts: Schema.Array(Metadata),
  generationId: Ulid,
  id: Ulid,
  keyVersion: NonNegativeSafeInteger,
  targetDigest: Schema.String,
});

/**
 * Create-only proof that an operator dropped a suspended organization's own memory search
 * indexes. The organization keeps its rows; erasing the organization removes the receipt.
 */
export const MemorySearchIndexDropReceiptRecord = makeRecordSchema(
  "memory-search-index-drop-receipt",
  {
    ...mutableResourceFields,
    droppedAt: Timestamp,
    indexes: Schema.NonEmptyArray(NonEmptyString),
    /** The earliest operator hold that authorized the drop, keyed `operator/<key>`. */
    operatorHold: Schema.Struct({
      id: NonEmptyString.pipe(Schema.check(Schema.isPattern(/^operator\//u))),
      placedAt: Timestamp,
      reason: HoldReason,
    }),
    organizationId: Ulid,
  },
);
