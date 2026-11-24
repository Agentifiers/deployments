import {
  expiredIdempotencyReplacementCondition,
  IdempotencyRecord,
  MemoryIndexJobRecord,
  key,
  withCanonicalRecordKeys,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
  principalAuditActor,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import {
  loadMemoryBlobText,
  MemoryBlobIntegrityError,
  type MemoryBlobLoader,
  type MemoryBlobReference,
} from "./blob.ts";
import { memoryContentMatchesHash } from "./governance.ts";
import * as Claims from "./provider-mutation-claim.ts";
import { prepareSearchRoutingFence } from "./platform-routing.ts";
import { type CanonicalMemoryRecord } from "./memory-record.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
export function makeMemoryPlatformCore(runtime: Shared.MemoryPlatformRuntime) {
  const { database, dependencies, generateId, now } = runtime;
  const hasDurableRouting = !!(
    dependencies.searchRoutingResolver ?? dependencies.searchPlacementResolver
  );

  async function loadReferencedText(
    reference: Parameters<MemoryBlobLoader>[0],
    label: string,
    maxBytes: number,
  ) {
    if (!dependencies.loadBlob) {
      throw new Types.MemoryPlatformError(
        409,
        "memory_blob_loader_unavailable",
        `${label} storage is not configured.`,
      );
    }
    try {
      return await loadMemoryBlobText({
        label,
        load: dependencies.loadBlob,
        maxBytes,
        reference,
      });
    } catch (cause) {
      if (!(cause instanceof MemoryBlobIntegrityError)) {
        throw new Types.MemoryPlatformError(
          503,
          "memory_blob_load_failed",
          `${label} could not be loaded from storage.`,
          { cause },
        );
      }
      throw new Types.MemoryPlatformError(
        409,
        "memory_blob_invalid",
        cause instanceof Error ? cause.message : `${label} could not be loaded.`,
      );
    }
  }

  async function resolveMemoryContent(memory: CanonicalMemoryRecord) {
    const content =
      memory.data.body ??
      (memory.data.bodyRef
        ? await loadReferencedText(memory.data.bodyRef, "Memory body", Shared.MAX_MEMORY_BLOB_BYTES)
        : undefined);
    if (!content) {
      throw new Types.MemoryPlatformError(
        409,
        "memory_body_unavailable",
        "Memory body is unavailable.",
      );
    }
    if (
      !memoryContentMatchesHash(content, memory.data.contentHash) ||
      (memory.data.bodyRef !== undefined &&
        !memoryContentMatchesHash(content, memory.data.bodyRef.sha256))
    ) {
      throw new Types.MemoryPlatformError(
        409,
        "memory_content_hash_mismatch",
        "Memory content does not match its canonical content hash.",
      );
    }
    return content;
  }

  async function idempotencyReplay(
    scope: Types.MemoryPlatformScope,
    idempotencyKey: string | undefined,
    expectedCommandHash: string,
  ) {
    if (!idempotencyKey) return undefined;
    const existing = await Shared.loadRecord(
      database,
      "events",
      Shared.idempotencyRecordKey(scope, idempotencyKey),
      "idempotency",
    );
    if (!existing) return undefined;
    if (existing.data.expiresAt <= Shared.iso(now())) return undefined;
    if (existing.data.commandHash !== expectedCommandHash) {
      throw new Types.MemoryPlatformError(
        409,
        "idempotency_conflict",
        "The idempotency key was already used for a different memory mutation.",
      );
    }
    return existing.data.resourceIds;
  }

  function completedIdempotency(args: {
    readonly commandHash: string;
    readonly idempotencyKey: string;
    readonly resourceIds: readonly Ulid[];
    readonly scope: Types.MemoryPlatformScope;
    readonly timestamp: Date;
  }) {
    const expiresAt = new Date(args.timestamp.getTime() + Shared.IDEMPOTENCY_TTL_MS);
    return Shared.record(
      IdempotencyRecord,
      withCanonicalRecordKeys({
        data: {
          commandHash: args.commandHash,
          createdAt: Shared.iso(args.timestamp),
          expiresAt: Shared.iso(expiresAt),
          idempotencyKey: Shared.scopedIdempotencyKey(args.scope, args.idempotencyKey),
          organizationId: args.scope.organizationId,
          resourceIds: [...args.resourceIds],
          response: { resourceIds: [...args.resourceIds] },
          status: "completed" as const,
          version: 0,
        },
        itemType: "idempotency" as const,
        ttl: Math.floor(expiresAt.getTime() / 1_000),
      }),
    );
  }

  function idempotencyOperation(value: Types.Idempotency): TransactionOperation {
    return {
      ...expiredIdempotencyReplacementCondition(value),
      kind: "put",
      record: value,
      replaceExpired: true,
    };
  }

  async function eventFor(args: {
    readonly aggregateId: Ulid;
    readonly aggregateType: string;
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, boolean | number | string>>;
    readonly scope: Types.MemoryPlatformScope;
  }) {
    return makeSemanticEventRecord({
      aggregateId: args.aggregateId,
      aggregateType: args.aggregateType,
      aggregateVersion: args.aggregateVersion,
      environmentId: args.scope.environmentId,
      eventId: await generateId(),
      eventType: args.eventType,
      occurredAt: now(),
      organizationId: args.scope.organizationId,
      payload: args.payload,
      projectId: args.scope.projectId,
      ...(args.scope.principalId
        ? {
            actor: principalAuditActor(args.scope.principalId, args.scope.operatorAccessGrantId),
          }
        : {}),
    });
  }

  async function blobCleanupEvent(
    scope: Types.MemoryPlatformScope,
    reference: MemoryBlobReference,
  ) {
    const cleanupId = await generateId();
    return eventFor({
      aggregateId: cleanupId,
      aggregateType: "memory-blob-cleanup",
      aggregateVersion: 1,
      eventType: "memory.blob-cleanup.requested",
      payload: {
        blobBucket: reference.bucket,
        blobByteSize: reference.byteSize,
        blobContentType: reference.contentType,
        blobKey: reference.key,
        blobSha256: reference.sha256,
        ...(reference.versionId ? { blobVersionId: reference.versionId } : {}),
      },
      scope,
    });
  }

  async function reviewContentCleanupEvent(scope: Types.MemoryPlatformScope, memoryId: Ulid) {
    const cleanupId = await generateId();
    return eventFor({
      aggregateId: cleanupId,
      aggregateType: "memory-review-cleanup",
      aggregateVersion: 1,
      eventType: "memory.review-content-cleanup.requested",
      payload: { memoryId, operation: "review-content-cleanup" },
      scope,
    });
  }

  async function cleanupMemoryBlob(reference: MemoryBlobReference) {
    if (!dependencies.deleteBlob) {
      throw new Types.MemoryPlatformError(
        503,
        "memory_blob_delete_unavailable",
        "Referenced memory content cannot be permanently deleted by this runtime.",
      );
    }
    await dependencies.deleteBlob(reference);
  }

  async function requiredMemory(scope: Types.MemoryPlatformScope, memoryId: Ulid) {
    const memory = await Shared.loadRecord(
      database,
      "control",
      Shared.memoryKey(scope, memoryId),
      "memory",
    );
    if (!memory || !Shared.scopeMatches(memory, scope)) {
      throw new Types.MemoryPlatformError(404, "memory_not_found", "Memory was not found.");
    }
    return memory;
  }

  async function requiredMutableMemory(scope: Types.MemoryPlatformScope, memoryId: Ulid) {
    const memory = await requiredMemory(scope, memoryId);
    if (!Shared.mutationScopeMatches(memory, scope)) {
      throw new Types.MemoryPlatformError(404, "memory_not_found", "Memory was not found.");
    }
    return memory;
  }

  async function requiredSpace(scope: Types.MemoryPlatformScope, memorySpaceId: Ulid) {
    const space = await Shared.loadRecord(
      database,
      "control",
      Shared.memorySpaceKey(scope, memorySpaceId),
      "memory-space",
    );
    if (!space || !Shared.scopeMatches(space, scope)) {
      throw new Types.MemoryPlatformError(
        404,
        "memory_space_not_found",
        "Memory space was not found.",
      );
    }
    return space;
  }

  async function requiredMutableSpace(scope: Types.MemoryPlatformScope, memorySpaceId: Ulid) {
    const space = await requiredSpace(scope, memorySpaceId);
    if (!Shared.mutationScopeMatches(space, scope)) {
      throw new Types.MemoryPlatformError(
        404,
        "memory_space_not_found",
        "Memory space was not found.",
      );
    }
    return space;
  }

  async function loadPoliciesStrong(scope: Types.MemoryPlatformScope) {
    const policies: Types.MemoryPolicy[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await memoryPersistence.find(database, "control", {
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": key("ORG", scope.organizationId, "ENV", scope.environmentId),
          ":prefix": `${key("MEMORY-POLICY")}#`,
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        Limit: Shared.MAX_LIMIT,
        ScanIndexForward: false,
      });
      policies.push(
        ...result.items.filter(
          (value): value is Types.MemoryPolicy => value.itemType === "memory-policy",
        ),
      );
      exclusiveStartKey = result.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return policies.filter((policy) => Shared.scopeMatches(policy, scope));
  }

  async function effectivePolicy(scope: Types.MemoryPlatformScope) {
    return Shared.effectivePolicyAmong(await loadPoliciesStrong(scope), scope.workspaceId);
  }

  const preparedSearchRoutingFence = (organizationId: Ulid) =>
    prepareSearchRoutingFence(dependencies, organizationId);

  async function preparedIndexJob(args: {
    readonly memory: CanonicalMemoryRecord;
    readonly operation?: Types.MemoryIndexJob["data"]["operation"];
    readonly scope: Types.MemoryPlatformScope;
    readonly synchronizationGeneration: number;
    readonly targetId?: Ulid;
  }) {
    const { operations: routingOperations, placement } = await preparedSearchRoutingFence(
      args.scope.organizationId,
    );
    const operation = args.operation ?? Shared.memoryOperation(args.memory);
    const timestamp = Shared.iso(now());
    const mutationProviders = [
      ...placement.writes,
      ...(placement.candidate ? [placement.candidate] : []),
    ];
    const writeProviders = args.targetId
      ? mutationProviders.filter((provider) => provider.target.targetId === args.targetId)
      : mutationProviders;
    const prepared = await Promise.all(
      writeProviders.map(async (provider) => {
        const idempotencyKey = [
          provider.target.targetId,
          args.memory.data.id,
          args.memory.data.version,
          args.synchronizationGeneration,
          operation,
        ].join(":");
        const job = Shared.record(
          MemoryIndexJobRecord,
          withCanonicalRecordKeys({
            data: {
              attempt: 0,
              attemptEpoch: 0,
              createdAt: timestamp,
              environmentId: args.scope.environmentId,
              embeddingProfileId: provider.target.embeddingProfileId,
              eventVersion: 1,
              expectedContentHash: args.memory.data.contentHash,
              expectedMemoryVersion: args.memory.data.version,
              id: await generateId(),
              idempotencyKey,
              memoryId: args.memory.data.id,
              nextDueAt: new Date(
                Date.parse(timestamp) + Shared.INDEX_DISPATCH_RETRY_MS,
              ).toISOString(),
              operation,
              organizationId: args.scope.organizationId,
              placementGeneration: placement.placementGeneration,
              projectId: args.scope.projectId,
              provider: provider.providerId,
              schemaGeneration: provider.target.schemaGeneration,
              status: "queued" as const,
              synchronizationGeneration: args.synchronizationGeneration,
              targetId: provider.target.targetId,
              updatedAt: timestamp,
              version: 0,
              ...(args.scope.workspaceId ? { workspaceId: args.scope.workspaceId } : {}),
            },
            itemType: "memory-index-job" as const,
          }),
        );
        const event = await eventFor({
          aggregateId: job.data.id,
          aggregateType: "memory-index-job",
          aggregateVersion: 1,
          eventType: "memory.index.queued",
          payload: {
            idempotencyKey,
            memoryId: args.memory.data.id,
            operation,
            provider: provider.providerId,
            targetId: provider.target.targetId,
          },
          scope: args.scope,
        });
        return {
          event,
          job,
          operations: Claims.prepareIndexJobOperations(job, now(), hasDurableRouting),
        };
      }),
    );
    const first = prepared[0];
    if (!first) {
      throw new Types.MemoryPlatformError(
        503,
        "memory_search_not_serving",
        "Memory search placement has no write targets.",
      );
    }
    return {
      ...first,
      events: prepared.map((value) => value.event),
      jobOperations: prepared.flatMap((value) => value.operations),
      jobs: prepared.map((value) => value.job),
      operations: [...routingOperations, ...prepared.flatMap((value) => value.operations)],
      perJobOperations: prepared.map((value) => value.operations),
      routingOperations,
    };
  }

  async function queuedIndexJob(args: {
    readonly memory: CanonicalMemoryRecord;
    readonly operation?: Types.MemoryIndexJob["data"]["operation"];
    readonly scope: Types.MemoryPlatformScope;
    readonly synchronizationGeneration: number;
    readonly targetId?: Ulid;
  }) {
    const prepared = await preparedIndexJob(args);
    const results: Types.MemoryIndexJob[] = [];
    for (let index = 0; index < prepared.jobs.length; index += 1) {
      const candidate = prepared.jobs[index]!;
      const targetId = candidate.data.targetId;
      const key = Shared.memoryJobKey(
        args.scope,
        args.memory.data.id,
        candidate.data.idempotencyKey,
        targetId,
      );
      const existing = await Shared.loadRecord(database, "execution", key, "memory-index-job");
      if (existing?.data.status === "failed") {
        const timestamp = Shared.iso(now());
        const eventVersion = (await Shared.memoryIndexJobEventVersion(database, existing)) + 1;
        const {
          acknowledgement: _acknowledgement,
          completedAt: _completedAt,
          error: _error,
          leaseExpiresAt: _leaseExpiresAt,
          leaseOwner: _leaseOwner,
          nextDueAt: _nextDueAt,
          retryAt: _retryAt,
          skipReason: _skipReason,
          startedAt: _startedAt,
          ...jobData
        } = existing.data;
        const requeued = Shared.record(
          MemoryIndexJobRecord,
          withCanonicalRecordKeys({
            data: {
              ...jobData,
              eventVersion,
              nextDueAt: new Date(
                Date.parse(timestamp) + Shared.INDEX_DISPATCH_RETRY_MS,
              ).toISOString(),
              status: "queued" as const,
              updatedAt: timestamp,
              version: existing.data.version + 1,
            },
            itemType: "memory-index-job" as const,
          }),
        );
        const event = await eventFor({
          aggregateId: requeued.data.id,
          aggregateType: "memory-index-job",
          aggregateVersion: eventVersion,
          eventType: "memory.index.queued",
          payload: {
            idempotencyKey: candidate.data.idempotencyKey,
            memoryId: args.memory.data.id,
            operation: candidate.data.operation,
            provider: candidate.data.provider,
            ...(targetId ? { targetId } : {}),
          },
          scope: args.scope,
        });
        const admissionOperations = hasDurableRouting
          ? await Claims.prepareIndexAdmissionRequeue(database, requeued, now())
          : [];
        await transactWithSemanticEvents(
          database,
          [
            ...prepared.routingOperations,
            ...admissionOperations,
            { kind: "put", previousRecord: existing, record: requeued },
          ],
          [event],
        );
        results.push(requeued);
        continue;
      }
      if (existing) {
        results.push(existing);
        continue;
      }
      try {
        await transactWithSemanticEvents(
          database,
          [...prepared.routingOperations, ...prepared.perJobOperations[index]!],
          [prepared.events[index]!],
        );
        results.push(candidate);
      } catch (cause) {
        const replay = await Shared.loadRecord(database, "execution", key, "memory-index-job");
        if (!replay) throw cause;
        results.push(replay);
      }
    }
    return results[0]!;
  }

  return {
    loadReferencedText,
    resolveMemoryContent,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    blobCleanupEvent,
    reviewContentCleanupEvent,
    cleanupMemoryBlob,
    requiredMemory,
    requiredMutableMemory,
    requiredSpace,
    requiredMutableSpace,
    loadPoliciesStrong,
    effectivePolicy,
    preparedSearchRoutingFence,
    preparedIndexJob,
    queuedIndexJob,
  };
}

export type MemoryPlatformCore = ReturnType<typeof makeMemoryPlatformCore>;
