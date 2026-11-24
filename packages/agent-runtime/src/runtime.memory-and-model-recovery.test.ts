import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import type {
  AgentRunInput,
  RuntimeModelGenerationRequest,
  RuntimeProgressEvent,
} from "./types.ts";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime", () => {
  it("runs model adapter preflight before memory or tool side effects", async () => {
    let memoryRecalled = false;
    let toolAuthorized = false;
    const generateAssistantMessage = Object.assign(
      async () => ({ assistantMessage: "unexpected" }),
      {
        validateRunInput: (runInput: AgentRunInput) => {
          if ((runInput.skills?.length ?? 0) > 0) {
            throw new Error("Pinned skills are unsupported by this adapter.");
          }
        },
      },
    );
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        toolAuthorized = true;
        return { action: "allow", reason: "Allowed.", toolCallId: id("90") };
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage,
      recallMemory: async () => {
        memoryRecalled = true;
        return [];
      },
    });

    expect(
      runtime.execute(
        input({
          memoryMode: "agent",
          skills: ["managed-skill@1"],
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-after-skill-preflight",
              inputSummary: "Read after skill validation",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toThrow("Pinned skills are unsupported");
    expect(memoryRecalled).toBe(false);
    expect(toolAuthorized).toBe(false);
  });

  it("pins standalone identities, recalls memory, and falls back models", async () => {
    const requests: string[] = [];
    const modelCallIds: string[] = [];
    const responseRecoveries: RuntimeModelGenerationRequest["responseRecovery"][] = [];
    const progress: RuntimeProgressEvent[] = [];
    const responseInterpretation = {
      assistantCharacters: 0,
      disposition: "provider-empty",
      gatewayResponseShape: {
        normalized: {
          choiceCount: 1,
          choiceShape: "record",
          contentCharacters: 0,
          contentPartCount: 0,
          contentShape: "null",
          messageShape: "record",
          reasoningCarrier: "reasoning-content",
          reasoningCharacters: 27,
          reasoningShape: "text",
          toolCallCount: 0,
          toolCallsShape: "missing",
        },
        rawResponseShape: "missing",
      },
      providerAssistantCharacters: 0,
      providerToolCallCount: 0,
    } as const;
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event),
      generateAssistantMessage: async (request) => {
        requests.push(request.modelId);
        modelCallIds.push(request.modelCallId);
        responseRecoveries.push(request.responseRecovery);
        expect(request.agentDeploymentId).toBe(id("2"));
        expect(request.agentReleaseId).toBe(id("3"));
        expect(request.memories.map((memory) => memory.content)).toEqual(["Remember this."]);
        if (request.modelId === "openrouter/primary") {
          return {
            assistantMessage: "",
            metadata: { responseInterpretation },
            usage: [
              {
                idempotencyKey: `${request.runId}:primary-model`,
                occurredAt: 2,
                quantity: 5,
                source: "model-gateway",
                type: "model_tokens",
                unit: "tokens",
              },
            ],
          };
        }
        return {
          assistantMessage: "Completed with fallback.",
          resolvedModelId: "provider/fallback-2026-07-22",
          usage: [
            {
              idempotencyKey: `${request.runId}:model`,
              modelId: "provider/fallback-2026-07-22",
              occurredAt: 2,
              quantity: 12,
              source: "model-gateway",
              type: "model_tokens",
              unit: "tokens",
            },
          ],
        };
      },
      now: (() => {
        let value = 1;
        return () => value++;
      })(),
      recallMemory: async () => [
        {
          content: "Remember this.",
          memoryId: id("10"),
          score: 0.9,
          sensitivity: "internal",
        },
      ],
    });

    const result = await runtime.execute(input({ memoryMode: "agent" }));

    expect(requests).toEqual(["openrouter/primary", "openrouter/fallback"]);
    expect(modelCallIds).toEqual([
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:1`,
    ]);
    expect(responseRecoveries).toEqual([undefined, undefined]);
    expect(result.completionStatus).toBe("completed");
    expect(result.modelId).toBe("openrouter/fallback");
    expect(result.usage).toHaveLength(3);
    expect(progress).toContainEqual(
      expect.objectContaining({
        eventType: "model.generation.failed",
        metadata: expect.objectContaining({ responseInterpretation }),
      }),
    );
    expect(progress.map((event) => event.eventType)).toContain("memory.recall.completed");
    expect(progress.map((event) => event.eventType)).toContain("run.completed");
  });

  it("continues without automatic recall when supplemental memory is unavailable", async () => {
    const progress: RuntimeProgressEvent[] = [];
    const explicitMemory = {
      content: "An explicitly supplied preference.",
      memoryId: id("10"),
      score: 1,
      sensitivity: "internal" as const,
    };
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event),
      generateAssistantMessage: async (request) => {
        expect(request.memories).toEqual([explicitMemory]);
        return { assistantMessage: "Continued without automatic recall." };
      },
      recallMemory: async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });

    const result = await runtime.execute(
      input({ memoryMode: "agent", relevantMemories: [explicitMemory] }),
    );

    expect(result.assistantMessage).toBe("Continued without automatic recall.");
    expect(progress).toContainEqual(
      expect.objectContaining({
        eventType: "memory.recall.completed",
        level: "warn",
        message: "Runtime memory recall failed; continuing without recalled memory.",
        metadata: {
          degraded: true,
          error: "The operation was aborted due to timeout",
          memoryMode: "agent",
          recalledCount: 0,
        },
      }),
    );
    expect(progress.map((event) => event.eventType)).toContain("run.completed");
  });

  it("does not treat cancellation during automatic recall as degraded memory", async () => {
    let canceled = false;
    let generated = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => {
        generated = true;
        return { assistantMessage: "unexpected" };
      },
      recallMemory: async () => {
        canceled = true;
        throw new DOMException("The operation was aborted", "AbortError");
      },
      shouldCancel: async () => canceled,
    });

    const result = await runtime.execute(input({ memoryMode: "agent" }));

    expect(result.completionStatus).toBe("canceled");
    expect(generated).toBe(false);
  });

  it("retries one invalid single-route response across the durable metering boundary", async () => {
    const modelCallIds: string[] = [];
    const responseRecoveries: RuntimeModelGenerationRequest["responseRecovery"][] = [];
    const invocations: RuntimeModelInvocationAttempt[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        modelCallIds.push(request.modelCallId);
        responseRecoveries.push(request.responseRecovery);
        return modelCallIds.length === 1
          ? {
              assistantMessage: "",
              inputTokens: 1_227,
              metadata: { finishReason: "length" },
              outputTokens: 235,
              totalTokens: 1_462,
              usage: [
                {
                  idempotencyKey: `${request.modelCallId}:usage`,
                  inputTokens: 1_227,
                  occurredAt: 2,
                  outputTokens: 235,
                  quantity: 1_462,
                  source: "model-gateway",
                  type: "model_tokens",
                  unit: "tokens",
                },
              ],
            }
          : {
              assistantMessage: "hey rowan. what's up?",
              inputTokens: 1_227,
              metadata: { finishReason: "stop" },
              outputTokens: 6,
              totalTokens: 1_233,
              usage: [
                {
                  idempotencyKey: `${request.modelCallId}:usage`,
                  inputTokens: 1_227,
                  occurredAt: 3,
                  outputTokens: 6,
                  quantity: 1_233,
                  source: "model-gateway",
                  type: "model_tokens",
                  unit: "tokens",
                },
              ],
            };
      },
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    });

    const result = await runtime.execute(input({ modelFallbackIds: [] }));

    expect(result.assistantMessage).toBe("hey rowan. what's up?");
    expect(modelCallIds).toEqual([
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:1`,
    ]);
    expect(responseRecoveries).toEqual([undefined, "same-model-retry"]);
    expect(result.usage.map((entry) => entry.idempotencyKey)).toEqual([
      `${id("7")}:execution:1:attempt:0:worker-ms:completed`,
      `${modelCallIds[0]}:usage`,
      `${modelCallIds[1]}:usage`,
    ]);
    expect(invocations).toMatchObject([
      {
        fallbackAttempt: 0,
        status: "failed",
        usageIdempotencyKey: `${modelCallIds[0]}:usage`,
      },
      {
        fallbackAttempt: 1,
        status: "succeeded",
        usageIdempotencyKey: `${modelCallIds[1]}:usage`,
      },
    ]);
  });

  it("corrects an ordinary length-exhausted model response without publishing its prefix", async () => {
    const requests: ModelGatewayChatCompletionRequest[] = [];
    const gateway = {
      chatCompletion: (request: ModelGatewayChatCompletionRequest) => {
        requests.push(request);
        return Effect.succeed({
          assistantMessage:
            requests.length === 1
              ? "This synthetic response contains ordinary prose but keeps elaborating past the configured output boundary. ".repeat(
                  11,
                )
              : "synthetic retry completed",
          body: {},
          ...(requests.length === 1 ? { finishReason: "length" } : { finishReason: "stop" }),
          modelCallId: request.modelCallId,
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: modelGatewayGenerationPort(gateway),
    });

    const result = await runtime.execute(
      input({
        modelFallbackIds: [],
        modelId: "openrouter/example/custom-gemma4",
        modelInputTokenBudget: 8_192,
        modelOutputTokenReserve: 512,
        modelToolProtocol: "gemma4",
      }),
    );

    expect(result.assistantMessage).toBe("synthetic retry completed");
    expect(requests).toHaveLength(2);
  });

  it("reconstructs same-model recovery context after resuming at the second attempt", async () => {
    const responseRecoveries: RuntimeModelGenerationRequest["responseRecovery"][] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        responseRecoveries.push(request.responseRecovery);
        return { assistantMessage: "recovered synthetic response" };
      },
    });

    const result = await runtime.execute(
      input({ modelFallbackIds: [], modelFallbackStartIndex: 1 }),
    );

    expect(result.assistantMessage).toBe("recovered synthetic response");
    expect(responseRecoveries).toEqual(["same-model-retry"]);
  });

  it("routes memory and Brain separately and revalidates evidence at every model boundary", async () => {
    let revalidations = 0;
    let generations = 0;
    const evidence = {
      brainId: id("20"),
      chunkId: "chunk-1",
      coordinates: { end: 25, kind: "utf8-byte", start: 0 },
      documentId: id("21"),
      documentVersionId: id("22"),
      excerpt: "The signed source says the launch is Tuesday.",
      renditionId: id("23"),
      score: 0.95,
      sensitivity: "internal" as const,
      sourceId: id("24"),
      title: "Signed launch plan",
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        generations += 1;
        expect(request.memories.map((memory) => memory.content)).toEqual([
          "The user prefers short answers.",
        ]);
        expect(request.brainEvidence).toEqual([evidence]);
        return generations === 1
          ? { assistantMessage: "", responseError: "retry" }
          : { assistantMessage: "The launch is Tuesday." };
      },
      recallBrain: async (request) => {
        expect(request.brainRetrievalMode).toBe("hybrid");
        expect(request.memories).toHaveLength(1);
        return {
          brainRequired: true,
          evidence: [evidence],
          reasons: ["citation-request", "preference"],
          route: "both",
          unmetEvidenceRequirement: false,
        };
      },
      recallMemory: async () => [
        {
          content: "The user prefers short answers.",
          memoryId: id("10"),
          score: 0.9,
          sensitivity: "internal",
        },
      ],
      revalidateBrainEvidence: async (request) => {
        revalidations += 1;
        return request.evidence;
      },
    });

    const result = await runtime.execute(
      input({
        brainRetrievalMode: "hybrid",
        memoryMode: "agent",
        prompt: "Cite the launch plan and remember my preference.",
      }),
    );

    expect(result.assistantMessage).toBe("The launch is Tuesday.");
    expect(result.brainEvidence).toEqual([evidence]);
    expect(revalidations).toBe(2);
  });

  it("fails closed when required Brain evidence is unavailable", async () => {
    let generated = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => {
        generated = true;
        return { assistantMessage: "unexpected" };
      },
      recallBrain: async () => ({
        brainRequired: true,
        evidence: [],
        reasons: ["citation-request"],
        route: "neither",
        unmetEvidenceRequirement: true,
      }),
    });

    expect(
      runtime.execute(input({ brainRetrievalMode: "brain-first", prompt: "Cite the source." })),
    ).rejects.toThrow("requires live Brain evidence");
    expect(generated).toBe(false);
  });

  it("rejects excessive model fallback attempts before runtime side effects", async () => {
    let generated = false;
    let recalled = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => {
        generated = true;
        return { assistantMessage: "unexpected" };
      },
      recallMemory: async () => {
        recalled = true;
        return [];
      },
    });

    expect(
      runtime.execute(
        input({
          memoryMode: "agent",
          modelFallbackIds: ["fallback-1", "fallback-2", "fallback-3", "fallback-4"],
        }),
      ),
    ).rejects.toThrow("model attempts");
    expect(recalled).toBe(false);
    expect(generated).toBe(false);
  });

  it("fails when a pinned memory mode has no recall adapter", async () => {
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    expect(runtime.execute(input({ memoryMode: "thread" }))).rejects.toThrow(
      "requires a recallMemory port",
    );
  });

  it("rejects workspace memory recall without a workspace boundary", async () => {
    let recalled = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recallMemory: async () => {
        recalled = true;
        return [];
      },
    });

    const { workspaceId: _workspaceId, ...request } = input({ memoryMode: "workspace" });
    expect(runtime.execute(request)).rejects.toThrow("requires a workspaceId");
    expect(recalled).toBe(false);
  });
});
