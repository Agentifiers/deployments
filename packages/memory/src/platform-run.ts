import {
  type BoundExecutionPins,
  type CustomerExecutionPins,
  ConversationCheckpointRecord,
  conversationMessageIsTransient,
  isDatabaseWriteConflict,
  key,
  makeConversationMemoryContinuityPersistence,
  makeConversationPersistence,
  type Ulid,
  memoryPersistence,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  memoryContentMatchesHash,
  memoryScopeAllowed,
  type MemoryFlushCandidate,
  type MemoryReviewMode,
  type MemoryTranscriptPrivacy,
  type MemoryScope,
} from "./governance.ts";
import { type CanonicalMemoryRecord } from "./memory-record.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import {
  customerRun,
  makeRunMemorySubjects,
  type RunMemorySubject,
} from "./platform-run-subject.ts";
import type { MemoryPlatformSpaces } from "./platform-spaces.ts";
import type { MemoryPlatformGrantList } from "./platform-grant-list.ts";
import type { MemoryPlatformMemories } from "./platform-memories.ts";
export function makeMemoryPlatformRun(
  runtime: Shared.MemoryPlatformRuntime &
    MemoryPlatformCore &
    MemoryPlatformSpaces &
    MemoryPlatformGrantList &
    MemoryPlatformMemories,
) {
  const {
    database,
    loadReferencedText,
    requiredSpace,
    requiredMutableSpace,
    listMemorySpaceGrants,
    importMemories,
    now,
  } = runtime;
  const subjects = makeRunMemorySubjects({ database, now });

  async function messagesForThread(
    scope: Types.MemoryPlatformScope,
    threadId: Ulid,
    limit = 20,
    runId?: Ulid,
  ) {
    const requested = Shared.boundedLimit(limit);
    const messages: Types.Message[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await memoryPersistence.find(database, "execution", {
        ExpressionAttributeValues: {
          ":pk": key("ORG", scope.organizationId, "THREAD", threadId),
          ":prefix": `${key("MESSAGE")}#`,
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        Limit: Shared.MAX_LIMIT,
        ScanIndexForward: false,
        ConsistentRead: true,
      });
      messages.push(
        ...result.items.filter(
          (value): value is Types.Message =>
            value.itemType === "message" &&
            Shared.scopeMatches(value, scope) &&
            (runId === undefined || value.data.runId === runId),
        ),
      );
      exclusiveStartKey = result.lastEvaluatedKey;
    } while (exclusiveStartKey && messages.length < requested);
    return messages.slice(0, requested);
  }

  async function modelTokenQuantityForRun(scope: Types.MemoryPlatformScope, runId: Ulid) {
    let quantity = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await memoryPersistence.find(database, "usage", {
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": key("ORG", scope.organizationId, "ENV", scope.environmentId),
          ":prefix": key("METER-EVENT", runId),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        Limit: Shared.MAX_LIMIT,
        ScanIndexForward: false,
      });
      for (const value of result.items) {
        if (
          value.itemType === "meter-event" &&
          value.data.runId === runId &&
          value.data.metric === "model_tokens" &&
          value.data.unit === "tokens" &&
          value.data.organizationId === scope.organizationId &&
          value.data.projectId === scope.projectId &&
          value.data.environmentId === scope.environmentId
        ) {
          quantity += value.data.quantity;
        }
      }
      exclusiveStartKey = result.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return quantity;
  }

  async function latestConversationCheckpoint(
    scope: Types.MemoryPlatformScope,
    threadId: Ulid,
    maximumSequence = Number.MAX_SAFE_INTEGER,
  ) {
    const checkpoint = await makeConversationPersistence(database).latestCheckpoint(
      { organizationId: scope.organizationId, threadId },
      maximumSequence,
    );
    return checkpoint && Shared.scopeMatches(checkpoint, scope) ? checkpoint : undefined;
  }

  async function messagesForConversationCheckpoint(
    scope: Types.MemoryPlatformScope,
    threadId: Ulid,
    throughSequence: number,
    afterSequence?: number,
    limit = 512,
  ) {
    const records = await makeConversationPersistence(database).messagesInSequenceRange(
      { organizationId: scope.organizationId, threadId },
      { ...(afterSequence === undefined ? {} : { afterSequence }), limit, throughSequence },
    );
    return records.filter(
      (record): record is Types.Message =>
        record.itemType === "message" &&
        Shared.scopeMatches(record, scope) &&
        !conversationMessageIsTransient(record.data.metadata),
    );
  }

  async function saveConversationCheckpoint(
    scope: Types.MemoryPlatformScope,
    input: (CustomerExecutionPins | BoundExecutionPins) & {
      readonly fromMessageCreatedAt?: string;
      readonly fromSequence: number;
      readonly runId: Ulid;
      readonly sourceMessageCount: number;
      readonly summary: string;
      readonly threadId: Ulid;
      readonly throughMessageCharacterOffset?: number;
      readonly throughMessageCreatedAt: string;
      readonly throughSequence: number;
    },
  ) {
    const existing = await latestConversationCheckpoint(
      scope,
      input.threadId,
      input.throughSequence,
    );
    if (
      existing?.data.throughSequence === input.throughSequence &&
      (existing.data.throughMessageCharacterOffset === undefined ||
        (input.throughMessageCharacterOffset !== undefined &&
          existing.data.throughMessageCharacterOffset >= input.throughMessageCharacterOffset))
    ) {
      return existing;
    }
    const summary = input.summary.trim().slice(0, 24 * 1_024);
    if (!summary) throw new TypeError("Conversation checkpoint summary must not be empty.");
    const checkpoint = Schema.decodeUnknownSync(ConversationCheckpointRecord)(
      withCanonicalRecordKeys({
        data: {
          ...(input.executionBindingId === undefined
            ? { agentDeploymentId: input.agentDeploymentId }
            : {
                executionBindingId: input.executionBindingId,
                executionPurpose: input.executionPurpose,
              }),
          contentHash: createHash("sha256").update(summary).digest("hex"),
          ...(existing?.data.continuedFromCheckpointId
            ? { continuedFromCheckpointId: existing.data.continuedFromCheckpointId }
            : {}),
          ...(existing?.data.continuedFromThreadId
            ? { continuedFromThreadId: existing.data.continuedFromThreadId }
            : {}),
          ...(existing?.data.continuedFromThroughSequence !== undefined
            ? { continuedFromThroughSequence: existing.data.continuedFromThroughSequence }
            : {}),
          createdAt: now().toISOString(),
          environmentId: scope.environmentId,
          ...(input.fromMessageCreatedAt
            ? { fromMessageCreatedAt: input.fromMessageCreatedAt }
            : {}),
          fromSequence: input.fromSequence,
          id: input.runId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          runId: input.runId,
          sourceMessageCount: input.sourceMessageCount,
          summary,
          threadId: input.threadId,
          ...(input.throughMessageCharacterOffset !== undefined
            ? { throughMessageCharacterOffset: input.throughMessageCharacterOffset }
            : {}),
          throughMessageCreatedAt: input.throughMessageCreatedAt,
          throughSequence: input.throughSequence,
        },
        itemType: "conversation-checkpoint" as const,
      }),
    );
    try {
      await makeConversationPersistence(database).saveCheckpoint(checkpoint);
      return checkpoint;
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      const replay = await latestConversationCheckpoint(
        scope,
        input.threadId,
        input.throughSequence,
      );
      if (
        replay?.data.throughSequence === input.throughSequence &&
        (replay.data.throughMessageCharacterOffset === undefined ||
          (input.throughMessageCharacterOffset !== undefined &&
            replay.data.throughMessageCharacterOffset >= input.throughMessageCharacterOffset))
      ) {
        return replay;
      }
      throw cause;
    }
  }

  async function resolveMessageContent(message: Types.Message) {
    if (message.data.body !== undefined) return message.data.body;
    if (!message.data.bodyRef) return undefined;
    const content = await loadReferencedText(
      message.data.bodyRef,
      "Types.Message body",
      Shared.MAX_MESSAGE_BLOB_BYTES,
    );
    if (!memoryContentMatchesHash(content, message.data.contentHash)) {
      throw new Types.MemoryPlatformError(
        409,
        "message_content_hash_mismatch",
        "Types.Message body does not match its canonical content hash.",
      );
    }
    return content;
  }

  async function findRun(scope: Types.MemoryPlatformScope, runId: Ulid) {
    const locator = await Shared.loadRecord(
      database,
      "control",
      Shared.runLocatorKey(scope, runId),
      "run-locator",
    );
    const located = locator
      ? await Shared.loadRecord(
          database,
          "execution",
          { pk: locator.data.runPk, sk: locator.data.runSk },
          "run",
        )
      : undefined;
    if (located && Shared.scopeMatches(located, scope)) return located;
    throw new Types.MemoryPlatformError(404, "run_not_found", "Types.Run was not found.");
  }

  async function memoryAccessForRun(
    scope: Types.MemoryPlatformScope,
    runId: Ulid,
    options: { readonly includeThreadContinuity?: boolean } = {},
  ): Promise<Types.MemoryRunAccess> {
    const run = await findRun(scope, runId);
    const subject = await subjects.forRun(run);
    const access = await memoryAccessForSubject(scope, run, subject);
    // Preview threads never continue production threads, so they have no predecessors to search.
    if (!options.includeThreadContinuity || subject.readOnly) return access;
    const predecessorThreadIds = await makeConversationMemoryContinuityPersistence(
      database,
    ).validatedPredecessorThreadIds({
      agentDefinitionId: access.agentDefinitionId,
      currentAgentDeploymentId: subject.agentDeploymentId,
      environmentId: run.data.environmentId,
      organizationId: run.data.organizationId,
      projectId: run.data.projectId,
      threadId: run.data.threadId,
      ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
    });
    return {
      ...access,
      searchKeys: [
        ...access.searchKeys,
        ...predecessorThreadIds.map((threadId) => `thread:${threadId}`),
      ],
    };
  }

  /** Write-capable access for flushes and candidate imports, which only customer runs perform. */
  async function memoryAccessForResolvedRun(
    scope: Types.MemoryPlatformScope,
    run: Types.Run,
    requiredWritableScope?: MemoryScope,
  ): Promise<Types.MemoryRunAccess> {
    const customer = customerRun(run);
    return memoryAccessForSubject(
      scope,
      customer,
      { agentDeploymentId: customer.data.agentDeploymentId, readOnly: false },
      requiredWritableScope,
    );
  }

  async function memoryAccessForSubject(
    scope: Types.MemoryPlatformScope,
    run: Types.Run,
    subject: RunMemorySubject,
    requiredWritableScope?: MemoryScope,
  ): Promise<Types.MemoryRunAccess> {
    const runScope = Shared.memoryOwnedScope(scope, run.data.workspaceId);
    const agentDefinitionId = await agentDefinitionForDeployment(
      runScope,
      subject.agentDeploymentId,
    );
    let grants = await listMemorySpaceGrants(runScope, {
      agentDefinitionId,
    });
    const activeGrantsFor = async (candidateGrants: typeof grants) =>
      (
        await Promise.all(
          candidateGrants
            .filter(
              (grant) =>
                grant.data.workspaceId === undefined ||
                grant.data.workspaceId === run.data.workspaceId,
            )
            .map(async (grant) => ({
              grant,
              space: await requiredSpace(runScope, grant.data.memorySpaceId),
            })),
        )
      ).filter(({ space }) => space.data.status === "active");
    let activeGrants = await activeGrantsFor(grants);
    const hasCompatibleWritableGrant = () => {
      if (!requiredWritableScope) {
        return activeGrants.some(({ grant }) => grant.data.permission === "read-write");
      }
      const requiredWorkspaceId = Shared.memoryWorkspaceForScope(run, requiredWritableScope);
      return activeGrants.some(
        ({ grant, space }) =>
          grant.data.permission === "read-write" && space.data.workspaceId === requiredWorkspaceId,
      );
    };
    // Read-only subjects never write, so a missing writable grant needs no consistent re-read.
    if (!subject.readOnly && !hasCompatibleWritableGrant()) {
      // Agent grant projections are eventually consistent. A strong base-table
      // fallback distinguishes a newly-created scope-compatible writable grant
      // from a genuinely unconfigured agent before a completed run decides
      // whether to retry.
      grants = await listMemorySpaceGrants(runScope, {
        agentDefinitionId,
        consistent: true,
      });
      activeGrants = await activeGrantsFor(grants);
    }
    const accessForSpaces = (
      values: readonly (typeof activeGrants)[number][],
    ): Types.MemoryRunSpaceAccess[] => [
      ...new Map(
        values.map(({ space }) => [
          space.data.id,
          {
            id: space.data.id,
            ...(space.data.workspaceId ? { workspaceId: space.data.workspaceId } : {}),
          },
        ]),
      ).values(),
    ];
    const readMemorySpaces = accessForSpaces(activeGrants);
    const writeMemorySpaces = subject.readOnly
      ? []
      : accessForSpaces(activeGrants.filter(({ grant }) => grant.data.permission === "read-write"));
    return {
      agentDefinitionId,
      readMemorySpaceIds: readMemorySpaces.map((space) => space.id),
      readMemorySpaces,
      run,
      searchKeys: [
        `organization:${scope.organizationId}`,
        ...(run.data.workspaceId ? [`workspace:${run.data.workspaceId}`] : []),
        `agent:${agentDefinitionId}`,
        `thread:${run.data.threadId}`,
      ],
      writeMemorySpaceIds: writeMemorySpaces.map((space) => space.id),
      writeMemorySpaces,
    };
  }

  async function agentDefinitionForDeployment(
    scope: Types.MemoryPlatformScope,
    agentDeploymentId: Ulid,
  ) {
    const deployment = await Shared.loadRecord(
      database,
      "control",
      {
        pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
        sk: key("AGENT-DEPLOYMENT", agentDeploymentId),
      },
      "agent-deployment",
    );
    if (!deployment || !Shared.scopeMatches(deployment, scope)) {
      throw new Types.MemoryPlatformError(
        404,
        "agent_deployment_not_found",
        "Agent deployment was not found.",
      );
    }
    return deployment.data.agentDefinitionId;
  }

  async function agentReleaseForRun(scope: Types.MemoryPlatformScope, bound: Types.Run) {
    const run = customerRun(bound);
    const release = await Shared.loadRecord(
      database,
      "control",
      {
        pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
        sk: key("AGENT-RELEASE", run.data.agentReleaseId),
      },
      "agent-release",
    );
    if (!release || !Shared.scopeMatches(release, scope)) {
      throw new Types.MemoryPlatformError(
        404,
        "agent_release_not_found",
        "Agent release was not found.",
      );
    }
    return release;
  }

  async function importFlushCandidates(
    scope: Types.MemoryPlatformScope,
    args: {
      readonly candidates: readonly MemoryFlushCandidate[];
      readonly flushId: Ulid;
      readonly memorySpaceId: Ulid;
      readonly memoryMode: MemoryScope | "off";
      readonly reviewMode?: MemoryReviewMode;
      readonly run: Types.Run;
      readonly transcriptPrivacy?: MemoryTranscriptPrivacy;
    },
  ) {
    const run = customerRun(args.run);
    const occurrences = new Map<string, number>();
    const identifiedCandidates = args.candidates.map((candidate) => {
      const candidateScope = candidate.scope ?? "thread";
      const signature = Shared.canonicalJson({
        confidence: candidate.confidence,
        content: candidate.content,
        entityKeys: candidate.entityKeys,
        importance: candidate.importance,
        memoryType: candidate.memoryType,
        reason: candidate.reason,
        scope: candidateScope,
        sourceQuality: candidate.sourceQuality,
        supersedesMemoryId: candidate.supersedesMemoryId,
        validFrom: candidate.validFrom,
        validUntil: candidate.validUntil,
      })!;
      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      return {
        candidate,
        candidateKey: Shared.commandHash({
          flushId: args.flushId,
          occurrence,
          signature,
        }),
        candidateScope,
      };
    });
    const candidateKeys = identifiedCandidates.map(({ candidateKey }) => candidateKey);
    const needsAgentIdentity = args.candidates.some(
      (candidate) => (candidate.scope ?? "thread") === "agent",
    );
    const agentDefinitionId = needsAgentIdentity
      ? await agentDefinitionForDeployment(scope, run.data.agentDeploymentId)
      : undefined;
    const rejected: { readonly index: number; readonly reason: string }[] = [];
    const items = identifiedCandidates.flatMap(
      ({ candidate, candidateKey, candidateScope }, index) => {
        if (!memoryScopeAllowed(args.memoryMode, candidateScope)) {
          rejected.push({
            index,
            reason: "Candidate scope is broader than the flush memory mode.",
          });
          return [];
        }
        return [
          {
            index,
            item: {
              content: candidate.content,
              ...(candidate.entityKeys?.length ? { entityKeys: candidate.entityKeys } : {}),
              idempotencyKey: candidateKey,
              ...(candidate.importance === undefined ? {} : { importance: candidate.importance }),
              memoryType: candidate.memoryType ?? "fact",
              metadata: {
                ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
                ...(candidate.reason ? { reason: candidate.reason } : {}),
              },
              scope: candidateScope,
              source: "flush",
              sourceQuality: candidate.sourceQuality ?? candidate.confidence ?? 0.5,
              sourceRunId: args.run.data.id,
              ...(args.transcriptPrivacy === "retain" ? { retainPersonalData: true } : {}),
              observability: {
                captureMode: args.run.data.captureMode,
                ...(args.run.data.parentSpanId ? { parentSpanId: args.run.data.parentSpanId } : {}),
                runSpanId: args.run.data.spanId,
                sessionId: args.run.data.threadId,
                traceId: args.run.data.traceId,
                ...(args.run.data.workspaceId ? { workspaceId: args.run.data.workspaceId } : {}),
              },
              ...(candidate.supersedesMemoryId
                ? { supersedesMemoryId: candidate.supersedesMemoryId as Ulid }
                : {}),
              ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
              ...(candidate.validUntil ? { validUntil: candidate.validUntil } : {}),
              ...(candidateScope === "agent" && agentDefinitionId ? { agentDefinitionId } : {}),
              ...(candidateScope === "thread" ? { threadId: args.run.data.threadId } : {}),
              ...(candidateScope === "workspace" && args.run.data.workspaceId
                ? { workspaceId: args.run.data.workspaceId }
                : {}),
            } satisfies Types.ImportMemoryItem,
            scope: candidateScope,
          },
        ];
      },
    );
    if (items.length === 0) {
      return { candidateKeys, imported: [], rejected, replayed: [] };
    }
    const primarySpace = await requiredMutableSpace(scope, args.memorySpaceId);
    if (primarySpace.data.status !== "active") {
      throw new Types.MemoryPlatformError(
        409,
        "memory_space_archived",
        "Memory space is archived.",
      );
    }
    const access = await memoryAccessForResolvedRun(scope, args.run);
    if (!access.writeMemorySpaceIds.includes(primarySpace.data.id)) {
      throw new Types.MemoryPlatformError(
        403,
        "memory_space_write_forbidden",
        "The run agent no longer has write access to the flush memory space.",
      );
    }
    const grouped = new Map<Ulid, typeof items>();
    for (const item of items) {
      let memorySpaceId =
        primarySpace.data.workspaceId === Shared.memoryWorkspaceForScope(args.run, item.scope)
          ? primarySpace.data.id
          : undefined;
      if (!memorySpaceId) {
        memorySpaceId = Shared.writableMemorySpaceForScope(access, item.scope)?.id;
      }
      if (!memorySpaceId) {
        rejected.push({
          index: item.index,
          reason: "No writable memory space is compatible with the candidate scope.",
        });
        continue;
      }
      const group = grouped.get(memorySpaceId) ?? [];
      group.push(item);
      grouped.set(memorySpaceId, group);
    }
    const imported: CanonicalMemoryRecord[] = [];
    const replayed: CanonicalMemoryRecord[] = [];
    for (const [memorySpaceId, group] of grouped) {
      const result = await importMemories(scope, {
        items: group.map((entry) => entry.item),
        memorySpaceId,
        reviewMode: args.reviewMode ?? "manual",
        writableSupersessionMemorySpaceIds: access.writeMemorySpaceIds,
      });
      imported.push(...result.imported);
      replayed.push(...result.replayed);
      rejected.push(
        ...result.rejected.map((entry) => ({
          index: group[entry.index]!.index,
          reason: entry.reason,
        })),
      );
    }
    rejected.sort((left, right) => left.index - right.index);
    return { candidateKeys, imported, rejected, replayed };
  }

  return {
    latestConversationCheckpoint,
    messagesForThread,
    messagesForConversationCheckpoint,
    modelTokenQuantityForRun,
    resolveMessageContent,
    saveConversationCheckpoint,
    findRun,
    memoryAccessForRun,
    memoryAccessForResolvedRun,
    agentReleaseForRun,
    importFlushCandidates,
  };
}

export type MemoryPlatformRun = ReturnType<typeof makeMemoryPlatformRun>;
