import {
  MemoryIndexJobRecord,
  withCanonicalRecordKeys,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import { randomUUID } from "node:crypto";
import { memoryContentMatchesHash, memoryRecallBlockedReason } from "./governance.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import { MemoryIndexingError, MemoryIndexJobSuperseded } from "./service.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import type { MemoryPlatformSpaces } from "./platform-spaces.ts";
import { memorySearchPlacementResolver } from "./provider.ts";
import {
  INDEX_MAX_ATTEMPTS,
  indexFailureOutcome,
  isIndexConfigurationFailure,
  isIndexRetryPending,
  isTerminalIndexJob,
} from "./index-retry-policy.ts";
import {
  acquireMemoryIndexMutationClaim,
  currentMemoryIndexAdmissionClaim,
  prepareIndexJobClaimAdmission,
  prepareMemoryIndexAdmissionResolution,
  providerMutationSignal,
  resolveMemoryProviderMutationClaim,
  type MemoryProviderMutationClaim,
} from "./provider-mutation-claim.ts";
export function makeMemoryPlatformIndexing(
  runtime: Shared.MemoryPlatformRuntime & MemoryPlatformCore & MemoryPlatformSpaces,
) {
  const {
    database,
    dependencies,
    now,
    repository,
    searchService,
    eventFor,
    loadReferencedText,
    requiredMemory,
    effectivePolicy,
  } = runtime;

  async function claimIndexJob(
    scope: Types.MemoryPlatformScope,
    memoryId: Ulid,
    idempotencyKey: string,
    workerId: string,
    targetId?: Ulid,
  ) {
    let resolvedIdempotencyKey = idempotencyKey;
    let previous = await Shared.loadRecord(
      database,
      "execution",
      Shared.memoryJobKey(scope, memoryId, idempotencyKey),
      "memory-index-job",
    );
    if (!previous && idempotencyKey.split(":").length === 4) {
      const resolvePlacement =
        dependencies.searchRoutingResolver ?? memorySearchPlacementResolver(dependencies);
      const placement = await resolvePlacement(scope.organizationId);
      for (const provider of placement.writes) {
        const candidateKey = `${provider.target.targetId}:${idempotencyKey}`;
        previous = await Shared.loadRecord(
          database,
          "execution",
          Shared.memoryJobKey(scope, memoryId, candidateKey, provider.target.targetId),
          "memory-index-job",
        );
        if (previous) {
          resolvedIdempotencyKey = candidateKey;
          break;
        }
      }
    }
    if (!previous || !Shared.scopeMatches(previous, scope)) {
      throw new Types.MemoryPlatformError(
        404,
        "index_job_not_found",
        "Memory index job was not found.",
      );
    }
    if (previous.data.idempotencyKey !== resolvedIdempotencyKey) {
      throw new Types.MemoryPlatformError(
        409,
        "index_job_identity_mismatch",
        "Memory index job identity does not match the requested queue operation.",
      );
    }
    if (targetId && previous.data.targetId !== targetId) {
      throw new Types.MemoryPlatformError(
        409,
        "index_job_target_mismatch",
        "Memory index queue target does not match the persisted job.",
      );
    }
    const claimTime = now();
    if (isTerminalIndexJob(previous) || isIndexRetryPending(previous, claimTime)) {
      return previous;
    }
    const previousLeaseExpiresAt = previous.data.leaseExpiresAt
      ? Date.parse(previous.data.leaseExpiresAt)
      : Number.NaN;
    if (
      previous.data.status === "running" &&
      (!Number.isFinite(previousLeaseExpiresAt) || previousLeaseExpiresAt > claimTime.getTime())
    ) {
      throw new Types.MemoryPlatformError(
        409,
        "index_job_lease_active",
        "Memory index job lease is active.",
      );
    }
    if (previous.data.status === "running" && previous.data.attempt >= INDEX_MAX_ATTEMPTS) {
      return failIndexJob(
        previous,
        new Error("Memory index job lease expired during its final attempt."),
      );
    }
    const timestamp = Shared.iso(claimTime);
    const leaseExpiresAt = new Date(claimTime.getTime() + Shared.INDEX_LEASE_MS).toISOString();
    const eventVersion = (await Shared.memoryIndexJobEventVersion(database, previous)) + 1;
    const { nextDueAt: _nextDueAt, retryAt: _retryAt, ...previousData } = previous.data;
    const next = Shared.record(
      MemoryIndexJobRecord,
      withCanonicalRecordKeys({
        data: {
          ...previousData,
          acknowledgement: workerId,
          attempt: previous.data.attempt + 1,
          eventVersion,
          leaseExpiresAt,
          leaseOwner: workerId,
          nextDueAt: leaseExpiresAt,
          startedAt: timestamp,
          status: "running" as const,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
        itemType: "memory-index-job" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-index-job",
      aggregateVersion: eventVersion,
      eventType: "memory.index.started",
      payload: { attempt: next.data.attempt, memoryId, workerId },
      scope,
    });
    const jobTargetId = previous.data.targetId;
    const durableRouting = jobTargetId
      ? (dependencies.searchRoutingResolver ?? dependencies.searchPlacementResolver)
      : undefined;
    if (durableRouting) {
      // A job queued without durable admission for a target the organization no longer routes can
      // never be admitted (that target has no open gate); it ends here instead of retrying forever.
      const routing = await durableRouting(scope.organizationId);
      const routed = [...routing.writes, ...(routing.candidate ? [routing.candidate] : [])].some(
        (provider) => provider.target.targetId === jobTargetId,
      );
      if (!routed) return await retireIndexJob(previous);
    }
    const admissionOperations = durableRouting
      ? await prepareIndexJobClaimAdmission(database, previous, claimTime)
      : [];
    await transactWithSemanticEvents(
      database,
      [...admissionOperations, { kind: "put", previousRecord: previous, record: next }],
      [event],
    );
    return next;
  }

  async function succeedIndexJob(
    job: Types.MemoryIndexJob,
    admissionOperations: readonly TransactionOperation[],
    skipReason?: string,
  ) {
    const timestamp = Shared.iso(now());
    const eventVersion = (await Shared.memoryIndexJobEventVersion(database, job)) + 1;
    const {
      error: _error,
      leaseExpiresAt: _leaseExpiresAt,
      leaseOwner: _leaseOwner,
      nextDueAt: _nextDueAt,
      skipReason: _skipReason,
      ...jobData
    } = job.data;
    const next = Shared.record(
      MemoryIndexJobRecord,
      withCanonicalRecordKeys({
        data: {
          ...jobData,
          completedAt: timestamp,
          eventVersion,
          ...(skipReason ? { skipReason } : {}),
          status: "succeeded" as const,
          updatedAt: timestamp,
          version: job.data.version + 1,
        },
        itemType: "memory-index-job" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-index-job",
      aggregateVersion: eventVersion,
      eventType: "memory.index.succeeded",
      payload: {
        memoryId: next.data.memoryId,
        ...(skipReason ? { skipReason } : {}),
      },
      scope: {
        environmentId: next.data.environmentId,
        organizationId: next.data.organizationId,
        projectId: next.data.projectId,
      },
    });
    await transactWithSemanticEvents(
      database,
      [...admissionOperations, { kind: "put", previousRecord: job, record: next }],
      [event],
    );
    return next;
  }

  async function completeIndexJob(job: Types.MemoryIndexJob, skipReason?: string) {
    if (job.data.status !== "running") return job;
    const admissionResolution =
      job.data.targetId &&
      (dependencies.searchRoutingResolver || dependencies.searchPlacementResolver)
        ? await prepareMemoryIndexAdmissionResolution(database, job)
        : undefined;
    return await succeedIndexJob(job, admissionResolution ? [admissionResolution] : [], skipReason);
  }

  async function retireIndexJob(job: Types.MemoryIndexJob) {
    const admission = await currentMemoryIndexAdmissionClaim(database, job);
    return await succeedIndexJob(
      job,
      admission ? [{ kind: "delete", record: admission }] : [],
      "retired-search-target",
    );
  }

  async function failIndexJob(
    job: Types.MemoryIndexJob,
    cause: unknown,
    options: { readonly configurationFailure?: boolean } = {},
  ) {
    const timestamp = Shared.iso(now());
    const eventVersion = (await Shared.memoryIndexJobEventVersion(database, job)) + 1;
    const {
      completedAt: _completedAt,
      leaseExpiresAt: _leaseExpiresAt,
      leaseOwner: _leaseOwner,
      nextDueAt: _nextDueAt,
      retryAt: _retryAt,
      skipReason: _skipReason,
      ...jobData
    } = job.data;
    const outcome = indexFailureOutcome(job, options.configurationFailure === true);
    const retryAt =
      "retryAfterMs" in outcome
        ? new Date(Date.parse(timestamp) + outcome.retryAfterMs).toISOString()
        : undefined;
    const skipReason = "skipReason" in outcome ? outcome.skipReason : undefined;
    const next = Shared.record(
      MemoryIndexJobRecord,
      withCanonicalRecordKeys({
        data: {
          ...jobData,
          error: cause instanceof Error ? cause.message.slice(0, 2_000) : "Memory indexing failed.",
          eventVersion,
          ...(retryAt ? { nextDueAt: retryAt, retryAt } : skipReason ? { skipReason } : {}),
          status: "failed" as const,
          updatedAt: timestamp,
          version: job.data.version + 1,
        },
        itemType: "memory-index-job" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-index-job",
      aggregateVersion: eventVersion,
      eventType: "memory.index.failed",
      payload: {
        attempt: next.data.attempt,
        memoryId: next.data.memoryId,
        ...(skipReason ? { skipReason } : {}),
      },
      scope: {
        environmentId: next.data.environmentId,
        organizationId: next.data.organizationId,
        projectId: next.data.projectId,
      },
    });
    const admissionResolution =
      job.data.targetId &&
      (dependencies.searchRoutingResolver || dependencies.searchPlacementResolver)
        ? await prepareMemoryIndexAdmissionResolution(database, job)
        : undefined;
    await transactWithSemanticEvents(
      database,
      [
        ...(admissionResolution ? [admissionResolution] : []),
        { kind: "put", previousRecord: job, record: next },
      ],
      [event],
    );
    return next;
  }

  async function processIndexJob(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly idempotencyKey: string;
      readonly memoryId: Ulid;
      readonly targetId?: Ulid;
      readonly workerId?: string;
    },
  ) {
    const job = await claimIndexJob(
      scope,
      input.memoryId,
      input.idempotencyKey,
      input.workerId ?? randomUUID(),
      input.targetId,
    );
    if (job.data.status !== "running") return job;
    let mutationClaim: MemoryProviderMutationClaim | undefined;
    let configurationFailure = false;
    const classifyTargetResolutionFailure = (cause: unknown): never => {
      configurationFailure = isIndexConfigurationFailure(cause);
      throw cause;
    };
    try {
      if (job.data.targetId && dependencies.searchRoutingResolver) {
        const routing = await dependencies
          .searchRoutingResolver(scope.organizationId)
          .catch(classifyTargetResolutionFailure);
        const mutationTargets = [
          ...routing.writes,
          ...(routing.candidate ? [routing.candidate] : []),
        ];
        if (!mutationTargets.some((provider) => provider.target.targetId === job.data.targetId)) {
          return await completeIndexJob(job, "retired-search-target");
        }
      }
      const memory = await requiredMemory(scope, input.memoryId);
      if (memory.data.contentHash !== job.data.expectedContentHash) {
        return await completeIndexJob(job, "stale-content-hash");
      }
      if (memory.data.version !== job.data.expectedMemoryVersion) {
        return await completeIndexJob(job, "stale-memory-version");
      }
      const currentIndexState = await Shared.effectValue(
        repository.getIndexState(scope, memory.data.id, job.data.targetId),
      );
      if (
        currentIndexState &&
        (currentIndexState.data.synchronizedVersion > job.data.expectedMemoryVersion ||
          (currentIndexState.data.synchronizedVersion === job.data.expectedMemoryVersion &&
            currentIndexState.data.synchronizationGeneration > job.data.synchronizationGeneration))
      ) {
        return await completeIndexJob(job, "superseded-index-state");
      }
      const policyScope = Shared.memoryOwnedScope(scope, memory.data.workspaceId);
      const policy = await effectivePolicy(policyScope);
      const space = await Shared.loadRecord(
        database,
        "control",
        Shared.memorySpaceKey(policyScope, memory.data.memorySpaceId),
        "memory-space",
      );
      if (space && !Shared.scopeMatches(space, policyScope)) {
        throw new Types.MemoryPlatformError(
          404,
          "memory_space_not_found",
          "Memory space was not found.",
        );
      }
      const memorySpaceActive = space?.data.status === "active";
      let allowedSensitivities = memorySpaceActive
        ? Shared.sensitivityModeValues(Shared.reconciledPolicyFields(policy).sensitivityMode)
        : [];
      const currentTime = now();
      let searchable =
        memorySpaceActive &&
        memory.data.status === "active" &&
        memory.data.reviewStatus === "approved" &&
        allowedSensitivities.includes(memory.data.sensitivity) &&
        (!memory.data.retentionExpiresAt ||
          memory.data.retentionExpiresAt > Shared.iso(currentTime));
      let content: string | undefined;
      let embedding: readonly number[] | undefined;
      let embeddingModel: string | undefined;
      let embeddingProvider: string | undefined;
      let completionSkipReason: string | undefined;
      if (searchable) {
        content =
          memory.data.body ??
          (memory.data.bodyRef
            ? await loadReferencedText(
                memory.data.bodyRef,
                "Memory body",
                Shared.MAX_MEMORY_BLOB_BYTES,
              )
            : undefined);
        if (!content) {
          throw new Types.MemoryPlatformError(
            409,
            "memory_body_unavailable",
            "Searchable memory body is unavailable.",
          );
        }
        const embeddingContentOversized = Shared.embeddingContentTooLarge(content);
        if (memoryRecallBlockedReason(memory.data, content) || embeddingContentOversized) {
          allowedSensitivities = [];
          searchable = false;
          content = undefined;
          completionSkipReason = embeddingContentOversized
            ? "embedding-content-too-large"
            : "unsafe-index-content";
        }
        if (
          searchable &&
          content &&
          (!memoryContentMatchesHash(content, memory.data.contentHash) ||
            (memory.data.bodyRef !== undefined &&
              !memoryContentMatchesHash(content, memory.data.bodyRef.sha256)))
        ) {
          allowedSensitivities = [];
          searchable = false;
          content = undefined;
          completionSkipReason = "memory-content-hash-mismatch";
        }
        if (searchable && content) {
          const generated = await dependencies.embedding({
            attribution: memory.data.sourceRunId
              ? { kind: "run", runId: memory.data.sourceRunId }
              : {
                  kind: "operation",
                  operationId: job.data.id,
                  operationType: "memory-index",
                },
            content,
            ...(job.data.embeddingProfileId
              ? { embeddingProfileId: job.data.embeddingProfileId }
              : {}),
            memoryId: memory.data.id,
            modelCallId: `memory-index:${job.data.id}:${memory.data.version}`,
            ...(memory.data.observability ? { observability: memory.data.observability } : {}),
            scope: policyScope,
          });
          embedding = generated.embedding;
          if (
            dependencies.searchPlacementResolver &&
            job.data.embeddingProfileId &&
            generated.embeddingProfileId !== job.data.embeddingProfileId
          ) {
            throw new Types.MemoryPlatformError(
              503,
              "memory_embedding_profile_mismatch",
              "The embedding gateway did not honor the target's immutable embedding profile.",
            );
          }
          embeddingModel = generated.model || Shared.DEFAULT_EMBEDDING_MODEL;
          embeddingProvider = generated.provider;
        }
      }
      let mutationSignal: AbortSignal | undefined;
      if (job.data.targetId && dependencies.searchPlacementResolver) {
        const placement = await dependencies
          .searchPlacementResolver(scope.organizationId)
          .catch(classifyTargetResolutionFailure);
        const provider = [
          ...placement.writes,
          ...(placement.candidate ? [placement.candidate] : []),
        ].find((candidate) => candidate.target.targetId === job.data.targetId);
        if (provider?.providerId === "aws-native") {
          mutationClaim = await acquireMemoryIndexMutationClaim({
            database,
            job,
            memoryId: memory.data.id,
            mutationTuple: [
              memory.data.version,
              job.data.synchronizationGeneration,
              searchable ? "write" : "tombstone",
              memory.data.contentHash,
            ].join(":"),
            now: currentTime,
            organizationId: scope.organizationId,
            targetId: job.data.targetId,
          });
          mutationSignal = providerMutationSignal(mutationClaim, currentTime);
        }
      }
      await Shared.effectValue(
        searchService.index({
          allowedSensitivities,
          ...(content ? { content } : {}),
          ...(embedding ? { embedding } : {}),
          ...(content ? { embeddingContentHash: memory.data.contentHash } : {}),
          ...(embeddingModel ? { embeddingModel } : {}),
          ...(embeddingProvider ? { embeddingProvider } : {}),
          environmentId: scope.environmentId,
          expectedContentHash: job.data.expectedContentHash,
          expectedMemoryVersion: job.data.expectedMemoryVersion,
          memoryId: memory.data.id,
          now: currentTime,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          ...(mutationSignal ? { signal: mutationSignal } : {}),
          ...(completionSkipReason ? { suppressionReason: completionSkipReason } : {}),
          synchronizationGeneration: job.data.synchronizationGeneration,
          ...(job.data.targetId ? { targetId: job.data.targetId } : {}),
        }),
      );
      if (mutationClaim) {
        const appliedClaim = resolveMemoryProviderMutationClaim(mutationClaim, "applied", now());
        await memoryPersistence.commit(database, [
          {
            kind: "put",
            previousRecord: mutationClaim,
            record: appliedClaim,
          },
        ]);
      }
      return await completeIndexJob(job, completionSkipReason);
    } catch (cause) {
      if (cause instanceof MemoryIndexingError && cause.cause instanceof MemoryIndexJobSuperseded) {
        if (mutationClaim) {
          const failedClaim = resolveMemoryProviderMutationClaim(mutationClaim, "failed", now());
          await memoryPersistence.commit(database, [
            {
              kind: "put",
              previousRecord: mutationClaim,
              record: failedClaim,
            },
          ]);
        }
        return await completeIndexJob(job, cause.cause.skipReason);
      }
      if (mutationClaim) {
        try {
          const ambiguousClaim = resolveMemoryProviderMutationClaim(
            mutationClaim,
            "ambiguous",
            now(),
          );
          await memoryPersistence.commit(database, [
            {
              kind: "put",
              previousRecord: mutationClaim,
              record: ambiguousClaim,
            },
          ]);
        } catch {
          // A concurrent resolution wins; unresolved claims remain visible to drain and retry.
        }
      }
      await failIndexJob(job, cause, { configurationFailure });
      throw cause;
    }
  }

  return {
    claimIndexJob,
    completeIndexJob,
    failIndexJob,
    processIndexJob,
  };
}
