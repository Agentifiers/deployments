import { createHash } from "node:crypto";
import type {
  Brain,
  BrainBlobReference,
  BrainDocument,
  BrainDocumentCaptureResult,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainGrant,
  BrainSource,
  BrainUploadLease,
  BrainUploadTicket,
} from "./models.ts";
import type {
  BrainAgentWriteAuthorization,
  BrainMutationCaller,
  BrainRepository,
} from "./ports.ts";

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function identityFields(actor: BrainMutationCaller) {
  return actor.kind === "human"
    ? { createdByPrincipalId: actor.principalId }
    : {
        createdByServiceAccountId: actor.serviceAccountId,
        environmentId: actor.environmentId,
        projectId: actor.projectId,
      };
}

export interface CaptureBrainContentInput {
  readonly actor: BrainMutationCaller;
  readonly agentAuthorization?: BrainAgentWriteAuthorization;
  readonly authorizingGrant: BrainGrant;
  readonly brain: Brain;
  readonly bytes: Uint8Array;
  readonly externalItemIdentity: string;
  readonly generateId: () => Promise<string>;
  readonly mediaType: string;
  readonly now?: () => string;
  readonly repository: BrainRepository;
  readonly sensitivity?: BrainDocument["sensitivity"];
  readonly source: BrainSource;
  readonly sourceLocator?: string;
  readonly sourceOrder?: number;
  readonly sourceRevision: string;
  readonly sourceTimestamp?: string;
  readonly title?: string;
  readonly upload: (input: {
    readonly bytes: Uint8Array;
    readonly lease: BrainUploadLease;
    readonly ticket: BrainUploadTicket;
  }) => Promise<BrainBlobReference>;
}

export async function captureBrainContent(
  input: CaptureBrainContentInput,
): Promise<BrainDocumentCaptureResult> {
  if (
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > 32 * 1_024 * 1_024 ||
    input.source.status !== "active" ||
    input.brain.status !== "active" ||
    input.source.organizationId !== input.brain.organizationId ||
    input.source.brainId !== input.brain.id ||
    input.authorizingGrant.brainId !== input.brain.id ||
    input.authorizingGrant.status !== "active"
  ) {
    throw new TypeError("Brain content capture envelope is invalid.");
  }
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const contentHash = sha256(input.bytes);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        brainId: input.brain.id,
        contentHash,
        externalItemIdentity: input.externalItemIdentity,
        mediaType: input.mediaType,
        sourceId: input.source.id,
        sourceLocator: input.sourceLocator,
        sourceRevision: input.sourceRevision,
        title: input.title,
      }),
    )
    .digest("hex");
  const existingClaim = await input.repository.findSourceRevisionClaim(
    input.brain.organizationId,
    input.source.id,
    input.externalItemIdentity,
    input.sourceRevision,
  );
  if (existingClaim) {
    if (existingClaim.fingerprint !== fingerprint) {
      throw new TypeError("Brain source revision conflicts with an existing evidence envelope.");
    }
    const [document, version] = await Promise.all([
      input.repository.getDocument(
        input.brain.organizationId,
        input.brain.id,
        existingClaim.documentId,
      ),
      input.repository.getDocumentVersion(
        input.brain.organizationId,
        existingClaim.documentId,
        existingClaim.versionId,
      ),
    ]);
    if (!document || !version) throw new TypeError("Brain revision replay result is unavailable.");
    return { document, version };
  }

  const previous = await input.repository.findDocumentBySourceIdentity(
    input.brain.organizationId,
    input.brain.id,
    input.source.id,
    input.externalItemIdentity,
  );
  const sourceOrder = input.sourceOrder ?? (previous?.currentSourceOrder ?? -1) + 1;
  if (previous?.currentSourceOrder !== undefined && sourceOrder <= previous.currentSourceOrder) {
    throw new TypeError("Brain capture source order must advance the current document revision.");
  }
  const [ticketId, leaseId, renditionId, revisionClaimId, captureEventId] = await Promise.all([
    input.generateId(),
    input.generateId(),
    input.generateId(),
    input.generateId(),
    input.generateId(),
  ]);
  const documentId = previous?.id ?? (await input.generateId());
  const expiresAt = new Date(Date.parse(timestamp) + 15 * 60_000).toISOString();
  const issued: BrainUploadTicket = {
    brainId: input.brain.id,
    createdAt: timestamp,
    ...identityFields(input.actor),
    expectedByteSize: input.bytes.byteLength,
    expectedContentHash: contentHash,
    expiresAt,
    id: ticketId,
    mediaType: input.mediaType,
    objectKey: `organizations/${input.brain.organizationId}/brains/${input.brain.id}/document-versions/${ticketId}/original`,
    organizationId: input.brain.organizationId,
    sourceId: input.source.id,
    status: "issued",
    updatedAt: timestamp,
    version: 0,
  };
  await input.repository.issueUploadTicket({
    actor: input.actor,
    ...(input.agentAuthorization ? { agentAuthorization: input.agentAuthorization } : {}),
    authorizingGrant: input.authorizingGrant,
    eventId: await input.generateId(),
    source: input.source,
    ticket: issued,
  });
  const activeLease: BrainUploadLease = {
    brainId: input.brain.id,
    createdAt: timestamp,
    expiresAt,
    id: leaseId,
    organizationId: input.brain.organizationId,
    owner: leaseId,
    status: "active",
    ticketId,
    updatedAt: timestamp,
    version: 0,
  };
  const streaming = await input.repository.beginUpload({
    actor: input.actor,
    ...(input.agentAuthorization ? { agentAuthorization: input.agentAuthorization } : {}),
    authorizingGrant: input.authorizingGrant,
    lease: activeLease,
    next: { ...issued, status: "streaming", version: 1 },
    previous: issued,
    source: input.source,
  });
  const bodyRef = await input.upload({ bytes: input.bytes, lease: activeLease, ticket: streaming });
  if (
    bodyRef.key !== issued.objectKey ||
    bodyRef.byteSize !== input.bytes.byteLength ||
    bodyRef.sha256 !== contentHash ||
    !bodyRef.versionId
  ) {
    throw new TypeError("Brain capture upload did not preserve the issued immutable envelope.");
  }
  const completed = await input.repository.completeUpload({
    actor: input.actor,
    ...(input.agentAuthorization ? { agentAuthorization: input.agentAuthorization } : {}),
    authorizingGrant: input.authorizingGrant,
    lease: { ...activeLease, status: "completed", version: 1 },
    next: {
      ...streaming,
      bodyRef,
      completedAt: timestamp,
      status: "completed",
      version: streaming.version + 1,
    },
    previous: streaming,
    previousLease: activeLease,
    source: input.source,
  });
  const version: BrainDocumentVersion = {
    bodyRef,
    brainId: input.brain.id,
    byteSize: input.bytes.byteLength,
    contentHash,
    createdAt: timestamp,
    documentId,
    envelopeHash: fingerprint,
    id: ticketId,
    kind: "content",
    mediaType: input.mediaType,
    organizationId: input.brain.organizationId,
    originalRenditionId: renditionId,
    ...(previous?.currentVersionId ? { predecessorVersionId: previous.currentVersionId } : {}),
    sourceId: input.source.id,
    sourceOrder,
    sourceRevision: input.sourceRevision,
    ...(input.sourceTimestamp ? { sourceTimestamp: input.sourceTimestamp } : {}),
  };
  const rendition: BrainDocumentRendition = {
    bodyRef,
    brainId: input.brain.id,
    contentHash,
    coordinateSystem: "utf8-byte",
    createdAt: timestamp,
    documentId,
    documentVersionId: version.id,
    id: renditionId,
    kind: "original",
    organizationId: input.brain.organizationId,
  };
  const document: BrainDocument = {
    ...(previous ?? {
      brainId: input.brain.id,
      createdAt: timestamp,
      externalItemIdentity: input.externalItemIdentity,
      id: documentId,
      organizationId: input.brain.organizationId,
      projectionGeneration: -1,
      reviewStatus: "unreviewed" as const,
      sourceId: input.source.id,
      version: -1,
    }),
    currentContentVersionId: version.id,
    currentEnvelopeHash: fingerprint,
    currentSourceOrder: sourceOrder,
    currentVersionId: version.id,
    lifecycle: "active",
    projectionGeneration: (previous?.projectionGeneration ?? -1) + 1,
    sensitivity: input.sensitivity ?? previous?.sensitivity ?? input.brain.sensitivity,
    ...(input.sourceLocator ? { sourceLocator: input.sourceLocator } : {}),
    ...(input.title ? { title: input.title } : {}),
    updatedAt: timestamp,
    version: (previous?.version ?? -1) + 1,
  };
  return input.repository.captureDocumentRevision({
    actor: input.actor,
    ...(input.agentAuthorization ? { agentAuthorization: input.agentAuthorization } : {}),
    authorizingGrant: input.authorizingGrant,
    document,
    eventId: captureEventId,
    ...(previous ? { previous } : {}),
    rendition,
    revisionClaim: {
      brainId: input.brain.id,
      createdAt: timestamp,
      documentId,
      externalItemIdentity: input.externalItemIdentity,
      fingerprint,
      id: revisionClaimId,
      organizationId: input.brain.organizationId,
      revisionKey: input.sourceRevision,
      sourceId: input.source.id,
      versionId: version.id,
    },
    source: input.source,
    uploadTicket: {
      next: {
        ...completed,
        consumedAt: timestamp,
        documentId,
        documentVersionId: version.id,
        revisionClaimId,
        status: "consumed",
        version: completed.version + 1,
      },
      previous: completed,
    },
    version,
  });
}

export async function captureBrainDocumentLifecycle(input: {
  readonly actor: BrainMutationCaller;
  readonly agentAuthorization?: BrainAgentWriteAuthorization;
  readonly authorizingGrant: BrainGrant;
  readonly brain: Brain;
  readonly externalItemIdentity: string;
  readonly generateId: () => Promise<string>;
  readonly kind: "archive" | "tombstone";
  readonly now?: () => string;
  readonly repository: BrainRepository;
  readonly source: BrainSource;
  readonly sourceRevision: string;
  readonly sourceTimestamp?: string;
  readonly transitionReason: string;
}) {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        brainId: input.brain.id,
        externalItemIdentity: input.externalItemIdentity,
        kind: input.kind,
        sourceId: input.source.id,
        sourceRevision: input.sourceRevision,
        transitionReason: input.transitionReason,
      }),
    )
    .digest("hex");
  const existingClaim = await input.repository.findSourceRevisionClaim(
    input.brain.organizationId,
    input.source.id,
    input.externalItemIdentity,
    input.sourceRevision,
  );
  if (existingClaim) {
    if (existingClaim.fingerprint !== fingerprint) {
      throw new TypeError("Brain lifecycle revision conflicts with an existing evidence envelope.");
    }
    const [document, version] = await Promise.all([
      input.repository.getDocument(
        input.brain.organizationId,
        input.brain.id,
        existingClaim.documentId,
      ),
      input.repository.getDocumentVersion(
        input.brain.organizationId,
        existingClaim.documentId,
        existingClaim.versionId,
      ),
    ]);
    if (!document || !version) throw new TypeError("Brain lifecycle replay is unavailable.");
    return { document, version };
  }
  const previous = await input.repository.findDocumentBySourceIdentity(
    input.brain.organizationId,
    input.brain.id,
    input.source.id,
    input.externalItemIdentity,
  );
  if (!previous?.currentVersionId || previous.lifecycle === "deleted") {
    throw new TypeError("Brain lifecycle transition requires a current source document.");
  }
  const [versionId, claimId, eventId] = await Promise.all([
    input.generateId(),
    input.generateId(),
    input.generateId(),
  ]);
  const sourceOrder = (previous.currentSourceOrder ?? -1) + 1;
  const version: BrainDocumentVersion = {
    brainId: input.brain.id,
    createdAt: timestamp,
    documentId: previous.id,
    envelopeHash: fingerprint,
    id: versionId,
    kind: input.kind,
    organizationId: input.brain.organizationId,
    predecessorVersionId: previous.currentVersionId,
    sourceId: input.source.id,
    sourceOrder,
    sourceRevision: input.sourceRevision,
    ...(input.sourceTimestamp ? { sourceTimestamp: input.sourceTimestamp } : {}),
    transitionReason: input.transitionReason,
  };
  const document: BrainDocument = {
    ...previous,
    currentEnvelopeHash: fingerprint,
    currentSourceOrder: sourceOrder,
    currentVersionId: versionId,
    lifecycle: input.kind === "archive" ? "archived" : "deleted",
    projectionGeneration: previous.projectionGeneration + 1,
    updatedAt: timestamp,
    version: previous.version + 1,
  };
  return input.repository.captureDocumentRevision({
    actor: input.actor,
    ...(input.agentAuthorization ? { agentAuthorization: input.agentAuthorization } : {}),
    authorizingGrant: input.authorizingGrant,
    document,
    eventId,
    previous,
    revisionClaim: {
      brainId: input.brain.id,
      createdAt: timestamp,
      documentId: previous.id,
      externalItemIdentity: input.externalItemIdentity,
      fingerprint,
      id: claimId,
      organizationId: input.brain.organizationId,
      revisionKey: input.sourceRevision,
      sourceId: input.source.id,
      versionId,
    },
    source: input.source,
    version,
  });
}
