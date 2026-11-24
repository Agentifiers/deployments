import {
  MemoryRecallAttemptRecord,
  withCanonicalRecordKeys,
  memoryPersistence,
} from "@deployments-ai/db";
import type { MemorySearchContext, MemorySearchExecution } from "./platform-search.ts";
import { memorySearchPhaseDeadline, SHADOW_CLAIM_GRACE_MS, withAbort } from "./platform-search.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import { ACTIVE_RECALL_TOP_K } from "./retrieval.ts";

export interface PreparedMemorySearch {
  readonly allowedScopeKeys: readonly string[];
  readonly searchKeys: readonly string[];
  readonly shadowClaim: Types.MemoryRecallAttempt | undefined;
  readonly spacePolicies: readonly Awaited<ReturnType<MemorySearchContext["effectivePolicy"]>>[];
  readonly spaces: readonly Awaited<ReturnType<MemorySearchContext["requiredSpace"]>>[];
  readonly topK: number;
}

export async function prepareMemorySearch(
  context: MemorySearchContext,
  scope: Types.MemoryPlatformScope,
  input: Types.SearchPlatformMemoryInput,
  execution: MemorySearchExecution,
): Promise<PreparedMemorySearch | { readonly result: Types.MemoryRecallResult }> {
  const {
    database,
    dependencies: _dependencies,
    generateId: _generateId,
    now,
    searchService: _searchService,
    resolveMemoryContent: _resolveMemoryContent,
    requiredSpace,
    effectivePolicy,
    eventFor: _eventFor,
    idempotencyReplay: _idempotencyReplay,
    completedIdempotency: _completedIdempotency,
    idempotencyOperation: _idempotencyOperation,
  } = context;
  const {
    activeRecall,
    attemptId,
    memorySpaceIds,
    operationDeadline,
    purpose: _purpose,
    query,
    retrievalConfig,
    retrievalStrategy,
  } = execution;
  const deadline = memorySearchPhaseDeadline(operationDeadline, retrievalConfig.phaseDeadlineMs);
  let shadowClaim: Types.MemoryRecallAttempt | undefined;

  const spaces = await withAbort(
    Promise.all(memorySpaceIds.map((id) => requiredSpace(scope, id))),
    deadline,
  );
  if (spaces.some((space) => space.data.status !== "active")) {
    throw new Types.MemoryPlatformError(
      409,
      "memory_space_archived",
      "Archived memory spaces cannot be searched.",
    );
  }
  const policiesByWorkspace = new Map<string, Promise<Types.MemoryPolicy | undefined>>();
  const spacePolicies = await withAbort(
    Promise.all(
      spaces.map((space) => {
        const workspaceKey = space.data.workspaceId ?? "environment";
        let spacePolicy = policiesByWorkspace.get(workspaceKey);
        if (!spacePolicy) {
          spacePolicy = effectivePolicy(Shared.memoryOwnedScope(scope, space.data.workspaceId));
          policiesByWorkspace.set(workspaceKey, spacePolicy);
        }
        return spacePolicy;
      }),
    ),
    deadline,
  );
  const defaultScopeKeys = [
    `organization:${scope.organizationId}`,
    ...(scope.workspaceId ? [`workspace:${scope.workspaceId}`] : []),
    ...spaces.flatMap((space) =>
      space.data.workspaceId ? [`workspace:${space.data.workspaceId}`] : [],
    ),
  ];
  const canonicalScopeKeys = [...new Set(defaultScopeKeys)];
  if (input.searchKeys && input.searchKeys.length > 50) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_search_key",
      "Memory searches accept at most 50 search keys.",
    );
  }
  const searchKeys = input.searchKeys?.map(Shared.validatedSearchKey) ?? canonicalScopeKeys;
  const allowedScopeKeys = input.allowedScopeKeys ?? canonicalScopeKeys;
  if (
    activeRecall &&
    (memorySpaceIds.length === 0 || searchKeys.length === 0 || allowedScopeKeys.length === 0)
  ) {
    const timestamp = Shared.iso(now());
    const attempt = Shared.record(
      MemoryRecallAttemptRecord,
      withCanonicalRecordKeys({
        data: {
          candidateCount: 0,
          ...(input.comparisonPurpose ? { comparisonPurpose: input.comparisonPurpose } : {}),
          createdAt: timestamp,
          environmentId: scope.environmentId,
          id: attemptId,
          injectedCount: 0,
          organizationId: scope.organizationId,
          ...(input.observability ? { observability: input.observability } : {}),
          projectId: scope.projectId,
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
          purpose: input.purpose ?? "search",
          queryHash: Shared.sha256(query),
          retrievedCount: 0,
          ...(input.runId ? { runId: input.runId, threadId: input.threadId } : {}),
          skipReason: "no-memory-access",
          status: "skipped" as const,
          strategy: retrievalStrategy,
          version: 0,
        },
        itemType: "memory-recall-attempt" as const,
      }),
    );
    await memoryPersistence.write(
      database,
      attempt,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    return { result: { attempt, results: [], retrievals: [] } };
  }
  const topK = input.topK ?? (activeRecall ? ACTIVE_RECALL_TOP_K : 10);
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > Shared.MAX_PERSISTED_RETRIEVALS) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_top_k",
      `topK must be an integer from 1 to ${Shared.MAX_PERSISTED_RETRIEVALS}.`,
    );
  }
  if (input.shadow === true && input.shadowAttemptId && input.shadowOfAttemptId) {
    const timestamp = Shared.iso(now());
    shadowClaim = Shared.record(
      MemoryRecallAttemptRecord,
      withCanonicalRecordKeys({
        data: {
          candidateCount: 0,
          ...(input.comparisonPurpose ? { comparisonPurpose: input.comparisonPurpose } : {}),
          createdAt: timestamp,
          environmentId: scope.environmentId,
          id: attemptId,
          injectedCount: 0,
          organizationId: scope.organizationId,
          ...(input.observability ? { observability: input.observability } : {}),
          projectId: scope.projectId,
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
          purpose: input.purpose ?? "search",
          queryHash: Shared.sha256(query),
          retrievedCount: 0,
          ...(input.runId ? { runId: input.runId, threadId: input.threadId } : {}),
          requestedStrategy: retrievalStrategy,
          shadow: true,
          shadowOfAttemptId: input.shadowOfAttemptId,
          status: "running" as const,
          strategy: retrievalStrategy,
          ...(input.targetId ? { targetId: input.targetId } : {}),
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
          version: 0,
        },
        itemType: "memory-recall-attempt" as const,
      }),
    );
    try {
      await memoryPersistence.write(
        database,
        shadowClaim,
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      );
    } catch (cause) {
      const existing = await Shared.loadRecord(
        database,
        "execution",
        { pk: shadowClaim.pk, sk: shadowClaim.sk },
        "memory-recall-attempt",
      );
      if (
        existing &&
        Shared.scopeMatches(existing, scope) &&
        existing.data.shadow === true &&
        existing.data.shadowOfAttemptId === input.shadowOfAttemptId &&
        (existing.data.requestedStrategy ?? existing.data.strategy) === retrievalStrategy &&
        existing.data.queryHash === shadowClaim.data.queryHash
      ) {
        if (existing.data.status === "completed") {
          return { result: { attempt: existing, results: [], retrievals: [] } };
        }
        const claimAgeMs = Math.max(0, now().getTime() - Date.parse(existing.data.createdAt));
        if (
          existing.data.status === "running" &&
          claimAgeMs <= retrievalConfig.deadlineMs + SHADOW_CLAIM_GRACE_MS
        ) {
          return { result: { attempt: existing, results: [], retrievals: [] } };
        }
        if (existing.data.status === "failed" || existing.data.status === "running") {
          const {
            canonicalDropCount: _canonicalDropCount,
            contextTokens: _contextTokens,
            denseCandidateCount: _denseCandidateCount,
            denseOpenSearchCandidateCount: _denseOpenSearchCandidateCount,
            duplicateCount: _duplicateCount,
            entityCandidateCount: _entityCandidateCount,
            exactCandidateCount: _exactCandidateCount,
            latencyMs: _latencyMs,
            lexicalCandidateCount: _lexicalCandidateCount,
            plannerModel: _plannerModel,
            plannerProvider: _plannerProvider,
            rerankLatencyMs: _rerankLatencyMs,
            rerankModel: _rerankModel,
            rerankProvider: _rerankProvider,
            selectionMode: _selectionMode,
            skipReason: _skipReason,
            ...claimData
          } = existing.data;
          const reclaimed = Shared.record(
            MemoryRecallAttemptRecord,
            withCanonicalRecordKeys({
              data: {
                ...claimData,
                candidateCount: 0,
                createdAt: Shared.iso(now()),
                injectedCount: 0,
                retrievedCount: 0,
                status: "running" as const,
                version: existing.data.version + 1,
              },
              itemType: "memory-recall-attempt" as const,
            }),
          );
          await memoryPersistence.commit(database, [
            { kind: "put", previousRecord: existing, record: reclaimed },
          ]);
          shadowClaim = reclaimed;
        } else {
          throw cause;
        }
      } else {
        throw cause;
      }
    }
  }
  return {
    allowedScopeKeys,
    searchKeys,
    shadowClaim,
    spacePolicies,
    spaces,
    topK,
  };
}
