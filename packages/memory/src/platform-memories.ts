import {
  MemoryRecord,
  MemoryReviewItemRecord,
  withCanonicalRecordKeys,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import {
  MEMORY_BROAD_SCOPE_REVIEW_REASON,
  inspectMemoryContent,
  memoryContentHash,
  memoryMetadataBlockedReason,
  normalizeMemoryEntityKeys,
  memoryReviewSampled,
} from "./governance.ts";
import { type CanonicalMemoryRecord } from "./memory-record.ts";
import { supersessionIdentityMatches } from "./memory-supersession-identity.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import type { MemoryPlatformSpaces } from "./platform-spaces.ts";
import type { MemoryReviewMode } from "./governance.ts";

function withoutDeletedContent(memory: CanonicalMemoryRecord): CanonicalMemoryRecord {
  if (memory.data.status !== "deleted") return memory;
  const { body: _body, bodyRef: _bodyRef, metadata: _metadata, ...retainedData } = memory.data;
  return { ...memory, data: retainedData } as CanonicalMemoryRecord;
}

export function makeMemoryPlatformMemories(
  runtime: Shared.MemoryPlatformRuntime & MemoryPlatformCore & MemoryPlatformSpaces,
) {
  const {
    cursorCodec,
    database,
    generateId,
    now,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    requiredMutableMemory,
    requiredMutableSpace,
    effectivePolicy,
    preparedIndexJob,
    queuedIndexJob,
    resolveMemoryContent,
  } = runtime;

  async function importMemories(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly items: readonly Types.ImportMemoryItem[];
      readonly memorySpaceId: Ulid;
      readonly reviewMode?: MemoryReviewMode;
      readonly writableSupersessionMemorySpaceIds?: readonly Ulid[];
    },
  ) {
    if (input.items.length < 1 || input.items.length > Shared.MAX_IMPORT_COUNT) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_import",
        `Memory imports must contain between 1 and ${Shared.MAX_IMPORT_COUNT} items.`,
      );
    }
    if (
      scope.exactWorkspaceMutations &&
      input.items.some((item) => item.scope === "organization")
    ) {
      throw new Types.MemoryPlatformError(
        403,
        "workspace_scope_conflict",
        "Workspace-scoped credentials cannot create organization memory.",
      );
    }
    const imported: CanonicalMemoryRecord[] = [];
    const replayed: CanonicalMemoryRecord[] = [];
    const rejected: { readonly index: number; readonly reason: string }[] = [];
    for (const [index, item] of input.items.entries()) {
      const outcome = await Shared.retryDatabaseWriteConflicts(async () => {
        const space = await requiredMutableSpace(scope, input.memorySpaceId);
        if (space.data.status !== "active") {
          throw new Types.MemoryPlatformError(
            409,
            "memory_space_archived",
            "Memory space is archived.",
          );
        }
        try {
          Shared.validateImportScope(item, scope);
          const itemWorkspaceId =
            item.scope === "organization" ? undefined : (item.workspaceId ?? scope.workspaceId);
          if (itemWorkspaceId !== space.data.workspaceId) {
            throw new Types.MemoryPlatformError(
              400,
              "invalid_scope",
              "Memory and memory space workspace ownership must match.",
            );
          }
          const retainPersonalData = item.retainPersonalData === true;
          const inspection = inspectMemoryContent(
            Shared.embeddableText(item.content, "Memory content"),
            { retainPersonalData },
          );
          if (inspection.blockedReason) {
            return {
              kind: "rejected" as const,
              reason: inspection.blockedReason,
            };
          }
          if (item.metadata) {
            let metadataBytes: number;
            try {
              metadataBytes = new TextEncoder().encode(JSON.stringify(item.metadata)).byteLength;
            } catch {
              throw new Types.MemoryPlatformError(
                400,
                "invalid_metadata",
                "Memory metadata must be JSON serializable.",
              );
            }
            if (metadataBytes > Shared.MAX_MEMORY_METADATA_BYTES) {
              throw new Types.MemoryPlatformError(
                400,
                "invalid_metadata",
                `Memory metadata must not exceed ${Shared.MAX_MEMORY_METADATA_BYTES} UTF-8 bytes.`,
              );
            }
          }
          const metadataBlockedReason = item.metadata
            ? memoryMetadataBlockedReason(item.metadata, { retainPersonalData })
            : undefined;
          if (metadataBlockedReason) {
            return { kind: "rejected" as const, reason: metadataBlockedReason };
          }
          let entityKeys: readonly string[] | undefined;
          try {
            entityKeys = normalizeMemoryEntityKeys(item.entityKeys);
          } catch (cause) {
            throw new Types.MemoryPlatformError(
              400,
              "invalid_entity_key",
              cause instanceof Error ? cause.message : "Memory entity keys are invalid.",
            );
          }
          for (const [label, value] of [
            ["importance", item.importance],
            ["sourceQuality", item.sourceQuality],
          ] as const) {
            if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
              throw new Types.MemoryPlatformError(
                400,
                "invalid_ranking_signal",
                `${label} must be between 0 and 1.`,
              );
            }
          }
          const validFrom = item.validFrom ? new Date(item.validFrom) : undefined;
          const validUntil = item.validUntil ? new Date(item.validUntil) : undefined;
          if (
            (validFrom && Number.isNaN(validFrom.getTime())) ||
            (validUntil && Number.isNaN(validUntil.getTime())) ||
            (validFrom && validUntil && validFrom >= validUntil)
          ) {
            throw new Types.MemoryPlatformError(
              400,
              "invalid_validity_interval",
              "Memory validity timestamps must be valid and validUntil must follow validFrom.",
            );
          }
          const searchKey = Shared.searchKeyForItem(item, scope);
          const normalizedItem: Types.ImportMemoryItem = {
            ...item,
            ...(entityKeys ? { entityKeys } : {}),
            ...(validFrom ? { validFrom: validFrom.toISOString() } : {}),
            ...(validUntil ? { validUntil: validUntil.toISOString() } : {}),
          };
          const expectedCommandHash = Shared.importCommandHash(
            normalizedItem,
            input.memorySpaceId,
            inspection.content,
            searchKey,
          );
          const idempotencyKey = item.idempotencyKey?.trim() || Shared.sha256(expectedCommandHash);
          const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
          if (replay?.[0]) {
            const existing = await requiredMutableMemory(scope, replay[0]);
            await queuedIndexJob({
              memory: existing,
              scope,
              synchronizationGeneration: Shared.memorySynchronizationGeneration(existing),
            });
            return { kind: "replayed" as const, memory: existing };
          }
          const timestampDate = now();
          const timestamp = Shared.iso(timestampDate);
          const memoryId = await generateId();
          const contentHash = memoryContentHash(inspection.content);
          const memoryWorkspaceId =
            item.scope === "organization" ? undefined : (item.workspaceId ?? scope.workspaceId);
          const broadScope = item.scope === "workspace" || item.scope === "organization";
          const generatedCrossThreadScope = item.source === "flush" && item.scope === "agent";
          const generatedSupersession = item.source === "flush" && item.supersedesMemoryId;
          const publicAttributedScope =
            item.source === "api" && (item.scope === "agent" || item.scope === "thread");
          const sampled = memoryReviewSampled({
            contentHash,
            source: item.source ?? "import",
          });
          const requiresReview =
            inspection.reviewStatus === "pending" ||
            broadScope ||
            generatedCrossThreadScope ||
            generatedSupersession ||
            publicAttributedScope ||
            sampled;
          const autoApprove = input.reviewMode === "auto-approve" && item.source === "flush";
          const reviewStatus = autoApprove ? "approved" : requiresReview ? "pending" : "approved";
          const pendingSupersession = reviewStatus === "pending" && item.supersedesMemoryId;
          const reconciledPolicy = Shared.reconciledPolicyFields(
            await effectivePolicy(Shared.memoryOwnedScope(scope, memoryWorkspaceId)),
          );
          const retentionExpiresAt = Shared.addDays(
            timestampDate,
            reconciledPolicy.retentionDays ?? space.data.retentionDays,
          );
          const memory = Shared.record(
            MemoryRecord,
            withCanonicalRecordKeys({
              data: {
                ...(item.agentDefinitionId ? { agentDefinitionId: item.agentDefinitionId } : {}),
                body: inspection.content,
                ...(item.brainProvenance ? { brainProvenance: item.brainProvenance } : {}),
                contentHash,
                createdAt: timestamp,
                ...(entityKeys?.length ? { entityKeys } : {}),
                environmentId: scope.environmentId,
                id: memoryId,
                idempotencyKey,
                ...(item.importance === undefined ? {} : { importance: item.importance }),
                memorySpaceId: input.memorySpaceId,
                memoryType: item.memoryType ?? "fact",
                ...(item.metadata ? { metadata: item.metadata } : {}),
                ...(item.observability ? { observability: item.observability } : {}),
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                ...(retentionExpiresAt ? { retentionExpiresAt } : {}),
                ...(retainPersonalData ? { retainsPersonalData: true } : {}),
                reviewStatus,
                scope: item.scope,
                searchKey,
                sensitivity: inspection.sensitivity,
                source: item.source ?? "import",
                ...(item.sourceQuality === undefined ? {} : { sourceQuality: item.sourceQuality }),
                ...(item.sourceRunId ? { sourceRunId: item.sourceRunId } : {}),
                status: "active" as const,
                ...(item.threadId ? { threadId: item.threadId } : {}),
                ...(item.supersedesMemoryId ? { supersedesMemoryId: item.supersedesMemoryId } : {}),
                updatedAt: timestamp,
                version: 0,
                ...(validFrom ? { validFrom: validFrom.toISOString() } : {}),
                ...(validUntil ? { validUntil: validUntil.toISOString() } : {}),
                ...(memoryWorkspaceId ? { workspaceId: memoryWorkspaceId } : {}),
              },
              itemType: "memory" as const,
            }),
          ) as CanonicalMemoryRecord;
          const predecessor = item.supersedesMemoryId
            ? await requiredMutableMemory(scope, item.supersedesMemoryId)
            : undefined;
          if (predecessor && !supersessionIdentityMatches(predecessor, memory)) {
            throw new Types.MemoryPlatformError(
              409,
              "invalid_supersession",
              "Superseded memory must have the same scope and thread or agent identity.",
            );
          }
          if (
            predecessor?.data.supersededByMemoryId &&
            predecessor.data.supersededByMemoryId !== memory.data.id
          ) {
            const currentSuccessor = await Shared.loadRecord(
              database,
              "control",
              Shared.memoryKey(scope, predecessor.data.supersededByMemoryId),
              "memory",
            );
            if (
              currentSuccessor &&
              Shared.mutationScopeMatches(currentSuccessor, scope) &&
              currentSuccessor.data.status === "active" &&
              currentSuccessor.data.reviewStatus === "approved" &&
              (!currentSuccessor.data.retentionExpiresAt ||
                currentSuccessor.data.retentionExpiresAt > timestamp) &&
              (!currentSuccessor.data.validFrom || currentSuccessor.data.validFrom <= timestamp) &&
              (!currentSuccessor.data.validUntil || currentSuccessor.data.validUntil > timestamp)
            ) {
              throw new Types.MemoryPlatformError(
                409,
                "memory_superseded",
                "A different approved replacement is already active for the superseded memory.",
              );
            }
          }
          if (
            predecessor &&
            item.source === "flush" &&
            !(input.writableSupersessionMemorySpaceIds ?? [input.memorySpaceId]).includes(
              predecessor.data.memorySpaceId,
            )
          ) {
            throw new Types.MemoryPlatformError(
              403,
              "supersession_write_forbidden",
              "Flush supersession requires write access to the predecessor memory space.",
            );
          }
          const successorCurrentlyValid =
            memory.data.status === "active" &&
            (!memory.data.validFrom || memory.data.validFrom <= timestamp) &&
            (!memory.data.validUntil || memory.data.validUntil > timestamp) &&
            (!memory.data.retentionExpiresAt || memory.data.retentionExpiresAt > timestamp);
          if (
            reviewStatus === "approved" &&
            memory.data.supersedesMemoryId &&
            !successorCurrentlyValid
          ) {
            throw new Types.MemoryPlatformError(
              409,
              "supersession_successor_inactive",
              "A superseding memory must be active and currently valid before approval.",
            );
          }
          if (reviewStatus === "approved" && predecessor?.data.status === "deleted") {
            throw new Types.MemoryPlatformError(
              409,
              "supersession_predecessor_deleted",
              "Permanently deleted memory cannot be superseded.",
            );
          }
          const operations: TransactionOperation[] = [
            Shared.activeMemorySpaceCondition(space),
            { kind: "put", record: memory },
          ];
          if (reviewStatus === "pending") {
            const supersessionReviewReason = pendingSupersession
              ? `Approving this memory will archive predecessor memory ${item.supersedesMemoryId}.`
              : undefined;
            const review = Shared.record(
              MemoryReviewItemRecord,
              withCanonicalRecordKeys({
                data: {
                  createdAt: timestamp,
                  environmentId: scope.environmentId,
                  id: await generateId(),
                  kind: pendingSupersession
                    ? "supersession"
                    : inspection.reviewReason
                      ? "content-governance"
                      : broadScope
                        ? "broad-scope"
                        : "sampled-import",
                  memoryId,
                  organizationId: scope.organizationId,
                  projectId: scope.projectId,
                  reason: supersessionReviewReason
                    ? inspection.reviewReason
                      ? `${supersessionReviewReason} ${inspection.reviewReason}`
                      : supersessionReviewReason
                    : (inspection.reviewReason ??
                      (broadScope ? MEMORY_BROAD_SCOPE_REVIEW_REASON : "Sampled import review.")),
                  status: "open" as const,
                  ...(pendingSupersession ? { supersedesMemoryId: item.supersedesMemoryId } : {}),
                  updatedAt: timestamp,
                  version: 0,
                  ...(memory.data.workspaceId ? { workspaceId: memory.data.workspaceId } : {}),
                },
                itemType: "memory-review-item" as const,
              }),
            );
            operations.push({ kind: "put", record: review });
          }
          operations.push(
            idempotencyOperation(
              completedIdempotency({
                commandHash: expectedCommandHash,
                idempotencyKey,
                resourceIds: [memoryId],
                scope,
                timestamp: timestampDate,
              }),
            ),
          );
          const event = await eventFor({
            aggregateId: memoryId,
            aggregateType: "memory",
            aggregateVersion: 1,
            eventType: "memory.created",
            payload: {
              memorySpaceId: input.memorySpaceId,
              reviewStatus,
              scope: item.scope,
              status: memory.data.status,
            },
            scope,
          });
          const indexJob = await preparedIndexJob({
            memory,
            scope,
            synchronizationGeneration: Shared.memorySynchronizationGeneration(memory),
          });
          operations.push(...indexJob.operations);
          const predecessorArchived =
            predecessor?.data.status === "active" && predecessor.data.reviewStatus === "approved";
          const superseded =
            predecessor && reviewStatus === "approved"
              ? (Shared.record(
                  MemoryRecord,
                  withCanonicalRecordKeys({
                    data: {
                      ...predecessor.data,
                      ...(predecessorArchived
                        ? { archivedAt: timestamp, status: "archived" as const }
                        : {}),
                      supersededByMemoryId: memory.data.id,
                      updatedAt: timestamp,
                      version: predecessor.data.version + 1,
                    },
                    itemType: "memory" as const,
                  }),
                ) as CanonicalMemoryRecord)
              : undefined;
          const supersededEvent = superseded
            ? await eventFor({
                aggregateId: superseded.data.id,
                aggregateType: "memory",
                aggregateVersion: superseded.data.version + 1,
                eventType: predecessorArchived ? "memory.archived" : "memory.superseded",
                payload: {
                  status: superseded.data.status,
                  supersededByMemoryId: memory.data.id,
                },
                scope,
              })
            : undefined;
          const supersededIndexJob =
            superseded && predecessorArchived
              ? await preparedIndexJob({
                  memory: superseded,
                  operation: "archive",
                  scope,
                  synchronizationGeneration: Shared.memorySynchronizationGeneration(superseded),
                })
              : undefined;
          if (superseded) {
            operations.push({
              kind: "put",
              previousRecord: predecessor!,
              record: superseded,
            });
            if (supersededIndexJob) operations.push(...supersededIndexJob.jobOperations);
          }
          try {
            await transactWithSemanticEvents(database, operations, [
              event,
              ...indexJob.events,
              ...(supersededEvent ? [supersededEvent] : []),
              ...(supersededIndexJob ? supersededIndexJob.events : []),
            ]);
          } catch (cause) {
            const concurrentReplay = await idempotencyReplay(
              scope,
              idempotencyKey,
              expectedCommandHash,
            );
            if (concurrentReplay?.[0]) {
              const existing = await requiredMutableMemory(scope, concurrentReplay[0]);
              await queuedIndexJob({
                memory: existing,
                scope,
                synchronizationGeneration: Shared.memorySynchronizationGeneration(existing),
              });
              return { kind: "replayed" as const, memory: existing };
            }
            throw cause;
          }
          return { kind: "imported" as const, memory };
        } catch (cause) {
          if (cause instanceof Types.MemoryPlatformError && cause.code !== "idempotency_conflict") {
            return { kind: "rejected" as const, reason: cause.message };
          }
          throw cause;
        }
      });
      if (outcome.kind === "imported") imported.push(outcome.memory);
      else if (outcome.kind === "replayed") replayed.push(outcome.memory);
      else rejected.push({ index, reason: outcome.reason });
    }
    return { imported, rejected, replayed };
  }

  async function listMemories(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly all?: boolean;
      readonly limit?: number;
      readonly memorySpaceId?: Ulid;
      readonly status?: CanonicalMemoryRecord["data"]["status"];
    } = {},
  ) {
    const memories = await Shared.queryEnvironmentRecords<CanonicalMemoryRecord>({
      ...(input.all || input.memorySpaceId ? { all: true } : {}),
      database,
      environmentId: scope.environmentId,
      itemType: "memory",
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.status ? { status: input.status } : {}),
      table: "control",
    });
    const filtered = memories
      .filter(
        (memory) =>
          Shared.scopeMatches(memory, scope) &&
          (!input.memorySpaceId || memory.data.memorySpaceId === input.memorySpaceId),
      )
      .map(withoutDeletedContent);
    return input.all ? filtered : filtered.slice(0, Shared.boundedLimit(input.limit));
  }

  async function listMemoriesPage(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly memorySpaceId?: Ulid;
      readonly status?: CanonicalMemoryRecord["data"]["status"];
    } = {},
  ) {
    const page = await Shared.queryEnvironmentRecordPage<CanonicalMemoryRecord>({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      cursorCodec,
      database,
      environmentId: scope.environmentId,
      filter: (memory) =>
        Shared.scopeMatches(memory, scope) &&
        (!input.memorySpaceId || memory.data.memorySpaceId === input.memorySpaceId),
      itemType: "memory",
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.status ? { status: input.status } : {}),
      table: "control",
    });
    const canonical = await Promise.all(
      page.items.map((memory) =>
        Shared.loadRecord(database, "control", { pk: memory.pk, sk: memory.sk }, "memory"),
      ),
    );
    return {
      ...page,
      items: canonical
        .filter(
          (memory): memory is CanonicalMemoryRecord =>
            memory !== undefined &&
            Shared.scopeMatches(memory, scope) &&
            (!input.memorySpaceId || memory.data.memorySpaceId === input.memorySpaceId) &&
            (!input.status || memory.data.status === input.status),
        )
        .map(withoutDeletedContent),
    };
  }

  async function exportMemoriesPage(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly memorySpaceId?: Ulid;
      readonly status?: CanonicalMemoryRecord["data"]["status"];
    } = {},
  ) {
    const page = await listMemoriesPage(scope, input);
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (memory) => {
          if (memory.data.status === "deleted") return withoutDeletedContent(memory);
          const body = await resolveMemoryContent(memory);
          const { bodyRef: _bodyRef, ...data } = memory.data;
          return { ...memory, data: { ...data, body } };
        }),
      ),
    };
  }

  return {
    importMemories,
    listMemories,
    listMemoriesPage,
    exportMemoriesPage,
  };
}

export type MemoryPlatformMemories = ReturnType<typeof makeMemoryPlatformMemories>;
