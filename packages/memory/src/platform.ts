import { makeIdGenerator, type Ulid, memoryPersistence } from "@deployments-ai/db";
import { makeMemoryRepository } from "./repository.ts";
import { makeMemoryService } from "./service.ts";
import { memorySearchPlacementResolver } from "./provider.ts";
import { makeMemoryPlatformCore } from "./platform-core.ts";
import { makeMemoryPlatformDefaultWorkspaceMemory } from "./platform-default-workspace-memory.ts";
import { makeMemoryPlatformFlush } from "./platform-flush.ts";
import { makeMemoryPlatformGrantList } from "./platform-grant-list.ts";
import { makeMemoryPlatformGrants } from "./platform-grants.ts";
import { makeMemoryPlatformIndexing } from "./platform-indexing.ts";
import { makeMemoryPlatformLifecycle } from "./platform-lifecycle.ts";
import { makeMemoryPlatformMemories } from "./platform-memories.ts";
import { makeMemoryPlatformQuality } from "./platform-quality.ts";
import { makeMemoryPlatformReconcile } from "./platform-reconcile.ts";
import { makeMemoryPlatformRun } from "./platform-run.ts";
import { makeMemoryPlatformSearch } from "./platform-search.ts";
import { makeMemoryPlatformSpaces } from "./platform-spaces.ts";
import { publicMemoryRecallResult, publicMemoryRecord } from "./public-projections.ts";
import * as Shared from "./platform-shared.ts";
import {
  MemoryPlatformError,
  type MemoryPlatformDependencies,
  type MemoryPlatformScope,
  type MemorySpace,
  type MemorySpaceGrant,
  type SearchPlatformMemoryInput,
} from "./platform-types.ts";
export { InvalidMemoryPageCursorError, MemoryPlatformError } from "./platform-types.ts";
export type {
  BrainMemoryProvenance,
  ImportMemoryItem,
  MemoryEmbeddingRequest,
  MemoryEmbeddingResult,
  MemoryPlatformDependencies,
  MemoryPlatformScope,
  MemoryRecallResult,
  MemoryRunAccess,
  MemoryRunSpaceAccess,
  SearchPlatformMemoryInput,
} from "./platform-types.ts";
export {
  MAX_EMBEDDING_CONTENT_BYTES,
  MAX_PERSISTED_RETRIEVALS,
  writableMemorySpaceForScope,
} from "./platform-shared.ts";

export function makeMemoryPlatform(dependencies: MemoryPlatformDependencies) {
  const database = dependencies.database;
  const repository = makeMemoryRepository(database);
  const placementResolver = memorySearchPlacementResolver(dependencies);
  const searchService = makeMemoryService(repository, placementResolver);
  const idGenerator = makeIdGenerator();
  const now = dependencies.now ?? (() => new Date());
  const generateId = dependencies.generateId ?? (async () => idGenerator.generate());
  const cursorCodec = dependencies.pageCursorCodec ?? Shared.localPageCursorCodec;
  const runtime: Shared.MemoryPlatformRuntime = {
    cursorCodec,
    database,
    dependencies,
    generateId,
    now,
    repository,
    searchService,
  };
  const core = makeMemoryPlatformCore(runtime);
  const spaces = makeMemoryPlatformSpaces({ ...runtime, ...core });
  const grantList = makeMemoryPlatformGrantList({ ...runtime, ...core });
  const grants = makeMemoryPlatformGrants({
    ...runtime,
    ...core,
    ...spaces,
    ...grantList,
  });
  const memories = makeMemoryPlatformMemories({
    ...runtime,
    ...core,
    ...spaces,
  });
  const lifecycle = makeMemoryPlatformLifecycle({ ...runtime, ...core });
  const search = makeMemoryPlatformSearch({ ...runtime, ...core, ...spaces });
  const quality = makeMemoryPlatformQuality(runtime);
  const indexing = makeMemoryPlatformIndexing({
    ...runtime,
    ...core,
    ...spaces,
  });
  const run = makeMemoryPlatformRun({
    ...runtime,
    ...core,
    ...spaces,
    ...grantList,
    ...memories,
  });
  const flush = makeMemoryPlatformFlush({
    ...runtime,
    ...core,
    ...spaces,
    ...run,
  });
  const defaultWorkspaceMemory = makeMemoryPlatformDefaultWorkspaceMemory({
    ...runtime,
    ...core,
    ...spaces,
    ...grantList,
    ...grants,
    ...run,
  });
  const reconciliation = makeMemoryPlatformReconcile({
    ...runtime,
    ...core,
    ...spaces,
  });

  return {
    agentReleaseForRun: run.agentReleaseForRun,
    archiveMemory: (
      scope: MemoryPlatformScope,
      memoryId: Ulid,
      input: { readonly idempotencyKey?: string } = {},
    ) => lifecycle.mutateMemory(scope, memoryId, "archive", input).then(publicMemoryRecord),
    archiveMemorySpace: spaces.archiveMemorySpace,
    claimFlush: flush.claimFlush,
    claimIndexJob: indexing.claimIndexJob,
    cleanupMemoryBlob: core.cleanupMemoryBlob,
    completeFlush: flush.completeFlush,
    completeIndexJob: indexing.completeIndexJob,
    createMemorySpace: spaces.createMemorySpace,
    deleteMemory: (
      scope: MemoryPlatformScope,
      memoryId: Ulid,
      input: {
        readonly idempotencyKey?: string;
        readonly reason?: string;
      } = {},
    ) => lifecycle.mutateMemory(scope, memoryId, "delete", input).then(publicMemoryRecord),
    effectivePolicy: core.effectivePolicy,
    provisionDefaultWorkspaceMemory: defaultWorkspaceMemory.provisionDefaultWorkspaceMemory,
    executeShadowJob: async (scope: MemoryPlatformScope, jobId: Ulid) => {
      const job = await Shared.loadRecord(
        database,
        "execution",
        Shared.memoryShadowJobKey(scope, jobId),
        "memory-shadow-job",
      );
      if (
        !job ||
        !Shared.tenantScopeMatches(job, scope) ||
        (scope.workspaceId !== undefined && job.data.workspaceId !== scope.workspaceId)
      ) {
        return undefined;
      }
      if (job.data.expiresAt <= now().toISOString()) {
        await memoryPersistence.remove(database, job).catch(() => undefined);
        return undefined;
      }
      const jobScope = {
        environmentId: job.data.environmentId,
        organizationId: job.data.organizationId,
        projectId: job.data.projectId,
        ...(job.data.workspaceId ? { workspaceId: job.data.workspaceId } : {}),
      };
      const { runId, ...input } = job.data.input;
      const searchInput: SearchPlatformMemoryInput = {
        memorySpaceIds: input.memorySpaceIds,
        ...(input.observability ? { observability: input.observability } : {}),
        query: input.query,
        shadow: true,
        shadowAttemptId: input.shadowAttemptId,
        shadowOfAttemptId: input.shadowOfAttemptId,
        strategyOverride: input.strategyOverride,
        ...(input.allowedScopeKeys ? { allowedScopeKeys: input.allowedScopeKeys } : {}),
        ...(input.comparisonPurpose ? { comparisonPurpose: input.comparisonPurpose } : {}),
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.searchKeys ? { searchKeys: input.searchKeys } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.topK === undefined ? {} : { topK: input.topK }),
        ...(input.targetId ? { targetId: input.targetId } : {}),
      };
      const result = runId
        ? await (async () => {
            const access = await run.memoryAccessForRun(jobScope, runId);
            return search.search(
              {
                environmentId: jobScope.environmentId,
                organizationId: jobScope.organizationId,
                projectId: jobScope.projectId,
                ...(access.run.data.workspaceId
                  ? { workspaceId: access.run.data.workspaceId }
                  : {}),
              },
              {
                ...searchInput,
                runId,
                threadId: access.run.data.threadId,
                allowedScopeKeys: access.searchKeys,
                memorySpaceIds: access.readMemorySpaceIds,
                observability: {
                  captureMode: access.run.data.captureMode,
                  ...(access.run.data.parentSpanId
                    ? { parentSpanId: access.run.data.parentSpanId }
                    : {}),
                  runSpanId: access.run.data.spanId,
                  sessionId: access.run.data.threadId,
                  traceId: access.run.data.traceId,
                  ...(access.run.data.workspaceId
                    ? { workspaceId: access.run.data.workspaceId }
                    : {}),
                },
                searchKeys: access.searchKeys,
              },
            );
          })()
        : await search.search(jobScope, searchInput);
      if (result.attempt.data.status === "completed" || result.attempt.data.status === "skipped") {
        await memoryPersistence.remove(database, job);
      }
      return publicMemoryRecallResult(result);
    },
    enqueueFlush: flush.enqueueFlush,
    enqueueIndexJob: core.queuedIndexJob,
    exportMemoriesPage: async (...args: Parameters<typeof memories.exportMemoriesPage>) => {
      const page = await memories.exportMemoriesPage(...args);
      return { ...page, items: page.items.map(publicMemoryRecord) };
    },
    failFlush: flush.failFlush,
    failIndexJob: indexing.failIndexJob,
    findRun: run.findRun,
    grantMemorySpace: grants.grantMemorySpace,
    importFlushCandidates: run.importFlushCandidates,
    latestConversationCheckpoint: run.latestConversationCheckpoint,
    importMemories: async (...args: Parameters<typeof memories.importMemories>) => {
      const result = await memories.importMemories(...args);
      return {
        ...result,
        imported: result.imported.map(publicMemoryRecord),
        replayed: result.replayed.map(publicMemoryRecord),
      };
    },
    listMemories: async (...args: Parameters<typeof memories.listMemories>) =>
      (await memories.listMemories(...args)).map(publicMemoryRecord),
    listMemoriesPage: async (...args: Parameters<typeof memories.listMemoriesPage>) => {
      const page = await memories.listMemoriesPage(...args);
      return { ...page, items: page.items.map(publicMemoryRecord) };
    },
    listMemorySpaceGrants: grantList.listMemorySpaceGrants,
    listMemorySpaceGrantsPage: (
      scope: MemoryPlatformScope,
      input: {
        readonly agentDefinitionId?: Ulid;
        readonly cursor?: string;
        readonly limit?: number;
        readonly memorySpaceId?: Ulid;
        readonly status?: "active" | "all" | "revoked";
      } = {},
    ) =>
      Shared.queryEnvironmentRecordPage<MemorySpaceGrant>({
        ...(input.cursor ? { cursor: input.cursor } : {}),
        database,
        cursorCodec,
        environmentId: scope.environmentId,
        filter: (grant) =>
          Shared.scopeMatches(grant, scope) &&
          (!input.agentDefinitionId || grant.data.agentDefinitionId === input.agentDefinitionId) &&
          (!input.memorySpaceId || grant.data.memorySpaceId === input.memorySpaceId) &&
          (input.status === "all"
            ? true
            : input.status === "revoked"
              ? grant.data.revokedAt !== undefined
              : grant.data.revokedAt === undefined),
        itemType: "memory-space-grant",
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        table: "control",
      }),
    listMemorySpaces: spaces.listMemorySpaces,
    listMemorySpacesPage: (
      scope: MemoryPlatformScope,
      input: { readonly cursor?: string; readonly limit?: number } = {},
    ) =>
      Shared.queryEnvironmentRecordPage<MemorySpace>({
        ...input,
        cursorCodec,
        database,
        environmentId: scope.environmentId,
        filter: (space) => Shared.scopeMatches(space, scope),
        itemType: "memory-space",
        table: "control",
      }),
    listPolicies: spaces.listPolicies,
    listPoliciesPage: spaces.listPoliciesPage,
    listReviewItems: lifecycle.listReviewItems,
    listReviewItemsPage: lifecycle.listReviewItemsPage,
    messagesForThread: run.messagesForThread,
    messagesForConversationCheckpoint: run.messagesForConversationCheckpoint,
    modelTokenQuantityForRun: run.modelTokenQuantityForRun,
    memoryAccessForRun: run.memoryAccessForRun,
    namespaceReadiness: async (scope: MemoryPlatformScope) => {
      const provider = (await placementResolver(scope.organizationId)).read;
      if (!provider.readiness) {
        throw new MemoryPlatformError(
          501,
          "namespace_readiness_unavailable",
          "Memory provider readiness is unavailable.",
        );
      }
      return provider.readiness({ organizationId: scope.organizationId });
    },
    openReviewForMemory: lifecycle.openReviewForMemory,
    processIndexJob: indexing.processIndexJob,
    prepareNamespaceFullText: async (scope: MemoryPlatformScope) => {
      if (scope.workspaceId !== undefined) {
        throw new MemoryPlatformError(
          403,
          "workspace_scope_conflict",
          "Workspace-scoped callers cannot prepare an organization-wide search namespace.",
        );
      }
      const provider = (await placementResolver(scope.organizationId)).read;
      if (!provider.prepare) {
        throw new MemoryPlatformError(
          501,
          "namespace_preparation_unavailable",
          "Full-text namespace preparation is unavailable for this placement.",
        );
      }
      return provider.prepare({ organizationId: scope.organizationId });
    },
    quality: quality.quality,
    reconcile: reconciliation.reconcile,
    recordRetrievalFeedback: search.recordRetrievalFeedback,
    requiredFlush: flush.requiredFlush,
    requiredMemory: async (...args: Parameters<typeof core.requiredMemory>) =>
      publicMemoryRecord(await core.requiredMemory(...args)),
    requiredMemorySpaceGrant: grants.requiredMemorySpaceGrant,
    requiredSpace: core.requiredSpace,
    resolveMessageContent: run.resolveMessageContent,
    saveConversationCheckpoint: run.saveConversationCheckpoint,
    resolveReview: async (...args: Parameters<typeof lifecycle.resolveReview>) => {
      const result = await lifecycle.resolveReview(...args);
      return { ...result, memory: publicMemoryRecord(result.memory) };
    },
    restoreMemory: (
      scope: MemoryPlatformScope,
      memoryId: Ulid,
      input: { readonly idempotencyKey?: string } = {},
    ) => lifecycle.mutateMemory(scope, memoryId, "restore", input).then(publicMemoryRecord),
    revokeMemorySpaceGrant: grants.revokeMemorySpaceGrant,
    scrubMemoryReviewContent: lifecycle.scrubMemoryReviewContent,
    search: async (...args: Parameters<typeof search.search>) =>
      publicMemoryRecallResult(await search.search(...args)),
    searchCanonicalForRun: search.search,
    updateMemorySpaceGrant: grants.updateMemorySpaceGrant,
    upsertPolicy: spaces.upsertPolicy,
    verifyIndexStates: reconciliation.verifyIndexStates,
  };
}

export type MemoryPlatform = ReturnType<typeof makeMemoryPlatform>;
