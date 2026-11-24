import {
  decodePlatformRecord,
  fromDatabase,
  key,
  withCanonicalRecordKeys,
  type DatabaseError,
  type DynamoDatabaseService,
  type MemorySearchProviderId,
  type PlatformRecord,
  type RecordDecodeError,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { Effect, Schema } from "effect";
import type { CanonicalMemoryRecord } from "./memory-record.ts";
export type MemoryIndexStateRecord = Extract<
  PlatformRecord,
  { readonly itemType: "memory-index-state" }
>;

export interface MemoryTenantScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

export class MemoryRepositoryError extends Schema.TaggedErrorClass<MemoryRepositoryError>()(
  "MemoryRepositoryError",
  {
    cause: Schema.Unknown,
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export type MemoryRepositoryFailure = DatabaseError | MemoryRepositoryError | RecordDecodeError;

export interface UpdateMemoryIndexStateInput {
  readonly attemptId: string;
  readonly expectedAttemptId?: string;
  readonly lastError?: string;
  readonly memory: CanonicalMemoryRecord;
  readonly namespace: string;
  readonly embeddingProfileId?: Ulid;
  readonly placementGeneration?: number;
  readonly provider: MemorySearchProviderId;
  readonly providerRef?: string;
  readonly schemaGeneration?: number;
  readonly status: MemoryIndexStateRecord["data"]["status"];
  readonly synchronizationGeneration: number;
  readonly targetId?: Ulid;
  readonly updatedAt?: Date;
}

function memoryKey(organizationId: Ulid, memoryId: Ulid) {
  return {
    pk: key("ORG", organizationId, "MEMORY", memoryId),
    sk: key("MEMORY", memoryId),
  };
}

function indexStateKey(organizationId: Ulid, memoryId: Ulid, targetId?: Ulid) {
  return {
    pk: key("ORG", organizationId, "MEMORY", memoryId),
    sk: targetId ? key("MEMORY-INDEX-STATE", targetId) : key("MEMORY-INDEX-STATE", memoryId),
  };
}

function inScope(record: CanonicalMemoryRecord, scope: MemoryTenantScope) {
  return (
    record.data.organizationId === scope.organizationId &&
    record.data.projectId === scope.projectId &&
    record.data.environmentId === scope.environmentId
  );
}

export function memoryIndexStateRecord(
  input: UpdateMemoryIndexStateInput,
  previous?: MemoryIndexStateRecord,
): Effect.Effect<MemoryIndexStateRecord, MemoryRepositoryError | RecordDecodeError> {
  const timestamp = (input.updatedAt ?? new Date()).toISOString();
  if (
    input.expectedAttemptId !== undefined &&
    (previous?.data.status !== "pending" || previous.data.attemptId !== input.expectedAttemptId)
  ) {
    return Effect.fail(
      new MemoryRepositoryError({
        cause: {
          actualAttemptId: previous?.data.attemptId,
          expectedAttemptId: input.expectedAttemptId,
          status: previous?.data.status,
        },
        message: "Memory index state is no longer owned by this synchronization attempt.",
        operation: "update-index-state",
      }),
    );
  }
  if (
    previous &&
    (input.memory.data.version < previous.data.synchronizedVersion ||
      (input.memory.data.version === previous.data.synchronizedVersion &&
        input.synchronizationGeneration < previous.data.synchronizationGeneration))
  ) {
    return Effect.fail(
      new MemoryRepositoryError({
        cause: {
          attemptedGeneration: input.synchronizationGeneration,
          attemptedVersion: input.memory.data.version,
          synchronizationGeneration: previous.data.synchronizationGeneration,
          synchronizedVersion: previous.data.synchronizedVersion,
        },
        message: "Memory index state cannot regress its synchronization ordering.",
        operation: "update-index-state",
      }),
    );
  }
  return decodePlatformRecord(
    withCanonicalRecordKeys({
      data: {
        attemptId: input.attemptId,
        contentHash: input.memory.data.contentHash,
        createdAt: previous?.data.createdAt ?? timestamp,
        ...(input.embeddingProfileId ? { embeddingProfileId: input.embeddingProfileId } : {}),
        environmentId: input.memory.data.environmentId,
        ...(input.status === "ready" ? { indexedAt: timestamp } : {}),
        ...(input.lastError ? { lastError: input.lastError.slice(0, 2_000) } : {}),
        memoryId: input.memory.data.id,
        namespace: input.namespace,
        organizationId: input.memory.data.organizationId,
        ...(input.placementGeneration === undefined
          ? {}
          : { placementGeneration: input.placementGeneration }),
        projectId: input.memory.data.projectId,
        provider: input.provider,
        ...(input.providerRef ? { providerRef: input.providerRef } : {}),
        ...(input.schemaGeneration === undefined
          ? {}
          : { schemaGeneration: input.schemaGeneration }),
        status: input.status,
        synchronizationGeneration: input.synchronizationGeneration,
        synchronizedVersion: input.memory.data.version,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        updatedAt: timestamp,
        version: (previous?.data.version ?? -1) + 1,
      },
      itemType: "memory-index-state" as const,
    }),
  ).pipe(Effect.map((record) => record as MemoryIndexStateRecord));
}

export function makeMemoryRepository(database: DynamoDatabaseService) {
  const getMemory = Effect.fn("MemoryRepository.getMemory")((scope: MemoryTenantScope, id: Ulid) =>
    fromDatabase(() =>
      memoryPersistence.read(database, "control", memoryKey(scope.organizationId, id)),
    ).pipe(
      Effect.map((record) =>
        record?.itemType === "memory" && inScope(record, scope) ? record : undefined,
      ),
    ),
  );

  const getIndexState = Effect.fn("MemoryRepository.getIndexState")(
    (scope: MemoryTenantScope, memoryId: Ulid, targetId?: Ulid) =>
      fromDatabase(() =>
        memoryPersistence.read(
          database,
          "control",
          indexStateKey(scope.organizationId, memoryId, targetId),
        ),
      ).pipe(
        Effect.map((record) =>
          record?.itemType === "memory-index-state" &&
          record.data.organizationId === scope.organizationId &&
          record.data.projectId === scope.projectId &&
          record.data.environmentId === scope.environmentId
            ? record
            : undefined,
        ),
      ),
  );

  const updateIndexState = Effect.fn("MemoryRepository.updateIndexState")((
    input: UpdateMemoryIndexStateInput,
  ) => {
    const scope: MemoryTenantScope = {
      environmentId: input.memory.data.environmentId,
      organizationId: input.memory.data.organizationId,
      projectId: input.memory.data.projectId,
    };
    return getIndexState(scope, input.memory.data.id, input.targetId).pipe(
      Effect.flatMap((previous) =>
        memoryIndexStateRecord(input, previous).pipe(
          Effect.flatMap((next) =>
            fromDatabase(() =>
              memoryPersistence.commit(database, [
                {
                  kind: "put",
                  ...(previous ? { previousRecord: previous } : {}),
                  record: next,
                },
              ]),
            ).pipe(Effect.as(next)),
          ),
        ),
      ),
    );
  });

  return { getIndexState, getMemory, updateIndexState };
}

export type MemoryRepository = ReturnType<typeof makeMemoryRepository>;
