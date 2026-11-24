import { describe, expect, test } from "bun:test";
import type { ReasoningDetail } from "@deployments-ai/model-gateway";
import { validateGenerationReasoning } from "./generation-reasoning.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import type {
  RuntimeModelGenerationRequest,
  RuntimeModelGenerationResult,
  RuntimeProgressEvent,
} from "./types.ts";

const OPUS = "openrouter/anthropic/claude-opus-5.5";
const signedText = {
  format: "anthropic-claude-v1",
  index: 0,
  signature: "c2ln",
  text: "Check the account.",
  type: "reasoning.text",
} satisfies ReasoningDetail;

function runtimeWith(
  results: readonly RuntimeModelGenerationResult[],
  progress: RuntimeProgressEvent[],
  action: "allow" | "require-approval" = "allow",
) {
  let generation = 0;
  return createTestAgentRuntime({
    appendProgress: async (event) => {
      progress.push(event);
    },
    authorizeToolCall: async () =>
      action === "allow"
        ? { action, reason: "Read is allowed.", toolCallId: id("20") }
        : { action, approvalId: id("21"), reason: "Approval is required.", toolCallId: id("20") },
    executeToolCall: async () => ({ outputSummary: "account is active", status: "completed" }),
    generateAssistantMessage: async () => results[generation++]!,
  });
}

const readAccount = {
  assistantMessage: "",
  reasoningDetails: [signedText],
  toolCalls: [
    { input: { resource: "account" }, modelToolCallId: "toolu_1", toolName: "provider.read" },
  ],
} satisfies RuntimeModelGenerationResult;

const captureOutcomes = (progress: readonly RuntimeProgressEvent[]) =>
  progress
    .filter((event) => event.eventType === "model.generation.completed")
    .map((event) => event.metadata?.reasoningCapture);

describe("generation reasoning capture in a run", () => {
  test("carries a paused generation's reasoning in its model continuation", async () => {
    const progress: RuntimeProgressEvent[] = [];
    const paused = await runtimeWith([readAccount], progress, "require-approval").execute(
      input({ modelFallbackIds: [], modelId: OPUS, modelToolNames: ["provider.read"] }),
    );

    expect(paused.completionStatus).toBe("waiting-for-approval");
    expect<unknown>(paused.modelContinuation?.generationReasoning).toEqual([
      {
        details: [signedText],
        modelCallIndex: 0,
        producerAttemptId: `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
        producerModelId: OPUS,
      },
    ]);
    expect(captureOutcomes(progress)).toEqual([{ bytes: 115, kind: "captured" }]);
    expect(JSON.stringify(progress)).not.toContain("c2ln");
  });

  test("reports why a generation kept no reasoning", async () => {
    const progress: RuntimeProgressEvent[] = [];
    const result = await runtimeWith(
      [readAccount, { assistantMessage: "The account is active.", reasoningDetails: [signedText] }],
      progress,
    ).execute(input({ modelToolNames: ["provider.read"] }));

    expect(result.assistantMessage).toBe("The account is active.");
    expect(captureOutcomes(progress)).toEqual([
      { kind: "skipped", reason: "unsupported-route" },
      { kind: "skipped", reason: "no-tool-calls" },
    ]);
  });
});

describe("generation reasoning in the persistence transaction budget", () => {
  async function checkpoint(modelId: string, signatureBytes: number) {
    let generation = 0;
    let nextToolId = 20;
    const result = await createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Read is allowed.",
        toolCallId: id(String(nextToolId++)),
      }),
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({
        assistantMessage: "",
        reasoningDetails: [{ ...signedText, signature: "s".repeat(signatureBytes) }],
        toolCalls: [
          {
            input: { resource: "account" },
            modelToolCallId: `toolu_${generation++}`,
            toolName: "provider.read",
          },
        ],
      }),
    }).execute(
      input({
        maxModelGenerations: 24,
        maxToolCalls: 48,
        modelFallbackIds: [],
        modelId,
        modelToolNames: ["provider.read"],
      }),
    );
    return {
      completionStatus: result.completionStatus,
      generations: result.modelContinuation?.modelCallCount,
      reasoningGenerations: result.modelContinuation?.generationReasoning.length,
    };
  }

  test("checkpoints single-tool generations sooner when each one adds a reasoning record", async () => {
    expect(await checkpoint(OPUS, 4)).toEqual({
      completionStatus: "checkpointed",
      generations: 8,
      reasoningGenerations: 8,
    });
    expect(await checkpoint("openrouter/qwen/qwen3.7-plus", 4)).toEqual({
      completionStatus: "checkpointed",
      generations: 10,
      reasoningGenerations: 0,
    });
  });

  test("checkpoints once unpersisted reasoning leaves no room for another 64 KiB generation", async () => {
    expect(await checkpoint(OPUS, 60 * 1_024)).toEqual({
      completionStatus: "checkpointed",
      generations: 3,
      reasoningGenerations: 3,
    });
  });

  test("does not charge a resumed run for reasoning its run record already stores", async () => {
    const requests = [0, 1, 2].map((modelCallIndex) => ({
      effect: "read" as const,
      idempotencyKey: `${id("7")}:model-tool:${modelCallIndex}:0`,
      input: { resource: "account" },
      inputSummary: "Model requested provider.read.",
      requiredScopes: [],
      toolName: "provider.read",
    }));
    const generations: RuntimeModelGenerationRequest[] = [];

    const result = await createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("Completed calls must not be reauthorized.");
      },
      executeToolCall: async () => {
        throw new Error("Completed calls must not run again.");
      },
      generateAssistantMessage: async (request) => {
        generations.push(request);
        return { assistantMessage: "The account is active." };
      },
    }).execute(
      input({
        completedToolCalls: requests.map((request, index) => ({
          ...request,
          outputSummary: "account is active",
          policyAction: "allow" as const,
          policyReason: "Read is allowed.",
          toolCallId: id(String(20 + index)),
        })),
        modelContinuation: {
          generationReasoning: validateGenerationReasoning(
            requests.map((_, modelCallIndex) => ({
              details: [{ ...signedText, signature: "s".repeat(60 * 1_024) }],
              modelCallIndex,
              producerAttemptId: `${id("7")}:execution:1:assistant:${modelCallIndex}`,
              producerModelId: OPUS,
            })),
            3,
          ),
          modelCallCount: 3,
          toolRequests: requests,
        },
        modelFallbackIds: [],
        modelId: OPUS,
        modelToolNames: ["provider.read"],
      }),
    );

    expect(result.completionStatus).toBe("completed");
    expect(generations.map((request) => [...(request.replayReasoning?.keys() ?? [])])).toEqual([
      [0, 1, 2],
    ]);
  });
});
