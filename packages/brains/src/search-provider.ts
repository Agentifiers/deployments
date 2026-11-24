import type { BrainSensitivity } from "./models.ts";

export type BrainSearchProviderId = "aws-native";

export type BrainSearchComponentKind = "dense" | "entity" | "exact" | "lexical";

export interface BrainSearchCapabilities {
  readonly components: readonly BrainSearchComponentKind[];
  readonly hybrid: boolean;
}

export interface BrainSearchComponentResult {
  readonly error?: string;
  readonly kind: BrainSearchComponentKind;
  readonly ready: boolean;
}

export interface BrainSearchTarget {
  readonly embeddingProfileId?: string;
  readonly location: Readonly<Record<string, unknown>>;
  readonly providerId: BrainSearchProviderId;
  readonly schemaGeneration: number;
  readonly targetId: string;
}

export interface BrainChunkCoordinates {
  readonly end: number;
  readonly kind:
    | "media-timestamp"
    | "page-bounding-box"
    | "stable-message"
    | "unicode-scalar"
    | "utf8-byte";
  readonly start: number;
}

export interface BrainIndexChunk {
  readonly brainId: string;
  readonly chunkId: string;
  readonly contentHash: string;
  readonly coordinates: BrainChunkCoordinates;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly embedding: readonly number[];
  readonly entityKeys: readonly string[];
  readonly projectionGeneration: number;
  readonly reviewStatus: "approved" | "pending" | "rejected" | "unreviewed";
  readonly organizationId: string;
  readonly retentionExpiresAtMs: number;
  readonly renditionId: string;
  readonly sensitivity: BrainSensitivity;
  readonly schemaGeneration: number;
  readonly sourceId: string;
  readonly text: string;
  readonly title?: string;
}

export interface BrainSearchProviderHit {
  readonly brainId: string;
  readonly chunkId: string;
  readonly coordinates: BrainChunkCoordinates;
  readonly denseScore?: number;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly entityScore?: number;
  readonly exactScore?: number;
  readonly lexicalScore?: number;
  readonly organizationId: string;
  readonly renditionId: string;
  readonly contentHash: string;
  readonly projectionGeneration: number;
  readonly reviewStatus: "approved" | "pending" | "rejected" | "unreviewed";
  readonly schemaGeneration: number;
  readonly sensitivity: BrainSensitivity;
  readonly sourceId: string;
}

export interface BrainSearchProviderClient {
  readonly capabilities: BrainSearchCapabilities;
  readonly providerId: BrainSearchProviderId;
  readonly target: BrainSearchTarget;
  deleteDocument(input: {
    readonly brainId: string;
    readonly chunkIds: readonly string[];
    readonly documentId: string;
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly deleted: boolean }>;
  inspect(input: { readonly organizationId: string; readonly signal?: AbortSignal }): Promise<{
    readonly components: readonly BrainSearchComponentResult[];
    readonly ready: boolean;
    readonly rowCount?: number;
  }>;
  prepare(input: { readonly organizationId: string; readonly signal?: AbortSignal }): Promise<void>;
  purgeBrain(input: {
    readonly brainId: string;
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly deleted: boolean;
    readonly receipt: Readonly<Record<string, unknown>>;
  }>;
  /** Deletes the organization's documents and then the index if the organization alone owns it. */
  purgeOrganization(input: {
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly deleted: boolean;
    readonly receipt: Readonly<Record<string, unknown>>;
  }>;
  search(input: {
    readonly allowedReviewStatuses: readonly BrainIndexChunk["reviewStatus"][];
    readonly allowedSensitivities: readonly BrainSensitivity[];
    readonly authorizedBrainIds: readonly string[];
    readonly embedding: readonly number[];
    readonly limit: number;
    readonly organizationId: string;
    readonly query: string;
    readonly retentionCutoffMs: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly BrainSearchProviderHit[]>;
  upsert(input: {
    readonly chunks: readonly BrainIndexChunk[];
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly components: readonly BrainSearchComponentResult[];
    readonly written: number;
  }>;
}

export interface BrainSearchProviderRegistry {
  readonly resolve: (target: BrainSearchTarget) => Promise<BrainSearchProviderClient>;
}
