import type { Ulid } from "@deployments-ai/db";
import { memoryContentMatchesHash, memoryRecallBlockedReason } from "./governance.ts";
import { memoryScopeKey, type CanonicalMemoryRecord } from "./memory-record.ts";
import type {
  MemorySearchCandidateRow,
  MemorySearchExactQueryInput,
  MemorySearchLexicalQueryInput,
  MemorySearchProviderClient,
  MemorySearchQueryInput,
  MemorySearchTarget,
} from "./provider.ts";

const fakeMemorySearchTarget: MemorySearchTarget = {
  componentIds: ["01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid],
  embeddingProfileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
  location: {},
  providerId: "aws-native",
  schemaGeneration: 1,
  targetId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
};

type FakeMemorySearchQuery =
  | { readonly input: MemorySearchQueryInput; readonly kind: "dense" }
  | { readonly input: MemorySearchExactQueryInput; readonly kind: "exact" }
  | { readonly input: MemorySearchLexicalQueryInput; readonly kind: "lexical" };

function projection(memory: CanonicalMemoryRecord, synchronizationGeneration: number) {
  return {
    contentHash: memory.data.contentHash,
    entityKeys: memory.data.entityKeys ?? [],
    environmentId: memory.data.environmentId,
    id: memory.data.id,
    memorySpaceId: memory.data.memorySpaceId,
    memoryVersion: memory.data.version,
    organizationId: memory.data.organizationId,
    projectId: memory.data.projectId,
    retentionExpiresAt: memory.data.retentionExpiresAt,
    reviewStatus: memory.data.reviewStatus,
    scopeKey: memoryScopeKey(memory),
    searchKey: memory.data.searchKey,
    sensitivity: memory.data.sensitivity,
    status: memory.data.status,
    synchronizationGeneration,
    updatedAt: memory.data.updatedAt,
  };
}

/**
 * In-memory search provider for platform tests. Every query returns all active approved rows so
 * tests exercise canonical revalidation rather than provider filtering.
 */
export function fakeMemorySearchProvider(overrides: Partial<MemorySearchProviderClient> = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const queries: FakeMemorySearchQuery[] = [];
  const candidates = (): MemorySearchCandidateRow[] =>
    [...rows.values()]
      .filter((row) => row.status === "active" && row.reviewStatus === "approved")
      .map((row) => ({
        contentHash: String(row.contentHash),
        dist: 0.1,
        id: String(row.id),
        memorySpaceId: String(row.memorySpaceId),
        memoryVersion: Number(row.memoryVersion),
        scopeKey: String(row.scopeKey),
        searchKey: String(row.searchKey),
      }));
  const provider: MemorySearchProviderClient = {
    capabilities: { dense: true, exact: true, lexical: true, purgeOrganization: false },
    delete: async ({ memory, synchronizationGeneration }) => {
      rows.set(memory.data.id, {
        ...projection(memory, synchronizationGeneration),
        content: "",
        reviewStatus: "pending",
        status: "deleted",
      });
      return { rowsAffected: 1, status: "synchronized" };
    },
    providerId: "aws-native",
    query: async (input) => {
      queries.push({ input, kind: "dense" });
      return candidates();
    },
    queryExact: async (input) => {
      queries.push({ input, kind: "exact" });
      return candidates();
    },
    queryLexical: async (input) => {
      queries.push({ input, kind: "lexical" });
      return candidates();
    },
    reference: (organizationId) => `deployments-ai-test-memory-${organizationId}`,
    synchronizeLifecycle: async ({ memory, synchronizationGeneration }) => {
      rows.set(memory.data.id, {
        ...rows.get(memory.data.id),
        ...projection(memory, synchronizationGeneration),
      });
      return { rowsAffected: 1, status: "synchronized" };
    },
    target: fakeMemorySearchTarget,
    write: async (input) => {
      if (
        memoryRecallBlockedReason(input.memory.data, input.content) ||
        !memoryContentMatchesHash(input.content, input.memory.data.contentHash) ||
        input.embeddingContentHash !== input.memory.data.contentHash
      ) {
        throw new Error("Search provider content must pass governance and match its hash.");
      }
      rows.set(input.memory.data.id, {
        ...projection(input.memory, input.synchronizationGeneration),
        content: input.content,
        embedding: input.embedding,
        embeddingModel: input.embeddingModel,
        embeddingProvider: input.embeddingProvider,
      });
      return { rowsAffected: 1, status: "written" };
    },
    ...overrides,
  };
  return { provider, queries, rows };
}
