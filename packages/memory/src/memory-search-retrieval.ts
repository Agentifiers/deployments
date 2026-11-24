import {
  key,
  type MemoryRecallSelectionMode,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { memoryMetadataBlockedReason, memoryRecallBlockedReason } from "./governance.ts";
import type { PreparedMemorySearch } from "./memory-search-preparation.ts";
import type { MemorySearchContext, MemorySearchExecution } from "./platform-search.ts";
import { observeMemorySearchPhase } from "./memory-search-telemetry.ts";
import {
  mapConcurrentOrdered,
  memorySearchPhaseDeadline,
  USEFULNESS_LOOKUP_BUDGET_MS,
  USEFULNESS_LOOKUP_CONCURRENCY,
  withAbort,
} from "./platform-search.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import { denseTelemetryFields, type MemorySearchResult } from "./memory-search-result.ts";
import {
  adjustedCandidateScore,
  MemoryRerankUsagePersistenceError,
  queryIdentifiers,
  rankAndSelectMemories,
  selectFullContextMemories,
  type SelectableMemoryCandidate,
} from "./retrieval.ts";
import { type CanonicalMemoryRecord } from "./memory-record.ts";
import { memorySearchPlacementResolver } from "./provider.ts";

export function denseSearchCandidateLimit(
  resultK: number,
  configuredCandidateK: number,
  providerPageSize: number | undefined,
) {
  return Math.max(
    resultK,
    Math.min(configuredCandidateK, providerPageSize ?? configuredCandidateK),
  );
}

export function lexicalSearchCandidateLimit(resultK: number, configuredCandidateK: number) {
  return Math.max(resultK, configuredCandidateK);
}

export async function retrieveMemorySearchCandidates(
  context: MemorySearchContext,
  scope: Types.MemoryPlatformScope,
  input: Types.SearchPlatformMemoryInput,
  execution: MemorySearchExecution & PreparedMemorySearch,
) {
  const {
    database,
    dependencies,
    generateId: _generateId,
    now,
    searchService,
    resolveMemoryContent,
    requiredSpace: _requiredSpace,
    effectivePolicy: _effectivePolicy,
    eventFor: _eventFor,
    idempotencyReplay: _idempotencyReplay,
    completedIdempotency: _completedIdempotency,
    idempotencyOperation: _idempotencyOperation,
  } = context;
  const {
    allowedScopeKeys,
    attemptId,
    enhancedQueryEligible,
    memorySpaceIds,
    operationDeadline,
    query,
    retrievalConfig,
    retrievalStrategy,
    searchKeys,
    spacePolicies,
    spaces,
    telemetry,
    topK,
  } = execution;

  const resolvePlacement = memorySearchPlacementResolver(dependencies);
  const placementDeadline = memorySearchPhaseDeadline(
    operationDeadline,
    retrievalConfig.phaseDeadlineMs,
  );
  const placement = await observeMemorySearchPhase(telemetry, "placement", () =>
    withAbort(resolvePlacement(scope.organizationId), placementDeadline),
  );
  const searchProvider = input.targetId
    ? placement.writes.find((provider) => provider.target.targetId === input.targetId)
    : placement.read;
  if (!searchProvider) {
    throw new Types.MemoryPlatformError(
      403,
      "memory_search_target_not_authorized",
      "Internal memory search target is not authorized by the current placement.",
    );
  }
  telemetry.placementGeneration = placement.placementGeneration;
  telemetry.provider = searchProvider.providerId;
  telemetry.targetId = searchProvider.target.targetId;
  const denseResultLimit = searchProvider.capabilities.denseResultLimit;
  if (denseResultLimit !== undefined && topK > denseResultLimit) {
    throw new Types.MemoryPlatformError(
      400,
      "memory_search_provider_result_limit",
      `${searchProvider.providerId} supports at most ${denseResultLimit} memory search results.`,
    );
  }
  if (input.denseAnnControl && input.denseExactControl) {
    throw new Types.MemoryPlatformError(
      400,
      "memory_search_strategy_unsupported",
      "Memory search accepts only one dense control per request.",
    );
  }
  if (input.denseAnnControl && !searchProvider.queryDenseAnn) {
    throw new Types.MemoryPlatformError(
      400,
      "memory_search_strategy_unsupported",
      `${searchProvider.providerId} does not support isolated ANN control queries.`,
    );
  }
  if (input.denseExactControl && !searchProvider.queryDenseExact) {
    throw new Types.MemoryPlatformError(
      400,
      "memory_search_strategy_unsupported",
      `${searchProvider.providerId} does not support exact dense control queries.`,
    );
  }
  // One candidate past topK tells a complete in-scope set from a truncated one.
  const fullContextProbe = retrievalConfig.fullContextTokenCap > 0 ? topK + 1 : 0;
  const denseCandidateLimit = Math.max(
    denseSearchCandidateLimit(
      topK,
      retrievalConfig.candidateK,
      searchProvider.capabilities.densePageSize,
    ),
    fullContextProbe,
  );
  let providerDeadline: AbortSignal | undefined;
  const providerStarted = Promise.withResolvers<void>();
  const pendingEmbedding = await observeMemorySearchPhase(
    telemetry,
    "embeddingPreparation",
    async () => {
      const request = dependencies.embedding({
        attribution: input.runId
          ? { kind: "run", runId: input.runId }
          : {
              kind: "operation",
              operationId: attemptId,
              operationType: "memory-search",
            },
        content: query,
        embeddingProfileId: searchProvider.target.embeddingProfileId,
        memoryId: attemptId,
        modelCallId: `memory-query:${attemptId}`,
        ...(input.observability ? { observability: input.observability } : {}),
        providerSignal: () => {
          providerDeadline ??= memorySearchPhaseDeadline(
            operationDeadline,
            retrievalConfig.phaseDeadlineMs,
          );
          providerStarted.resolve();
          return providerDeadline;
        },
        scope,
        signal: operationDeadline,
      });
      await withAbort(Promise.race([providerStarted.promise, request]), operationDeadline);
      return { request };
    },
  );
  const embedding = await observeMemorySearchPhase(telemetry, "embedding", () =>
    withAbort(pendingEmbedding.request, operationDeadline).catch((cause: unknown) => {
      throw providerDeadline?.aborted ? providerDeadline.reason : cause;
    }),
  );
  telemetry.plannerModel = embedding.model;
  telemetry.plannerProvider = embedding.provider;
  if (
    dependencies.searchPlacementResolver &&
    embedding.embeddingProfileId !== searchProvider.target.embeddingProfileId
  ) {
    throw new Types.MemoryPlatformError(
      503,
      "memory_embedding_profile_mismatch",
      "The embedding gateway did not honor the serving target's immutable embedding profile.",
    );
  }
  if (operationDeadline.aborted) throw operationDeadline.reason;
  const identifiers = enhancedQueryEligible
    ? queryIdentifiers(query)
    : { entityKeys: [], memoryIds: [], searchKeys: [] };
  const spacesBySensitivity = new Map<
    string,
    {
      readonly allowedSensitivities: ReturnType<typeof Shared.sensitivityModeValues>;
      readonly memorySpaceIds: Ulid[];
    }
  >();
  for (const [index, space] of spaces.entries()) {
    const allowedSensitivities = Shared.sensitivityModeValues(
      spacePolicies[index]?.data.sensitivityMode ?? "standard",
    );
    const sensitivityKey = allowedSensitivities.join(",");
    const group = spacesBySensitivity.get(sensitivityKey) ?? {
      allowedSensitivities,
      memorySpaceIds: [],
    };
    group.memorySpaceIds.push(space.data.id);
    spacesBySensitivity.set(sensitivityKey, group);
  }
  const authorizationGroups = [...spacesBySensitivity.values()];
  const allowedSensitivities = [
    ...new Set(authorizationGroups.flatMap((group) => group.allowedSensitivities)),
  ];
  const searchDeadline = memorySearchPhaseDeadline(
    operationDeadline,
    retrievalConfig.searchDeadlineMs,
  );
  const searchResult = await observeMemorySearchPhase(telemetry, "search", () =>
    withAbort(
      Shared.effectValue(
        searchService.searchEnhanced({
          allowedScopeKeys,
          allowedSensitivities,
          authorizationGroups,
          denseCandidateLimit,
          ...(input.denseAnnControl ? { denseAnnControl: true } : {}),
          ...(input.denseExactControl ? { denseExactControl: true } : {}),
          embedding: embedding.embedding,
          entityKeys: identifiers.entityKeys,
          environmentId: scope.environmentId,
          exactMemoryIds: identifiers.memoryIds,
          exactSearchKeys: identifiers.searchKeys,
          fusionCandidateLimit: retrievalConfig.candidateK,
          lexicalCandidateLimit: lexicalSearchCandidateLimit(topK, retrievalConfig.candidateK),
          memorySpaceIds,
          now: now(),
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          query,
          resultLimit: topK,
          searchKeys,
          signal: searchDeadline,
          strategy: retrievalStrategy,
          targetId: searchProvider.target.targetId,
          topK: Math.max(retrievalConfig.candidateK, fullContextProbe),
        }),
      ),
      searchDeadline,
    ),
  );
  const actualStrategy = searchResult.strategy;
  telemetry.actualStrategy = actualStrategy;
  telemetry.candidateCount = searchResult.candidateCount;
  telemetry.denseCandidateCount = searchResult.counts.dense;
  telemetry.denseOpenSearchCandidateCount = searchResult.counts.denseOpenSearch;
  telemetry.entityCandidateCount = searchResult.counts.entity;
  telemetry.exactCandidateCount = searchResult.counts.exact;
  telemetry.lexicalCandidateCount = searchResult.counts.lexical;
  const canonicalResults = [...searchResult.results];
  const hydrationDeadline = memorySearchPhaseDeadline(
    operationDeadline,
    retrievalConfig.phaseDeadlineMs,
  );
  const hydratedResults = await observeMemorySearchPhase(telemetry, "hydration", () =>
    Promise.all(
      canonicalResults.map(async (result) => {
        try {
          if (hydrationDeadline.aborted) throw hydrationDeadline.reason;
          const body = await withAbort(resolveMemoryContent(result.memory), hydrationDeadline);
          if (
            memoryRecallBlockedReason(result.memory.data, body) ||
            (result.memory.data.metadata !== undefined &&
              memoryMetadataBlockedReason(result.memory.data.metadata, {
                retainPersonalData: result.memory.data.retainsPersonalData === true,
              }) !== undefined)
          ) {
            return undefined;
          }
          const { bodyRef: _bodyRef, ...memoryData } = result.memory.data;
          return {
            ...result,
            memory: {
              ...result.memory,
              data: { ...memoryData, body },
            } as CanonicalMemoryRecord,
          };
        } catch (cause) {
          if (
            cause instanceof Types.MemoryPlatformError &&
            [
              "memory_blob_invalid",
              "memory_blob_load_failed",
              "memory_body_unavailable",
              "memory_content_hash_mismatch",
            ].includes(cause.code)
          ) {
            return undefined;
          }
          throw cause;
        }
      }),
    ),
  );
  const hydrated = hydratedResults.filter(
    (result): result is MemorySearchResult => result !== undefined,
  );
  telemetry.canonicalDropCount =
    searchResult.canonicalDropCount + (canonicalResults.length - hydrated.length);
  const fullContext =
    fullContextProbe > 0 && searchResult.counts.dense < denseCandidateLimit
      ? selectFullContextMemories({
          candidates: hydrated,
          fullContextTokenCap: retrievalConfig.fullContextTokenCap,
          strategy: actualStrategy,
          topK,
        })
      : undefined;
  const selectionMode: MemoryRecallSelectionMode = fullContext ? "whole-set" : "ranked";
  telemetry.selectionMode = selectionMode;
  const usefulness = new Map<string, number>();
  if (actualStrategy !== "dense-v1" && !fullContext) {
    const usefulnessSignal = AbortSignal.any([
      operationDeadline,
      AbortSignal.timeout(USEFULNESS_LOOKUP_BUDGET_MS),
    ]);
    try {
      const usefulnessScores = await observeMemorySearchPhase(telemetry, "usefulness", () =>
        mapConcurrentOrdered(hydrated, USEFULNESS_LOOKUP_CONCURRENCY, async (result) => {
          const response = await withAbort(
            memoryPersistence.find(
              database,
              "execution",
              {
                ExpressionAttributeValues: {
                  ":pk": key("ORG", scope.organizationId, "MEMORY", result.memory.data.id),
                  ":prefix": `${key("MEMORY-RETRIEVAL")}#`,
                },
                KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
                Limit: 20,
                ScanIndexForward: false,
              },
              usefulnessSignal,
            ),
            usefulnessSignal,
          );
          let score = 0;
          let samples = 0;
          for (const record of response.items) {
            if (record.itemType !== "memory-retrieval" || !record.data.usefulness) continue;
            score +=
              record.data.usefulness === "useful"
                ? 1
                : record.data.usefulness === "harmful"
                  ? -1
                  : 0;
            samples += 1;
          }
          return samples > 0 ? ([result.memory.data.id, score / samples] as const) : undefined;
        }),
      );
      for (const score of usefulnessScores) {
        if (score) usefulness.set(...score);
      }
    } catch {
      if (operationDeadline.aborted) throw operationDeadline.reason;
    }
  }
  let selectable: SelectableMemoryCandidate[] = hydrated.map((result, index) => {
    const fusedScore = result.fusedScore ?? result.score;
    const candidate = {
      ...denseTelemetryFields(result),
      fusedRank: result.fusedRank ?? index + 1,
      fusedScore,
      id: result.memory.data.id,
      memory: result.memory,
      row: {
        contentHash: result.memory.data.contentHash,
        ...denseTelemetryFields(result),
        id: result.memory.data.id,
        memorySpaceId: result.memory.data.memorySpaceId,
        memoryVersion: result.memory.data.version,
        scopeKey: result.sourceRanks ? "" : "dense",
        searchKey: result.memory.data.searchKey,
      },
      score:
        actualStrategy === "dense-v1"
          ? result.score
          : adjustedCandidateScore(
              {
                fusedRank: result.fusedRank ?? index + 1,
                fusedScore,
                id: result.memory.data.id,
                row: {
                  contentHash: result.memory.data.contentHash,
                  id: result.memory.data.id,
                  memorySpaceId: result.memory.data.memorySpaceId,
                  memoryVersion: result.memory.data.version,
                  scopeKey: "",
                  searchKey: result.memory.data.searchKey,
                },
                sourceRanks: result.sourceRanks ?? { dense: result.rank },
                sourceScores: result.sourceScores ?? {},
              },
              result.memory,
              now(),
              usefulness.get(result.memory.data.id) ?? 0,
            ),
      sourceRanks: result.sourceRanks ?? { dense: result.rank },
      sourceScores: result.sourceScores ?? {},
      ...(usefulness.has(result.memory.data.id)
        ? { usefulnessScore: usefulness.get(result.memory.data.id)! }
        : {}),
    } satisfies SelectableMemoryCandidate;
    return candidate;
  });
  let rerankTelemetry:
    | {
        readonly latencyMs: number;
        readonly model: string;
        readonly provider: string;
      }
    | undefined;
  if (
    !fullContext &&
    actualStrategy === "hybrid-rerank-v1" &&
    dependencies.rerank &&
    selectable.length > 1
  ) {
    const candidates = selectable.slice(0, retrievalConfig.rerankCandidateK);
    const rerankDeadline = memorySearchPhaseDeadline(
      operationDeadline,
      retrievalConfig.rerankDeadlineMs,
    );
    if (!rerankDeadline.aborted) {
      try {
        const reranked = await observeMemorySearchPhase(telemetry, "rerank", () =>
          withAbort(
            dependencies.rerank!({
              attribution: input.runId
                ? { kind: "run", runId: input.runId }
                : { kind: "operation", operationId: attemptId },
              candidates,
              deadlineMs: retrievalConfig.rerankDeadlineMs,
              maxOutputTokens: retrievalConfig.rerankMaxOutputTokens,
              modelCallId: `memory-rerank:${attemptId}`,
              ...(input.observability ? { observability: input.observability } : {}),
              promptBytes: retrievalConfig.rerankPromptBytes,
              query,
              scope,
              signal: rerankDeadline,
            }),
            rerankDeadline,
          ),
        );
        const scores = new Map(reranked.scores.map((entry) => [entry.memoryId, entry.score]));
        if (
          scores.size === candidates.length &&
          candidates.every((entry) => scores.has(entry.id))
        ) {
          selectable = selectable.map((candidate) => {
            const rerankScore = scores.get(candidate.id);
            return rerankScore === undefined
              ? candidate
              : {
                  ...candidate,
                  rerankScore,
                  score: rerankScore + (candidate.score - candidate.fusedScore),
                };
          });
          rerankTelemetry = reranked;
          telemetry.rerankLatencyMs = reranked.latencyMs;
          telemetry.rerankModel = reranked.model;
          telemetry.rerankProvider = reranked.provider;
        }
      } catch (cause) {
        if (operationDeadline.aborted) throw operationDeadline.reason;
        if (cause instanceof MemoryRerankUsagePersistenceError) throw cause;
        // A failed or partial rerank keeps the complete fused order.
      }
    }
  }
  const { contextTokens, duplicateCount, results } = await observeMemorySearchPhase(
    telemetry,
    "selection",
    () => {
      if (fullContext) {
        return {
          contextTokens: fullContext.contextTokens,
          duplicateCount: fullContext.duplicateCount,
          results: fullContext.selected.map((result, index) => ({ ...result, rank: index + 1 })),
        };
      }
      const ranked = rankAndSelectMemories({
        candidates: selectable,
        contextTokenBudget: retrievalConfig.contextTokenBudget,
        strategy: actualStrategy,
        topK,
      });
      return {
        contextTokens: ranked.contextTokens,
        duplicateCount: ranked.duplicateCount,
        results: ranked.selected.map(
          (candidate, index): MemorySearchResult => ({
            ...denseTelemetryFields(candidate),
            fusedRank: candidate.fusedRank,
            fusedScore: candidate.fusedScore,
            memory: candidate.memory,
            rank: index + 1,
            score: candidate.score,
            ...(candidate.rerankScore === undefined
              ? {}
              : {
                  rerankDelta: candidate.rerankScore - candidate.fusedScore,
                  rerankScore: candidate.rerankScore,
                }),
            sourceRanks: candidate.sourceRanks,
            sourceScores: candidate.sourceScores,
          }),
        ),
      };
    },
  );
  telemetry.contextTokens = contextTokens;
  telemetry.duplicateCount = duplicateCount;
  telemetry.injectedCount = input.purpose === "active-recall" ? results.length : 0;
  telemetry.retrievedCount = results.length;
  telemetry.selectedMemoryIds = results.map((result) => result.memory.data.id);
  return {
    actualStrategy,
    canonicalResults,
    contextTokens,
    duplicateCount,
    embedding,
    hydrated,
    placementGeneration: placement.placementGeneration,
    providerId: searchProvider.providerId,
    rerankTelemetry,
    results,
    searchResult,
    selectionMode,
    targetId: searchProvider.target.targetId,
  };
}

export type RetrievedMemorySearch = Awaited<ReturnType<typeof retrieveMemorySearchCandidates>>;
