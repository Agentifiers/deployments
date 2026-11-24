import type {
  Brain,
  BrainDeploymentMount,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainEdge,
  BrainEntity,
  BrainGrant,
  BrainSource,
  BrainSourceRevisionClaim,
  BrainUploadLease,
  BrainUploadTicket,
} from "@deployments-ai/brains";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  BrainDeploymentMountRecord,
  BrainDocumentRecord,
  BrainDocumentRenditionRecord,
  BrainDocumentVersionRecord,
  BrainGrantRecord,
  BrainRecord,
  BrainSourceRecord,
  BrainSourceRevisionClaimRecord,
  BrainUploadLeaseRecord,
  BrainUploadTicketRecord,
} from "../records/brains.ts";
import { BrainEdgeRecord, BrainEntityRecord } from "../records/brain-graph.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";

export type BrainPlatformRecord = typeof BrainRecord.Type;
export type BrainGrantPlatformRecord = typeof BrainGrantRecord.Type;
export type BrainMountPlatformRecord = typeof BrainDeploymentMountRecord.Type;
export type BrainSourcePlatformRecord = typeof BrainSourceRecord.Type;
export type BrainDocumentPlatformRecord = typeof BrainDocumentRecord.Type;
export type BrainDocumentVersionPlatformRecord = typeof BrainDocumentVersionRecord.Type;
export type BrainDocumentRenditionPlatformRecord = typeof BrainDocumentRenditionRecord.Type;
export type BrainSourceRevisionClaimPlatformRecord = typeof BrainSourceRevisionClaimRecord.Type;
export type BrainUploadTicketPlatformRecord = typeof BrainUploadTicketRecord.Type;
export type BrainUploadLeasePlatformRecord = typeof BrainUploadLeaseRecord.Type;
export type BrainEntityPlatformRecord = typeof BrainEntityRecord.Type;
export type BrainEdgePlatformRecord = typeof BrainEdgeRecord.Type;

export function brainUlid(value: string) {
  return Schema.decodeUnknownSync(Ulid)(value);
}

export function brainEntityPlatformRecord(entity: BrainEntity): BrainEntityPlatformRecord {
  return Schema.decodeUnknownSync(BrainEntityRecord)(
    withCanonicalRecordKeys({
      data: {
        ...entity,
        brainId: brainUlid(entity.brainId),
        id: brainUlid(entity.id),
        ...(entity.mergedIntoEntityId
          ? { mergedIntoEntityId: brainUlid(entity.mergedIntoEntityId) }
          : {}),
        organizationId: brainUlid(entity.organizationId),
      },
      itemType: "brain-entity" as const,
    }),
  );
}

export function brainEntityFromPlatformRecord(record: BrainEntityPlatformRecord): BrainEntity {
  const data = record.data;
  return {
    brainId: data.brainId,
    canonicalName: data.canonicalName,
    createdAt: data.createdAt,
    externalIdentifiers: data.externalIdentifiers,
    id: data.id,
    kind: data.kind,
    ...(data.mergedIntoEntityId ? { mergedIntoEntityId: data.mergedIntoEntityId } : {}),
    normalizedAliases: data.normalizedAliases,
    organizationId: data.organizationId,
    reviewStatus: data.reviewStatus,
    status: data.status,
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

export function brainEdgePlatformRecord(edge: BrainEdge): BrainEdgePlatformRecord {
  return Schema.decodeUnknownSync(BrainEdgeRecord)(
    withCanonicalRecordKeys({
      data: {
        ...edge,
        brainId: brainUlid(edge.brainId),
        documentVersionId: brainUlid(edge.documentVersionId),
        from: { id: brainUlid(edge.from.id), kind: edge.from.kind },
        id: brainUlid(edge.id),
        organizationId: brainUlid(edge.organizationId),
        renditionId: brainUlid(edge.renditionId),
        to: { id: brainUlid(edge.to.id), kind: edge.to.kind },
      },
      itemType: "brain-edge" as const,
    }),
  );
}

export function brainEdgeFromPlatformRecord(record: BrainEdgePlatformRecord): BrainEdge {
  return { ...record.data };
}

export function brainDocumentRenditionPlatformRecord(
  rendition: BrainDocumentRendition,
): BrainDocumentRenditionPlatformRecord {
  return Schema.decodeUnknownSync(BrainDocumentRenditionRecord)(
    withCanonicalRecordKeys({
      data: {
        ...rendition,
        brainId: brainUlid(rendition.brainId),
        documentId: brainUlid(rendition.documentId),
        documentVersionId: brainUlid(rendition.documentVersionId),
        id: brainUlid(rendition.id),
        organizationId: brainUlid(rendition.organizationId),
      },
      itemType: "brain-document-rendition" as const,
    }),
  );
}

export function brainDocumentRenditionFromPlatformRecord(
  record: BrainDocumentRenditionPlatformRecord,
): BrainDocumentRendition {
  const data = record.data;
  return {
    bodyRef: {
      bucket: data.bodyRef.bucket,
      byteSize: data.bodyRef.byteSize,
      contentType: data.bodyRef.contentType,
      ...(data.bodyRef.etag ? { etag: data.bodyRef.etag } : {}),
      ...(data.bodyRef.fileName ? { fileName: data.bodyRef.fileName } : {}),
      key: data.bodyRef.key,
      sha256: data.bodyRef.sha256,
      versionId: data.bodyRef.versionId!,
    },
    brainId: data.brainId,
    contentHash: data.contentHash,
    coordinateSystem: data.coordinateSystem,
    createdAt: data.createdAt,
    documentId: data.documentId,
    documentVersionId: data.documentVersionId,
    id: data.id,
    kind: data.kind,
    organizationId: data.organizationId,
    ...(data.transformation ? { transformation: data.transformation } : {}),
  };
}

export function brainPlatformRecord(brain: Brain): BrainPlatformRecord {
  return Schema.decodeUnknownSync(BrainRecord)(
    withCanonicalRecordKeys({ data: { ...brain }, itemType: "brain" as const }),
  );
}

export function brainFromPlatformRecord(record: BrainPlatformRecord): Brain {
  const data = record.data;
  return {
    createdAt: data.createdAt,
    createdByPrincipalId: data.createdByPrincipalId,
    id: data.id,
    kind: data.kind,
    maintenancePolicy: data.maintenancePolicy,
    name: data.name,
    organizationId: data.organizationId,
    ...(data.ownerPrincipalId ? { ownerPrincipalId: data.ownerPrincipalId } : {}),
    ownershipGeneration: data.ownershipGeneration,
    ...(data.retentionPolicyId ? { retentionPolicyId: data.retentionPolicyId } : {}),
    retrievalPolicy: data.retrievalPolicy,
    schemaVersion: data.schemaVersion,
    sensitivity: data.sensitivity,
    slug: data.slug,
    status: data.status,
    updatedAt: data.updatedAt,
    updatedByPrincipalId: data.updatedByPrincipalId,
    version: data.version,
  };
}

function grantTargetData(target: BrainGrant["target"]) {
  switch (target.type) {
    case "agent-definition":
      return {
        agentDefinitionId: brainUlid(target.agentDefinitionId),
        targetEnvironmentId: brainUlid(target.environmentId),
        targetProjectId: brainUlid(target.projectId),
      };
    case "organization-role":
      return { organizationRole: target.organizationRole };
    case "principal":
      return { principalId: brainUlid(target.principalId) };
    case "service-account":
      return {
        serviceAccountId: brainUlid(target.serviceAccountId),
        targetEnvironmentId: brainUlid(target.environmentId),
        targetProjectId: brainUlid(target.projectId),
      };
  }
}

export function brainGrantPlatformRecord(grant: BrainGrant): BrainGrantPlatformRecord {
  return Schema.decodeUnknownSync(BrainGrantRecord)(
    withCanonicalRecordKeys({
      data: {
        brainId: brainUlid(grant.brainId),
        brainKind: grant.brainKind,
        createdAt: grant.createdAt,
        grantedByPrincipalId: brainUlid(grant.grantedByPrincipalId),
        id: brainUlid(grant.id),
        organizationId: brainUlid(grant.organizationId),
        ...(grant.ownershipGeneration === undefined
          ? {}
          : { ownershipGeneration: grant.ownershipGeneration }),
        permission: grant.permission,
        ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
        status: grant.status,
        ...grantTargetData(grant.target),
        targetType: grant.target.type,
        updatedAt: grant.updatedAt,
        version: grant.version,
      },
      itemType: "brain-grant" as const,
    }),
  );
}

export function brainGrantFromPlatformRecord(record: BrainGrantPlatformRecord): BrainGrant {
  const data = record.data;
  const shared = {
    brainId: data.brainId,
    brainKind: data.brainKind,
    createdAt: data.createdAt,
    grantedByPrincipalId: data.grantedByPrincipalId,
    id: data.id,
    organizationId: data.organizationId,
    ...(data.ownershipGeneration === undefined
      ? {}
      : { ownershipGeneration: data.ownershipGeneration }),
    permission: data.permission,
    ...(data.revokedAt ? { revokedAt: data.revokedAt } : {}),
    status: data.status,
    updatedAt: data.updatedAt,
    version: data.version,
  };
  switch (data.targetType) {
    case "agent-definition":
      return {
        ...shared,
        target: {
          agentDefinitionId: data.agentDefinitionId!,
          environmentId: data.targetEnvironmentId!,
          projectId: data.targetProjectId!,
          type: "agent-definition",
        },
      };
    case "organization-role":
      return {
        ...shared,
        target: {
          organizationRole: data.organizationRole!,
          type: "organization-role",
        },
      };
    case "principal":
      return {
        ...shared,
        target: { principalId: data.principalId!, type: "principal" },
      };
    case "service-account":
      return {
        ...shared,
        target: {
          environmentId: data.targetEnvironmentId!,
          projectId: data.targetProjectId!,
          serviceAccountId: data.serviceAccountId!,
          type: "service-account",
        },
      };
  }
}

export function brainMountPlatformRecord(mount: BrainDeploymentMount): BrainMountPlatformRecord {
  return Schema.decodeUnknownSync(BrainDeploymentMountRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: brainUlid(mount.agentDefinitionId),
        agentDeploymentId: brainUlid(mount.agentDeploymentId),
        brainId: brainUlid(mount.brainId),
        brainKind: mount.brainKind,
        createdAt: mount.createdAt,
        environmentId: brainUlid(mount.environmentId),
        grantedByPrincipalId: brainUlid(mount.grantedByPrincipalId),
        id: brainUlid(mount.id),
        organizationId: brainUlid(mount.organizationId),
        ...(mount.ownershipGeneration === undefined
          ? {}
          : { ownershipGeneration: mount.ownershipGeneration }),
        permission: mount.permission,
        projectId: brainUlid(mount.projectId),
        ...(mount.revokedAt ? { revokedAt: mount.revokedAt } : {}),
        status: mount.status,
        updatedAt: mount.updatedAt,
        version: mount.version,
      },
      itemType: "brain-deployment-mount" as const,
    }),
  );
}

export function brainMountFromPlatformRecord(
  record: BrainMountPlatformRecord,
): BrainDeploymentMount {
  const data = record.data;
  return {
    agentDefinitionId: data.agentDefinitionId,
    agentDeploymentId: data.agentDeploymentId,
    brainId: data.brainId,
    brainKind: data.brainKind,
    createdAt: data.createdAt,
    environmentId: data.environmentId,
    grantedByPrincipalId: data.grantedByPrincipalId,
    id: data.id,
    organizationId: data.organizationId,
    ...(data.ownershipGeneration === undefined
      ? {}
      : { ownershipGeneration: data.ownershipGeneration }),
    permission: data.permission,
    projectId: data.projectId,
    ...(data.revokedAt ? { revokedAt: data.revokedAt } : {}),
    status: data.status,
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

export function brainSourcePlatformRecord(source: BrainSource): BrainSourcePlatformRecord {
  return Schema.decodeUnknownSync(BrainSourceRecord)(
    withCanonicalRecordKeys({
      data: { ...source },
      itemType: "brain-source" as const,
    }),
  );
}

export function brainSourceFromPlatformRecord(record: BrainSourcePlatformRecord): BrainSource {
  const data = record.data;
  return {
    brainId: data.brainId,
    ...(data.connectionId ? { connectionId: data.connectionId } : {}),
    ...(data.configuration ? { configuration: data.configuration } : {}),
    createdAt: data.createdAt,
    createdByPrincipalId: data.createdByPrincipalId,
    id: data.id,
    kind: data.kind,
    ...(data.environmentId ? { environmentId: data.environmentId } : {}),
    ...(data.lastSyncAt ? { lastSyncAt: data.lastSyncAt } : {}),
    name: data.name,
    organizationId: data.organizationId,
    ...(data.projectId ? { projectId: data.projectId } : {}),
    status: data.status,
    ...(data.syncCursor ? { syncCursor: data.syncCursor } : {}),
    ...(data.syncError ? { syncError: data.syncError } : {}),
    updatedAt: data.updatedAt,
    updatedByPrincipalId: data.updatedByPrincipalId,
    version: data.version,
  };
}

export function brainDocumentPlatformRecord(document: BrainDocument): BrainDocumentPlatformRecord {
  return Schema.decodeUnknownSync(BrainDocumentRecord)(
    withCanonicalRecordKeys({
      data: { ...document },
      itemType: "brain-document" as const,
    }),
  );
}

export function brainDocumentFromPlatformRecord(
  record: BrainDocumentPlatformRecord,
): BrainDocument {
  const data = record.data;
  return {
    brainId: data.brainId,
    createdAt: data.createdAt,
    ...(data.currentContentVersionId
      ? { currentContentVersionId: data.currentContentVersionId }
      : {}),
    ...(data.currentEnvelopeHash ? { currentEnvelopeHash: data.currentEnvelopeHash } : {}),
    ...(data.currentSourceOrder === undefined
      ? {}
      : { currentSourceOrder: data.currentSourceOrder }),
    ...(data.currentVersionId ? { currentVersionId: data.currentVersionId } : {}),
    externalItemIdentity: data.externalItemIdentity,
    id: data.id,
    lifecycle: data.lifecycle,
    organizationId: data.organizationId,
    projectionGeneration: data.projectionGeneration,
    reviewStatus: data.reviewStatus,
    sensitivity: data.sensitivity,
    sourceId: data.sourceId,
    ...(data.sourceLocator ? { sourceLocator: data.sourceLocator } : {}),
    ...(data.title ? { title: data.title } : {}),
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

export function brainDocumentVersionPlatformRecord(
  version: BrainDocumentVersion,
): BrainDocumentVersionPlatformRecord {
  return Schema.decodeUnknownSync(BrainDocumentVersionRecord)(
    withCanonicalRecordKeys({
      data: { ...version },
      itemType: "brain-document-version" as const,
    }),
  );
}

export function brainDocumentVersionFromPlatformRecord(
  record: BrainDocumentVersionPlatformRecord,
): BrainDocumentVersion {
  const data = record.data;
  return {
    ...(data.bodyRef
      ? {
          bodyRef: {
            bucket: data.bodyRef.bucket,
            byteSize: data.bodyRef.byteSize,
            contentType: data.bodyRef.contentType,
            ...(data.bodyRef.etag ? { etag: data.bodyRef.etag } : {}),
            ...(data.bodyRef.fileName ? { fileName: data.bodyRef.fileName } : {}),
            key: data.bodyRef.key,
            sha256: data.bodyRef.sha256,
            versionId: data.bodyRef.versionId!,
          },
        }
      : {}),
    brainId: data.brainId,
    ...(data.byteSize === undefined ? {} : { byteSize: data.byteSize }),
    ...(data.contentHash ? { contentHash: data.contentHash } : {}),
    createdAt: data.createdAt,
    documentId: data.documentId,
    envelopeHash: data.envelopeHash,
    id: data.id,
    kind: data.kind,
    ...(data.language ? { language: data.language } : {}),
    ...(data.mediaType ? { mediaType: data.mediaType } : {}),
    organizationId: data.organizationId,
    ...(data.originalRenditionId ? { originalRenditionId: data.originalRenditionId } : {}),
    ...(data.predecessorVersionId ? { predecessorVersionId: data.predecessorVersionId } : {}),
    ...(data.restoredContentVersionId
      ? { restoredContentVersionId: data.restoredContentVersionId }
      : {}),
    sourceId: data.sourceId,
    sourceOrder: data.sourceOrder,
    ...(data.sourceRevision ? { sourceRevision: data.sourceRevision } : {}),
    ...(data.sourceTimestamp ? { sourceTimestamp: data.sourceTimestamp } : {}),
    ...(data.transitionReason ? { transitionReason: data.transitionReason } : {}),
  };
}

export function brainSourceRevisionClaimPlatformRecord(
  claim: BrainSourceRevisionClaim,
): BrainSourceRevisionClaimPlatformRecord {
  return Schema.decodeUnknownSync(BrainSourceRevisionClaimRecord)(
    withCanonicalRecordKeys({
      data: { ...claim },
      itemType: "brain-source-revision-claim" as const,
    }),
  );
}

export function brainSourceRevisionClaimFromPlatformRecord(
  record: BrainSourceRevisionClaimPlatformRecord,
): BrainSourceRevisionClaim {
  return { ...record.data };
}

function uploadBodyReference(bodyRef: BrainUploadTicket["bodyRef"]) {
  return bodyRef
    ? {
        bucket: bodyRef.bucket,
        byteSize: bodyRef.byteSize,
        contentType: bodyRef.contentType,
        ...(bodyRef.etag ? { etag: bodyRef.etag } : {}),
        ...(bodyRef.fileName ? { fileName: bodyRef.fileName } : {}),
        key: bodyRef.key,
        sha256: bodyRef.sha256,
        versionId: bodyRef.versionId,
      }
    : undefined;
}

export function brainUploadTicketPlatformRecord(
  ticket: BrainUploadTicket,
): BrainUploadTicketPlatformRecord {
  return Schema.decodeUnknownSync(BrainUploadTicketRecord)(
    withCanonicalRecordKeys({
      data: {
        ...ticket,
        ...(ticket.bodyRef ? { bodyRef: uploadBodyReference(ticket.bodyRef) } : {}),
      },
      itemType: "brain-upload-ticket" as const,
    }),
  );
}

export function brainUploadTicketFromPlatformRecord(
  record: BrainUploadTicketPlatformRecord,
): BrainUploadTicket {
  const data = record.data;
  return {
    ...(data.bodyRef
      ? {
          bodyRef: {
            bucket: data.bodyRef.bucket,
            byteSize: data.bodyRef.byteSize,
            contentType: data.bodyRef.contentType,
            ...(data.bodyRef.etag ? { etag: data.bodyRef.etag } : {}),
            ...(data.bodyRef.fileName ? { fileName: data.bodyRef.fileName } : {}),
            key: data.bodyRef.key,
            sha256: data.bodyRef.sha256,
            versionId: data.bodyRef.versionId!,
          },
        }
      : {}),
    brainId: data.brainId,
    ...(data.completedAt ? { completedAt: data.completedAt } : {}),
    ...(data.consumedAt ? { consumedAt: data.consumedAt } : {}),
    createdAt: data.createdAt,
    ...(data.createdByPrincipalId ? { createdByPrincipalId: data.createdByPrincipalId } : {}),
    ...(data.createdByServiceAccountId
      ? { createdByServiceAccountId: data.createdByServiceAccountId }
      : {}),
    ...(data.documentId ? { documentId: data.documentId } : {}),
    ...(data.documentVersionId ? { documentVersionId: data.documentVersionId } : {}),
    ...(data.environmentId ? { environmentId: data.environmentId } : {}),
    expectedByteSize: data.expectedByteSize,
    expectedContentHash: data.expectedContentHash,
    expiresAt: data.expiresAt,
    id: data.id,
    mediaType: data.mediaType,
    objectKey: data.objectKey,
    organizationId: data.organizationId,
    ...(data.projectId ? { projectId: data.projectId } : {}),
    ...(data.revisionClaimId ? { revisionClaimId: data.revisionClaimId } : {}),
    sourceId: data.sourceId,
    status: data.status,
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

export function brainUploadLeasePlatformRecord(
  lease: BrainUploadLease,
): BrainUploadLeasePlatformRecord {
  return Schema.decodeUnknownSync(BrainUploadLeaseRecord)(
    withCanonicalRecordKeys({
      data: { ...lease },
      itemType: "brain-upload-lease" as const,
      ttl: Math.floor(Date.parse(lease.expiresAt) / 1_000),
    }),
  );
}
