import { describe, expect, it } from "bun:test";
import type { MemoryPlatform } from "@deployments-ai/memory";
import { handleMemoryFlushQueue } from "./flush-worker.ts";
import { scope, agentReleaseForRun } from "./flush-worker-test-support.ts";

describe("memory flush worker", () => {
  it("claims a flush, extracts candidates, imports them, and completes the attempt", async () => {
    const calls: string[] = [];
    let importedScope: unknown;
    let receivedPrompt = "";
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => {
        calls.push("claim");
        return {
          data: {
            attempt: 1,
            id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
            memoryMode: "workspace",
            memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
            status: "running",
          },
        };
      },
      completeFlush: async (
        _flush: unknown,
        memoryIds: readonly string[],
        candidateCount: number,
      ) => {
        calls.push(`complete:${memoryIds.join(",")}:${candidateCount}`);
      },
      failFlush: async () => {
        calls.push("fail");
      },
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        },
      }),
      importFlushCandidates: async (
        receivedScope: unknown,
        input: { candidates: readonly unknown[] },
      ) => {
        importedScope = receivedScope;
        calls.push(`import:${input.candidates.length}`);
        return {
          candidateKeys: ["candidate-0"],
          imported: [{ data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAC" } }],
          rejected: [],
          replayed: [],
        };
      },
      messagesForThread: async () => [
        {
          data: {
            bodyRef: { bucket: "artifacts", key: "messages/1" },
            role: "assistant",
          },
        },
      ],
      modelTokenQuantityForRun: async () => 16_000,
      resolveMessageContent: async () => "Production changes happen Tuesday.",
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      {
        generateCompletion: async (input) => {
          const { prompt } = input;
          receivedPrompt = prompt;
          return JSON.stringify({
            memories: [
              {
                confidence: 0.9,
                content: "Use the Tuesday production change window.",
                scope: "workspace",
              },
            ],
          });
        },
        platform,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(calls).toEqual(["claim", "import:1", "complete:01ARZ3NDEKTSV4RRFFQ69G5FAC:1"]);
    expect(importedScope).toMatchObject({ workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAB" });
    expect(receivedPrompt).toContain("Production changes happen Tuesday.");
  });

  it("completes off-mode flushes without reading messages or calling the model", async () => {
    const calls: string[] = [];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "off",
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          status: "running",
        },
      }),
      completeFlush: async (
        _flush: unknown,
        memoryIds: readonly string[],
        candidateCount: number,
      ) => {
        calls.push(`complete:${memoryIds.length}:${candidateCount}`);
      },
      failFlush: async () => {
        calls.push("fail");
      },
      findRun: async () => {
        throw new Error("run must not be loaded");
      },
      messagesForThread: async () => {
        throw new Error("messages must not be loaded");
      },
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      {
        generateCompletion: async () => {
          throw new Error("model must not be called");
        },
        platform,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(calls).toEqual(["complete:0:0"]);
  });

  it("omits secret-like transcript content before calling the flush model", async () => {
    let receivedPrompt = "";
    const secret = "sk-live-abcdefghijklmnop";
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "workspace",
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          status: "running",
        },
      }),
      completeFlush: async () => undefined,
      failFlush: async () => undefined,
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        },
      }),
      importFlushCandidates: async () => ({ imported: [], rejected: [], replayed: [] }),
      messagesForThread: async () => [
        { data: { body: `API key: ${secret}`, role: "user" } },
        { data: { body: "Patient diagnosis: hypertension.", role: "user" } },
        { data: { body: "Production changes happen Tuesday.", role: "assistant" } },
      ],
      modelTokenQuantityForRun: async () => 16_000,
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      {
        generateCompletion: async ({ prompt }) => {
          receivedPrompt = prompt;
          return JSON.stringify({ memories: [] });
        },
        platform,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(receivedPrompt).toContain("[omitted sensitive content]");
    expect(receivedPrompt).not.toContain(secret);
    expect(receivedPrompt).not.toContain("hypertension");
    expect(receivedPrompt).toContain("Production changes happen Tuesday.");
  });

  async function flushPrompt(transcriptPrivacy: "redact" | "retain") {
    let receivedPrompt = "";
    let importedWith: unknown;
    const platform = {
      agentReleaseForRun: async () => {
        const release = await agentReleaseForRun();
        return {
          data: {
            ...release.data,
            manifest: {
              spec: { ...release.data.manifest.spec, memory: { mode: "agent", transcriptPrivacy } },
            },
          },
        };
      },
      claimFlush: async () => ({
        data: {
          attempt: 1,
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
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        },
      }),
      importFlushCandidates: async (_scope: unknown, args: { transcriptPrivacy?: string }) => {
        importedWith = args.transcriptPrivacy;
        return { imported: [], rejected: [], replayed: [] };
      },
      messagesForThread: async () => [
        { data: { body: "API key: [REDACTED:sk-secret]", role: "user" } },
        {
          data: {
            body: "From: hello@florist.example. The deposit is 500 USD, due March 1. Call 602-555-0110.",
            role: "user",
          },
        },
        { data: { body: "Patient diagnosis: hypertension.", role: "user" } },
      ],
      modelTokenQuantityForRun: async () => 16_000,
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      {
        generateCompletion: async ({ prompt }) => {
          receivedPrompt = prompt;
          return JSON.stringify({
            memories: [{ content: "The deposit is due March 1.", scope: "agent" }],
          });
        },
        platform,
      },
    );
    expect(result).toEqual({ batchItemFailures: [] });
    expect(receivedPrompt).not.toContain("[REDACTED:sk-secret]");
    expect(receivedPrompt).toContain("Patient diagnosis: hypertension.");
    return { importedWith, receivedPrompt };
  }

  it("redacts personal data instead of omitting the message when the agent opts in", async () => {
    const { importedWith, receivedPrompt } = await flushPrompt("redact");
    expect(receivedPrompt).toContain(
      "From: [redacted email]. The deposit is 500 USD, due March 1. Call [redacted phone].",
    );
    expect(receivedPrompt).not.toContain("hello@florist.example");
    expect(importedWith).toBe("redact");
  });

  it("keeps personal data as written when the agent retains it", async () => {
    const { importedWith, receivedPrompt } = await flushPrompt("retain");
    expect(receivedPrompt).toContain(
      "From: hello@florist.example. The deposit is 500 USD, due March 1. Call 602-555-0110.",
    );
    expect(importedWith).toBe("retain");
  });

  it("completes short low-token flushes without calling the model", async () => {
    const calls: string[] = [];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "workspace",
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          status: "running",
        },
      }),
      completeFlush: async (
        _flush: unknown,
        memoryIds: readonly string[],
        candidateCount: number,
      ) => calls.push(`complete:${memoryIds.length}:${candidateCount}`),
      failFlush: async () => calls.push("fail"),
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      messagesForThread: async () => [{ data: { body: "Thanks.", role: "assistant" } }],
      modelTokenQuantityForRun: async () => 100,
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      {
        generateCompletion: async () => {
          throw new Error("model must not be called");
        },
        platform,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(calls).toEqual(["complete:0:0"]);
  });

  it("extracts a normal two-message turn even when token usage is low", async () => {
    let modelCalls = 0;
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
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
          agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      importFlushCandidates: async () => ({ imported: [], rejected: [], replayed: [] }),
      messagesForThread: async () => [
        { data: { body: "I love hiking in Sedona.", role: "user" } },
        { data: { body: "noted babe 😘", role: "assistant" } },
      ],
      modelTokenQuantityForRun: async () => 50,
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      {
        generateCompletion: async () => {
          modelCalls += 1;
          return JSON.stringify({ memories: [] });
        },
        platform,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(modelCalls).toBe(1);
  });

  it("fails and retries a flush when the model completion is malformed", async () => {
    const calls: string[] = [];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "workspace",
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          status: "running",
        },
      }),
      completeFlush: async () => {
        calls.push("complete");
      },
      failFlush: async () => {
        calls.push("fail");
      },
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
      }),
      importFlushCandidates: async () => {
        calls.push("import");
        return { imported: [], rejected: [], replayed: [] };
      },
      messagesForThread: async () => [
        { data: { body: "Production changes happen Tuesday.", role: "assistant" } },
      ],
      modelTokenQuantityForRun: async () => 16_000,
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      { generateCompletion: async () => "truncated json {", platform },
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
    expect(calls).toEqual(["fail"]);
  });

  it("completes a flush with accepted imports and rejection accounting", async () => {
    const calls: string[] = [];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "workspace",
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          status: "running",
        },
      }),
      completeFlush: async (
        _flush: unknown,
        _memoryIds: readonly string[],
        _candidateCount: number,
        rejectedCount: number,
      ) => calls.push(`complete:${rejectedCount}`),
      failFlush: async () => calls.push("fail"),
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        },
      }),
      importFlushCandidates: async () => ({
        candidateKeys: ["candidate-0"],
        imported: [],
        rejected: [{ index: 0, reason: "workspace scope was invalid" }],
        replayed: [],
      }),
      messagesForThread: async () => [
        { data: { body: "Production changes happen Tuesday.", role: "assistant" } },
      ],
      modelTokenQuantityForRun: async () => 16_000,
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      {
        generateCompletion: async () =>
          JSON.stringify({
            memories: [{ content: "Use the Tuesday window.", scope: "workspace" }],
          }),
        platform,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(calls).toEqual(["complete:1"]);
  });

  it("imports the valid memories of a completion that holds an invalid one", async () => {
    const calls: string[] = [];
    let importedCandidates: readonly unknown[] = [];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: 1,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          memoryMode: "workspace",
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          status: "running",
        },
      }),
      completeFlush: async (
        _flush: unknown,
        _memoryIds: readonly string[],
        _candidateCount: number,
        rejectedCount: number,
      ) => calls.push(`complete:${rejectedCount}`),
      failFlush: async () => calls.push("fail"),
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        },
      }),
      importFlushCandidates: async (_scope: unknown, input: { candidates: readonly unknown[] }) => {
        importedCandidates = input.candidates;
        return {
          candidateKeys: ["candidate-0", "candidate-1"],
          imported: [],
          rejected: [],
          replayed: [],
        };
      },
      messagesForThread: async () => [
        { data: { body: "Production changes happen Tuesday.", role: "assistant" } },
      ],
      modelTokenQuantityForRun: async () => 16_000,
    } as unknown as MemoryPlatform;

    const result = await handleMemoryFlushQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                ...scope,
                idempotencyKey: "memory-flush:run-1",
                runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              },
            }),
            messageId: "message-1",
          },
        ],
      },
      {
        generateCompletion: async () =>
          JSON.stringify({
            memories: [
              { content: "Use the Tuesday window.", scope: "workspace" },
              {
                content: "Change freeze this week.",
                validFrom: "2026-03-10T00:00:00Z",
                validUntil: "2026-03-03T00:00:00Z",
              },
              {
                content: "Shipped the Tuesday release on 2026-03-03.",
                validFrom: "2026-03-03T00:00:00Z",
                validUntil: "2026-03-03T00:00:00Z",
              },
            ],
          }),
        platform,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(importedCandidates).toEqual([
      { content: "Use the Tuesday window.", scope: "workspace" },
      {
        content: "Shipped the Tuesday release on 2026-03-03.",
        validFrom: "2026-03-03T00:00:00.000Z",
      },
    ]);
    expect(calls).toEqual(["complete:1"]);
  });

  it("reuses persisted extraction progress after completion fails", async () => {
    const flushId = "01ARZ3NDEKTSV4RRFFQ69G5FA7";
    const importIdentities: string[] = [];
    let generatedCompletions = 0;
    let completionAttempts = 0;
    let persistedProgress:
      | {
          readonly candidateKeys: readonly string[];
          readonly memoryIds: readonly string[];
          readonly rejectedCount: number;
        }
      | undefined;
    let completedMemoryIds: readonly string[] = [];
    const platform = {
      agentReleaseForRun,
      claimFlush: async () => ({
        data: {
          attempt: completionAttempts + 1,
          candidateCount: persistedProgress?.candidateKeys.length,
          candidateKeys: persistedProgress?.candidateKeys,
          id: flushId,
          memoryMode: "workspace",
          memoryIds: persistedProgress?.memoryIds ?? [],
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          rejectedCount: persistedProgress?.rejectedCount,
          status: "running",
        },
      }),
      completeFlush: async (_flush: unknown, memoryIds: readonly string[]) => {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("completion write failed");
        completedMemoryIds = memoryIds;
      },
      failFlush: async (_flush: unknown, _cause: unknown, progress: typeof persistedProgress) => {
        persistedProgress = progress;
      },
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        },
      }),
      importFlushCandidates: async (_scope: unknown, input: { flushId: string }) => {
        importIdentities.push(input.flushId);
        return {
          candidateKeys: ["candidate-C"],
          imported: [{ data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAC" } }],
          rejected: [],
          replayed: [],
        };
      },
      messagesForThread: async () => [
        { data: { body: "Production changes happen Tuesday.", role: "assistant" } },
      ],
      modelTokenQuantityForRun: async () => 16_000,
    } as unknown as MemoryPlatform;
    const event = {
      Records: [
        {
          body: JSON.stringify({
            detail: {
              ...scope,
              idempotencyKey: "memory-flush:run-1",
              runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
            },
          }),
          messageId: "message-1",
        },
      ],
    };
    const dependencies = {
      generateCompletion: async () => {
        generatedCompletions += 1;
        return JSON.stringify({
          memories: [
            {
              content: "Use the Tuesday window.",
              scope: "workspace",
            },
          ],
        });
      },
      platform,
    };

    expect(handleMemoryFlushQueue(event, dependencies)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
    expect(handleMemoryFlushQueue(event, dependencies)).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(generatedCompletions).toBe(1);
    expect(importIdentities).toEqual([flushId]);
    expect(completedMemoryIds).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAC"]);
  });
});
