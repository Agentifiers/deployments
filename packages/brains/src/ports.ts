import type {
  Brain,
  BrainDeploymentMount,
  BrainErasure,
  BrainEdge,
  BrainEntity,
  BrainGrant,
  BrainGrantTarget,
  BrainIndexHealth,
  BrainPage,
  BrainReviewItem,
  BrainDocument,
  BrainDocumentCaptureResult,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainSource,
  BrainSourceRevisionClaim,
  BrainUploadLease,
  BrainUploadTicket,
} from "./models.ts";

export interface BrainListOptions {
  readonly cursor?: string;
  readonly limit: number;
  readonly status?: Brain["status"];
}

export interface BrainResourceListOptions {
  readonly cursor?: string;
  readonly limit: number;
}

export type BrainMutationCaller =
  | { readonly kind: "human"; readonly principalId: string }
  | {
      readonly apiCredentialId: string;
      readonly environmentId: string;
      readonly kind: "service";
      readonly projectId: string;
      readonly serviceAccountId: string;
    };

export interface BrainAgentWriteAuthorization {
  readonly agentDefinitionGrant: BrainGrant;
  readonly agentDefinitionId: string;
  readonly agentDefinitionVersion: number;
  readonly agentDeploymentId: string;
  readonly agentDeploymentVersion: number;
  readonly agentReleaseContentHash: string;
  readonly agentReleaseId: string;
  readonly agentReleaseVersion: number;
  readonly callerGrant: BrainGrant;
  readonly mount: BrainDeploymentMount;
}

export interface BrainRepository {
  readonly beginErasure: (args: {
    readonly authorizingGrant: BrainGrant;
    readonly brain: Brain;
    readonly erasure: BrainErasure;
    readonly eventId: string;
    readonly previous: Brain;
  }) => Promise<BrainErasure>;
  readonly createWithOwner: (args: {
    readonly brain: Brain;
    readonly eventId: string;
    readonly ownerGrant: BrainGrant;
  }) => Promise<Brain>;
  readonly get: (organizationId: string, brainId: string) => Promise<Brain | undefined>;
  readonly getErasure: (
    organizationId: string,
    brainId: string,
    erasureId: string,
  ) => Promise<BrainErasure | undefined>;
  readonly listByOrganization: (
    organizationId: string,
    options: BrainListOptions,
  ) => Promise<BrainPage<Brain>>;
  readonly getGrant: (
    organizationId: string,
    brainId: string,
    grantId: string,
  ) => Promise<BrainGrant | undefined>;
  readonly findActiveGrant: (
    organizationId: string,
    brainId: string,
    target: BrainGrantTarget,
  ) => Promise<BrainGrant | undefined>;
  readonly listGrants: (
    organizationId: string,
    brainId: string,
    options: BrainResourceListOptions,
  ) => Promise<BrainPage<BrainGrant>>;
  readonly putGrant: (args: {
    readonly authorizingGrant: BrainGrant;
    readonly eventId: string;
    readonly grant: BrainGrant;
  }) => Promise<BrainGrant>;
  readonly revokeGrant: (args: {
    readonly actorPrincipalId: string;
    readonly authorizingGrant: BrainGrant;
    readonly eventId: string;
    readonly grant: BrainGrant;
    readonly replacementOwnerGrant?: BrainGrant;
    readonly revokedAt: string;
  }) => Promise<BrainGrant>;
  readonly getMount: (
    organizationId: string,
    brainId: string,
    mountId: string,
  ) => Promise<BrainDeploymentMount | undefined>;
  readonly findActiveMount: (
    organizationId: string,
    brainId: string,
    agentDeploymentId: string,
  ) => Promise<BrainDeploymentMount | undefined>;
  readonly listMounts: (
    organizationId: string,
    brainId: string,
    options: BrainResourceListOptions,
  ) => Promise<BrainPage<BrainDeploymentMount>>;
  readonly putMount: (args: {
    readonly agentDefinitionGrant: BrainGrant;
    readonly authorizingGrant: BrainGrant;
    readonly eventId: string;
    readonly mount: BrainDeploymentMount;
  }) => Promise<BrainDeploymentMount>;
  readonly revokeMount: (args: {
    readonly actorPrincipalId: string;
    readonly authorizingGrant: BrainGrant;
    readonly eventId: string;
    readonly mount: BrainDeploymentMount;
    readonly revokedAt: string;
  }) => Promise<BrainDeploymentMount>;
  readonly transferMemberPrivateOwnership: (args: {
    readonly brain: Brain;
    readonly eventId: string;
    readonly nextOwnerGrant: BrainGrant;
    readonly previousOwnerGrant: BrainGrant;
  }) => Promise<Brain>;
  readonly update: (args: {
    readonly authorizingGrant: BrainGrant;
    readonly brain: Brain;
    readonly eventId: string;
    readonly previous: Brain;
  }) => Promise<Brain>;
  readonly createSource: (args: {
    readonly actor: BrainMutationCaller;
    readonly authorizingGrant: BrainGrant;
    readonly eventId: string;
    readonly initialSyncJobId?: string;
    readonly source: BrainSource;
  }) => Promise<BrainSource>;
  readonly getSource: (
    organizationId: string,
    brainId: string,
    sourceId: string,
  ) => Promise<BrainSource | undefined>;
  readonly listSources: (
    organizationId: string,
    brainId: string,
    options: BrainResourceListOptions,
  ) => Promise<BrainPage<BrainSource>>;
  readonly getDocument: (
    organizationId: string,
    brainId: string,
    documentId: string,
  ) => Promise<BrainDocument | undefined>;
  readonly listDocumentsBySource: (
    organizationId: string,
    brainId: string,
    sourceId: string,
    options: BrainResourceListOptions,
  ) => Promise<BrainPage<BrainDocument>>;
  readonly listDocuments: (
    organizationId: string,
    brainId: string,
    options: BrainResourceListOptions,
  ) => Promise<BrainPage<BrainDocument>>;
  readonly listIndexHealth: (
    organizationId: string,
    brainId: string,
    options: BrainResourceListOptions,
  ) => Promise<BrainPage<BrainIndexHealth>>;
  readonly getReviewItem: (
    organizationId: string,
    brainId: string,
    reviewItemId: string,
  ) => Promise<BrainReviewItem | undefined>;
  readonly listReviewItems: (
    organizationId: string,
    brainId: string,
    options: BrainResourceListOptions & { readonly status?: BrainReviewItem["status"] },
  ) => Promise<BrainPage<BrainReviewItem>>;
  readonly getEntity: (
    organizationId: string,
    brainId: string,
    entityId: string,
  ) => Promise<BrainEntity | undefined>;
  readonly findEntityByAlias: (
    organizationId: string,
    brainId: string,
    normalizedAlias: string,
  ) => Promise<BrainEntity | undefined>;
  readonly listEntityEdges: (
    organizationId: string,
    brainId: string,
    entityId: string,
    direction: "incoming" | "outgoing",
    options: BrainResourceListOptions,
  ) => Promise<BrainPage<BrainEdge>>;
  readonly resolveReviewItem: (args: {
    readonly actorPrincipalId: string;
    readonly authorizingGrant: BrainGrant;
    readonly brain: Brain;
    readonly eventId: string;
    readonly reviewItem: BrainReviewItem;
  }) => Promise<BrainReviewItem>;
  readonly findDocumentBySourceIdentity: (
    organizationId: string,
    brainId: string,
    sourceId: string,
    externalItemIdentity: string,
  ) => Promise<BrainDocument | undefined>;
  readonly getDocumentVersion: (
    organizationId: string,
    documentId: string,
    versionId: string,
  ) => Promise<BrainDocumentVersion | undefined>;
  readonly getDocumentRendition: (
    organizationId: string,
    documentVersionId: string,
    renditionId: string,
  ) => Promise<BrainDocumentRendition | undefined>;
  readonly findSourceRevisionClaim: (
    organizationId: string,
    sourceId: string,
    externalItemIdentity: string,
    revisionKey: string,
  ) => Promise<BrainSourceRevisionClaim | undefined>;
  readonly captureDocumentRevision: (args: {
    readonly actor: BrainMutationCaller;
    readonly agentAuthorization?: BrainAgentWriteAuthorization;
    readonly authorizingGrant: BrainGrant;
    readonly document: BrainDocument;
    readonly eventId: string;
    readonly indexEvidence?: {
      readonly rendition: BrainDocumentRendition;
      readonly version: BrainDocumentVersion;
    };
    readonly previous?: BrainDocument;
    readonly revisionClaim: BrainSourceRevisionClaim;
    readonly rendition?: BrainDocumentRendition;
    readonly source: BrainSource;
    readonly version: BrainDocumentVersion;
    readonly uploadTicket?: {
      readonly next: BrainUploadTicket;
      readonly previous: BrainUploadTicket;
    };
  }) => Promise<BrainDocumentCaptureResult>;
  readonly issueUploadTicket: (args: {
    readonly actor: BrainMutationCaller;
    readonly agentAuthorization?: BrainAgentWriteAuthorization;
    readonly authorizingGrant: BrainGrant;
    readonly eventId: string;
    readonly source: BrainSource;
    readonly ticket: BrainUploadTicket;
  }) => Promise<BrainUploadTicket>;
  readonly getUploadTicket: (
    organizationId: string,
    brainId: string,
    ticketId: string,
  ) => Promise<BrainUploadTicket | undefined>;
  readonly getUploadLease: (
    organizationId: string,
    brainId: string,
    leaseId: string,
  ) => Promise<BrainUploadLease | undefined>;
  readonly beginUpload: (args: {
    readonly actor: BrainMutationCaller;
    readonly agentAuthorization?: BrainAgentWriteAuthorization;
    readonly authorizingGrant: BrainGrant;
    readonly lease: BrainUploadLease;
    readonly next: BrainUploadTicket;
    readonly previous: BrainUploadTicket;
    readonly source: BrainSource;
  }) => Promise<BrainUploadTicket>;
  readonly completeUpload: (args: {
    readonly actor: BrainMutationCaller;
    readonly agentAuthorization?: BrainAgentWriteAuthorization;
    readonly authorizingGrant: BrainGrant;
    readonly lease: BrainUploadLease;
    readonly next: BrainUploadTicket;
    readonly previous: BrainUploadTicket;
    readonly previousLease: BrainUploadLease;
    readonly source: BrainSource;
  }) => Promise<BrainUploadTicket>;
}
