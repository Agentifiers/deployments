import {
  type DynamoDatabaseService,
  type ObservabilitySourceContext,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { type MemoryBlobDeleter, type MemoryBlobLoader } from "./blob.ts";
import { type MemoryScope, type MemoryType } from "./governance.ts";
import { type MemoryTenantScope } from "./repository.ts";
import { type MemorySearchResult } from "./service.ts";
import type { MemoryReranker } from "./rerank.ts";
import type { MemoryRetrievalStrategy } from "./retrieval.ts";
import type {
  MemorySearchPlacementResolver,
  MemorySearchProviderClient,
  MemorySearchRoutingResolver,
} from "./provider.ts";
export type MemorySpace = Extract<PlatformRecord, { readonly itemType: "memory-space" }>;
export type MemorySpaceGrant = Extract<PlatformRecord, { readonly itemType: "memory-space-grant" }>;
export type MemoryPolicy = Extract<PlatformRecord, { readonly itemType: "memory-policy" }>;
export type MemoryReviewItem = Extract<PlatformRecord, { readonly itemType: "memory-review-item" }>;
export type MemoryIndexJob = Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;
export type MemoryFlush = Extract<PlatformRecord, { readonly itemType: "memory-flush" }>;
export type MemoryRecallAttempt = Extract<
  PlatformRecord,
  { readonly itemType: "memory-recall-attempt" }
>;
export type MemoryRetrieval = Extract<PlatformRecord, { readonly itemType: "memory-retrieval" }>;
export type BrainMemoryProvenance = NonNullable<
  Extract<PlatformRecord, { readonly itemType: "memory" }>["data"]["brainProvenance"]
>;
export type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
export type Message = Extract<PlatformRecord, { readonly itemType: "message" }>;
export type Idempotency = Extract<PlatformRecord, { readonly itemType: "idempotency" }>;
export type UniqueClaim = Extract<PlatformRecord, { readonly itemType: "unique-claim" }>;

export interface MemoryPlatformScope extends MemoryTenantScope {
  readonly exactWorkspaceMutations?: boolean;
  /** The operator access a platform administrator acts under; events name it on their actor. */
  readonly operatorAccessGrantId?: Ulid;
  readonly principalId?: Ulid;
  readonly workspaceId?: Ulid;
}

export interface MemoryEmbeddingRequest {
  readonly attribution:
    | { readonly kind: "operation"; readonly operationId: Ulid; readonly operationType: string }
    | { readonly kind: "run"; readonly runId: Ulid };
  readonly content: string;
  readonly embeddingProfileId?: Ulid;
  readonly memoryId: Ulid;
  readonly modelCallId: string;
  readonly observability?: ObservabilitySourceContext;
  /**
   * Called when the provider round-trip starts, after credentials and routing are ready. The
   * returned signal bounds only that round-trip; `signal` bounds the whole call.
   */
  readonly providerSignal?: () => AbortSignal;
  readonly scope: MemoryPlatformScope;
  readonly signal?: AbortSignal;
}

export interface MemoryEmbeddingResult {
  readonly embedding: readonly number[];
  readonly embeddingProfileId?: Ulid;
  readonly model: string;
  readonly provider: string;
}

export interface MemoryPageCursorCodec {
  readonly open: (ciphertext: string) => Promise<string>;
  readonly seal: (plaintext: string) => Promise<string>;
}

export class InvalidMemoryPageCursorError extends Error {
  override readonly name = "InvalidMemoryPageCursorError";
}

export interface MemoryPlatformDependencies {
  readonly database: DynamoDatabaseService;
  readonly deleteBlob?: MemoryBlobDeleter;
  readonly embedding: (request: MemoryEmbeddingRequest) => Promise<MemoryEmbeddingResult>;
  readonly generateId?: () => Promise<Ulid>;
  readonly loadBlob?: MemoryBlobLoader;
  readonly now?: () => Date;
  readonly pageCursorCodec?: MemoryPageCursorCodec;
  readonly rerank?: MemoryReranker;
  readonly searchPlacementResolver?: MemorySearchPlacementResolver;
  /** Single provider served without durable placement when no placement resolver is configured. */
  readonly searchProvider?: MemorySearchProviderClient;
  readonly searchRoutingResolver?: MemorySearchRoutingResolver;
}

export interface ImportMemoryItem {
  readonly agentDefinitionId?: Ulid;
  readonly brainProvenance?: BrainMemoryProvenance;
  readonly content: string;
  readonly entityKeys?: readonly string[];
  readonly idempotencyKey?: string;
  readonly importance?: number;
  readonly memoryType?: MemoryType;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly observability?: ObservabilitySourceContext;
  /** Keep personal and health data verbatim (the agent's `memory.transcriptPrivacy: retain`). */
  readonly retainPersonalData?: boolean;
  readonly scope: MemoryScope;
  readonly searchKey?: string;
  readonly source?: string;
  readonly sourceQuality?: number;
  readonly sourceRunId?: Ulid;
  readonly threadId?: Ulid;
  readonly supersedesMemoryId?: Ulid;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly workspaceId?: Ulid;
}

export type SearchPlatformMemoryInput = {
  readonly allowedScopeKeys?: readonly string[];
  readonly comparisonPurpose?: "quality" | "schema-rollout";
  readonly denseAnnControl?: boolean;
  readonly denseExactControl?: boolean;
  readonly memorySpaceIds: readonly Ulid[];
  readonly observability?: ObservabilitySourceContext;
  readonly purpose?: string;
  readonly query: string;
  readonly searchKeys?: readonly string[];
  readonly shadow?: boolean;
  readonly shadowAttemptId?: Ulid;
  readonly shadowOfAttemptId?: Ulid;
  readonly strategyOverride?: MemoryRetrievalStrategy;
  readonly targetId?: Ulid;
  readonly toolCallId?: Ulid;
  readonly topK?: number;
} & (
  | { readonly runId?: undefined; readonly threadId?: undefined }
  | { readonly runId: Ulid; readonly threadId: Ulid }
);

export interface MemoryRunAccess {
  readonly agentDefinitionId: Ulid;
  readonly readMemorySpaces: readonly MemoryRunSpaceAccess[];
  readonly readMemorySpaceIds: readonly Ulid[];
  readonly run: Run;
  readonly searchKeys: readonly string[];
  readonly writeMemorySpaces: readonly MemoryRunSpaceAccess[];
  readonly writeMemorySpaceIds: readonly Ulid[];
}

export interface MemoryRunSpaceAccess {
  readonly id: Ulid;
  readonly workspaceId?: Ulid;
}

export interface MemoryRecallResult {
  readonly attempt: MemoryRecallAttempt;
  readonly results: readonly MemorySearchResult[];
  readonly retrievals: readonly MemoryRetrieval[];
}

export class MemoryPlatformError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryPlatformError";
  }
}
