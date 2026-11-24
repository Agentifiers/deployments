import {
  MemoryRecallAttemptRecord,
  MemoryRetrievalRecord,
  MemoryShadowJobRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import { memoryRolloutSelected } from "./governance.ts";
import type { PreparedMemorySearch } from "./memory-search-preparation.ts";
import type { RetrievedMemorySearch } from "./memory-search-retrieval.ts";
import type { MemorySearchContext, MemorySearchExecution } from "./platform-search.ts";
import { SHADOW_JOB_TTL_MS } from "./platform-search.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import { estimateMemoryTokens } from "./retrieval.ts";

export async function persistMemorySearch(
  context: MemorySearchContext,
  scope: Types.MemoryPlatformScope,
  input: Types.SearchPlatformMemoryInput,
  execution: MemorySearchExecution & PreparedMemorySearch & RetrievedMemorySearch,
): Promise<Types.MemoryRecallResult> {
  const {
    database,
    dependencies: _dependencies,
    generateId,
    now,
    searchService: _searchService,
    resolveMemoryContent: _resolveMemoryContent,
    requiredSpace: _requiredSpace,
    effectivePolicy: _effectivePolicy,
    eventFor,
    idempotencyReplay: _idempotencyReplay,
    completedIdempotency: _completedIdempotency,
    idempotencyOperation: _idempotencyOperation,
  } = context;
  const {
    actualStrategy,
    attemptId,
    canonicalResults,
    contextTokens,
    duplicateCount,
    embedding,
    enhancedQueryEligible,
    hydrated,
    operationDeadline: _operationDeadline,
    placementGeneration,
    purpose: _purpose,
    providerId,
    query,
    rerankTelemetry,
    results,
    retrievalConfig,
    retrievalStrategy,
    rolloutKey,
    searchResult,
    selectionMode,
    shadowClaim,
    startedAt,
    targetId,
  } = execution;
  const persistenceDeadline = AbortSignal.timeout(retrievalConfig.persistenceDeadlineMs);

  const serviceCanonicalDropCount = searchResult.canonicalDropCount;
  const timestamp = Shared.iso(now());
  const shouldStrategyShadow =
    !input.shadow &&
    retrievalConfig.shadowStrategy !== undefined &&
    retrievalConfig.shadowStrategy !== retrievalStrategy &&
    enhancedQueryEligible &&
    memoryRolloutSelected({
      rolloutKey: `shadow:${retrievalConfig.shadowStrategy}:${rolloutKey}`,
      rolloutPercent: retrievalConfig.shadowRolloutPercent,
    });
  const shouldShadow = shouldStrategyShadow;
  const shadowAttemptId = shouldShadow ? await generateId() : undefined;
  const shadowRequest =
    shouldShadow && shadowAttemptId
      ? {
          input: {
            ...input,
            shadow: true,
            shadowAttemptId,
            shadowOfAttemptId: attemptId,
            strategyOverride: retrievalConfig.shadowStrategy!,
            targetId,
          },
          scope,
          strategy: retrievalConfig.shadowStrategy!,
        }
      : undefined;
  const shadowExpiresAt = shadowRequest ? new Date(now().getTime() + SHADOW_JOB_TTL_MS) : undefined;
  const shadowJob =
    shadowRequest && shadowExpiresAt
      ? Shared.record(
          MemoryShadowJobRecord,
          withCanonicalRecordKeys({
            data: {
              createdAt: timestamp,
              environmentId: scope.environmentId,
              expiresAt: shadowExpiresAt.toISOString(),
              id: shadowAttemptId!,
              input: shadowRequest.input,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              targetId: shadowRequest.input.targetId!,
              version: 0,
              ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
            },
            itemType: "memory-shadow-job" as const,
            ttl: Math.floor(shadowExpiresAt.getTime() / 1_000),
          }),
        )
      : undefined;
  const shadowEvent = shadowJob
    ? await eventFor({
        aggregateId: shadowJob.data.id,
        aggregateType: "memory-shadow",
        aggregateVersion: 1,
        eventType: "memory.shadow.queued",
        payload: { jobId: shadowJob.data.id },
        scope,
      })
    : undefined;
  const attempt = Shared.record(
    MemoryRecallAttemptRecord,
    withCanonicalRecordKeys({
      data: {
        candidateCount: searchResult.candidateCount,
        ...(input.comparisonPurpose ? { comparisonPurpose: input.comparisonPurpose } : {}),
        canonicalDropCount: serviceCanonicalDropCount + (canonicalResults.length - hydrated.length),
        contextTokens,
        createdAt: timestamp,
        denseCandidateCount: searchResult.counts.dense,
        denseOpenSearchCandidateCount: searchResult.counts.denseOpenSearch,
        duplicateCount,
        entityCandidateCount: searchResult.counts.entity,
        exactCandidateCount: searchResult.counts.exact,
        environmentId: scope.environmentId,
        id: attemptId,
        injectedCount: input.purpose === "active-recall" ? results.length : 0,
        latencyMs: Math.max(0, Date.now() - startedAt),
        lexicalCandidateCount: searchResult.counts.lexical,
        organizationId: scope.organizationId,
        ...(input.observability ? { observability: input.observability } : {}),
        plannerModel: embedding.model,
        plannerProvider: embedding.provider,
        phaseTimingsMs: { ...execution.telemetry.phaseTimingsMs },
        placementGeneration,
        projectId: scope.projectId,
        provider: providerId,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        purpose: input.purpose ?? "search",
        queryHash: Shared.sha256(query),
        retrievedCount: results.length,
        ...(rerankTelemetry
          ? {
              rerankLatencyMs: rerankTelemetry.latencyMs,
              rerankModel: rerankTelemetry.model,
              rerankProvider: rerankTelemetry.provider,
            }
          : {}),
        ...(input.runId ? { runId: input.runId, threadId: input.threadId } : {}),
        ...(input.shadow ? { requestedStrategy: retrievalStrategy } : {}),
        selectedMemoryIds: results.map((result) => result.memory.data.id),
        selectionMode,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        status: "completed" as const,
        shadow: input.shadow === true,
        ...(input.shadowOfAttemptId ? { shadowOfAttemptId: input.shadowOfAttemptId } : {}),
        strategy: actualStrategy,
        targetId,
        version: shadowClaim ? shadowClaim.data.version + 1 : 0,
      },
      itemType: "memory-recall-attempt" as const,
    }),
  );
  const retrievals: Types.MemoryRetrieval[] = [];
  for (const result of results) {
    const retrieval = Shared.record(
      MemoryRetrievalRecord,
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          environmentId: scope.environmentId,
          id: await generateId(),
          injected: input.purpose === "active-recall",
          contextTokens: estimateMemoryTokens(result.memory.data.body ?? ""),
          ...(result.denseSourceDistances?.["open-search"] === undefined
            ? {}
            : { denseOpenSearchDistance: result.denseSourceDistances["open-search"] }),
          ...(result.denseSourceRanks?.["open-search"] === undefined
            ? {}
            : { denseOpenSearchRank: result.denseSourceRanks["open-search"] }),
          ...(result.sourceRanks?.dense ? { denseRank: result.sourceRanks.dense } : {}),
          ...(result.sourceScores?.dense !== undefined
            ? { denseDistance: result.sourceScores.dense }
            : {}),
          ...(result.sourceRanks?.entity ? { entityRank: result.sourceRanks.entity } : {}),
          ...(result.sourceRanks?.["memory-id"] || result.sourceRanks?.["search-key"]
            ? {
                exactRank: Math.min(
                  result.sourceRanks?.["memory-id"] ?? Infinity,
                  result.sourceRanks?.["search-key"] ?? Infinity,
                ),
              }
            : {}),
          ...(result.fusedRank ? { fusedRank: result.fusedRank } : {}),
          ...(result.fusedScore !== undefined ? { fusedScore: result.fusedScore } : {}),
          ...(result.sourceRanks?.lexical ? { lexicalRank: result.sourceRanks.lexical } : {}),
          ...(result.sourceScores?.lexical !== undefined
            ? { lexicalScore: result.sourceScores.lexical }
            : {}),
          memoryId: result.memory.data.id,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
          provider: providerId,
          purpose: input.purpose ?? "search",
          rank: result.rank,
          ...(result.rerankDelta === undefined ? {} : { rerankDelta: result.rerankDelta }),
          ...(result.rerankScore === undefined ? {} : { rerankScore: result.rerankScore }),
          recallAttemptId: attemptId,
          reviewStatus: result.memory.data.reviewStatus,
          ...(input.runId ? { runId: input.runId, threadId: input.threadId } : {}),
          score: result.score,
          searchKey: result.memory.data.searchKey,
          sensitivity: result.memory.data.sensitivity,
          shadow: input.shadow === true,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
          targetId,
          version: 0,
        },
        itemType: "memory-retrieval" as const,
      }),
    );
    retrievals.push(retrieval);
  }
  await transactWithSemanticEvents(
    database,
    [
      shadowClaim
        ? { kind: "put" as const, previousRecord: shadowClaim, record: attempt }
        : {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put" as const,
            record: attempt,
          },
      ...retrievals.map((retrieval) => ({
        kind: "put" as const,
        record: retrieval,
      })),
      ...(shadowJob
        ? [
            {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put" as const,
              record: shadowJob,
            },
          ]
        : []),
    ],
    shadowEvent ? [shadowEvent] : [],
    undefined,
    persistenceDeadline,
  );
  return { attempt, results, retrievals };
}
