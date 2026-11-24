import { describe, expect, it } from "bun:test";
import type { MemoryPlatform } from "@deployments-ai/memory";
import { operatorGrantAllowsModel } from "@deployments-ai/model-gateway";
import { handleMemoryFlushQueue } from "./flush-worker.ts";
import {
  scope,
  privateModelId,
  agentDefinitionId,
  agentReleaseForRun,
} from "./flush-worker-test-support.ts";

describe("memory flush worker", () => {
  it("checkpoints an agent-scoped custom model using its pinned context budget", async () => {
    let saved: Readonly<Record<string, unknown>> | undefined;
    let receivedPrompt = "";
    const messages = [
      {
        data: {
          body: "My interview is tomorrow.",
          createdAt: "2026-08-10T18:30:00.000Z",
          role: "user",
          sequence: 0,
        },
      },
      {
        data: {
          body: "I'll check in after it.",
          createdAt: "2026-08-10T18:31:00.000Z",
          role: "assistant",
          sequence: 1,
        },
      },
    ];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          checkpointMode: "auto",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "off",
          modelId: privateModelId,
          status: "running",
        },
      }),
      completeFlush: async () => undefined,
      failFlush: async () => undefined,
      findRun: async () => ({
        data: {
          agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      latestConversationCheckpoint: async () => undefined,
      messagesForConversationCheckpoint: async () => messages,
      messagesForThread: async () => messages.toReversed(),
      modelTokenQuantityForRun: async () => 0,
      resolveMessageContent: async () => undefined,
      saveConversationCheckpoint: async (
        _scope: unknown,
        input: Readonly<Record<string, unknown>>,
      ) => {
        saved = input;
        return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
      },
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:checkpoint-run",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-checkpoint",
          },
        ],
      },
      {
        generateCompletion: async ({ agentId, modelId, prompt }) => {
          expect(
            operatorGrantAllowsModel(
              [
                {
                  agentId: agentDefinitionId,
                  allowedModels: [privateModelId],
                  organizationId: scope.organizationId,
                  providers: ["openrouter"],
                },
              ],
              { agentId, organizationId: scope.organizationId },
              modelId,
            ),
          ).toBe(true);
          receivedPrompt = prompt;
          return JSON.stringify({
            checkpoint: "Rowan has an interview tomorrow; check in afterward.",
            memories: [],
          });
        },
        getModelCatalogEntries: async () => new Map(),
        platform,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(receivedPrompt).toContain("[2026-08-10T18:30:00.000Z] user: My interview is tomorrow.");
    expect(saved).toMatchObject({
      fromMessageCreatedAt: "2026-08-10T18:30:00.000Z",
      fromSequence: 0,
      sourceMessageCount: 2,
      throughMessageCreatedAt: "2026-08-10T18:31:00.000Z",
      throughSequence: 1,
    });
  });

  it("advances checkpoints only through the contiguous transcript prefix sent to the model", async () => {
    let saved: Readonly<Record<string, unknown>> | undefined;
    const messages = Array.from({ length: 10 }, (_, sequence) => ({
      data: {
        body: sequence === 0 ? `x${" ".repeat(20_000)}tail` : `${sequence}:${"x".repeat(20_000)}`,
        role: sequence % 2 === 0 ? ("user" as const) : ("assistant" as const),
        sequence,
      },
    }));
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          checkpointMode: "auto",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "off",
          status: "running",
        },
      }),
      completeFlush: async () => undefined,
      failFlush: async () => undefined,
      findRun: async () => ({
        data: {
          agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      latestConversationCheckpoint: async () => undefined,
      messagesForConversationCheckpoint: async () => messages,
      messagesForThread: async () => messages.toReversed(),
      modelTokenQuantityForRun: async () => 0,
      resolveMessageContent: async () => undefined,
      saveConversationCheckpoint: async (
        _scope: unknown,
        input: Readonly<Record<string, unknown>>,
      ) => {
        saved = input;
        return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
      },
    } as unknown as MemoryPlatform;

    await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:bounded-checkpoint",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-bounded-checkpoint",
          },
        ],
      },
      {
        generateCompletion: async () =>
          JSON.stringify({ checkpoint: "Bounded rolling summary.", memories: [] }),
        platform,
      },
    );

    expect(saved).toMatchObject({
      fromSequence: 0,
      sourceMessageCount: 0,
      throughMessageCharacterOffset: 12_000,
      throughSequence: 0,
    });
  });

  it("bounds Unicode checkpoint prompts and advances only through raw content sent", async () => {
    let receivedPrompt = "";
    let saved: Readonly<Record<string, unknown>> | undefined;
    const body = "😀".repeat(12_000);
    const messages = [{ data: { body, role: "user" as const, sequence: 0 } }];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          checkpointMode: "auto",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "off",
          status: "running",
        },
      }),
      completeFlush: async () => undefined,
      failFlush: async () => undefined,
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      latestConversationCheckpoint: async () => undefined,
      messagesForConversationCheckpoint: async () => messages,
      messagesForThread: async () => messages,
      modelTokenQuantityForRun: async () => 0,
      resolveMessageContent: async () => undefined,
      saveConversationCheckpoint: async (
        _scope: unknown,
        input: Readonly<Record<string, unknown>>,
      ) => {
        saved = input;
        return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
      },
    } as unknown as MemoryPlatform;

    await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:unicode-checkpoint",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-unicode-checkpoint",
          },
        ],
      },
      {
        generateCompletion: async ({ prompt }) => {
          receivedPrompt = prompt;
          return JSON.stringify({ checkpoint: "Bounded Unicode summary.", memories: [] });
        },
        platform,
        promptInputTokenBudget: () => 10_000,
      },
    );

    expect(new TextEncoder().encode(receivedPrompt).byteLength).toBeLessThanOrEqual(10_000);
    expect(saved).toMatchObject({
      fromSequence: 0,
      sourceMessageCount: 0,
      throughSequence: 0,
    });
    expect(saved?.throughMessageCharacterOffset).toBeNumber();
    expect(saved?.throughMessageCharacterOffset).toBeLessThan(body.length);
  });

  it("retries checkpoints instead of advancing past unavailable message content", async () => {
    let completions = 0;
    let generated = 0;
    let saves = 0;
    const message = {
      data: {
        bodyRef: { bucket: "artifacts", key: "messages/unavailable" },
        role: "user" as const,
        sequence: 0,
      },
    };
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          checkpointMode: "auto",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "off",
          status: "running",
        },
      }),
      completeFlush: async () => {
        completions += 1;
      },
      failFlush: async () => undefined,
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      latestConversationCheckpoint: async () => undefined,
      messagesForConversationCheckpoint: async () => [message],
      messagesForThread: async () => [message],
      modelTokenQuantityForRun: async () => 0,
      resolveMessageContent: async () => undefined,
      saveConversationCheckpoint: async () => {
        saves += 1;
        return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
      },
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:unavailable-checkpoint-content",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-unavailable-checkpoint-content",
          },
        ],
      },
      {
        generateCompletion: async () => {
          generated += 1;
          return JSON.stringify({ checkpoint: "Must not be saved.", memories: [] });
        },
        platform,
      },
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-unavailable-checkpoint-content" }],
    });
    expect({ completions, generated, saves }).toEqual({ completions: 0, generated: 0, saves: 0 });
  });

  it("retries when privacy filtering rejects a required checkpoint summary", async () => {
    let completions = 0;
    let saves = 0;
    const message = { data: { body: "Remember this.", role: "user" as const, sequence: 0 } };
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          checkpointMode: "auto",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "off",
          status: "running",
        },
      }),
      completeFlush: async () => {
        completions += 1;
      },
      failFlush: async () => undefined,
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      latestConversationCheckpoint: async () => undefined,
      messagesForConversationCheckpoint: async () => [message],
      messagesForThread: async () => [message],
      modelTokenQuantityForRun: async () => 0,
      resolveMessageContent: async () => undefined,
      saveConversationCheckpoint: async () => {
        saves += 1;
        return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
      },
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:rejected-checkpoint-summary",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-rejected-checkpoint-summary",
          },
        ],
      },
      {
        generateCompletion: async () =>
          JSON.stringify({ checkpoint: "Email rowan@example.com tomorrow.", memories: [] }),
        platform,
      },
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-rejected-checkpoint-summary" }],
    });
    expect({ completions, saves }).toEqual({ completions: 0, saves: 0 });
  });

  it("resumes a partially checkpointed message before advancing its sequence", async () => {
    let saved: Readonly<Record<string, unknown>> | undefined;
    const message = {
      data: { body: `0:${"x".repeat(20_000)}`, role: "user" as const, sequence: 0 },
    };
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          checkpointMode: "auto",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "off",
          status: "running",
        },
      }),
      completeFlush: async () => undefined,
      failFlush: async () => undefined,
      findRun: async () => ({
        data: {
          agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      latestConversationCheckpoint: async () => ({
        data: {
          fromSequence: 0,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAF",
          sourceMessageCount: 0,
          summary: "Partial message summary.",
          throughMessageCharacterOffset: 12_000,
          throughSequence: 0,
        },
      }),
      messagesForConversationCheckpoint: async () => [message],
      messagesForThread: async () => [message],
      modelTokenQuantityForRun: async () => 0,
      resolveMessageContent: async () => undefined,
      saveConversationCheckpoint: async (
        _scope: unknown,
        input: Readonly<Record<string, unknown>>,
      ) => {
        saved = input;
        return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
      },
    } as unknown as MemoryPlatform;

    await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:partial-checkpoint",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-partial-checkpoint",
          },
        ],
      },
      {
        generateCompletion: async () =>
          JSON.stringify({ checkpoint: "Complete message summary.", memories: [] }),
        platform,
      },
    );

    expect(saved).toMatchObject({
      fromSequence: 0,
      sourceMessageCount: 1,
      throughSequence: 0,
    });
    expect(saved).not.toHaveProperty("throughMessageCharacterOffset");
  });

  it("keeps current-run memory extraction alongside checkpoint backlog work", async () => {
    let prompt = "";
    let importedCandidates: readonly unknown[] = [];
    const currentMessages = [
      { data: { body: "Current user preference.", role: "user" as const, sequence: 10 } },
      { data: { body: "Current assistant reply.", role: "assistant" as const, sequence: 11 } },
    ];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          checkpointMode: "auto",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "agent",
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          status: "running",
        },
      }),
      completeFlush: async () => undefined,
      failFlush: async () => undefined,
      findRun: async () => ({
        data: {
          agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      importFlushCandidates: async (_scope: unknown, input: { candidates: readonly unknown[] }) => {
        importedCandidates = input.candidates;
        return { candidateKeys: [], imported: [], rejected: [], replayed: [] };
      },
      latestConversationCheckpoint: async () => undefined,
      messagesForConversationCheckpoint: async () => [
        { data: { body: "Old uncovered conversation.", role: "user", sequence: 0 } },
      ],
      messagesForThread: async () => currentMessages.toReversed(),
      modelTokenQuantityForRun: async () => 16_000,
      resolveMessageContent: async () => undefined,
      saveConversationCheckpoint: async () => ({
        data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" },
      }),
    } as unknown as MemoryPlatform;

    await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:combined-context",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-combined-context",
          },
        ],
      },
      {
        generateCompletion: async (input) => {
          prompt = input.prompt;
          return JSON.stringify({
            checkpoint: "Old conversation summarized.",
            memories: [{ content: "Current user preference.", memoryType: "preference" }],
          });
        },
        platform,
      },
    );

    expect(prompt).toContain("Old uncovered conversation.");
    expect(prompt).toContain("Current user preference.");
    expect(prompt).toContain("use only for the checkpoint");
    expect(prompt).toContain("use for durable memory extraction");
    expect(importedCandidates).toHaveLength(1);
  });

  it("retries incomplete checkpoint persistence and reuses a saved checkpoint", async () => {
    let persistedProgress:
      | {
          readonly candidateKeys: readonly string[];
          readonly checkpointCompleted?: boolean;
          readonly checkpointId?: string;
          readonly memoryIds: readonly string[];
          readonly rejectedCount: number;
        }
      | undefined;
    let generated = 0;
    let saves = 0;
    let completions = 0;
    const messages = [{ data: { body: "Checkpoint me.", role: "user" as const, sequence: 0 } }];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: generated + 1,
          candidateCount: persistedProgress?.candidateKeys.length,
          candidateKeys: persistedProgress?.candidateKeys,
          checkpointCompleted: persistedProgress?.checkpointCompleted,
          checkpointId: persistedProgress?.checkpointId,
          checkpointMode: "auto",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryIds: persistedProgress?.memoryIds ?? [],
          memoryMode: "off",
          rejectedCount: persistedProgress?.rejectedCount,
          status: "running",
        },
      }),
      completeFlush: async () => {
        completions += 1;
        if (completions === 1) throw new Error("completion write failed");
      },
      failFlush: async (_flush: unknown, _cause: unknown, progress: typeof persistedProgress) => {
        persistedProgress = progress;
      },
      findRun: async () => ({
        data: {
          agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      latestConversationCheckpoint: async () => undefined,
      messagesForConversationCheckpoint: async () => messages,
      messagesForThread: async () => messages,
      modelTokenQuantityForRun: async () => 0,
      resolveMessageContent: async () => undefined,
      saveConversationCheckpoint: async () => {
        saves += 1;
        if (saves === 1) throw new Error("checkpoint write failed");
        return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
      },
    } as unknown as MemoryPlatform;
    const event = {
      Records: [
        {
          body: JSON.stringify({
            detail: {
              ...scope,
              idempotencyKey: "memory-flush:checkpoint-recovery",
              runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
            },
          }),
          messageId: "message-checkpoint-recovery",
        },
      ],
    };
    const dependencies = {
      generateCompletion: async () => {
        generated += 1;
        return JSON.stringify({ checkpoint: "Recovered checkpoint.", memories: [] });
      },
      platform,
    };

    expect(await handleMemoryFlushQueue(event, dependencies)).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-checkpoint-recovery" }],
    });
    expect(await handleMemoryFlushQueue(event, dependencies)).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-checkpoint-recovery" }],
    });
    expect(await handleMemoryFlushQueue(event, dependencies)).toEqual({
      batchItemFailures: [],
    });
    expect({ completions, generated, saves }).toEqual({ completions: 2, generated: 2, saves: 2 });
    expect(persistedProgress).toMatchObject({
      checkpointCompleted: true,
      checkpointId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
    });
  });
});
