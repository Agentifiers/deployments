import { Schema } from "effect";
import { makeModelCatalogPersistence, Ulid } from "@deployments-ai/db";
import {
  buildMemoryFlushPrompt,
  MemoryCheckpointSizeError,
  type MemoryFlushCompletion,
  MEMORY_FLUSH_CHECKPOINT_TRANSCRIPT_CHARS,
  MEMORY_FLUSH_CURRENT_RUN_TRANSCRIPT_CHARS,
  MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS,
  MemoryPlatformError,
  parseMemoryFlushResult,
  sanitizeMemoryConversationContent,
  selectMemoryFlushMessageBatch,
  shouldRunMemoryFlush,
  type MemoryPlatform,
  type MemoryScope,
} from "@deployments-ai/memory";
import { normalizeModelId, type ModelCatalogRuntimeEntry } from "@deployments-ai/model-gateway";
import {
  memoryPlatformErrorLogContext,
  processQueue,
  queuePayload,
  queueScope,
  text,
  type QueueEventLike,
} from "./queue.ts";
import {
  admitMemoryFlushModel,
  generateFlushCompletion,
  memoryFlushModelBudget,
  memoryFlushModelCatalog,
  type MemoryFlushModelRuntime,
} from "./flush-model.ts";
import { runtimeDatabase, runtimeMemoryPlatform } from "./runtime.ts";

const CHECKPOINT_COMPACTION_MAX_ATTEMPTS = 3;
const CHECKPOINT_COMPACTION_PROMPT_RESERVE_BYTES = 512;

/** Client-class platform errors that clear on their own, so the message must be redelivered. */
const TRANSIENT_CLIENT_ERROR_CODES: Readonly<Record<string, true>> = {
  // Another worker holds the flush lease; its expiry makes the flush claimable again.
  flush_lease_active: true,
  // Message storage is unconfigured in this deployment; a fixed deploy plus redrive recovers it.
  memory_blob_loader_unavailable: true,
};

/**
 * Acknowledges a flush that can never succeed (an archived or missing memory space, a revoked
 * write grant, a vanished run or flush record) instead of letting SQS retry it into the DLQ.
 */
function acknowledgesPermanentFailure(cause: unknown, messageId: string, flushId?: string) {
  if (
    !(cause instanceof MemoryPlatformError) ||
    cause.statusCode < 400 ||
    cause.statusCode >= 500 ||
    cause.statusCode === 408 ||
    cause.statusCode === 429 ||
    Object.hasOwn(TRANSIENT_CLIENT_ERROR_CODES, cause.code)
  ) {
    return false;
  }
  console.warn("Memory flush failed permanently.", {
    ...memoryPlatformErrorLogContext(cause),
    ...(flushId ? { flushId } : {}),
    messageId,
  });
  return true;
}

export async function handleMemoryFlushQueue(
  event: QueueEventLike,
  dependencies: {
    /**
     * The deployment's flush model. It replaces the run's agent model when the run's environment
     * admits it; otherwise the flush keeps the agent's model.
     */
    readonly flushModelId?: string;
    readonly admitFlushModel?: typeof admitMemoryFlushModel;
    readonly generateCompletion?: typeof generateFlushCompletion;
    /** Reads synchronized model catalog entries; defaults to the platform catalog table. */
    readonly getModelCatalogEntries?: (
      modelIds: readonly string[],
    ) => Promise<ReadonlyMap<string, ModelCatalogRuntimeEntry>>;
    readonly platform?: MemoryPlatform;
    readonly promptInputTokenBudget?: (modelId: string) => number;
  } = {},
) {
  const platform = dependencies.platform ?? (await runtimeMemoryPlatform());
  return processQueue(event, async (record) => {
    const payload = queuePayload(record);
    const scope = queueScope(payload);
    const runId = Schema.decodeUnknownSync(Ulid)(text(payload.runId, "runId"));
    const flush = await platform
      .claimFlush(
        scope,
        runId,
        text(payload.idempotencyKey, "idempotencyKey"),
        process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? record.messageId,
      )
      .catch((cause: unknown) => {
        if (acknowledgesPermanentFailure(cause, record.messageId)) return undefined;
        throw cause;
      });
    if (!flush || flush.data.status === "succeeded") return;
    let progress:
      | {
          readonly candidateKeys: readonly string[];
          readonly checkpointCompleted?: boolean;
          readonly checkpointId?: Ulid;
          readonly completionModelId?: string;
          readonly memoryIds: readonly Ulid[];
          readonly rejectedCount: number;
        }
      | undefined;
    try {
      const {
        checkpointMode = "off",
        memoryMode,
        memorySpaceId,
        modelId: runModelId = "openrouter/openai/gpt-4o",
        reviewMode = "manual",
      } = flush.data;
      if (!memoryMode) {
        throw new TypeError("Memory flush mode is required.");
      }
      if (memoryMode === "off" && checkpointMode === "off") {
        await platform.completeFlush(flush, [], 0);
        return;
      }
      if (memoryMode !== "off" && !memorySpaceId) {
        throw new TypeError("Memory space is required for enabled memory flushes.");
      }
      if (
        flush.data.candidateCount !== undefined &&
        (checkpointMode !== "auto" || flush.data.checkpointCompleted === true)
      ) {
        await platform.completeFlush(
          flush,
          flush.data.memoryIds ?? [],
          flush.data.candidateCount,
          flush.data.rejectedCount ?? 0,
          flush.data.candidateKeys ?? [],
          flush.data.checkpointId,
        );
        return;
      }
      const run = await platform.findRun(scope, runId);
      const tenancyScope = {
        ...scope,
        ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
      };
      const [runMessages, modelTokenQuantity, { modelCatalog, modelId, release }] =
        await Promise.all([
          platform.messagesForThread(scope, run.data.threadId, 40, runId),
          platform.modelTokenQuantityForRun(scope, runId),
          platform.agentReleaseForRun(scope, run).then(async (release) => {
            let modelId = runModelId;
            if (dependencies.flushModelId) {
              const admission = await (dependencies.admitFlushModel ?? admitMemoryFlushModel)(
                dependencies.flushModelId,
                { agentId: release.data.agentDefinitionId, runId, scope: tenancyScope },
              );
              if (admission.admitted) {
                modelId = dependencies.flushModelId;
              } else {
                console.warn(
                  "Memory flush model is not admitted; the flush uses the agent's model.",
                  {
                    flushId: flush.data.id,
                    flushModelId: dependencies.flushModelId,
                    modelId: runModelId,
                    reason: admission.reason,
                  },
                );
              }
            }
            const modelCatalog = await memoryFlushModelCatalog(
              modelId,
              dependencies.getModelCatalogEntries ??
                ((modelIds) => makeModelCatalogPersistence(runtimeDatabase()).getEntries(modelIds)),
            );
            return { modelCatalog, modelId, release };
          }),
        ]);
      const manifestRuntime =
        normalizeModelId(modelId) === normalizeModelId(release.data.manifest.spec.model.id)
          ? release.data.manifest.spec.runtime
          : undefined;
      const modelRuntime: MemoryFlushModelRuntime | undefined =
        manifestRuntime || modelCatalog
          ? { ...manifestRuntime, ...(modelCatalog ? { modelCatalog } : {}) }
          : undefined;
      const transcriptPrivacy = release.data.manifest.spec.memory?.transcriptPrivacy ?? "omit";
      const currentMessages = [...runMessages].reverse();
      const recentMessages = await Promise.all(
        currentMessages.map(async (message) => {
          const content = message.data.body ?? (await platform.resolveMessageContent(message));
          return content
            ? {
                content: sanitizeMemoryConversationContent(content, transcriptPrivacy),
                createdAt: message.data.createdAt,
                role: message.data.role,
              }
            : undefined;
        }),
      );
      const availableMessages = recentMessages.filter(
        (message): message is NonNullable<typeof message> => message !== undefined,
      );
      const memoryFlushRequired = shouldRunMemoryFlush({
        memoryMode,
        modelTokenQuantity,
        recentMessageCount: availableMessages.length,
      });
      const currentThroughSequence = currentMessages.at(-1)?.data.sequence;
      const previousCheckpoint =
        checkpointMode === "auto" && currentThroughSequence !== undefined
          ? await platform.latestConversationCheckpoint(
              scope,
              run.data.threadId,
              Math.max(0, currentThroughSequence - 1),
            )
          : undefined;
      const checkpointMessages =
        checkpointMode === "auto" && currentThroughSequence !== undefined
          ? await platform.messagesForConversationCheckpoint(
              scope,
              run.data.threadId,
              currentThroughSequence,
              previousCheckpoint
                ? previousCheckpoint.data.throughSequence -
                    (previousCheckpoint.data.throughMessageCharacterOffset === undefined ? 0 : 1)
                : undefined,
              512,
            )
          : [];
      const checkpointTranscript = await Promise.all(
        checkpointMessages.map(async (message, index) => {
          const content = message.data.body ?? (await platform.resolveMessageContent(message));
          if (content === undefined) {
            throw new TypeError(
              `Checkpoint message ${message.data.sequence} content is unavailable.`,
            );
          }
          const previousOffset =
            index === 0 &&
            previousCheckpoint?.data.throughSequence === message.data.sequence &&
            previousCheckpoint.data.throughMessageCharacterOffset !== undefined
              ? previousCheckpoint.data.throughMessageCharacterOffset
              : 0;
          return {
            content: content.slice(previousOffset),
            createdAt: message.data.createdAt,
            role: message.data.role,
          };
        }),
      );
      const initialCheckpointBatch = selectMemoryFlushMessageBatch({
        checkpointMode,
        maximumCharacters: memoryFlushRequired
          ? MEMORY_FLUSH_CHECKPOINT_TRANSCRIPT_CHARS
          : MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS,
        recentMessages: checkpointTranscript,
      });
      const checkpointRequired = checkpointMode === "auto" && initialCheckpointBatch.length > 0;
      if (!memoryFlushRequired && !checkpointRequired) {
        await platform.completeFlush(flush, [], 0);
        return;
      }
      let checkpointCharacterBudget = checkpointRequired
        ? memoryFlushRequired
          ? MEMORY_FLUSH_CHECKPOINT_TRANSCRIPT_CHARS
          : MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS
        : 0;
      let memoryCharacterBudget = memoryFlushRequired
        ? checkpointRequired
          ? MEMORY_FLUSH_CURRENT_RUN_TRANSCRIPT_CHARS
          : MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS
        : 0;
      let checkpointBatch = initialCheckpointBatch;
      let prompt = "";
      const promptInputTokenBudget = dependencies.promptInputTokenBudget
        ? dependencies.promptInputTokenBudget(modelId)
        : memoryFlushModelBudget(modelId, modelRuntime).promptInputTokenBudget;
      if (!Number.isSafeInteger(promptInputTokenBudget) || promptInputTokenBudget < 1) {
        throw new TypeError("Memory flush prompt input token budget must be a positive integer.");
      }
      const correctionReserve = checkpointRequired ? CHECKPOINT_COMPACTION_PROMPT_RESERVE_BYTES : 0;
      while (true) {
        checkpointBatch = checkpointRequired
          ? selectMemoryFlushMessageBatch({
              checkpointMode,
              maximumCharacters: checkpointCharacterBudget,
              recentMessages: checkpointTranscript,
            })
          : [];
        const memoryMessages = memoryFlushRequired
          ? selectMemoryFlushMessageBatch({
              checkpointMode: "off",
              maximumCharacters: memoryCharacterBudget,
              recentMessages: availableMessages,
            }).map((selection) => selection.message)
          : [];
        const availableCheckpointMessages = checkpointBatch.map((selection, index) => {
          const sanitizedSource = sanitizeMemoryConversationContent(
            checkpointTranscript[index]!.content,
          );
          return {
            ...selection.message,
            content:
              sanitizedSource === "[omitted sensitive content]"
                ? sanitizedSource
                : sanitizeMemoryConversationContent(selection.message.content),
          };
        });
        prompt = buildMemoryFlushPrompt({
          ...(checkpointRequired ? { checkpointMessages: availableCheckpointMessages } : {}),
          checkpointMode,
          memoryMode,
          ...(previousCheckpoint
            ? {
                previousCheckpoint: previousCheckpoint.data.summary,
                ...(previousCheckpoint.data.fromMessageCreatedAt
                  ? {
                      previousCheckpointFromCreatedAt: previousCheckpoint.data.fromMessageCreatedAt,
                    }
                  : {}),
                ...(previousCheckpoint.data.throughMessageCreatedAt
                  ? {
                      previousCheckpointThroughCreatedAt:
                        previousCheckpoint.data.throughMessageCreatedAt,
                    }
                  : {}),
              }
            : {}),
          recentMessages: memoryMessages,
        });
        if (
          new TextEncoder().encode(prompt).byteLength + correctionReserve <=
          promptInputTokenBudget
        )
          break;
        const nextCheckpointBudget = Math.floor(checkpointCharacterBudget / 2);
        const nextMemoryBudget = Math.floor(memoryCharacterBudget / 2);
        if (
          nextCheckpointBudget === checkpointCharacterBudget &&
          nextMemoryBudget === memoryCharacterBudget
        ) {
          throw new TypeError("Memory flush prompt cannot fit the selected model input budget.");
        }
        checkpointCharacterBudget = nextCheckpointBudget;
        memoryCharacterBudget = nextMemoryBudget;
      }
      if (checkpointRequired && checkpointBatch.length === 0) {
        throw new TypeError(
          "Memory flush checkpoint transcript cannot fit the model input budget.",
        );
      }
      const completionInput = {
        agentId: release.data.agentDefinitionId,
        modelId,
        ...(modelRuntime ? { modelRuntime } : {}),
        observability: {
          captureMode: run.data.captureMode,
          ...(run.data.parentSpanId ? { parentSpanId: run.data.parentSpanId } : {}),
          runSpanId: run.data.spanId,
          sessionId: run.data.threadId,
          traceId: run.data.traceId,
          ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
        },
        prompt,
        runId,
        scope: tenancyScope,
      };
      let parsed: MemoryFlushCompletion;
      let correction = "";
      for (let attempt = 1; ; attempt += 1) {
        const completion = await (dependencies.generateCompletion ?? generateFlushCompletion)({
          ...completionInput,
          modelCallId: `memory-flush:${flush.data.id}:attempt:${flush.data.attempt}:completion:${attempt}`,
          prompt: correction ? `${prompt}\n\n${correction}` : prompt,
        });
        try {
          parsed = parseMemoryFlushResult(completion);
          break;
        } catch (cause) {
          if (
            !checkpointRequired ||
            !(cause instanceof MemoryCheckpointSizeError) ||
            attempt >= CHECKPOINT_COMPACTION_MAX_ATTEMPTS
          ) {
            throw cause;
          }
          correction = `Rewrite attempt ${attempt + 1}: the rejected checkpoint was ${cause.byteLength} UTF-8 bytes, above the ${cause.maximumBytes}-byte limit. Return complete JSON again, with the checkpoint rewritten to at most ${Math.floor(cause.maximumBytes / 2)} bytes. Compress wording and merge related facts while preserving names, boundaries, commitments, event times, and current narrative state. Do not append to or mechanically truncate the previous checkpoint.`;
        }
      }
      if (checkpointRequired && !parsed.checkpoint) {
        throw new TypeError("Memory flush completion must contain a checkpoint string.");
      }
      const sanitizedCheckpoint = parsed.checkpoint
        ? sanitizeMemoryConversationContent(parsed.checkpoint)
        : undefined;
      if (
        checkpointRequired &&
        (!sanitizedCheckpoint || sanitizedCheckpoint === "[omitted sensitive content]")
      ) {
        throw new TypeError("Memory flush checkpoint did not pass privacy filtering.");
      }
      const importsMemories =
        memoryFlushRequired && memoryMode !== "off" && memorySpaceId !== undefined;
      const rejectedByParse = importsMemories ? parsed.rejected : [];
      if (rejectedByParse.length > 0) {
        console.warn("Memory flush dropped invalid memories.", {
          flushId: flush.data.id,
          rejected: rejectedByParse,
        });
      }
      const imported = importsMemories
        ? await platform.importFlushCandidates(tenancyScope, {
            candidates: parsed.memories,
            flushId: flush.data.id,
            memoryMode: memoryMode as MemoryScope | "off",
            memorySpaceId,
            reviewMode,
            run,
            transcriptPrivacy,
          })
        : { candidateKeys: [], imported: [], rejected: [], replayed: [] };
      const candidateKeys = [
        ...new Set([...(flush.data.candidateKeys ?? []), ...(imported.candidateKeys ?? [])]),
      ];
      const memoryIds = [
        ...new Set([
          ...(flush.data.memoryIds ?? []),
          ...[...imported.imported, ...imported.replayed].map((memory) => memory.data.id),
        ]),
      ];
      progress = {
        candidateKeys,
        checkpointCompleted: false,
        completionModelId: modelId,
        memoryIds,
        rejectedCount: Math.max(
          flush.data.rejectedCount ?? 0,
          rejectedByParse.length + imported.rejected.length,
        ),
      };
      const firstCheckpointMessage = checkpointMessages[0];
      const lastCheckpointMessage = checkpointMessages[checkpointBatch.length - 1];
      const lastCheckpointSelection = checkpointBatch.at(-1);
      const fullyCoveredCheckpointMessages = checkpointBatch.filter(
        (selection) => selection.consumedCharacters >= selection.sourceCharacters,
      ).length;
      const lastMessageBaseOffset =
        checkpointBatch.length === 1 &&
        firstCheckpointMessage &&
        previousCheckpoint?.data.throughSequence === firstCheckpointMessage.data.sequence
          ? (previousCheckpoint.data.throughMessageCharacterOffset ?? 0)
          : 0;
      const throughMessageCharacterOffset =
        lastCheckpointSelection &&
        lastCheckpointSelection.consumedCharacters < lastCheckpointSelection.sourceCharacters
          ? lastMessageBaseOffset + lastCheckpointSelection.consumedCharacters
          : undefined;
      const checkpoint =
        checkpointRequired &&
        sanitizedCheckpoint &&
        sanitizedCheckpoint !== "[omitted sensitive content]" &&
        firstCheckpointMessage &&
        lastCheckpointMessage
          ? await platform.saveConversationCheckpoint(scope, {
              ...(run.data.executionBindingId === undefined
                ? { agentDeploymentId: run.data.agentDeploymentId }
                : {
                    executionBindingId: run.data.executionBindingId,
                    executionPurpose: run.data.executionPurpose,
                  }),
              ...(!previousCheckpoint || previousCheckpoint.data.fromMessageCreatedAt
                ? {
                    fromMessageCreatedAt:
                      previousCheckpoint?.data.fromMessageCreatedAt ??
                      firstCheckpointMessage.data.createdAt,
                  }
                : {}),
              fromSequence:
                previousCheckpoint?.data.fromSequence ?? firstCheckpointMessage.data.sequence,
              runId,
              sourceMessageCount:
                (previousCheckpoint?.data.sourceMessageCount ?? 0) + fullyCoveredCheckpointMessages,
              summary: sanitizedCheckpoint,
              threadId: run.data.threadId,
              ...(throughMessageCharacterOffset !== undefined
                ? { throughMessageCharacterOffset }
                : {}),
              throughMessageCreatedAt: lastCheckpointMessage.data.createdAt,
              throughSequence: lastCheckpointMessage.data.sequence,
            })
          : previousCheckpoint;
      progress = {
        ...progress,
        checkpointCompleted: true,
        ...(checkpoint?.data.id ? { checkpointId: checkpoint.data.id } : {}),
      };
      await platform.completeFlush(
        flush,
        memoryIds,
        candidateKeys.length,
        progress.rejectedCount,
        candidateKeys,
        progress.checkpointId,
        modelId,
      );
    } catch (cause) {
      await platform.failFlush(flush, cause, progress);
      if (acknowledgesPermanentFailure(cause, record.messageId, flush.data.id)) return;
      throw cause;
    }
  });
}

const configuredFlushModelId = process.env.DEPLOYMENTS_AI_MEMORY_FLUSH_MODEL?.trim();

export const handler = (event: QueueEventLike) =>
  handleMemoryFlushQueue(
    event,
    configuredFlushModelId ? { flushModelId: configuredFlushModelId } : {},
  );
