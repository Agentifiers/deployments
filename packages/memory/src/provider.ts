import type { MemorySearchProviderId, PlatformRecord, Ulid } from "@deployments-ai/db";
import type { CanonicalMemoryRecord, MemorySensitivity } from "./memory-record.ts";

export type MemorySearchPlacement = Extract<
  PlatformRecord,
  { readonly itemType: "memory-search-placement" }
>;
export type MemorySearchTarget = MemorySearchPlacement["data"]["writeTargets"][number];

export interface MemorySearchAuthorizationGroup {
  readonly allowedSensitivities: readonly MemorySensitivity[];
  readonly memorySpaceIds: readonly string[];
}

export interface MemorySearchQueryInput {
  readonly allowedScopeKeys: readonly string[];
  readonly allowedSensitivities: readonly MemorySensitivity[];
  readonly authorizationGroups?: readonly MemorySearchAuthorizationGroup[];
  readonly embedding: readonly number[];
  readonly environmentId: string;
  readonly memorySpaceIds: readonly string[];
  readonly now: Date;
  readonly organizationId: string;
  readonly projectId: string;
  readonly searchKeys: readonly string[];
  readonly signal?: AbortSignal;
  readonly topK: number;
}

export interface MemorySearchLexicalQueryInput extends Omit<MemorySearchQueryInput, "embedding"> {
  readonly query: string;
}

export interface MemorySearchExactQueryInput extends Omit<MemorySearchQueryInput, "embedding"> {
  readonly entityKeys?: readonly string[];
  readonly exactSearchKeys?: readonly string[];
  readonly memoryIds?: readonly string[];
}

export interface MemorySearchCandidateRow {
  readonly contentHash: string;
  readonly denseSourceCandidateCounts?: Partial<Record<"open-search", number>>;
  readonly denseSourceDistances?: Partial<Record<"open-search", number>>;
  readonly denseSourceRanks?: Partial<Record<"open-search", number>>;
  readonly dist?: number;
  readonly id: string;
  readonly memorySpaceId: string;
  readonly memoryVersion: number;
  readonly scopeKey: string;
  readonly searchKey: string;
}

export interface MemorySearchWriteInput {
  readonly content: string;
  readonly embedding: readonly number[];
  readonly embeddingModel: string;
  readonly embeddingProvider: string;
  readonly embeddingContentHash: string;
  readonly memory: CanonicalMemoryRecord;
  readonly signal?: AbortSignal;
  readonly synchronizationGeneration: number;
}

export interface MemorySearchMutationResult {
  readonly rowsAffected?: number;
  readonly status: "namespace-missing" | "not-applied" | "synchronized" | "written";
}

export interface MemorySearchEvidenceBinding {
  readonly operationId: Ulid;
  readonly targetId: Ulid;
}

export interface MemorySearchCapabilities {
  readonly dense: true;
  readonly densePageSize?: number;
  readonly denseResultLimit?: number;
  readonly exact: boolean;
  readonly lexical: boolean;
  readonly purgeOrganization: boolean;
}

export interface MemorySearchReadiness {
  readonly denseReady: boolean;
  readonly lexicalReady: boolean;
  readonly ready: boolean;
  readonly reference: string;
  readonly schemaReady: boolean;
}

export interface MemorySearchProviderClient {
  readonly capabilities: MemorySearchCapabilities;
  readonly providerId: MemorySearchProviderId;
  readonly target: MemorySearchTarget;
  delete(input: {
    readonly memory: CanonicalMemoryRecord;
    readonly signal?: AbortSignal;
    readonly synchronizationGeneration: number;
  }): Promise<MemorySearchMutationResult>;
  deleteEvidence?(input: {
    readonly evidence: MemorySearchEvidenceBinding;
    readonly memory: CanonicalMemoryRecord;
    readonly signal?: AbortSignal;
    readonly synchronizationGeneration: number;
  }): Promise<MemorySearchMutationResult>;
  /** Deletes the target's index, which must be the organization's own. Gone already counts. */
  dropOrganizationIndex?(input: {
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }): Promise<"already-absent" | "dropped">;
  inspect?(input: { readonly organizationId: string; readonly signal?: AbortSignal }): Promise<{
    readonly rowCount?: number;
    readonly ready: boolean;
  }>;
  prepare?(input: {
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  purgeOrganization?(input: {
    readonly organizationId: string;
    readonly providerPurgeStartedAt?: string;
    readonly providerPurgeState?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly deleted: boolean; readonly receipt: Readonly<Record<string, unknown>> }>;
  query(input: MemorySearchQueryInput): Promise<readonly MemorySearchCandidateRow[]>;
  queryDenseAnn?(input: MemorySearchQueryInput): Promise<readonly MemorySearchCandidateRow[]>;
  queryDenseExact?(input: MemorySearchQueryInput): Promise<readonly MemorySearchCandidateRow[]>;
  queryEvidence?(
    input: MemorySearchQueryInput & {
      readonly evidence: MemorySearchEvidenceBinding;
    },
  ): Promise<readonly MemorySearchCandidateRow[]>;
  queryExact?(input: MemorySearchExactQueryInput): Promise<readonly MemorySearchCandidateRow[]>;
  queryEvidenceExact?(
    input: MemorySearchExactQueryInput & {
      readonly evidence: MemorySearchEvidenceBinding;
    },
  ): Promise<readonly MemorySearchCandidateRow[]>;
  queryLexical?(input: MemorySearchLexicalQueryInput): Promise<readonly MemorySearchCandidateRow[]>;
  queryEvidenceLexical?(
    input: MemorySearchLexicalQueryInput & {
      readonly evidence: MemorySearchEvidenceBinding;
    },
  ): Promise<readonly MemorySearchCandidateRow[]>;
  readiness?(input: {
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }): Promise<MemorySearchReadiness>;
  reference(organizationId: string): string;
  synchronizeLifecycle(input: {
    readonly memory: CanonicalMemoryRecord;
    readonly signal?: AbortSignal;
    readonly synchronizationGeneration: number;
  }): Promise<MemorySearchMutationResult>;
  write(input: MemorySearchWriteInput): Promise<MemorySearchMutationResult>;
  writeEvidence?(
    input: MemorySearchWriteInput & {
      readonly evidence: MemorySearchEvidenceBinding;
    },
  ): Promise<MemorySearchMutationResult>;
}

export interface MemorySearchProviderRegistry {
  readonly resolve: (target: MemorySearchTarget) => Promise<MemorySearchProviderClient>;
}

export interface ResolvedMemorySearchPlacement {
  readonly candidate?: MemorySearchProviderClient;
  readonly fenceEpoch?: number;
  readonly fenceVersion?: number;
  readonly placementGeneration: number;
  readonly placementPhase?: string;
  readonly placementVersion?: number;
  readonly read: MemorySearchProviderClient;
  readonly writes: readonly MemorySearchProviderClient[];
}

export interface ResolvedMemorySearchRouting {
  readonly candidate?: Pick<MemorySearchProviderClient, "providerId" | "target">;
  readonly fenceEpoch?: number;
  readonly fenceVersion?: number;
  readonly placementGeneration: number;
  readonly placementPhase?: string;
  readonly placementVersion?: number;
  readonly read: Pick<MemorySearchProviderClient, "providerId" | "target">;
  readonly writes: readonly Pick<MemorySearchProviderClient, "providerId" | "target">[];
}

export type MemorySearchPlacementResolver = (
  organizationId: Ulid,
) => Promise<ResolvedMemorySearchPlacement>;

export type MemorySearchRoutingResolver = (
  organizationId: Ulid,
) => Promise<ResolvedMemorySearchRouting>;

/** Serves every organization from one provider without durable placement or fencing. */
export function staticMemorySearchPlacementResolver(
  provider: MemorySearchProviderClient,
): MemorySearchPlacementResolver {
  return async () => ({
    placementGeneration: 0,
    placementPhase: "active",
    read: provider,
    writes: [provider],
  });
}

/** Resolves the platform placement resolver from either durable routing or one static provider. */
export function memorySearchPlacementResolver(dependencies: {
  readonly searchPlacementResolver?: MemorySearchPlacementResolver;
  readonly searchProvider?: MemorySearchProviderClient;
}): MemorySearchPlacementResolver {
  if (dependencies.searchPlacementResolver) return dependencies.searchPlacementResolver;
  if (dependencies.searchProvider) {
    return staticMemorySearchPlacementResolver(dependencies.searchProvider);
  }
  throw new TypeError("Memory search requires a placement resolver or a search provider.");
}
