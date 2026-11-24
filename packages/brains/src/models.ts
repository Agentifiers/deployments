export const BRAIN_KINDS = ["company", "member-private"] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];

export const BRAIN_STATUSES = ["active", "archived", "erasing"] as const;
export type BrainStatus = (typeof BRAIN_STATUSES)[number];

export const BRAIN_SENSITIVITIES = ["confidential", "internal", "public", "restricted"] as const;
export type BrainSensitivity = (typeof BRAIN_SENSITIVITIES)[number];

export const BRAIN_HUMAN_ROLES = ["owner", "curator", "writer", "reader"] as const;
export type BrainHumanRole = (typeof BRAIN_HUMAN_ROLES)[number];

export const BRAIN_MACHINE_PERMISSIONS = ["read", "read-write"] as const;
export type BrainMachinePermission = (typeof BRAIN_MACHINE_PERMISSIONS)[number];

export interface Brain {
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly id: string;
  readonly kind: BrainKind;
  readonly maintenancePolicy: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly organizationId: string;
  readonly ownerPrincipalId?: string;
  readonly ownershipGeneration: number;
  readonly retentionPolicyId?: string;
  readonly retrievalPolicy: Readonly<Record<string, unknown>>;
  readonly schemaVersion: number;
  readonly sensitivity: BrainSensitivity;
  readonly slug: string;
  readonly status: BrainStatus;
  readonly updatedAt: string;
  readonly updatedByPrincipalId: string;
  readonly version: number;
}

export type BrainGrantTarget =
  | { readonly principalId: string; readonly type: "principal" }
  | {
      readonly organizationRole: "admin" | "member" | "owner";
      readonly type: "organization-role";
    }
  | {
      readonly environmentId: string;
      readonly projectId: string;
      readonly serviceAccountId: string;
      readonly type: "service-account";
    }
  | {
      readonly agentDefinitionId: string;
      readonly environmentId: string;
      readonly projectId: string;
      readonly type: "agent-definition";
    };

export interface BrainGrant {
  readonly brainId: string;
  readonly brainKind: BrainKind;
  readonly createdAt: string;
  readonly grantedByPrincipalId: string;
  readonly id: string;
  readonly organizationId: string;
  readonly ownershipGeneration?: number;
  readonly permission: BrainHumanRole | BrainMachinePermission;
  readonly revokedAt?: string;
  readonly status: "active" | "revoked";
  readonly target: BrainGrantTarget;
  readonly updatedAt: string;
  readonly version: number;
}

export interface BrainDeploymentMount {
  readonly agentDefinitionId: string;
  readonly agentDeploymentId: string;
  readonly brainId: string;
  readonly brainKind: BrainKind;
  readonly createdAt: string;
  readonly grantedByPrincipalId: string;
  readonly id: string;
  readonly organizationId: string;
  readonly ownershipGeneration?: number;
  readonly permission: BrainMachinePermission;
  readonly projectId: string;
  readonly environmentId: string;
  readonly revokedAt?: string;
  readonly status: "active" | "revoked";
  readonly updatedAt: string;
  readonly version: number;
}

export interface BrainPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
}

export interface BrainIndexHealth {
  readonly components: readonly {
    readonly error?: string;
    readonly kind: "dense" | "entity" | "exact" | "lexical";
    readonly status: "failed" | "pending" | "ready" | "suppressed";
    readonly updatedAt: string;
  }[];
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly lastError?: string;
  readonly projectionGeneration: number;
  readonly status: "failed" | "pending" | "ready" | "stale" | "suppressed";
  readonly synchronizedAt?: string;
  readonly updatedAt: string;
}

export interface BrainReviewItem {
  readonly brainId: string;
  readonly createdAt: string;
  readonly decision?: "approve" | "merge" | "reject";
  readonly documentId?: string;
  readonly entityId?: string;
  readonly id: string;
  readonly kind: "contradiction" | "duplicate-document" | "entity-merge" | "extraction" | "summary";
  readonly organizationId: string;
  readonly proposal: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly resolvedAt?: string;
  readonly resolvedByPrincipalId?: string;
  readonly status: "open" | "resolved";
  readonly updatedAt: string;
  readonly version: number;
}

export interface BrainErasure {
  readonly brainId: string;
  readonly completedAt?: string;
  readonly contentQuiescenceStartedAt?: string;
  readonly contentVerificationCount: number;
  readonly createdAt: string;
  readonly erasureGeneration: number;
  readonly error?: string;
  readonly failedAttempts?: number;
  readonly id: string;
  readonly leaseExpiresAt?: string;
  readonly leaseOwner?: string;
  readonly nextDueAt: string;
  readonly organizationId: string;
  readonly phase: "draining" | "purging" | "verifying";
  readonly priority: number;
  readonly recordsDeleted?: number;
  readonly requestedByPrincipalId: string;
  readonly searchReceipt?: Readonly<Record<string, unknown>>;
  readonly startedAt?: string;
  readonly status: "completed" | "failed" | "pending" | "running";
  readonly updatedAt: string;
  readonly version: number;
}

export interface BrainEntity {
  readonly brainId: string;
  readonly canonicalName: string;
  readonly createdAt: string;
  readonly externalIdentifiers: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: "company" | "concept" | "person" | "project";
  readonly mergedIntoEntityId?: string;
  readonly normalizedAliases: readonly string[];
  readonly organizationId: string;
  readonly reviewStatus: "approved" | "pending" | "rejected" | "unreviewed";
  readonly status: "active" | "archived" | "merged";
  readonly updatedAt: string;
  readonly version: number;
}

export interface BrainEdge {
  readonly brainId: string;
  readonly confidence: number;
  readonly createdAt: string;
  readonly documentVersionId: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly extractionMethod: "deterministic" | "model" | "trusted-hint";
  readonly from: { readonly id: string; readonly kind: "document" | "entity" };
  readonly id: string;
  readonly lifecycle: "active" | "archived" | "deleted";
  readonly organizationId: string;
  readonly relation: string;
  readonly renditionId: string;
  readonly reviewStatus: "approved" | "pending" | "rejected" | "unreviewed";
  readonly to: { readonly id: string; readonly kind: "document" | "entity" };
  readonly updatedAt: string;
  readonly version: number;
}

export const BRAIN_SOURCE_KINDS = [
  "email",
  "github",
  "google-drive",
  "notion",
  "platform-conversation",
  "slack",
  "teams",
  "upload",
] as const;
export type BrainSourceKind = (typeof BRAIN_SOURCE_KINDS)[number];

export interface BrainSource {
  readonly brainId: string;
  readonly connectionId?: string;
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly id: string;
  readonly kind: BrainSourceKind;
  readonly environmentId?: string;
  readonly lastSyncAt?: string;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly status: "active" | "archived" | "failed" | "paused";
  readonly syncCursor?: string;
  readonly syncError?: string;
  readonly updatedAt: string;
  readonly updatedByPrincipalId: string;
  readonly version: number;
}

export type BrainDocumentLifecycle = "active" | "archived" | "deleted";
export type BrainDocumentVersionKind = "archive" | "content" | "restore" | "tombstone";

export interface BrainDocument {
  readonly brainId: string;
  readonly createdAt: string;
  readonly currentEnvelopeHash?: string;
  readonly currentContentVersionId?: string;
  readonly currentSourceOrder?: number;
  readonly currentVersionId?: string;
  readonly externalItemIdentity: string;
  readonly id: string;
  readonly lifecycle: BrainDocumentLifecycle;
  readonly organizationId: string;
  readonly projectionGeneration: number;
  readonly reviewStatus: "approved" | "pending" | "rejected" | "unreviewed";
  readonly sensitivity: BrainSensitivity;
  readonly sourceId: string;
  readonly sourceLocator?: string;
  readonly title?: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface BrainBlobReference {
  readonly bucket: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly etag?: string;
  readonly fileName?: string;
  readonly key: string;
  readonly sha256: string;
  readonly versionId: string;
}

export interface BrainDocumentVersion {
  readonly bodyRef?: BrainBlobReference;
  readonly brainId: string;
  readonly byteSize?: number;
  readonly contentHash?: string;
  readonly createdAt: string;
  readonly documentId: string;
  readonly envelopeHash: string;
  readonly id: string;
  readonly kind: BrainDocumentVersionKind;
  readonly language?: string;
  readonly mediaType?: string;
  readonly organizationId: string;
  readonly originalRenditionId?: string;
  readonly predecessorVersionId?: string;
  readonly restoredContentVersionId?: string;
  readonly sourceId: string;
  readonly sourceOrder: number;
  readonly sourceRevision?: string;
  readonly sourceTimestamp?: string;
  readonly transitionReason?: string;
}

export interface BrainDocumentRendition {
  readonly bodyRef: BrainBlobReference;
  readonly brainId: string;
  readonly contentHash: string;
  readonly coordinateSystem:
    | "media-timestamp"
    | "page-bounding-box"
    | "stable-message"
    | "unicode-scalar"
    | "utf8-byte";
  readonly createdAt: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly id: string;
  readonly kind: "normalized" | "ocr" | "original" | "transcript";
  readonly organizationId: string;
  readonly transformation?: Readonly<Record<string, unknown>>;
}

export interface BrainDocumentCaptureResult {
  readonly document: BrainDocument;
  readonly rendition?: BrainDocumentRendition;
  readonly version: BrainDocumentVersion;
}

export interface BrainSourceRevisionClaim {
  readonly brainId: string;
  readonly createdAt: string;
  readonly documentId: string;
  readonly externalItemIdentity: string;
  readonly fingerprint: string;
  readonly id: string;
  readonly organizationId: string;
  readonly revisionKey: string;
  readonly sourceId: string;
  readonly versionId: string;
}

export interface BrainUploadTicket {
  readonly bodyRef?: BrainBlobReference;
  readonly brainId: string;
  readonly completedAt?: string;
  readonly consumedAt?: string;
  readonly createdAt: string;
  readonly createdByPrincipalId?: string;
  readonly createdByServiceAccountId?: string;
  readonly documentId?: string;
  readonly documentVersionId?: string;
  readonly environmentId?: string;
  readonly expectedByteSize: number;
  readonly expectedContentHash: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly mediaType: string;
  readonly objectKey: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly revisionClaimId?: string;
  readonly sourceId: string;
  readonly status: "completed" | "consumed" | "expired" | "issued" | "rejected" | "streaming";
  readonly updatedAt: string;
  readonly version: number;
}

export interface BrainUploadLease {
  readonly brainId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly organizationId: string;
  readonly owner: string;
  readonly status: "active" | "completed" | "expired" | "revoked";
  readonly ticketId: string;
  readonly updatedAt: string;
  readonly version: number;
}
