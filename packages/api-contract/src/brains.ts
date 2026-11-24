import { Schema } from "effect";
import { Cursor, PublicId } from "./primitives.ts";

const nonEmptyText = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) =>
      value.trim().length > 0 ? undefined : "Expected a non-empty string.",
    ),
  ),
);

const BrainName = nonEmptyText.pipe(Schema.check(Schema.isMaxLength(200)));
const BrainSlug = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(80),
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  ),
);
const BrainPageLimit = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
);
const BrainVersion = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const BrainUploadByteSize = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    // The authenticated HTTP API product limit stays below API Gateway's
    // payload ceiling. The storage/extraction hard cap remains 32 MiB.
    Schema.isLessThanOrEqualTo(8 * 1024 * 1024),
  ),
);
const BrainKind = Schema.Literals(["company", "member-private"]);
const BrainStatus = Schema.Literals(["active", "archived", "erasing"]);
const BrainSensitivity = Schema.Literals(["confidential", "internal", "public", "restricted"]);

export const BrainListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(BrainPageLimit),
  status: Schema.optional(BrainStatus),
});

export const CreateBrainRequest = Schema.Struct({
  kind: BrainKind,
  name: BrainName,
  sensitivity: Schema.optional(BrainSensitivity),
  slug: BrainSlug,
});

export const UpdateBrainRequest = Schema.Struct({
  expectedVersion: BrainVersion,
  maintenancePolicy: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  name: Schema.optional(BrainName),
  retrievalPolicy: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  sensitivity: Schema.optional(BrainSensitivity),
  slug: Schema.optional(BrainSlug),
});

export const ArchiveBrainRequest = Schema.Struct({
  expectedVersion: BrainVersion,
});

export const EraseBrainRequest = Schema.Struct({
  expectedVersion: BrainVersion,
});

const PrincipalGrantTarget = Schema.Struct({
  principalId: PublicId,
  type: Schema.Literal("principal"),
});
const OrganizationRoleGrantTarget = Schema.Struct({
  organizationRole: Schema.Literals(["admin", "member", "owner"]),
  type: Schema.Literal("organization-role"),
});
const ServiceAccountGrantTarget = Schema.Struct({
  environmentId: PublicId,
  projectId: PublicId,
  serviceAccountId: PublicId,
  type: Schema.Literal("service-account"),
});
const AgentDefinitionGrantTarget = Schema.Struct({
  agentDefinitionId: PublicId,
  environmentId: PublicId,
  projectId: PublicId,
  type: Schema.Literal("agent-definition"),
});

export const CreateBrainGrantRequest = Schema.Union([
  Schema.Struct({
    permission: Schema.Literals(["curator", "owner", "reader", "writer"]),
    target: PrincipalGrantTarget,
  }),
  Schema.Struct({
    permission: Schema.Literals(["curator", "reader", "writer"]),
    target: OrganizationRoleGrantTarget,
  }),
  Schema.Struct({
    permission: Schema.Literals(["read", "read-write"]),
    target: ServiceAccountGrantTarget,
  }),
  Schema.Struct({
    permission: Schema.Literals(["read", "read-write"]),
    target: AgentDefinitionGrantTarget,
  }),
]);

export const RevokeBrainGrantRequest = Schema.Struct({
  expectedVersion: BrainVersion,
});

export const CreateBrainMountRequest = Schema.Struct({
  agentDefinitionId: PublicId,
  agentDeploymentId: PublicId,
  environmentId: PublicId,
  permission: Schema.Literals(["read", "read-write"]),
  projectId: PublicId,
});

export const RevokeBrainMountRequest = Schema.Struct({
  expectedVersion: BrainVersion,
});

const GitHubRepositoryName = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isPattern(/^[A-Za-z0-9_.-]+$/u),
  ),
);
export const CreateBrainSourceRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("upload"),
    name: BrainName,
  }),
  Schema.Struct({
    configuration: Schema.Struct({
      owner: GitHubRepositoryName,
      ref: Schema.optional(nonEmptyText.pipe(Schema.check(Schema.isMaxLength(255)))),
      repository: GitHubRepositoryName,
    }),
    connectionId: PublicId,
    environmentId: PublicId,
    kind: Schema.Literal("github"),
    name: BrainName,
    projectId: PublicId,
  }),
]);

export const CreateBrainUploadTicketRequest = Schema.Struct({
  expectedByteSize: BrainUploadByteSize,
  expectedContentHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u))),
  mediaType: Schema.Literals([
    "application/json",
    "application/pdf",
    "text/csv",
    "text/html",
    "text/markdown",
    "text/plain",
  ]),
});

export const CaptureBrainDocumentRequest = Schema.Struct({
  completedUploadTicketId: Schema.optional(PublicId),
  externalItemIdentity: nonEmptyText,
  kind: Schema.Literals(["archive", "content", "restore", "tombstone"]),
  mediaType: Schema.optional(nonEmptyText),
  restoredContentVersionId: Schema.optional(PublicId),
  sensitivity: Schema.optional(BrainSensitivity),
  sourceLocator: Schema.optional(nonEmptyText),
  sourceOrder: Schema.optional(BrainVersion),
  sourceRevision: Schema.optional(nonEmptyText),
  sourceTimestamp: Schema.optional(nonEmptyText),
  stableVersion: Schema.optional(nonEmptyText),
  title: Schema.optional(nonEmptyText),
  transitionReason: Schema.optional(nonEmptyText),
}).pipe(
  Schema.check(
    Schema.makeFilter((input) => {
      if (input.kind === "content" && !input.completedUploadTicketId) {
        return "Content capture requires a completed upload ticket.";
      }
      if (input.kind !== "content" && input.completedUploadTicketId) {
        return "Lifecycle capture cannot include an upload ticket.";
      }
      return input.kind === "restore" && !input.restoredContentVersionId
        ? "Restore capture requires restoredContentVersionId."
        : undefined;
    }),
  ),
);

const BrainQuery = nonEmptyText.pipe(Schema.check(Schema.isMaxLength(8_000)));
const BrainQueryIds = Schema.Array(PublicId).pipe(
  Schema.check(
    Schema.makeFilter((ids) =>
      ids.length >= 1 && ids.length <= 20 && new Set(ids).size === ids.length
        ? undefined
        : "Brain queries require between 1 and 20 unique Brain IDs.",
    ),
  ),
);
const BrainSearchLimit = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
);

export const BrainSearchRequest = Schema.Struct({
  brainIds: BrainQueryIds,
  limit: Schema.optional(BrainSearchLimit),
  query: BrainQuery,
});

export const BrainAskRequest = Schema.Struct({
  brainIds: BrainQueryIds,
  evidenceLimit: Schema.optional(BrainSearchLimit),
  question: BrainQuery,
});

export const BrainResponse = Schema.Struct({
  createdAt: Schema.String,
  id: PublicId,
  kind: BrainKind,
  name: BrainName,
  organizationId: PublicId,
  ownerPrincipalId: Schema.optional(PublicId),
  ownershipGeneration: BrainVersion,
  schemaVersion: BrainVersion,
  sensitivity: BrainSensitivity,
  slug: BrainSlug,
  status: BrainStatus,
  updatedAt: Schema.String,
  version: BrainVersion,
});

export const BrainErasureResponse = Schema.Struct({
  brainId: PublicId,
  completedAt: Schema.optional(Schema.String),
  contentVerificationCount: BrainVersion,
  createdAt: Schema.String,
  erasureGeneration: BrainVersion,
  error: Schema.optional(nonEmptyText),
  id: PublicId,
  organizationId: PublicId,
  recordsDeleted: Schema.optional(BrainVersion),
  searchReceipt: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  startedAt: Schema.optional(Schema.String),
  status: Schema.Literals(["completed", "failed", "pending", "running"]),
  updatedAt: Schema.String,
  version: BrainVersion,
});

export const BrainGrantResponse = Schema.Struct({
  brainId: PublicId,
  createdAt: Schema.String,
  id: PublicId,
  organizationId: PublicId,
  ownershipGeneration: Schema.optional(BrainVersion),
  permission: Schema.Literals(["curator", "owner", "read", "read-write", "reader", "writer"]),
  revokedAt: Schema.optional(Schema.String),
  status: Schema.Literals(["active", "revoked"]),
  target: Schema.Union([
    PrincipalGrantTarget,
    OrganizationRoleGrantTarget,
    ServiceAccountGrantTarget,
    AgentDefinitionGrantTarget,
  ]),
  updatedAt: Schema.String,
  version: BrainVersion,
});

export const BrainMountResponse = Schema.Struct({
  agentDefinitionId: PublicId,
  agentDeploymentId: PublicId,
  brainId: PublicId,
  createdAt: Schema.String,
  environmentId: PublicId,
  id: PublicId,
  organizationId: PublicId,
  ownershipGeneration: Schema.optional(BrainVersion),
  permission: Schema.Literals(["read", "read-write"]),
  projectId: PublicId,
  revokedAt: Schema.optional(Schema.String),
  status: Schema.Literals(["active", "revoked"]),
  updatedAt: Schema.String,
  version: BrainVersion,
});

export const BrainSourceResponse = Schema.Struct({
  brainId: PublicId,
  connectionId: Schema.optional(PublicId),
  configuration: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  createdAt: Schema.String,
  createdByPrincipalId: PublicId,
  id: PublicId,
  environmentId: Schema.optional(PublicId),
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
  lastSyncAt: Schema.optional(Schema.String),
  name: BrainName,
  organizationId: PublicId,
  projectId: Schema.optional(PublicId),
  status: Schema.Literals(["active", "archived", "failed", "paused"]),
  syncCursor: Schema.optional(nonEmptyText),
  syncError: Schema.optional(nonEmptyText),
  updatedAt: Schema.String,
  updatedByPrincipalId: PublicId,
  version: BrainVersion,
});
const BrainDocumentStateResponse = Schema.Struct({
  brainId: PublicId,
  createdAt: Schema.String,
  currentContentVersionId: Schema.optional(PublicId),
  currentEnvelopeHash: Schema.optional(nonEmptyText),
  currentSourceOrder: Schema.optional(BrainVersion),
  currentVersionId: Schema.optional(PublicId),
  externalItemIdentity: nonEmptyText,
  id: PublicId,
  lifecycle: Schema.Literals(["active", "archived", "deleted"]),
  organizationId: PublicId,
  projectionGeneration: BrainVersion,
  reviewStatus: Schema.Literals(["approved", "pending", "rejected", "unreviewed"]),
  sensitivity: BrainSensitivity,
  sourceId: PublicId,
  sourceLocator: Schema.optional(nonEmptyText),
  title: Schema.optional(nonEmptyText),
  updatedAt: Schema.String,
  version: BrainVersion,
});
const BrainBlobReferenceResponse = Schema.Struct({
  bucket: nonEmptyText,
  byteSize: BrainVersion,
  contentType: nonEmptyText,
  etag: Schema.optional(nonEmptyText),
  fileName: Schema.optional(nonEmptyText),
  key: nonEmptyText,
  sha256: nonEmptyText,
  versionId: nonEmptyText,
});
const BrainDocumentVersionResponse = Schema.Struct({
  bodyRef: Schema.optional(BrainBlobReferenceResponse),
  brainId: PublicId,
  byteSize: Schema.optional(BrainVersion),
  contentHash: Schema.optional(nonEmptyText),
  createdAt: Schema.String,
  documentId: PublicId,
  envelopeHash: nonEmptyText,
  id: PublicId,
  kind: Schema.Literals(["archive", "content", "restore", "tombstone"]),
  language: Schema.optional(nonEmptyText),
  mediaType: Schema.optional(nonEmptyText),
  organizationId: PublicId,
  originalRenditionId: Schema.optional(PublicId),
  predecessorVersionId: Schema.optional(PublicId),
  restoredContentVersionId: Schema.optional(PublicId),
  sourceId: PublicId,
  sourceOrder: BrainVersion,
  sourceRevision: Schema.optional(nonEmptyText),
  sourceTimestamp: Schema.optional(Schema.String),
  transitionReason: Schema.optional(nonEmptyText),
});
export const BrainDocumentResponse = Schema.Struct({
  document: BrainDocumentStateResponse,
  version: BrainDocumentVersionResponse,
});
export const BrainUploadTicketResponse = Schema.Struct({
  bodyRef: Schema.optional(BrainBlobReferenceResponse),
  brainId: PublicId,
  completedAt: Schema.optional(Schema.String),
  consumedAt: Schema.optional(Schema.String),
  createdAt: Schema.String,
  directUpload: Schema.optional(
    Schema.Struct({
      completePath: nonEmptyText,
      expiresAt: Schema.String,
      headers: Schema.Record(Schema.String, Schema.String),
      method: Schema.Literal("PUT"),
      url: nonEmptyText,
    }),
  ),
  documentId: Schema.optional(PublicId),
  documentVersionId: Schema.optional(PublicId),
  expectedByteSize: BrainVersion,
  expectedContentHash: nonEmptyText,
  expiresAt: Schema.String,
  id: PublicId,
  mediaType: nonEmptyText,
  organizationId: PublicId,
  revisionClaimId: Schema.optional(PublicId),
  sourceId: PublicId,
  status: Schema.Literals(["completed", "consumed", "expired", "issued", "rejected", "streaming"]),
  updatedAt: Schema.String,
  uploadPath: Schema.optional(nonEmptyText),
  version: BrainVersion,
});
const BrainCitation = Schema.Struct({
  brainId: PublicId,
  chunkId: nonEmptyText,
  coordinates: Schema.Struct({
    end: BrainVersion,
    kind: Schema.Literals([
      "media-timestamp",
      "page-bounding-box",
      "stable-message",
      "unicode-scalar",
      "utf8-byte",
    ]),
    start: BrainVersion,
  }),
  documentId: PublicId,
  documentVersionId: PublicId,
  renditionId: PublicId,
  sourceId: PublicId,
});
const BrainSearchResultResponse = Schema.Struct({
  citation: BrainCitation,
  excerpt: nonEmptyText,
  score: Schema.Number,
  sensitivity: BrainSensitivity,
  title: Schema.optional(nonEmptyText),
});
export const BrainSearchResponse = Schema.Struct({
  queryAttemptId: PublicId,
  results: Schema.Array(BrainSearchResultResponse),
});
export const BrainAskResponse = Schema.Struct({
  claims: Schema.Array(
    Schema.Struct({
      citationIds: Schema.Array(nonEmptyText),
      text: nonEmptyText,
    }),
  ),
  gaps: Schema.Array(nonEmptyText),
  queryAttemptId: PublicId,
  usedCitations: Schema.Array(BrainCitation),
});
export const BrainPageResponse = Schema.Struct({
  items: Schema.Array(BrainResponse),
  nextCursor: Schema.optional(Cursor),
});
export const BrainGrantPageResponse = Schema.Struct({
  items: Schema.Array(BrainGrantResponse),
  nextCursor: Schema.optional(Cursor),
});
export const BrainMountPageResponse = Schema.Struct({
  items: Schema.Array(BrainMountResponse),
  nextCursor: Schema.optional(Cursor),
});
export const BrainSourcePageResponse = Schema.Struct({
  items: Schema.Array(BrainSourceResponse),
  nextCursor: Schema.optional(Cursor),
});
export const BrainIndexHealthPageResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      components: Schema.Array(
        Schema.Struct({
          error: Schema.optional(nonEmptyText),
          kind: Schema.Literals(["dense", "entity", "exact", "lexical"]),
          status: Schema.Literals(["failed", "pending", "ready", "suppressed"]),
          updatedAt: Schema.String,
        }),
      ),
      documentId: PublicId,
      documentVersionId: PublicId,
      lastError: Schema.optional(nonEmptyText),
      projectionGeneration: BrainVersion,
      status: Schema.Literals(["failed", "pending", "ready", "stale", "suppressed"]),
      synchronizedAt: Schema.optional(Schema.String),
      updatedAt: Schema.String,
    }),
  ),
  nextCursor: Schema.optional(Cursor),
});
export const ResolveBrainReviewItemRequest = Schema.Struct({
  decision: Schema.Literals(["approve", "merge", "reject"]),
  expectedVersion: BrainVersion,
  targetEntityId: Schema.optional(PublicId),
});
export const BrainReviewItemResponse = Schema.Struct({
  brainId: PublicId,
  createdAt: Schema.String,
  decision: Schema.optional(Schema.Literals(["approve", "merge", "reject"])),
  documentId: Schema.optional(PublicId),
  entityId: Schema.optional(PublicId),
  id: PublicId,
  kind: Schema.Literals([
    "contradiction",
    "duplicate-document",
    "entity-merge",
    "extraction",
    "summary",
  ]),
  organizationId: PublicId,
  proposal: Schema.Record(Schema.String, Schema.Unknown),
  reason: nonEmptyText,
  resolvedAt: Schema.optional(Schema.String),
  resolvedByPrincipalId: Schema.optional(PublicId),
  status: Schema.Literals(["open", "resolved"]),
  updatedAt: Schema.String,
  version: BrainVersion,
});
export const BrainReviewItemPageResponse = Schema.Struct({
  items: Schema.Array(BrainReviewItemResponse),
  nextCursor: Schema.optional(Cursor),
});
const BrainGraphEndpointResponse = Schema.Struct({
  id: PublicId,
  kind: Schema.Literals(["document", "entity"]),
});
const BrainEntityResponse = Schema.Struct({
  brainId: PublicId,
  canonicalName: nonEmptyText,
  createdAt: Schema.String,
  externalIdentifiers: Schema.Record(Schema.String, Schema.Unknown),
  id: PublicId,
  kind: Schema.Literals(["company", "concept", "person", "project"]),
  mergedIntoEntityId: Schema.optional(PublicId),
  normalizedAliases: Schema.Array(nonEmptyText),
  organizationId: PublicId,
  reviewStatus: Schema.Literals(["approved", "pending", "rejected", "unreviewed"]),
  status: Schema.Literals(["active", "archived", "merged"]),
  updatedAt: Schema.String,
  version: BrainVersion,
});
const BrainEdgeResponse = Schema.Struct({
  brainId: PublicId,
  confidence: Schema.Number,
  createdAt: Schema.String,
  documentVersionId: PublicId,
  evidence: Schema.Record(Schema.String, Schema.Unknown),
  extractionMethod: Schema.Literals(["deterministic", "model", "trusted-hint"]),
  from: BrainGraphEndpointResponse,
  id: PublicId,
  lifecycle: Schema.Literals(["active", "archived", "deleted"]),
  organizationId: PublicId,
  relation: nonEmptyText,
  renditionId: PublicId,
  reviewStatus: Schema.Literals(["approved", "pending", "rejected", "unreviewed"]),
  to: BrainGraphEndpointResponse,
  updatedAt: Schema.String,
  version: BrainVersion,
});
export const BrainEntityEvidenceResponse = Schema.Struct({
  edges: Schema.Array(BrainEdgeResponse),
  entity: BrainEntityResponse,
});
export const RecordBrainFeedbackRequest = Schema.Struct({
  feedback: Schema.optional(
    nonEmptyText.pipe(
      Schema.check(Schema.isMaxLength(2_000, { message: "Feedback is too long." })),
    ),
  ),
  usefulness: Schema.Literals(["harmful", "neutral", "useful"]),
});
export const BrainFeedbackResponse = Schema.Struct({
  queryAttemptId: PublicId,
  recordedAt: Schema.String,
  usefulness: Schema.Literals(["harmful", "neutral", "useful"]),
});

export type BrainListQuery = typeof BrainListQuery.Type;
export type CreateBrainRequest = typeof CreateBrainRequest.Type;
export type UpdateBrainRequest = typeof UpdateBrainRequest.Type;
export type ArchiveBrainRequest = typeof ArchiveBrainRequest.Type;
export type EraseBrainRequest = typeof EraseBrainRequest.Type;
export type CreateBrainGrantRequest = typeof CreateBrainGrantRequest.Type;
export type RevokeBrainGrantRequest = typeof RevokeBrainGrantRequest.Type;
export type CreateBrainMountRequest = typeof CreateBrainMountRequest.Type;
export type RevokeBrainMountRequest = typeof RevokeBrainMountRequest.Type;
export type CreateBrainSourceRequest = typeof CreateBrainSourceRequest.Type;
export type CreateBrainUploadTicketRequest = typeof CreateBrainUploadTicketRequest.Type;
export type CaptureBrainDocumentRequest = typeof CaptureBrainDocumentRequest.Type;
export type BrainSearchRequest = typeof BrainSearchRequest.Type;
export type BrainAskRequest = typeof BrainAskRequest.Type;
export type BrainResponse = typeof BrainResponse.Type;
export type BrainGrantResponse = typeof BrainGrantResponse.Type;
export type BrainMountResponse = typeof BrainMountResponse.Type;
export type BrainPageResponse = typeof BrainPageResponse.Type;
export type BrainGrantPageResponse = typeof BrainGrantPageResponse.Type;
export type BrainMountPageResponse = typeof BrainMountPageResponse.Type;
export type BrainSourceResponse = typeof BrainSourceResponse.Type;
export type BrainDocumentResponse = typeof BrainDocumentResponse.Type;
export type BrainIndexHealthPageResponse = typeof BrainIndexHealthPageResponse.Type;
export type BrainEntityEvidenceResponse = typeof BrainEntityEvidenceResponse.Type;
export type ResolveBrainReviewItemRequest = typeof ResolveBrainReviewItemRequest.Type;
export type RecordBrainFeedbackRequest = typeof RecordBrainFeedbackRequest.Type;
export type BrainUploadTicketResponse = typeof BrainUploadTicketResponse.Type;

export const BRAIN_API_SCHEMAS = {
  ArchiveBrainRequest,
  BrainAskRequest,
  BrainAskResponse,
  BrainDocumentResponse,
  BrainEntityEvidenceResponse,
  BrainErasureResponse,
  BrainFeedbackResponse,
  BrainGrantPageResponse,
  BrainGrantResponse,
  BrainIndexHealthPageResponse,
  BrainReviewItemPageResponse,
  BrainReviewItemResponse,
  BrainMountPageResponse,
  BrainMountResponse,
  BrainPageResponse,
  BrainResponse,
  BrainSearchRequest,
  BrainSearchResponse,
  BrainSourcePageResponse,
  BrainSourceResponse,
  BrainUploadTicketResponse,
  CaptureBrainDocumentRequest,
  CreateBrainGrantRequest,
  CreateBrainMountRequest,
  CreateBrainRequest,
  CreateBrainSourceRequest,
  CreateBrainUploadTicketRequest,
  EraseBrainRequest,
  RevokeBrainGrantRequest,
  RevokeBrainMountRequest,
  ResolveBrainReviewItemRequest,
  RecordBrainFeedbackRequest,
  UpdateBrainRequest,
} as const;

export { BRAIN_API_ROUTES } from "./brain-routes.ts";
export type { BrainApiRouteName } from "./brain-routes.ts";
export type BrainApiSchemaName = keyof typeof BRAIN_API_SCHEMAS;
