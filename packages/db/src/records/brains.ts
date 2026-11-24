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

export const BrainKind = Schema.Literals(["company", "member-private"]);
export const BrainStatus = Schema.Literals(["active", "archived", "erasing"]);
export const BrainSensitivity = Schema.Literals([
  "confidential",
  "internal",
  "public",
  "restricted",
]);
export const BrainReviewStatus = Schema.Literals(["approved", "pending", "rejected", "unreviewed"]);

export const BrainRecord = makeRecordSchema("brain", {
  ...mutableResourceFields,
  createdByPrincipalId: Ulid,
  id: Ulid,
  kind: BrainKind,
  maintenancePolicy: Metadata,
  name: NonEmptyString,
  organizationId: Ulid,
  ownerPrincipalId: Schema.optional(Ulid),
  ownershipGeneration: NonNegativeSafeInteger,
  retentionPolicyId: Schema.optional(Ulid),
  retrievalPolicy: Metadata,
  schemaVersion: NonNegativeSafeInteger,
  sensitivity: BrainSensitivity,
  slug: NonEmptyString,
  status: BrainStatus,
  updatedByPrincipalId: Ulid,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      if (record.data.kind === "member-private") {
        if (!record.data.ownerPrincipalId) {
          return {
            path: ["data", "ownerPrincipalId"],
            issue: "Member-private brains require one owner principal.",
          };
        }
        return record.data.ownershipGeneration > 0
          ? undefined
          : {
              path: ["data", "ownershipGeneration"],
              issue: "Member-private brains require a positive ownership generation.",
            };
      }
      if (record.data.ownerPrincipalId) {
        return {
          path: ["data", "ownerPrincipalId"],
          issue: "Company brains do not store a singular owner principal.",
        };
      }
      return record.data.ownershipGeneration === 0
        ? undefined
        : {
            path: ["data", "ownershipGeneration"],
            issue: "Company brains use ownership generation zero.",
          };
    }),
  ),
);

export const BrainGrantRecord = makeRecordSchema("brain-grant", {
  ...mutableResourceFields,
  agentDefinitionId: Schema.optional(Ulid),
  brainId: Ulid,
  brainKind: BrainKind,
  grantedByPrincipalId: Ulid,
  id: Ulid,
  organizationId: Ulid,
  organizationRole: Schema.optional(Schema.Literals(["admin", "member", "owner"])),
  ownershipGeneration: Schema.optional(NonNegativeSafeInteger),
  permission: Schema.Literals(["curator", "owner", "read", "read-write", "reader", "writer"]),
  principalId: Schema.optional(Ulid),
  revokedAt: Schema.optional(Timestamp),
  serviceAccountId: Schema.optional(Ulid),
  status: Schema.Literals(["active", "revoked"]),
  targetEnvironmentId: Schema.optional(Ulid),
  targetProjectId: Schema.optional(Ulid),
  targetType: Schema.Literals([
    "agent-definition",
    "organization-role",
    "principal",
    "service-account",
  ]),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const data = record.data;
      const targetFields = [
        data.agentDefinitionId,
        data.organizationRole,
        data.principalId,
        data.serviceAccountId,
      ].filter((value) => value !== undefined);
      if (targetFields.length !== 1) {
        return {
          path: ["data", "targetType"],
          issue: "Brain grants require exactly one target identity.",
        };
      }
      const targetMatches =
        (data.targetType === "agent-definition" && data.agentDefinitionId !== undefined) ||
        (data.targetType === "organization-role" && data.organizationRole !== undefined) ||
        (data.targetType === "principal" && data.principalId !== undefined) ||
        (data.targetType === "service-account" && data.serviceAccountId !== undefined);
      if (!targetMatches) {
        return {
          path: ["data", "targetType"],
          issue: "Brain grant targetType does not match its target identity.",
        };
      }
      const machineTarget =
        data.targetType === "agent-definition" || data.targetType === "service-account";
      if (
        machineTarget !==
        (data.targetEnvironmentId !== undefined && data.targetProjectId !== undefined)
      ) {
        return {
          path: ["data", "targetEnvironmentId"],
          issue: "Machine grants require project and environment scope; human grants forbid it.",
        };
      }
      if (machineTarget && data.permission !== "read" && data.permission !== "read-write") {
        return {
          path: ["data", "permission"],
          issue: "Agent and service-account grants use read or read-write permission.",
        };
      }
      if (!machineTarget && (data.permission === "read" || data.permission === "read-write")) {
        return {
          path: ["data", "permission"],
          issue: "Human and organization-role grants use human Brain roles.",
        };
      }
      if (data.brainKind === "member-private") {
        if (data.targetType === "organization-role") {
          return {
            path: ["data", "targetType"],
            issue: "Member-private brains cannot grant organization roles.",
          };
        }
        if (data.ownershipGeneration === undefined || data.ownershipGeneration <= 0) {
          return {
            path: ["data", "ownershipGeneration"],
            issue: "Member-private grants require a positive ownership generation.",
          };
        }
      } else if (data.ownershipGeneration !== undefined) {
        return {
          path: ["data", "ownershipGeneration"],
          issue: "Company Brain grants do not carry an ownership generation.",
        };
      }
      return (data.status === "revoked") === (data.revokedAt !== undefined)
        ? undefined
        : {
            path: ["data", "revokedAt"],
            issue: "Revoked Brain grants require revokedAt and active grants forbid it.",
          };
    }),
  ),
);

export const BrainDeploymentMountRecord = makeRecordSchema("brain-deployment-mount", {
  ...mutableResourceFields,
  agentDefinitionId: Ulid,
  agentDeploymentId: Ulid,
  brainId: Ulid,
  brainKind: BrainKind,
  grantedByPrincipalId: Ulid,
  id: Ulid,
  organizationId: Ulid,
  ownershipGeneration: Schema.optional(NonNegativeSafeInteger),
  permission: Schema.Literals(["read", "read-write"]),
  projectId: Ulid,
  environmentId: Ulid,
  revokedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["active", "revoked"]),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const data = record.data;
      if (
        data.brainKind === "member-private" &&
        (data.ownershipGeneration === undefined || data.ownershipGeneration <= 0)
      ) {
        return {
          path: ["data", "ownershipGeneration"],
          issue: "Member-private Brain mounts require a positive ownership generation.",
        };
      }
      if (data.brainKind === "company" && data.ownershipGeneration !== undefined) {
        return {
          path: ["data", "ownershipGeneration"],
          issue: "Company Brain mounts do not carry an ownership generation.",
        };
      }
      return (data.status === "revoked") === (data.revokedAt !== undefined)
        ? undefined
        : {
            path: ["data", "revokedAt"],
            issue: "Revoked Brain mounts require revokedAt and active mounts forbid it.",
          };
    }),
  ),
);

export const BrainSourceRecord = makeRecordSchema("brain-source", {
  ...mutableResourceFields,
  brainId: Ulid,
  connectionId: Schema.optional(Ulid),
  configuration: Schema.optional(Metadata),
  createdByPrincipalId: Ulid,
  id: Ulid,
  environmentId: Schema.optional(Ulid),
  kind: Schema.Literals([
    "email",
    "github",
    "google-drive",
    "notion",
    "platform-conversation",
    "slack",
    "teams",
    "upload",
  ]),
  lastSyncAt: Schema.optional(Timestamp),
  name: NonEmptyString,
  organizationId: Ulid,
  projectId: Schema.optional(Ulid),
  status: Schema.Literals(["active", "archived", "failed", "paused"]),
  syncCursor: Schema.optional(NonEmptyString),
  syncError: Schema.optional(NonEmptyString),
  updatedByPrincipalId: Ulid,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const connectorFields = [
        record.data.connectionId,
        record.data.configuration,
        record.data.environmentId,
        record.data.projectId,
      ].filter((value) => value !== undefined).length;
      return record.data.kind === "github"
        ? connectorFields === 4
          ? undefined
          : "GitHub Brain sources require connection, scope, and configuration."
        : connectorFields === 0
          ? undefined
          : "Only managed Brain sources may carry connector configuration.";
    }),
  ),
);

export const BrainSourceItemClaimRecord = makeRecordSchema("brain-source-item-claim", {
  brainId: Ulid,
  createdAt: Timestamp,
  documentId: Ulid,
  externalItemIdentity: NonEmptyString,
  id: Ulid,
  organizationId: Ulid,
  sourceId: Ulid,
});

export const BrainSourceRevisionClaimRecord = makeRecordSchema("brain-source-revision-claim", {
  brainId: Ulid,
  createdAt: Timestamp,
  documentId: Ulid,
  externalItemIdentity: NonEmptyString,
  fingerprint: NonEmptyString,
  id: Ulid,
  organizationId: Ulid,
  revisionKey: NonEmptyString,
  sourceId: Ulid,
  versionId: Ulid,
});

export const BrainDocumentRecord = makeRecordSchema("brain-document", {
  ...mutableResourceFields,
  brainId: Ulid,
  currentContentVersionId: Schema.optional(Ulid),
  currentEnvelopeHash: Schema.optional(NonEmptyString),
  currentSourceOrder: Schema.optional(NonNegativeSafeInteger),
  currentVersionId: Schema.optional(Ulid),
  externalItemIdentity: NonEmptyString,
  id: Ulid,
  lifecycle: Schema.Literals(["active", "archived", "deleted"]),
  organizationId: Ulid,
  projectionGeneration: NonNegativeSafeInteger,
  reviewStatus: BrainReviewStatus,
  sensitivity: BrainSensitivity,
  sourceId: Ulid,
  sourceLocator: Schema.optional(NonEmptyString),
  title: Schema.optional(NonEmptyString),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const data = record.data;
      const currentFields = [
        data.currentEnvelopeHash,
        data.currentSourceOrder,
        data.currentVersionId,
      ];
      const populated = currentFields.filter((value) => value !== undefined).length;
      if (populated !== 0 && populated !== currentFields.length) {
        return {
          path: ["data", "currentVersionId"],
          issue: "Current Brain document projection fields must be set together.",
        };
      }
      if (data.currentContentVersionId && !data.currentVersionId) {
        return {
          path: ["data", "currentContentVersionId"],
          issue: "Brain document content cannot exist without a current revision.",
        };
      }
      return data.lifecycle === "active" && data.currentVersionId && !data.currentContentVersionId
        ? {
            path: ["data", "currentContentVersionId"],
            issue: "Active Brain documents require a current citable content version.",
          }
        : undefined;
    }),
  ),
);

const BrainBodyReference = BlobReference.pipe(
  Schema.check(
    Schema.makeFilter((reference) =>
      reference.versionId?.trim()
        ? undefined
        : "Brain content references require an immutable S3 versionId.",
    ),
  ),
);

export const BrainDocumentVersionRecord = makeRecordSchema("brain-document-version", {
  bodyRef: Schema.optional(BrainBodyReference),
  brainId: Ulid,
  byteSize: Schema.optional(NonNegativeSafeInteger),
  contentHash: Schema.optional(NonEmptyString),
  createdAt: Timestamp,
  documentId: Ulid,
  envelopeHash: NonEmptyString,
  id: Ulid,
  kind: Schema.Literals(["archive", "content", "restore", "tombstone"]),
  language: Schema.optional(NonEmptyString),
  mediaType: Schema.optional(NonEmptyString),
  organizationId: Ulid,
  originalRenditionId: Schema.optional(Ulid),
  predecessorVersionId: Schema.optional(Ulid),
  restoredContentVersionId: Schema.optional(Ulid),
  sourceId: Ulid,
  sourceOrder: NonNegativeSafeInteger,
  sourceRevision: Schema.optional(NonEmptyString),
  sourceTimestamp: Schema.optional(Timestamp),
  transitionReason: Schema.optional(NonEmptyString),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const data = record.data;
      const contentFields = [data.bodyRef, data.byteSize, data.contentHash, data.mediaType];
      const populated = contentFields.filter((value) => value !== undefined).length;
      if (data.kind === "content") {
        return populated === contentFields.length && data.originalRenditionId
          ? undefined
          : {
              path: ["data", "bodyRef"],
              issue:
                "Content versions require body, size, hash, media type, and original rendition.",
            };
      }
      if (populated !== 0 || data.originalRenditionId) {
        return {
          path: ["data", "bodyRef"],
          issue: "Lifecycle document versions cannot contain a content body.",
        };
      }
      if (data.kind === "restore" && !data.restoredContentVersionId) {
        return {
          path: ["data", "restoredContentVersionId"],
          issue: "Restore versions require the restored content version identity.",
        };
      }
      return data.kind !== "restore" && data.restoredContentVersionId
        ? {
            path: ["data", "restoredContentVersionId"],
            issue: "Only restore versions may identify restored content.",
          }
        : undefined;
    }),
  ),
);

export const BrainDocumentRenditionRecord = makeRecordSchema("brain-document-rendition", {
  bodyRef: BrainBodyReference,
  brainId: Ulid,
  contentHash: NonEmptyString,
  coordinateSystem: Schema.Literals([
    "media-timestamp",
    "page-bounding-box",
    "stable-message",
    "unicode-scalar",
    "utf8-byte",
  ]),
  createdAt: Timestamp,
  documentId: Ulid,
  documentVersionId: Ulid,
  id: Ulid,
  kind: Schema.Literals(["normalized", "ocr", "original", "transcript"]),
  organizationId: Ulid,
  transformation: Schema.optional(Metadata),
});

export const BrainSourceOrderClaimRecord = makeRecordSchema("brain-source-order-claim", {
  ...mutableResourceFields,
  brainId: Ulid,
  documentId: Ulid,
  envelopeHash: NonEmptyString,
  id: Ulid,
  leaseExpiresAt: Timestamp,
  leaseOwner: NonEmptyString,
  organizationId: Ulid,
  sourceId: Ulid,
  sourceOrder: NonNegativeSafeInteger,
  stableVersion: NonEmptyString,
  status: Schema.Literals(["committed", "expired", "reserved"]),
});

export const BrainUploadTicketRecord = makeRecordSchema(
  "brain-upload-ticket",
  {
    ...mutableResourceFields,
    brainId: Ulid,
    bodyRef: Schema.optional(BrainBodyReference),
    completedAt: Schema.optional(Timestamp),
    consumedAt: Schema.optional(Timestamp),
    createdByPrincipalId: Schema.optional(Ulid),
    createdByServiceAccountId: Schema.optional(Ulid),
    documentId: Schema.optional(Ulid),
    documentVersionId: Schema.optional(Ulid),
    environmentId: Schema.optional(Ulid),
    expiresAt: Timestamp,
    expectedByteSize: NonNegativeSafeInteger,
    expectedContentHash: NonEmptyString,
    id: Ulid,
    mediaType: NonEmptyString,
    objectKey: NonEmptyString,
    organizationId: Ulid,
    projectId: Schema.optional(Ulid),
    revisionClaimId: Schema.optional(Ulid),
    sourceId: Ulid,
    status: Schema.Literals([
      "completed",
      "consumed",
      "expired",
      "issued",
      "rejected",
      "streaming",
    ]),
  },
  {
    expiresAtField: "expiresAt",
    expiresAtRequired: true,
    expiresAtTtlRequired: false,
  },
).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const data = record.data;
      const human = data.createdByPrincipalId !== undefined;
      const service = data.createdByServiceAccountId !== undefined;
      if (human === service) {
        return "Brain upload tickets require exactly one human or service caller.";
      }
      if (service !== (data.projectId !== undefined && data.environmentId !== undefined)) {
        return "Service upload tickets require project and environment scope; human tickets forbid it.";
      }
      const hasCompletion = data.completedAt !== undefined && data.bodyRef !== undefined;
      if (
        (data.completedAt === undefined) !== (data.bodyRef === undefined) ||
        ((data.status === "completed" || data.status === "consumed") && !hasCompletion) ||
        ((data.status === "issued" || data.status === "streaming") && hasCompletion)
      ) {
        return "Brain upload ticket completion fields and status are inconsistent.";
      }
      const consumption = [
        data.consumedAt,
        data.documentId,
        data.documentVersionId,
        data.revisionClaimId,
      ];
      const consumedFields = consumption.filter((value) => value !== undefined).length;
      return data.status === "consumed"
        ? consumedFields === consumption.length
          ? undefined
          : "Consumed upload tickets require the exact revision and document result binding."
        : consumedFields === 0
          ? undefined
          : "Only consumed upload tickets may carry revision and document result bindings.";
    }),
  ),
);

export const BrainUploadLeaseRecord = makeRecordSchema(
  "brain-upload-lease",
  {
    ...mutableResourceFields,
    brainId: Ulid,
    expiresAt: Timestamp,
    id: Ulid,
    organizationId: Ulid,
    owner: NonEmptyString,
    status: Schema.Literals(["active", "completed", "expired", "revoked"]),
    ticketId: Ulid,
  },
  {
    expiresAtField: "expiresAt",
    expiresAtRequired: true,
    expiresAtTtlRequired: true,
  },
);

export const BrainContentStagingRecord = makeRecordSchema(
  "brain-content-staging",
  {
    ...mutableResourceFields,
    attempt: NonNegativeSafeInteger,
    brainId: Ulid,
    documentId: Ulid,
    documentVersionId: Ulid,
    encryptionContext: Metadata,
    expectedByteLimit: NonNegativeSafeInteger,
    expectedKey: NonEmptyString,
    expiresAt: Timestamp,
    id: Ulid,
    intendedRenditionId: Ulid,
    jobId: Ulid,
    mediaType: NonEmptyString,
    organizationId: Ulid,
    status: Schema.Literals(["cleanup-pending", "pending", "promoted"]),
  },
  {
    expiresAtField: "expiresAt",
    expiresAtRequired: true,
    expiresAtTtlRequired: true,
  },
);
