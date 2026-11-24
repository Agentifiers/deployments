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

export const BrainSearchProviderId = Schema.Literal("aws-native");
export type BrainSearchProviderId = typeof BrainSearchProviderId.Type;

export const BrainSearchTarget = Schema.Struct({
  components: Schema.Array(
    Schema.Struct({
      componentId: Ulid,
      kind: Schema.Literals(["dense", "entity", "exact", "lexical"]),
    }),
  ),
  embeddingProfileId: Ulid,
  location: Metadata,
  providerId: BrainSearchProviderId,
  schemaGeneration: NonNegativeSafeInteger,
  targetId: Ulid,
});
export type BrainSearchTarget = typeof BrainSearchTarget.Type;

export const BrainSearchPlacementRecord = makeRecordSchema("brain-search-placement", {
  ...mutableResourceFields,
  candidateTarget: Schema.optional(BrainSearchTarget),
  generation: NonNegativeSafeInteger,
  operationId: Schema.optional(Ulid),
  organizationId: Ulid,
  phase: Schema.Literals(["active", "provisioning", "unconfigured"]),
  readTarget: Schema.optional(BrainSearchTarget),
  writeTarget: Schema.optional(BrainSearchTarget),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const data = record.data;
      if (data.phase === "active") {
        if (!data.readTarget || !data.writeTarget) {
          return "Active Brain search placements require one read and write target.";
        }
        if (data.readTarget.targetId !== data.writeTarget.targetId) {
          return "Brain search cannot read and write different targets.";
        }
        return (data.candidateTarget === undefined) === (data.operationId === undefined)
          ? undefined
          : "Active Brain search migrations require both a candidate and operation.";
      }
      if (data.readTarget || data.writeTarget) {
        return "Non-serving Brain search placements cannot expose a target.";
      }
      if (data.phase === "provisioning") {
        return data.candidateTarget && data.operationId
          ? undefined
          : "Provisioning Brain search placements require a candidate and operation.";
      }
      return !data.candidateTarget && !data.operationId
        ? undefined
        : "Unconfigured Brain search placements cannot own provisioning state.";
    }),
  ),
);

const BrainIndexComponentState = Schema.Struct({
  componentId: Ulid,
  error: Schema.optional(NonEmptyString),
  kind: Schema.Literals(["dense", "entity", "exact", "lexical"]),
  status: Schema.Literals(["failed", "pending", "ready", "suppressed"]),
  updatedAt: Timestamp,
});

export const BrainIndexStateRecord = makeRecordSchema("brain-index-state", {
  ...mutableResourceFields,
  attemptId: Ulid,
  brainId: Ulid,
  chunkIds: Schema.Array(NonEmptyString),
  components: Schema.Array(BrainIndexComponentState),
  contentHash: Schema.optional(NonEmptyString),
  documentId: Ulid,
  documentVersionId: Ulid,
  embeddingProfileId: Ulid,
  lastError: Schema.optional(NonEmptyString),
  organizationId: Ulid,
  placementGeneration: NonNegativeSafeInteger,
  projectionGeneration: NonNegativeSafeInteger,
  provider: BrainSearchProviderId,
  schemaGeneration: NonNegativeSafeInteger,
  sourceId: Ulid,
  status: Schema.Literals(["failed", "pending", "ready", "stale", "suppressed"]),
  synchronizedAt: Schema.optional(Timestamp),
  targetId: Ulid,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const data = record.data;
      const componentIds = data.components.map((component) => component.componentId);
      if (new Set(componentIds).size !== componentIds.length) {
        return "Brain index component identities must be unique.";
      }
      if (
        data.status === "ready" &&
        (data.components.length === 0 ||
          data.components.some((part) => part.status !== "ready") ||
          !data.contentHash ||
          !data.synchronizedAt ||
          data.chunkIds.length === 0)
      ) {
        return "Ready Brain index state requires every component, content, chunks, and synchronization time.";
      }
      return data.status !== "suppressed" || data.chunkIds.length === 0
        ? undefined
        : "Suppressed Brain index state cannot retain live chunk identities.";
    }),
  ),
);

export const BrainProviderMutationClaimRecord = makeRecordSchema("brain-provider-mutation-claim", {
  ...mutableResourceFields,
  brainId: Ulid,
  documentId: Ulid,
  jobId: Ulid,
  leaseExpiresAt: Schema.optional(Timestamp),
  leaseOwner: Schema.optional(NonEmptyString),
  mutationPriority: NonNegativeSafeInteger,
  organizationId: Ulid,
  projectionGeneration: NonNegativeSafeInteger,
  provider: BrainSearchProviderId,
  schemaGeneration: NonNegativeSafeInteger,
  status: Schema.Literals(["active", "committed", "unknown"]),
  targetId: Ulid,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const leased =
        record.data.leaseOwner !== undefined && record.data.leaseExpiresAt !== undefined;
      return (record.data.status === "active") === leased
        ? undefined
        : "Only active Brain provider mutation claims carry a complete lease.";
    }),
  ),
);
