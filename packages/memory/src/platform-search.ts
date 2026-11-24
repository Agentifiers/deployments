import {
  MemoryRecallAttemptRecord,
  withCanonicalRecordKeys,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { memoryRolloutSelected } from "./governance.ts";
import { makeMemoryRetrievalFeedback } from "./memory-retrieval-feedback.ts";
import { persistMemorySearch } from "./memory-search-persistence.ts";
import { prepareMemorySearch } from "./memory-search-preparation.ts";
import { retrieveMemorySearchCandidates } from "./memory-search-retrieval.ts";
import {
  completedMemorySearchPhaseTimings,
  createMemorySearchTelemetry,
  failedMemorySearchStage,
  observeMemorySearchPhase,
  type MemorySearchTelemetry,
} from "./memory-search-telemetry.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import * as Shared from "./platform-shared.ts";
import type { MemoryPlatformSpaces } from "./platform-spaces.ts";
import * as Types from "./platform-types.ts";
import { lexicalQueryEligible, memoryRetrievalConfig } from "./retrieval.ts";

export const USEFULNESS_LOOKUP_BUDGET_MS = 50;
export const USEFULNESS_LOOKUP_CONCURRENCY = 8;
export const SHADOW_CLAIM_GRACE_MS = 30_000;
export const SHADOW_JOB_TTL_MS = 15 * 24 * 60 * 60_000;

export function withAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

export function memorySearchPhaseDeadline(operationDeadline: AbortSignal, phaseDeadlineMs: number) {
  return AbortSignal.any([operationDeadline, AbortSignal.timeout(phaseDeadlineMs)]);
}

export async function mapConcurrentOrdered<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
) {
  const results: Output[] = [];
  results.length = values.length;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await map(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
function makeMemorySearchContext(
  runtime: Shared.MemoryPlatformRuntime & MemoryPlatformCore & MemoryPlatformSpaces,
) {
  const {
    database,
    dependencies,
    generateId,
    now,
    searchService,
    resolveMemoryContent,
    requiredSpace,
    effectivePolicy,
    eventFor,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
  } = runtime;
  return {
    database,
    dependencies,
    generateId,
    now,
    searchService,
    resolveMemoryContent,
    requiredSpace,
    effectivePolicy,
    eventFor,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
  };
}

export type MemorySearchContext = ReturnType<typeof makeMemorySearchContext>;

export interface MemorySearchExecution {
  readonly activeRecall: boolean;
  readonly attemptId: Ulid;
  readonly configuredStrategy: ReturnType<typeof memoryRetrievalConfig>["strategy"];
  readonly enhancedQueryEligible: boolean;
  readonly memorySpaceIds: readonly Ulid[];
  readonly operationDeadline: AbortSignal;
  readonly telemetry: MemorySearchTelemetry;
  readonly purpose: "active-recall" | "search";
  readonly query: string;
  readonly retrievalConfig: ReturnType<typeof memoryRetrievalConfig>;
  readonly retrievalStrategy: ReturnType<typeof memoryRetrievalConfig>["strategy"];
  readonly rolloutKey: string;
  readonly servedStrategy: ReturnType<typeof memoryRetrievalConfig>["strategy"];
  readonly startedAt: number;
}

export function makeMemoryPlatformSearch(
  runtime: Shared.MemoryPlatformRuntime & MemoryPlatformCore & MemoryPlatformSpaces,
) {
  const context = makeMemorySearchContext(runtime);
  const { database, generateId, now, effectivePolicy } = context;
  async function search(
    scope: Types.MemoryPlatformScope,
    input: Types.SearchPlatformMemoryInput,
  ): Promise<Types.MemoryRecallResult> {
    const query = Shared.embeddableText(input.query, "Memory query", 20_000);
    const enhancedQueryEligible = lexicalQueryEligible(query);
    const memorySpaceIds = [...new Set(input.memorySpaceIds)];
    const attemptId = input.shadowAttemptId ?? (await generateId());
    const startedAt = Date.now();
    const telemetry = createMemorySearchTelemetry();
    let retrievalStrategy: ReturnType<typeof memoryRetrievalConfig>["strategy"] = "dense-v1";
    let shadowClaim: Types.MemoryRecallAttempt | undefined;
    try {
      const activeRecall = input.purpose === "active-recall";
      const purpose = activeRecall ? "active-recall" : "search";
      const policyDeadline = AbortSignal.timeout(
        memoryRetrievalConfig(undefined, purpose).phaseDeadlineMs,
      );
      const policy = await observeMemorySearchPhase(telemetry, "policy", () =>
        withAbort(effectivePolicy(scope), policyDeadline),
      );
      const retrievalConfig = memoryRetrievalConfig(policy?.data.processingConfig, purpose);
      const rolloutKey = input.runId ?? attemptId;
      const configuredStrategy = input.strategyOverride ?? retrievalConfig.strategy;
      const servedStrategy =
        input.strategyOverride !== undefined ||
        configuredStrategy === "dense-v1" ||
        memoryRolloutSelected({
          rolloutKey: `served:${configuredStrategy}:${rolloutKey}`,
          rolloutPercent: retrievalConfig.rolloutPercent,
        })
          ? configuredStrategy
          : "dense-v1";
      retrievalStrategy = enhancedQueryEligible ? servedStrategy : "dense-v1";
      const operationDeadline = AbortSignal.timeout(retrievalConfig.deadlineMs);
      const activeRecallEnabled = !activeRecall || policy?.data.activeRecallEnabled === true;
      const selected =
        !activeRecall ||
        memoryRolloutSelected({
          rolloutKey: input.runId ?? attemptId,
          ...(policy ? { rolloutPercent: policy.data.activeRecallRolloutPercent } : {}),
        });
      if (!activeRecallEnabled || !selected) {
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
              phaseTimingsMs: completedMemorySearchPhaseTimings(telemetry),
              ...(input.observability ? { observability: input.observability } : {}),
              projectId: scope.projectId,
              ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
              purpose: input.purpose ?? "search",
              queryHash: Shared.sha256(query),
              retrievedCount: 0,
              ...(input.runId ? { runId: input.runId, threadId: input.threadId } : {}),
              ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
              skipReason: activeRecallEnabled ? "rollout-not-selected" : "active-recall-disabled",
              status: "skipped" as const,
              strategy: retrievalStrategy,
              ...(input.targetId ? { targetId: input.targetId } : {}),
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
        return { attempt, results: [], retrievals: [] };
      }
      const execution: MemorySearchExecution = {
        activeRecall,
        attemptId,
        configuredStrategy,
        enhancedQueryEligible,
        memorySpaceIds,
        operationDeadline,
        purpose,
        query,
        retrievalConfig,
        retrievalStrategy,
        rolloutKey,
        servedStrategy,
        startedAt,
        telemetry,
      };
      const preparation = await observeMemorySearchPhase(telemetry, "preparation", () =>
        prepareMemorySearch(context, scope, input, execution),
      );
      if ("result" in preparation) return preparation.result;
      shadowClaim = preparation.shadowClaim;
      const retrieval = await retrieveMemorySearchCandidates(context, scope, input, {
        ...execution,
        ...preparation,
      });
      return await observeMemorySearchPhase(telemetry, "persistence", () =>
        persistMemorySearch(context, scope, input, {
          ...execution,
          ...preparation,
          ...retrieval,
        }),
      );
    } catch (cause) {
      const timestamp = Shared.iso(now());
      const failureStage = failedMemorySearchStage(telemetry);
      const failedAttempt = Shared.record(
        MemoryRecallAttemptRecord,
        withCanonicalRecordKeys({
          data: {
            candidateCount: telemetry.candidateCount ?? 0,
            ...(input.comparisonPurpose ? { comparisonPurpose: input.comparisonPurpose } : {}),
            createdAt: timestamp,
            ...(telemetry.canonicalDropCount === undefined
              ? {}
              : { canonicalDropCount: telemetry.canonicalDropCount }),
            ...(telemetry.contextTokens === undefined
              ? {}
              : { contextTokens: telemetry.contextTokens }),
            ...(telemetry.denseCandidateCount === undefined
              ? {}
              : { denseCandidateCount: telemetry.denseCandidateCount }),
            ...(telemetry.denseOpenSearchCandidateCount === undefined
              ? {}
              : { denseOpenSearchCandidateCount: telemetry.denseOpenSearchCandidateCount }),
            ...(telemetry.duplicateCount === undefined
              ? {}
              : { duplicateCount: telemetry.duplicateCount }),
            ...(telemetry.entityCandidateCount === undefined
              ? {}
              : { entityCandidateCount: telemetry.entityCandidateCount }),
            ...(telemetry.exactCandidateCount === undefined
              ? {}
              : { exactCandidateCount: telemetry.exactCandidateCount }),
            environmentId: scope.environmentId,
            ...(failureStage ? { failureStage } : {}),
            id: attemptId,
            injectedCount: telemetry.injectedCount ?? 0,
            latencyMs: Math.max(0, Date.now() - startedAt),
            ...(telemetry.lexicalCandidateCount === undefined
              ? {}
              : { lexicalCandidateCount: telemetry.lexicalCandidateCount }),
            organizationId: scope.organizationId,
            phaseTimingsMs: completedMemorySearchPhaseTimings(telemetry),
            ...(telemetry.placementGeneration === undefined
              ? {}
              : { placementGeneration: telemetry.placementGeneration }),
            ...(telemetry.plannerModel ? { plannerModel: telemetry.plannerModel } : {}),
            ...(telemetry.plannerProvider ? { plannerProvider: telemetry.plannerProvider } : {}),
            ...(input.observability ? { observability: input.observability } : {}),
            projectId: scope.projectId,
            ...(telemetry.provider ? { provider: telemetry.provider } : {}),
            ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
            purpose: input.purpose ?? "search",
            queryHash: Shared.sha256(query),
            retrievedCount: telemetry.retrievedCount ?? 0,
            ...(telemetry.rerankLatencyMs === undefined
              ? {}
              : { rerankLatencyMs: telemetry.rerankLatencyMs }),
            ...(telemetry.rerankModel ? { rerankModel: telemetry.rerankModel } : {}),
            ...(telemetry.rerankProvider ? { rerankProvider: telemetry.rerankProvider } : {}),
            ...(input.runId ? { runId: input.runId, threadId: input.threadId } : {}),
            ...(input.shadow ? { requestedStrategy: retrievalStrategy } : {}),
            shadow: input.shadow === true,
            ...(input.shadowOfAttemptId ? { shadowOfAttemptId: input.shadowOfAttemptId } : {}),
            status: "failed" as const,
            ...(telemetry.selectedMemoryIds
              ? { selectedMemoryIds: [...telemetry.selectedMemoryIds] }
              : {}),
            ...(telemetry.selectionMode ? { selectionMode: telemetry.selectionMode } : {}),
            strategy: telemetry.actualStrategy ?? retrievalStrategy,
            ...((telemetry.targetId ?? input.targetId)
              ? { targetId: (telemetry.targetId ?? input.targetId)! }
              : {}),
            ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
            version: shadowClaim ? shadowClaim.data.version + 1 : 0,
          },
          itemType: "memory-recall-attempt" as const,
        }),
      );
      await (
        shadowClaim
          ? memoryPersistence.commit(database, [
              {
                kind: "put",
                previousRecord: shadowClaim,
                record: failedAttempt,
              },
            ])
          : memoryPersistence.write(
              database,
              failedAttempt,
              "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            )
      ).catch(() => undefined);
      throw cause;
    }
  }
  const recordRetrievalFeedback = makeMemoryRetrievalFeedback(context);
  return { search, recordRetrievalFeedback };
}
