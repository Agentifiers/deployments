import { expect, test } from "bun:test";
import { MEMORY_CHECKPOINT_MAX_BYTES, type MemoryPlatform } from "@deployments-ai/memory";
import { handleMemoryFlushQueue } from "./flush-worker.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};
const runId = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
const messages = [
  { data: { body: "The interview moved to Friday.", role: "user", sequence: 8 } },
  { data: { body: "I'll check in afterward.", role: "assistant", sequence: 9 } },
];
const oversized = JSON.stringify({
  checkpoint: "é".repeat(MEMORY_CHECKPOINT_MAX_BYTES),
  memories: [],
});
const compact = "The interview moved to Friday; check in afterward. Avoid phone calls.";

async function exercise(completions: readonly string[], flushAttempt = 1) {
  const calls: { modelCallId: string; prompt: string }[] = [];
  const saved: Readonly<Record<string, unknown>>[] = [];
  const failures: unknown[] = [];
  let completed = false;
  const platform = {
    agentReleaseForRun: async () => ({
      data: {
        agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
        manifest: { spec: { model: { id: "openrouter/openai/gpt-4o" } } },
      },
    }),
    claimFlush: async () => ({
      data: {
        attempt: flushAttempt,
        checkpointMode: "auto",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
        memoryMode: "off",
        modelId: "openrouter/openai/gpt-4o",
        status: "running",
      },
    }),
    completeFlush: async () => {
      completed = true;
    },
    failFlush: async (_flush: unknown, cause: unknown) => {
      failures.push(cause);
    },
    findRun: async () => ({
      data: {
        agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
        id: runId,
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      },
    }),
    latestConversationCheckpoint: async () => ({
      data: {
        fromSequence: 0,
        sourceMessageCount: 8,
        summary: "Avoid phone calls. " + "Earlier context. ".repeat(490),
        throughSequence: 7,
      },
    }),
    messagesForConversationCheckpoint: async () => messages,
    messagesForThread: async () => messages.toReversed(),
    modelTokenQuantityForRun: async () => 0,
    resolveMessageContent: async () => undefined,
    saveConversationCheckpoint: async (
      _scope: unknown,
      input: Readonly<Record<string, unknown>>,
    ) => {
      saved.push(input);
      return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
    },
  } as unknown as MemoryPlatform;
  const result = await handleMemoryFlushQueue(
    {
      Records: [
        {
          body: JSON.stringify({ detail: { ...scope, idempotencyKey: "checkpoint-size", runId } }),
          messageId: "checkpoint-size-message",
        },
      ],
    },
    {
      generateCompletion: async (args) => {
        calls.push(args);
        return completions[Math.min(calls.length - 1, completions.length - 1)]!;
      },
      platform,
      promptInputTokenBudget: () => 12_500,
    },
  );
  return { calls, completed, failures, result, saved };
}

test("rewrites an oversized rolling checkpoint without truncating history or advancing rejected coverage", async () => {
  const proof = await exercise([oversized, JSON.stringify({ checkpoint: compact, memories: [] })]);
  expect(proof.result).toEqual({ batchItemFailures: [] });
  expect(proof.completed).toBe(true);
  expect(proof.saved).toEqual([
    expect.objectContaining({
      summary: compact,
      fromSequence: 0,
      throughSequence: 9,
      sourceMessageCount: 10,
    }),
  ]);
  expect(proof.calls).toHaveLength(2);
  expect(new Set(proof.calls.map((call) => call.modelCallId)).size).toBe(2);
  for (const call of proof.calls) {
    expect(new TextEncoder().encode(call.prompt).byteLength).toBeLessThanOrEqual(12_500);
    expect(call.prompt).toContain("Avoid phone calls.");
    expect(call.prompt).toContain("The interview moved to Friday.");
  }
  expect(proof.calls[1]!.prompt).not.toEqual(proof.calls[0]!.prompt);
  const retry = await exercise([JSON.stringify({ checkpoint: compact, memories: [] })], 2);
  expect(retry.calls[0]!.modelCallId).not.toBe(proof.calls[0]!.modelCallId);
});

test("fails closed after bounded compaction attempts without saving an oversized checkpoint", async () => {
  const proof = await exercise([oversized]);
  expect(proof.result).toEqual({
    batchItemFailures: [{ itemIdentifier: "checkpoint-size-message" }],
  });
  expect(proof.completed).toBe(false);
  expect(proof.saved).toEqual([]);
  expect(proof.calls).toHaveLength(3);
  expect(proof.failures).toHaveLength(1);
});

test("does not retry malformed memory extraction as a checkpoint-size failure", async () => {
  const proof = await exercise([JSON.stringify({ checkpoint: compact, memories: "none" })]);
  expect(proof.result).toEqual({
    batchItemFailures: [{ itemIdentifier: "checkpoint-size-message" }],
  });
  expect(proof.saved).toEqual([]);
  expect(proof.calls).toHaveLength(1);
});
