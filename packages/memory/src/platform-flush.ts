import {
  MemoryFlushRecord,
  withCanonicalRecordKeys,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import { type MemoryReviewMode, type MemoryScope } from "./governance.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import type { MemoryPlatformSpaces } from "./platform-spaces.ts";
import type { MemoryPlatformRun } from "./platform-run.ts";
import { customerRun } from "./platform-run-subject.ts";
export function makeMemoryPlatformFlush(
  runtime: Shared.MemoryPlatformRuntime &
    MemoryPlatformCore &
    MemoryPlatformSpaces &
    MemoryPlatformRun,
) {
  const {
    database,
    generateId,
    now,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    requiredMutableSpace,
    memoryAccessForResolvedRun,
    agentReleaseForRun,
    requiredSpace,
  } = runtime;

  async function enqueueFlush(
    scope: Types.MemoryPlatformScope,
    run: Types.Run,
    input: {
      readonly checkpointMode?: "auto" | "off";
      readonly idempotencyKey?: string;
      readonly memoryMode?: MemoryScope | "off";
      readonly memorySpaceId?: Ulid;
      readonly modelId?: string;
      readonly reviewMode?: MemoryReviewMode;
    } = {},
  ) {
    if (!Shared.mutationScopeMatches(run, scope)) {
      throw new Types.MemoryPlatformError(404, "run_not_found", "Types.Run was not found.");
    }
    // Preview recall is read-only and evaluation runs never touch memory, so neither may flush.
    customerRun(run);
    if (
      run.data.status !== "canceled" &&
      run.data.status !== "completed" &&
      run.data.status !== "failed"
    ) {
      throw new Types.MemoryPlatformError(
        409,
        "run_not_terminal",
        "Memory flushes can only be queued for terminal runs.",
      );
    }
    const memoryMode = input.memoryMode ?? (run.data.workspaceId ? "workspace" : "organization");
    if (scope.exactWorkspaceMutations && memoryMode === "organization") {
      throw new Types.MemoryPlatformError(
        403,
        "workspace_scope_conflict",
        "Workspace-scoped credentials cannot enqueue organization memory flushes.",
      );
    }
    if (memoryMode === "workspace" && !run.data.workspaceId) {
      throw new Types.MemoryPlatformError(
        409,
        "workspace_required",
        "Workspace memory flushes require a run with workspaceId.",
      );
    }
    let memorySpaceId: Ulid | undefined;
    if (memoryMode !== "off") {
      const requestedSpace = input.memorySpaceId
        ? await requiredMutableSpace(scope, input.memorySpaceId)
        : undefined;
      if (requestedSpace?.data.status !== undefined && requestedSpace.data.status !== "active") {
        throw new Types.MemoryPlatformError(
          409,
          "memory_space_archived",
          "Memory space is archived.",
        );
      }
      const access = await memoryAccessForResolvedRun(scope, run, memoryMode);
      if (input.memorySpaceId && !access.writeMemorySpaceIds.includes(input.memorySpaceId)) {
        throw new Types.MemoryPlatformError(
          403,
          "memory_space_write_forbidden",
          "The run agent does not have write access to the requested memory space.",
        );
      }
      const selectedSpace = Shared.writableMemorySpaceForScope(
        access,
        memoryMode,
        input.memorySpaceId,
      );
      if (input.memorySpaceId && !selectedSpace) {
        throw new Types.MemoryPlatformError(
          409,
          "memory_space_scope_mismatch",
          "The requested memory space is not compatible with the flush memory mode.",
        );
      }
      memorySpaceId = selectedSpace?.id;
      if (!memorySpaceId) {
        throw new Types.MemoryPlatformError(
          409,
          "memory_space_required",
          "A writable memory space compatible with the flush memory mode is required before scheduling a flush.",
        );
      }
    }
    // Omitted settings mean the run agent's own configuration, resolved exactly as
    // the automatic completed-run flush resolves them, so identical intents share
    // one flush identity instead of conflicting with it.
    const manifest =
      input.checkpointMode && input.reviewMode && input.modelId?.trim()
        ? undefined
        : (await agentReleaseForRun(scope, run)).data.manifest;
    const checkpointMode =
      input.checkpointMode ?? manifest?.spec.runtime?.contextCheckpointMode ?? "off";
    const reviewMode =
      input.reviewMode ??
      manifest?.spec.memory?.reviewMode ??
      // A workspace's default space exists for workspace memory to work without setup, so its
      // generated memories are approved unless the agent's manifest asks for review.
      (memoryMode === "workspace" &&
      memorySpaceId &&
      (await requiredSpace(scope, memorySpaceId)).data.isDefault === true
        ? "auto-approve"
        : "manual");
    const modelId = input.modelId?.trim() || manifest!.spec.model.id;
    const requestIdempotencyKey = input.idempotencyKey?.trim();
    const expectedCommandHash = Shared.commandHash({
      checkpointMode,
      memoryMode,
      memorySpaceId,
      modelId,
      operation: "memory-flush.enqueue",
      reviewMode,
      runId: run.data.id,
    });
    const requestReplay = await idempotencyReplay(
      scope,
      requestIdempotencyKey,
      expectedCommandHash,
    );
    const idempotencyKey = `memory-flush:${run.data.id}`;
    let existing = await Shared.loadRecord(
      database,
      "execution",
      Shared.memoryFlushKey(scope, run.data.id, idempotencyKey),
      "memory-flush",
    );
    if (
      requestReplay?.[0] &&
      existing &&
      existing.data.status !== "failed" &&
      Shared.scopeMatches(existing, scope)
    ) {
      return existing;
    }
    const shouldRecordRequest = requestIdempotencyKey !== undefined && requestReplay === undefined;
    const conflictingRequest = (flush: Types.MemoryFlush) =>
      flush.data.checkpointMode !== checkpointMode ||
      flush.data.memoryMode !== memoryMode ||
      flush.data.memorySpaceId !== memorySpaceId ||
      flush.data.modelId !== modelId ||
      (flush.data.reviewMode ?? "manual") !== reviewMode;
    if (existing && existing.data.status !== "failed" && conflictingRequest(existing)) {
      throw new Types.MemoryPlatformError(
        409,
        "flush_request_conflict",
        "A different memory flush request already exists for this run.",
      );
    }
    if (existing && existing.data.status !== "failed") {
      if (shouldRecordRequest) {
        const timestampDate = now();
        try {
          await transactWithSemanticEvents(
            database,
            [
              {
                conditionExpression: "#data.#version = :version AND #itemType = :itemType",
                expressionAttributeNames: {
                  "#data": "data",
                  "#itemType": "itemType",
                  "#version": "version",
                },
                expressionAttributeValues: {
                  ":itemType": "memory-flush",
                  ":version": existing.data.version,
                },
                key: { pk: existing.pk, sk: existing.sk },
                kind: "condition-check",
                table: "execution",
              },
              idempotencyOperation(
                completedIdempotency({
                  commandHash: expectedCommandHash,
                  idempotencyKey: requestIdempotencyKey,
                  resourceIds: [existing.data.id],
                  scope,
                  timestamp: timestampDate,
                }),
              ),
            ],
            [],
          );
        } catch (cause) {
          const concurrentReplay = await idempotencyReplay(
            scope,
            requestIdempotencyKey,
            expectedCommandHash,
          );
          if (!concurrentReplay?.[0]) throw cause;
          existing =
            (await Shared.loadRecord(
              database,
              "execution",
              Shared.memoryFlushKey(scope, run.data.id, idempotencyKey),
              "memory-flush",
            )) ?? existing;
        }
      }
      return existing;
    }
    if (existing) {
      const {
        candidateCount: _candidateCount,
        candidateKeys: _candidateKeys,
        checkpointCompleted: _checkpointCompleted,
        checkpointId: _checkpointId,
        checkpointMode: _checkpointMode,
        completedAt: _completedAt,
        completionModelId: _completionModelId,
        error: _error,
        leaseExpiresAt: _leaseExpiresAt,
        leaseOwner: _leaseOwner,
        memoryMode: _memoryMode,
        memorySpaceId: _memorySpaceId,
        modelId: _modelId,
        rejectedCount: _rejectedCount,
        reviewMode: _reviewMode,
        startedAt: _startedAt,
        ...flushData
      } = existing.data;
      const timestampDate = now();
      const timestamp = Shared.iso(timestampDate);
      const requeued = Shared.record(
        MemoryFlushRecord,
        withCanonicalRecordKeys({
          data: {
            ...flushData,
            memoryIds: [],
            checkpointMode,
            memoryMode,
            ...(memorySpaceId ? { memorySpaceId } : {}),
            ...(modelId ? { modelId } : {}),
            reviewMode,
            status: "queued" as const,
            updatedAt: timestamp,
            version: existing.data.version + 1,
          },
          itemType: "memory-flush" as const,
        }),
      );
      const event = await eventFor({
        aggregateId: requeued.data.id,
        aggregateType: "memory-flush",
        aggregateVersion: requeued.data.version + 1,
        eventType: "memory.flush.queued",
        payload: {
          idempotencyKey,
          checkpointMode,
          memoryMode,
          ...(memorySpaceId ? { memorySpaceId } : {}),
          ...(modelId ? { modelId } : {}),
          reviewMode,
          runId: run.data.id,
          threadId: run.data.threadId,
        },
        scope,
      });
      const operations: TransactionOperation[] = [
        { kind: "put", previousRecord: existing, record: requeued },
      ];
      if (shouldRecordRequest) {
        operations.push(
          idempotencyOperation(
            completedIdempotency({
              commandHash: expectedCommandHash,
              idempotencyKey: requestIdempotencyKey,
              resourceIds: [requeued.data.id],
              scope,
              timestamp: timestampDate,
            }),
          ),
        );
      }
      await transactWithSemanticEvents(database, operations, [event]);
      return requeued;
    }
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    const flush = Shared.record(
      MemoryFlushRecord,
      withCanonicalRecordKeys({
        data: {
          attempt: 0,
          createdAt: timestamp,
          environmentId: scope.environmentId,
          id: await generateId(),
          idempotencyKey,
          checkpointMode,
          memoryMode,
          memoryIds: [],
          ...(memorySpaceId ? { memorySpaceId } : {}),
          ...(modelId ? { modelId } : {}),
          reviewMode,
          observability: {
            captureMode: run.data.captureMode,
            ...(run.data.parentSpanId ? { parentSpanId: run.data.parentSpanId } : {}),
            runSpanId: run.data.spanId,
            sessionId: run.data.threadId,
            traceId: run.data.traceId,
            ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
          },
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          runId: run.data.id,
          status: "queued" as const,
          threadId: run.data.threadId,
          updatedAt: timestamp,
          version: 0,
        },
        itemType: "memory-flush" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: flush.data.id,
      aggregateType: "memory-flush",
      aggregateVersion: 1,
      eventType: "memory.flush.queued",
      payload: {
        idempotencyKey,
        checkpointMode,
        memoryMode,
        ...(memorySpaceId ? { memorySpaceId } : {}),
        ...(modelId ? { modelId } : {}),
        reviewMode,
        runId: run.data.id,
        threadId: run.data.threadId,
      },
      scope,
    });
    try {
      const operations: TransactionOperation[] = [
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: flush,
        },
      ];
      if (shouldRecordRequest) {
        operations.push(
          idempotencyOperation(
            completedIdempotency({
              commandHash: expectedCommandHash,
              idempotencyKey: requestIdempotencyKey,
              resourceIds: [flush.data.id],
              scope,
              timestamp: timestampDate,
            }),
          ),
        );
      }
      await transactWithSemanticEvents(database, operations, [event]);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(
        scope,
        requestIdempotencyKey,
        expectedCommandHash,
      );
      if (concurrentReplay?.[0]) {
        const replayed = await Shared.loadRecord(
          database,
          "execution",
          Shared.memoryFlushKey(scope, run.data.id, idempotencyKey),
          "memory-flush",
        );
        if (replayed) return replayed;
      }
      const replay = await Shared.loadRecord(
        database,
        "execution",
        Shared.memoryFlushKey(scope, run.data.id, idempotencyKey),
        "memory-flush",
      );
      if (replay && !conflictingRequest(replay)) return replay;
      if (replay) {
        throw new Types.MemoryPlatformError(
          409,
          "flush_request_conflict",
          "A different memory flush request already exists for this run.",
        );
      }
      throw cause;
    }
    return flush;
  }

  async function requiredFlush(scope: Types.MemoryPlatformScope, runId: Ulid) {
    const flush = await Shared.loadRecord(
      database,
      "execution",
      Shared.memoryFlushKey(scope, runId, `memory-flush:${runId}`),
      "memory-flush",
    );
    if (!flush || !Shared.scopeMatches(flush, scope)) {
      throw new Types.MemoryPlatformError(404, "flush_not_found", "Memory flush was not found.");
    }
    return flush;
  }

  async function claimFlush(
    scope: Types.MemoryPlatformScope,
    runId: Ulid,
    idempotencyKey: string,
    workerId: string,
  ) {
    const previous = await Shared.loadRecord(
      database,
      "execution",
      Shared.memoryFlushKey(scope, runId, idempotencyKey),
      "memory-flush",
    );
    if (!previous || !Shared.scopeMatches(previous, scope)) {
      throw new Types.MemoryPlatformError(404, "flush_not_found", "Memory flush was not found.");
    }
    if (previous.data.status === "succeeded") return previous;
    const claimTime = now();
    const previousLeaseExpiresAt = previous.data.leaseExpiresAt
      ? Date.parse(previous.data.leaseExpiresAt)
      : Number.NaN;
    if (
      previous.data.status === "running" &&
      (!Number.isFinite(previousLeaseExpiresAt) || previousLeaseExpiresAt > claimTime.getTime())
    ) {
      throw new Types.MemoryPlatformError(
        409,
        "flush_lease_active",
        "Memory flush lease is active.",
      );
    }
    const timestamp = Shared.iso(claimTime);
    const next = Shared.record(
      MemoryFlushRecord,
      withCanonicalRecordKeys({
        data: {
          ...previous.data,
          attempt: previous.data.attempt + 1,
          leaseExpiresAt: new Date(claimTime.getTime() + Shared.FLUSH_LEASE_MS).toISOString(),
          leaseOwner: workerId,
          startedAt: timestamp,
          status: "running" as const,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
        itemType: "memory-flush" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-flush",
      aggregateVersion: next.data.version + 1,
      eventType: "memory.flush.started",
      payload: {
        attempt: next.data.attempt,
        runId: next.data.runId,
        workerId,
      },
      scope,
    });
    await transactWithSemanticEvents(
      database,
      [{ kind: "put", previousRecord: previous, record: next }],
      [event],
    );
    return next;
  }

  async function completeFlush(
    flush: Types.MemoryFlush,
    memoryIds: readonly Ulid[],
    candidateCount: number,
    rejectedCount = 0,
    candidateKeys: readonly string[] = [],
    checkpointId?: Ulid,
    completionModelId?: string,
  ) {
    const timestamp = Shared.iso(now());
    const {
      candidateCount: _candidateCount,
      candidateKeys: _candidateKeys,
      checkpointCompleted: _checkpointCompleted,
      checkpointId: _checkpointId,
      error: _error,
      leaseExpiresAt: _leaseExpiresAt,
      leaseOwner: _leaseOwner,
      memoryIds: _memoryIds,
      rejectedCount: _rejectedCount,
      ...flushData
    } = flush.data;
    const next = Shared.record(
      MemoryFlushRecord,
      withCanonicalRecordKeys({
        data: {
          ...flushData,
          candidateCount,
          ...(candidateKeys.length > 0 ? { candidateKeys: [...candidateKeys] } : {}),
          checkpointCompleted: true,
          ...(checkpointId ? { checkpointId } : {}),
          ...(completionModelId ? { completionModelId } : {}),
          completedAt: timestamp,
          memoryIds: [...memoryIds],
          ...(rejectedCount > 0 ? { rejectedCount } : {}),
          status: "succeeded" as const,
          updatedAt: timestamp,
          version: flush.data.version + 1,
        },
        itemType: "memory-flush" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-flush",
      aggregateVersion: next.data.version + 1,
      eventType: "memory.flush.succeeded",
      payload: {
        candidateCount,
        ...(checkpointId ? { checkpointId } : {}),
        memoryCount: memoryIds.length,
        rejectedCount,
        runId: next.data.runId,
      },
      scope: {
        environmentId: next.data.environmentId,
        organizationId: next.data.organizationId,
        projectId: next.data.projectId,
      },
    });
    await transactWithSemanticEvents(
      database,
      [{ kind: "put", previousRecord: flush, record: next }],
      [event],
    );
    return next;
  }

  async function failFlush(
    flush: Types.MemoryFlush,
    cause: unknown,
    progress?: {
      readonly candidateKeys: readonly string[];
      readonly checkpointCompleted?: boolean;
      readonly checkpointId?: Ulid;
      readonly completionModelId?: string;
      readonly memoryIds: readonly Ulid[];
      readonly rejectedCount: number;
    },
  ) {
    const timestamp = Shared.iso(now());
    const {
      completedAt: _completedAt,
      leaseExpiresAt: _leaseExpiresAt,
      leaseOwner: _leaseOwner,
      ...flushData
    } = flush.data;
    const next = Shared.record(
      MemoryFlushRecord,
      withCanonicalRecordKeys({
        data: {
          ...flushData,
          error: cause instanceof Error ? cause.message.slice(0, 2_000) : "Memory flush failed.",
          ...(progress
            ? {
                candidateCount: progress.candidateKeys.length,
                candidateKeys: [...progress.candidateKeys],
                ...(progress.checkpointCompleted !== undefined
                  ? { checkpointCompleted: progress.checkpointCompleted }
                  : {}),
                ...(progress.checkpointId ? { checkpointId: progress.checkpointId } : {}),
                ...(progress.completionModelId
                  ? { completionModelId: progress.completionModelId }
                  : {}),
                memoryIds: [...progress.memoryIds],
                rejectedCount: progress.rejectedCount,
              }
            : {}),
          status: "failed" as const,
          updatedAt: timestamp,
          version: flush.data.version + 1,
        },
        itemType: "memory-flush" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-flush",
      aggregateVersion: next.data.version + 1,
      eventType: "memory.flush.failed",
      payload: {
        attempt: next.data.attempt,
        runId: next.data.runId,
      },
      scope: {
        environmentId: next.data.environmentId,
        organizationId: next.data.organizationId,
        projectId: next.data.projectId,
      },
    });
    await transactWithSemanticEvents(
      database,
      [{ kind: "put", previousRecord: flush, record: next }],
      [event],
    );
    return next;
  }

  return {
    enqueueFlush,
    requiredFlush,
    claimFlush,
    completeFlush,
    failFlush,
  };
}
