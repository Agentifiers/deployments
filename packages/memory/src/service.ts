import { DatabaseError, RecordDecodeError, type Ulid } from "@deployments-ai/db";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { AwsNativeMemoryError } from "./aws-native-contracts.ts";
import { memoryRecallBlockedReason } from "./governance.ts";
import { MemoryPlatformError } from "./platform-types.ts";
import {
  MemoryRepositoryError,
  type MemoryRepositoryFailure,
  type MemoryRepository,
  type MemoryTenantScope,
} from "./repository.ts";
import {
  reciprocalRankFusion,
  type FusedMemoryCandidate,
  type MemoryCandidate,
  type MemoryRetrievalStrategy,
} from "./retrieval.ts";
import type { CanonicalMemoryRecord, MemorySensitivity } from "./memory-record.ts";
import {
  matchesAuthorization,
  openSearchCandidateCount,
  shouldRemoveFromIndex,
  verifyCanonicalContent,
} from "./memory-search-eligibility.ts";
import type {
  MemorySearchAuthorizationGroup,
  MemorySearchCandidateRow,
  MemorySearchPlacementResolver,
  MemorySearchProviderClient,
  MemorySearchQueryInput,
} from "./provider.ts";
import { withAbort } from "./promise-abort.ts";
import { makeServingReadinessCache } from "./serving-readiness-cache.ts";
import {
  denseTelemetryFields,
  type EnhancedMemorySearchResult,
  type MemorySearchResult,
} from "./memory-search-result.ts";
export type { EnhancedMemorySearchResult, MemorySearchResult } from "./memory-search-result.ts";
export class MemoryNotFoundError extends Schema.TaggedErrorClass<MemoryNotFoundError>()(
  "MemoryNotFoundError",
  {
    memoryId: Schema.String,
    message: Schema.String,
  },
) {}

export class MemoryIndexingError extends Schema.TaggedErrorClass<MemoryIndexingError>()(
  "MemoryIndexingError",
  {
    cause: Schema.Unknown,
    memoryId: Schema.String,
    message: Schema.String,
  },
) {}

export class MemoryIndexJobSuperseded {
  constructor(readonly skipReason: "stale-content-hash" | "stale-memory-version") {}
}

export interface IndexMemoryInput extends MemoryTenantScope {
  readonly allowedSensitivities: readonly MemorySensitivity[];
  readonly content?: string;
  readonly embedding?: readonly number[];
  readonly embeddingContentHash?: string;
  readonly embeddingModel?: string;
  readonly embeddingProvider?: string;
  readonly expectedContentHash: string;
  readonly expectedMemoryVersion: number;
  readonly memoryId: Ulid;
  readonly now?: Date;
  readonly signal?: AbortSignal;
  readonly suppressionReason?: string;
  readonly synchronizationGeneration: number;
  readonly targetId?: Ulid;
}

export interface SearchMemoryInput extends MemoryTenantScope {
  readonly allowedScopeKeys: readonly string[];
  readonly allowedSensitivities: readonly MemorySensitivity[];
  readonly authorizationGroups?: readonly MemorySearchAuthorizationGroup[];
  readonly denseCandidateLimit?: number;
  readonly denseAnnControl?: boolean;
  readonly denseExactControl?: boolean;
  readonly embedding: readonly number[];
  readonly entityKeys?: readonly string[];
  readonly exactMemoryIds?: readonly string[];
  readonly exactSearchKeys?: readonly string[];
  readonly fusionCandidateLimit?: number;
  readonly lexicalCandidateLimit?: number;
  readonly memorySpaceIds: readonly Ulid[];
  readonly now?: Date;
  readonly query?: string;
  readonly resultLimit?: number;
  readonly searchKeys: readonly string[];
  readonly signal?: AbortSignal;
  readonly strategy?: MemoryRetrievalStrategy;
  readonly targetId?: Ulid;
  readonly topK: number;
}

const CANONICAL_READ_CONCURRENCY = 8;

async function mapConcurrentOrdered<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
) {
  const results = Array.from({ length: values.length });
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

type MemorySearchFailure =
  | AwsNativeMemoryError
  | DOMException
  | MemoryIndexingError
  | MemoryPlatformError
  | MemoryRepositoryFailure;

/**
 * Failures callers already classify (tagged provider and repository errors, platform status
 * errors, abort and timeout reasons) pass through; any other failure becomes a MemoryIndexingError.
 */
function memorySearchFailure(cause: unknown, organizationId: string): MemorySearchFailure {
  if (
    cause instanceof AwsNativeMemoryError ||
    cause instanceof DatabaseError ||
    cause instanceof DOMException ||
    cause instanceof MemoryIndexingError ||
    cause instanceof MemoryPlatformError ||
    cause instanceof MemoryRepositoryError ||
    cause instanceof RecordDecodeError
  ) {
    return cause;
  }
  return new MemoryIndexingError({
    cause,
    memoryId: organizationId,
    message: "Memory search failed.",
  });
}

export function makeMemoryService(
  repository: MemoryRepository,
  resolvePlacement: MemorySearchPlacementResolver,
) {
  const readinessCache = makeServingReadinessCache();
  const getRequiredMemory = Effect.fn("MemoryService.getRequiredMemory")(
    (scope: MemoryTenantScope, memoryId: Ulid) =>
      repository.getMemory(scope, memoryId).pipe(
        Effect.flatMap((memory) =>
          memory
            ? Effect.succeed(memory)
            : Effect.fail(
                new MemoryNotFoundError({
                  memoryId,
                  message: "Canonical memory was not found in the requested tenant scope.",
                }),
              ),
        ),
      ),
  );

  const index = Effect.fn("MemoryService.index")((input: IndexMemoryInput) => {
    if (
      !Number.isSafeInteger(input.synchronizationGeneration) ||
      input.synchronizationGeneration < 0
    ) {
      return Effect.fail(
        new MemoryIndexingError({
          cause: input.synchronizationGeneration,
          memoryId: input.memoryId,
          message: "Memory synchronization generation must be a non-negative safe integer.",
        }),
      );
    }
    const scope: MemoryTenantScope = input;
    return Effect.tryPromise({
      catch: (cause) =>
        new MemoryIndexingError({
          cause,
          memoryId: input.memoryId,
          message: "Memory search placement could not be resolved.",
        }),
      try: () => resolvePlacement(input.organizationId),
    }).pipe(
      Effect.flatMap((placement) =>
        getRequiredMemory(scope, input.memoryId).pipe(
          Effect.flatMap((memory) => {
            if (memory.data.contentHash !== input.expectedContentHash) {
              return Effect.fail(
                new MemoryIndexingError({
                  cause: new MemoryIndexJobSuperseded("stale-content-hash"),
                  memoryId: memory.data.id,
                  message:
                    "Memory index job content was superseded before provider synchronization.",
                }),
              );
            }
            if (memory.data.version !== input.expectedMemoryVersion) {
              return Effect.fail(
                new MemoryIndexingError({
                  cause: new MemoryIndexJobSuperseded("stale-memory-version"),
                  memoryId: memory.data.id,
                  message:
                    "Memory index job version was superseded before provider synchronization.",
                }),
              );
            }
            const now = input.now ?? new Date();
            const mutationTargets = [
              ...placement.writes,
              ...(placement.candidate ? [placement.candidate] : []),
            ];
            const provider = input.targetId
              ? mutationTargets.find((candidate) => candidate.target.targetId === input.targetId)
              : placement.writes.length === 1
                ? placement.writes[0]
                : undefined;
            if (!provider) {
              return Effect.fail(
                new MemoryIndexingError({
                  cause: input.targetId ?? placement.writes.map((value) => value.target.targetId),
                  memoryId: memory.data.id,
                  message:
                    "The index job is not authorized for exactly one placement write target.",
                }),
              );
            }
            const namespace = provider.reference(memory.data.organizationId);
            const remove = shouldRemoveFromIndex(memory, input.allowedSensitivities, now);
            let writeInput: Parameters<MemorySearchProviderClient["write"]>[0] | undefined;
            if (!remove) {
              if (
                input.content === undefined ||
                input.embedding === undefined ||
                input.embeddingContentHash === undefined ||
                input.embeddingModel === undefined ||
                input.embeddingProvider === undefined
              ) {
                return Effect.fail(
                  new MemoryIndexingError({
                    cause: "missing-index-payload",
                    memoryId: memory.data.id,
                    message:
                      "Searchable memory indexing requires canonical content and embedding provenance.",
                  }),
                );
              }
              const governanceReason = memoryRecallBlockedReason(memory.data, input.content);
              if (governanceReason) {
                return Effect.fail(
                  new MemoryIndexingError({
                    cause: governanceReason,
                    memoryId: memory.data.id,
                    message:
                      "Canonical memory content that fails governance or changes during inspection cannot be sent to a search provider.",
                  }),
                );
              }
              if (!verifyCanonicalContent(memory, input.content, input.embeddingContentHash)) {
                return Effect.fail(
                  new MemoryIndexingError({
                    cause: "content-hash-mismatch",
                    memoryId: memory.data.id,
                    message: "Memory content and embedding must match canonical DynamoDB content.",
                  }),
                );
              }
              writeInput = {
                content: input.content,
                embedding: input.embedding,
                embeddingContentHash: input.embeddingContentHash,
                embeddingModel: input.embeddingModel,
                embeddingProvider: input.embeddingProvider,
                memory,
                ...(input.signal ? { signal: input.signal } : {}),
                synchronizationGeneration: input.synchronizationGeneration,
              };
            }
            const attemptId = randomUUID();
            const synchronize = Effect.tryPromise({
              catch: (cause) =>
                new MemoryIndexingError({
                  cause,
                  memoryId: memory.data.id,
                  message: remove
                    ? `${provider.providerId} memory deletion failed.`
                    : writeInput
                      ? `${provider.providerId} memory indexing failed.`
                      : `${provider.providerId} memory lifecycle synchronization failed.`,
                }),
              try: () =>
                remove
                  ? provider.delete({
                      memory,
                      ...(input.signal ? { signal: input.signal } : {}),
                      synchronizationGeneration: input.synchronizationGeneration,
                    })
                  : writeInput
                    ? provider.write(writeInput)
                    : provider.synchronizeLifecycle({
                        memory,
                        ...(input.signal ? { signal: input.signal } : {}),
                        synchronizationGeneration: input.synchronizationGeneration,
                      }),
            });

            return repository
              .updateIndexState({
                attemptId,
                embeddingProfileId: provider.target.embeddingProfileId,
                memory,
                namespace,
                placementGeneration: placement.placementGeneration,
                provider: provider.providerId,
                schemaGeneration: provider.target.schemaGeneration,
                status: "pending",
                synchronizationGeneration: input.synchronizationGeneration,
                targetId: provider.target.targetId,
                updatedAt: now,
              })
              .pipe(
                Effect.flatMap((pending) =>
                  synchronize.pipe(
                    Effect.flatMap((result) =>
                      repository.updateIndexState({
                        attemptId: pending.data.attemptId,
                        expectedAttemptId: pending.data.attemptId,
                        ...(remove && input.suppressionReason
                          ? { lastError: input.suppressionReason }
                          : {}),
                        memory,
                        namespace,
                        embeddingProfileId: provider.target.embeddingProfileId,
                        placementGeneration: placement.placementGeneration,
                        provider: provider.providerId,
                        schemaGeneration: provider.target.schemaGeneration,
                        status:
                          result.status === "not-applied"
                            ? "stale"
                            : result.status === "namespace-missing"
                              ? "stale"
                              : memory.data.status === "deleted"
                                ? "deleted"
                                : remove
                                  ? "suppressed"
                                  : "ready",
                        synchronizationGeneration: input.synchronizationGeneration,
                        targetId: provider.target.targetId,
                        updatedAt: now,
                      }),
                    ),
                    Effect.catchTag("MemoryIndexingError", (cause) =>
                      repository
                        .updateIndexState({
                          attemptId: pending.data.attemptId,
                          expectedAttemptId: pending.data.attemptId,
                          lastError: cause.message,
                          memory,
                          namespace,
                          embeddingProfileId: provider.target.embeddingProfileId,
                          placementGeneration: placement.placementGeneration,
                          provider: provider.providerId,
                          schemaGeneration: provider.target.schemaGeneration,
                          status: "failed",
                          synchronizationGeneration: input.synchronizationGeneration,
                          targetId: provider.target.targetId,
                          updatedAt: now,
                        })
                        .pipe(Effect.flatMap(() => Effect.fail(cause))),
                    ),
                  ),
                ),
              );
          }),
        ),
      ),
    );
  });

  const search = Effect.fn("MemoryService.search")((input: SearchMemoryInput) => {
    return searchEnhanced({ ...input, strategy: "dense-v1" }).pipe(
      Effect.map((result) => result.results),
    );
  });

  const searchEnhanced = Effect.fn("MemoryService.searchEnhanced")((input: SearchMemoryInput) => {
    const now = input.now ?? new Date();
    return Effect.tryPromise({
      catch: (cause) => memorySearchFailure(cause, input.organizationId),
      try: async (): Promise<EnhancedMemorySearchResult> => {
        const placement = await resolvePlacement(input.organizationId);
        const provider = input.targetId
          ? [...placement.writes, ...(placement.candidate ? [placement.candidate] : [])].find(
              (candidate) => candidate.target.targetId === input.targetId,
            )
          : placement.read;
        if (!provider) {
          throw new MemoryIndexingError({
            cause: input.targetId,
            memoryId: input.organizationId,
            message: "Memory search target override is not authorized by placement.",
          });
        }
        const providerDenseLimit =
          input.denseCandidateLimit ?? provider.capabilities.denseResultLimit;
        const resultLimit = input.resultLimit ?? input.topK;
        if (providerDenseLimit !== undefined && resultLimit > providerDenseLimit) {
          throw new MemoryIndexingError({
            cause: { providerId: provider.providerId, providerDenseLimit, resultLimit },
            memoryId: input.organizationId,
            message: `${provider.providerId} supports at most ${providerDenseLimit} memory search results.`,
          });
        }
        const candidateBudget =
          input.resultLimit === undefined
            ? Math.max(input.topK, Math.min(input.topK * 3, 100))
            : Math.max(input.topK, resultLimit);
        const denseCandidateTopK = Math.min(candidateBudget, providerDenseLimit ?? candidateBudget);
        const lexicalCandidateTopK = Math.min(input.lexicalCandidateLimit ?? candidateBudget, 100);
        const fusionCandidateTopK = Math.min(
          Math.max(resultLimit, input.fusionCandidateLimit ?? candidateBudget),
          100,
        );
        const query: MemorySearchQueryInput = {
          allowedScopeKeys: input.allowedScopeKeys,
          allowedSensitivities: input.allowedSensitivities,
          ...(input.authorizationGroups ? { authorizationGroups: input.authorizationGroups } : {}),
          embedding: input.embedding,
          environmentId: input.environmentId,
          memorySpaceIds: input.memorySpaceIds,
          now,
          organizationId: input.organizationId,
          projectId: input.projectId,
          searchKeys: input.searchKeys,
          ...(input.signal ? { signal: input.signal } : {}),
          topK: denseCandidateTopK,
        };
        const requestedStrategy = input.strategy ?? "dense-v1";
        const actualStrategy = requestedStrategy;
        if (requestedStrategy !== "dense-v1" && !provider.queryLexical) {
          throw new MemoryIndexingError({
            cause: {
              lexicalQueryAvailable: false,
              providerId: provider.providerId,
            },
            memoryId: input.organizationId,
            message: "Memory search provider is not ready for the requested hybrid strategy.",
          });
        }
        if (input.denseAnnControl && input.denseExactControl) {
          throw new MemoryIndexingError({
            cause: { denseAnnControl: true, denseExactControl: true },
            memoryId: input.organizationId,
            message: "Memory search accepts only one dense control per request.",
          });
        }
        if (input.denseAnnControl && !provider.queryDenseAnn) {
          throw new MemoryIndexingError({
            cause: { providerId: provider.providerId },
            memoryId: input.organizationId,
            message: "Memory search provider does not support isolated ANN control queries.",
          });
        }
        if (input.denseExactControl && !provider.queryDenseExact) {
          throw new MemoryIndexingError({
            cause: { providerId: provider.providerId },
            memoryId: input.organizationId,
            message: "Memory search provider does not support exact dense control queries.",
          });
        }
        const readinessPromise =
          requestedStrategy === "dense-v1"
            ? undefined
            : readinessCache.read(provider, input.organizationId, input.signal);
        const densePromise = input.denseAnnControl
          ? provider.queryDenseAnn!(query)
          : input.denseExactControl
            ? provider.queryDenseExact!(query)
            : provider.query(query);
        if (actualStrategy === "dense-v1") {
          let rows: readonly MemorySearchCandidateRow[];
          try {
            rows = await densePromise;
          } catch (cause) {
            readinessCache.invalidate(provider, input.organizationId);
            throw cause;
          }
          const canonical = await mapConcurrentOrdered(
            rows.slice(0, fusionCandidateTopK),
            CANONICAL_READ_CONCURRENCY,
            async (row, index) => {
              if (input.signal?.aborted) throw input.signal.reason;
              const memory = await withAbort(
                Effect.runPromise(repository.getMemory(input, row.id as Ulid)),
                input.signal,
              );
              return memory && matchesAuthorization(memory, row, input, now)
                ? {
                    ...denseTelemetryFields(row),
                    memory,
                    rank: index + 1,
                    score: 1 - (row.dist ?? 1),
                  }
                : undefined;
            },
          );
          const results = canonical.filter(
            (result): result is MemorySearchResult => result !== undefined,
          );
          return {
            candidateCount: rows.length,
            canonicalDropCount: canonical.length - results.length,
            counts: {
              dense: rows.length,
              denseOpenSearch: openSearchCandidateCount(rows),
              entity: 0,
              exact: 0,
              lexical: 0,
            },
            results,
            strategy: "dense-v1",
          };
        }
        const common = {
          allowedScopeKeys: input.allowedScopeKeys,
          allowedSensitivities: input.allowedSensitivities,
          ...(input.authorizationGroups ? { authorizationGroups: input.authorizationGroups } : {}),
          environmentId: input.environmentId,
          memorySpaceIds: input.memorySpaceIds,
          now,
          organizationId: input.organizationId,
          projectId: input.projectId,
          searchKeys: input.searchKeys,
          ...(input.signal ? { signal: input.signal } : {}),
          topK: lexicalCandidateTopK,
        };
        let denseRows: readonly MemorySearchCandidateRow[];
        let lexicalRows: readonly MemorySearchCandidateRow[];
        let memoryIdRows: readonly MemorySearchCandidateRow[];
        let searchKeyRows: readonly MemorySearchCandidateRow[];
        let entityRows: readonly MemorySearchCandidateRow[];
        const providerQueries = Promise.all([
          densePromise,
          provider.queryLexical!({ ...common, query: input.query ?? "" }),
          provider.queryExact && input.exactMemoryIds?.length
            ? provider.queryExact({ ...common, memoryIds: input.exactMemoryIds })
            : [],
          provider.queryExact && input.exactSearchKeys?.length
            ? provider.queryExact({ ...common, exactSearchKeys: input.exactSearchKeys })
            : [],
          provider.queryExact && input.entityKeys?.length
            ? provider.queryExact({ ...common, entityKeys: input.entityKeys })
            : [],
        ]);
        void providerQueries.catch(() => undefined);
        try {
          const readiness = await readinessPromise!;
          if (!readiness?.ready) {
            throw new MemoryIndexingError({
              cause: {
                lexicalQueryAvailable: true,
                providerId: provider.providerId,
                readiness,
              },
              memoryId: input.organizationId,
              message: "Memory search provider is not ready for the requested hybrid strategy.",
            });
          }
          [denseRows, lexicalRows, memoryIdRows, searchKeyRows, entityRows] = await providerQueries;
        } catch (cause) {
          readinessCache.invalidate(provider, input.organizationId);
          throw cause;
        }
        const source = (
          rows: readonly MemorySearchCandidateRow[],
          candidateSource: MemoryCandidate["source"],
        ): MemoryCandidate[] =>
          rows.map((row, index) => ({ row, source: candidateSource, sourceRank: index + 1 }));
        const fused = reciprocalRankFusion([
          source(denseRows, "dense"),
          source(lexicalRows, "lexical"),
          source(memoryIdRows, "memory-id"),
          source(searchKeyRows, "search-key"),
          source(entityRows, "entity"),
        ]);
        const canonical = await mapConcurrentOrdered(
          fused.slice(0, fusionCandidateTopK),
          CANONICAL_READ_CONCURRENCY,
          async (candidate) => {
            if (input.signal?.aborted) throw input.signal.reason;
            const memory = await withAbort(
              Effect.runPromise(repository.getMemory(input, candidate.row.id as Ulid)),
              input.signal,
            );
            return memory && matchesAuthorization(memory, candidate.row, input, now)
              ? { candidate, memory }
              : undefined;
          },
        );
        const results = canonical
          .filter(
            (
              result,
            ): result is {
              readonly candidate: FusedMemoryCandidate;
              readonly memory: CanonicalMemoryRecord;
            } => result !== undefined,
          )
          .map(
            (result, index): MemorySearchResult => ({
              ...denseTelemetryFields(result.candidate.row),
              fusedRank: result.candidate.fusedRank,
              fusedScore: result.candidate.fusedScore,
              memory: result.memory,
              rank: index + 1,
              score: result.candidate.fusedScore,
              sourceRanks: result.candidate.sourceRanks,
              sourceScores: result.candidate.sourceScores,
            }),
          );
        return {
          candidateCount: fused.length,
          canonicalDropCount: canonical.length - results.length,
          counts: {
            dense: denseRows.length,
            denseOpenSearch: openSearchCandidateCount(denseRows),
            entity: entityRows.length,
            exact: memoryIdRows.length + searchKeyRows.length,
            lexical: lexicalRows.length,
          },
          results,
          strategy: actualStrategy,
        };
      },
    });
  });

  return { index, search, searchEnhanced };
}

export type MemoryService = ReturnType<typeof makeMemoryService>;
