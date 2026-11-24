import { describe, expect, it } from "bun:test";
import type { AgentResponseDepthPolicy } from "@deployments-ai/agent-manifest";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { RuntimeModelInvocationPersistenceError, runtimeExecutionFailureState } from "./errors.ts";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import {
  createTestAgentRuntime,
  id,
  input,
  type CustomerAgentRunInput,
} from "./runtime.fixture.ts";
import type {
  AgentRunInput,
  RuntimeApprovedToolCall,
  RuntimeModelGenerationRequest,
  RuntimeProgressEvent,
} from "./types.ts";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";

const policy: AgentResponseDepthPolicy = {
  classifierInstructions:
    "Select default for ordinary chat or detailed for developed explanations.",
  detailedInstructions: "Develop the explanation in complete paragraphs.",
  minimumWords: 8,
  maximumWords: 16,
};
const developedAnswer =
  "The mechanism transfers stored energy through a sequence of controlled movements.";
const depthInput = (overrides: Partial<CustomerAgentRunInput> = {}) =>
  input({
    modelFallbackIds: [],
    modelInputTokenBudget: 31_744,
    modelOutputTokenReserve: 1_024,
    responseDepthPolicy: policy,
    ...overrides,
  });

function usage(modelCallId: string) {
  return {
    costUsdMicros: 25,
    idempotencyKey: `${modelCallId}:usage`,
    inputTokens: 40,
    occurredAt: 2,
    outputTokens: 10,
    quantity: 50,
    source: "model-gateway",
    type: "model_tokens",
    unit: "tokens",
  };
}

function recordedRuntime(replies: readonly string[]) {
  const requests: ModelGatewayChatCompletionRequest[] = [];
  const invocations: RuntimeModelInvocationAttempt[] = [];
  const progress: RuntimeProgressEvent[] = [];
  const gateway = {
    chatCompletion: (request: ModelGatewayChatCompletionRequest) => {
      const assistantMessage = replies[requests.length];
      requests.push(request);
      if (assistantMessage === undefined) throw new Error("Unexpected extra model generation");
      if (!request.modelCallId) throw new Error("Expected a scoped model call identity");
      return Effect.succeed({
        assistantMessage,
        body: {},
        finishReason: "stop",
        inputTokens: 40,
        modelCallId: request.modelCallId,
        modelId: request.modelId,
        outputTokens: 10,
        route: {},
        totalTokens: 50,
        usage: usage(request.modelCallId),
      } as never);
    },
  } as unknown as ModelGatewayService;
  return {
    requests,
    invocations,
    progress,
    runtime: createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event),
      generateAssistantMessage: modelGatewayGenerationPort(gateway),
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    }),
  };
}

describe("private response depth execution", () => {
  it("meters private selection and rejected drafts separately and only delivers the valid answer", async () => {
    const rejectedSelection = "private-selector-explanation";
    const rejectedDraft = "private-rejected-draft";
    const { runtime, requests, invocations, progress } = recordedRuntime([
      rejectedSelection,
      "detailed",
      rejectedDraft,
      developedAnswer,
    ]);

    const result = await runtime.execute(depthInput());

    expect(result.assistantMessage).toBe(developedAnswer);
    expect(result.modelContinuation).toBeUndefined();
    expect(invocations.map((attempt) => attempt.status)).toEqual([
      "failed",
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(requests.map((request) => request.modelCallId)).toEqual([
      `${id("7")}:execution:1:response-depth:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:response-depth:0:run-attempt:0:fallback:1`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:1`,
    ]);
    expect(invocations.every((attempt) => attempt.internalEvaluator === false)).toBe(true);
    const metered = result.usage.filter((entry) => entry.type === "model_tokens");
    expect(metered.map((entry) => entry.quantity)).toEqual([50, 50, 50, 50]);
    expect(new Set(metered.map((entry) => entry.idempotencyKey)).size).toBe(4);
    expect(invocations.map((attempt) => attempt.usageIdempotencyKey)).toEqual(
      metered.map((entry) => entry.idempotencyKey),
    );
    const published = JSON.stringify({ result, invocations, progress });
    expect(published).not.toContain(rejectedSelection);
    expect(published).not.toContain(rejectedDraft);
  });

  it("regenerates overlong default answers without publishing drafts or losing charges", async () => {
    const rejectedDraft = "private ordinary draft that exceeds the cap";
    const answer = "The account is active.";
    const { runtime, requests, invocations, progress } = recordedRuntime([
      "default",
      rejectedDraft,
      answer,
    ]);
    const result = await runtime.execute(
      depthInput({
        responseDepthPolicy: { ...policy, defaultMaximumWords: 4 },
        recentMessages: [{ role: "assistant", content: developedAnswer }],
      }),
    );

    expect(result.assistantMessage).toBe(answer);
    expect(result.modelContinuation).toBeUndefined();
    expect(invocations.map((attempt) => attempt.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(requests.map((request) => request.modelCallId)).toEqual([
      `${id("7")}:execution:1:response-depth:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:1`,
    ]);
    expect(
      invocations.map(({ fallbackAttempt, invocationKind, modelCallIndex }) => ({
        fallbackAttempt,
        invocationKind,
        modelCallIndex,
      })),
    ).toEqual([
      { fallbackAttempt: 0, invocationKind: "response-depth", modelCallIndex: 0 },
      { fallbackAttempt: 0, invocationKind: "assistant", modelCallIndex: 0 },
      { fallbackAttempt: 1, invocationKind: "assistant", modelCallIndex: 0 },
    ]);
    expect(invocations.every((attempt) => attempt.internalEvaluator === false)).toBe(true);
    const metered = result.usage.filter((entry) => entry.type === "model_tokens");
    expect(metered.map((entry) => entry.quantity)).toEqual([50, 50, 50]);
    expect(new Set(metered.map((entry) => entry.idempotencyKey)).size).toBe(3);
    expect(invocations.map((attempt) => attempt.usageIdempotencyKey)).toEqual(
      metered.map((entry) => entry.idempotencyKey),
    );
    expect(JSON.stringify({ result, invocations, progress })).not.toContain(rejectedDraft);
  });

  it("fails closed on bounded malformed selections without publishing or silently choosing default", async () => {
    const secret = "private-invalid-selection";
    const { runtime, requests, invocations, progress } = recordedRuntime([secret, secret]);
    const delivered: string[] = [];
    const failure = await runtime
      .execute(depthInput())
      .then((result) => delivered.push(result.assistantMessage))
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect(delivered).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(invocations.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
    const retained = runtimeExecutionFailureState(failure);
    expect(retained?.modelContinuation).toBeUndefined();
    expect(
      retained?.usage
        .filter((entry) => entry.type === "model_tokens")
        .map((entry) => entry.quantity),
    ).toEqual([50, 50]);
    expect(
      JSON.stringify({ retained, invocations, progress, error: String(failure) }),
    ).not.toContain(secret);
  });

  it("retains all charges when bounded detailed retries are exhausted without persisting drafts", async () => {
    const { runtime, invocations, progress } = recordedRuntime([
      "detailed",
      "private-short-draft",
      "private-second-draft",
    ]);
    const failure = await runtime.execute(depthInput()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(invocations.map((attempt) => attempt.status)).toEqual(["succeeded", "failed", "failed"]);
    const retained = runtimeExecutionFailureState(failure);
    expect(retained?.usage.filter((entry) => entry.type === "model_tokens")).toHaveLength(3);
    expect(retained?.modelContinuation).toBeUndefined();
    expect(
      JSON.stringify({ retained, invocations, progress, error: String(failure) }),
    ).not.toContain("private-short-draft");
    expect(
      JSON.stringify({ retained, invocations, progress, error: String(failure) }),
    ).not.toContain("private-second-draft");
  });

  it("preserves legacy default answers and leaves unconfigured requests unclassified", async () => {
    const answer = `${developedAnswer} ${developedAnswer}`;
    const selected = recordedRuntime(["default", answer]);
    const ordinary = await selected.runtime.execute(depthInput());
    expect(ordinary.assistantMessage).toBe(answer);
    expect(selected.invocations.map((attempt) => attempt.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    const unconfigured = recordedRuntime([answer]);
    const legacy = await unconfigured.runtime.execute(
      input({
        modelFallbackIds: [],
        modelInputTokenBudget: 31_744,
        modelOutputTokenReserve: 1_024,
      }),
    );
    expect(legacy.assistantMessage).toBe(answer);
    expect(unconfigured.requests.map((request) => request.modelCallId)).toEqual([
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
    ]);
  });

  it("does not let assistant recovery indices skip the private selection budget", async () => {
    const { runtime, requests } = recordedRuntime(["detailed", developedAnswer]);
    const result = await runtime.execute(depthInput({ modelFallbackStartIndex: 1 }));
    expect(result.assistantMessage).toBe(developedAnswer);
    expect(requests.map((request) => request.modelCallId)).toEqual([
      `${id("7")}:execution:1:response-depth:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:1`,
    ]);
  });

  it("caches selection through an uninterrupted tool loop without consuming an assistant slot", async () => {
    const modelCallIds: string[] = [];
    let selections = 0;
    let executions = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "allowed",
        toolCallId: id("20"),
      }),
      executeToolCall: async () => {
        executions += 1;
        return { outputSummary: "Account is active.", status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        modelCallIds.push(request.modelCallId);
        if (request.modelCallId.includes(":response-depth:")) {
          selections += 1;
          return { assistantMessage: "detailed" };
        }
        return executions === 0
          ? {
              assistantMessage: "",
              toolCalls: [{ modelToolCallId: "read-account", toolName: "provider.read" }],
            }
          : { assistantMessage: developedAnswer };
      },
    });
    const result = await runtime.execute(depthInput({ modelToolNames: ["provider.read"] }));
    expect(result.assistantMessage).toBe(developedAnswer);
    expect(result.modelContinuation).toBeUndefined();
    expect(selections).toBe(1);
    expect(executions).toBe(1);
    expect(modelCallIds).toEqual([
      `${id("7")}:execution:1:response-depth:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:1:run-attempt:0:fallback:0`,
    ]);
  });

  it("rejects a malformed persisted mode before resuming its tool", async () => {
    let operations = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        operations += 1;
        return { action: "allow", reason: "allowed", toolCallId: id("20") };
      },
      generateAssistantMessage: async () => {
        operations += 1;
        return { assistantMessage: "Unexpected response" };
      },
    });
    const failure = await runtime
      .execute(
        depthInput({
          modelContinuation: {
            modelCallCount: 1,
            responseDepthMode: "invalid",
            toolRequests: [
              {
                effect: "read",
                idempotencyKey: `${id("7")}:model-tool:0:0`,
                inputSummary: "Model requested provider.read.",
                requiredScopes: [],
                toolName: "provider.read",
              },
            ],
          } as unknown as NonNullable<AgentRunInput["modelContinuation"]>,
        }),
      )
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(operations).toBe(0);
  });

  it("rejects classifier tool calls before persistence or tool execution", async () => {
    const invocations: RuntimeModelInvocationAttempt[] = [];
    let calls = 0;
    let executions = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "allowed",
        toolCallId: id("20"),
      }),
      executeToolCall: async () => {
        executions += 1;
        return { outputSummary: "Unexpected execution", status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        calls += 1;
        return {
          assistantMessage: "default",
          toolCalls: [{ modelToolCallId: "invalid-private-call", toolName: "provider.read" }],
          usage: [usage(request.modelCallId)],
        };
      },
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    });
    const failure = await runtime
      .execute(depthInput({ modelToolNames: ["provider.read"] }))
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(calls).toBe(2);
    expect(executions).toBe(0);
    expect(invocations.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
    expect(runtimeExecutionFailureState(failure)?.modelContinuation).toBeUndefined();
  });

  it("honors in-flight classifier cancellation while retaining its customer-billed usage", async () => {
    const controller = new AbortController();
    const invocations: RuntimeModelInvocationAttempt[] = [];
    let calls = 0;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        calls += 1;
        controller.abort();
        return { assistantMessage: "detailed", usage: [usage(request.modelCallId)] };
      },
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    });
    const result = await runtime.execute(depthInput({ signal: controller.signal }));
    expect(result.completionStatus).toBe("canceled");
    expect(result.assistantMessage).not.toBe("detailed");
    expect(result.modelContinuation).toBeUndefined();
    expect(calls).toBe(1);
    expect(invocations.map((attempt) => [attempt.status, attempt.internalEvaluator])).toEqual([
      ["canceled", false],
    ]);
    expect(
      result.usage.filter((entry) => entry.type === "model_tokens").map((entry) => entry.quantity),
    ).toEqual([50]);
  });

  it("propagates private invocation ledger failures without another provider call", async () => {
    let calls = 0;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        calls += 1;
        return { assistantMessage: "detailed", usage: [usage(request.modelCallId)] };
      },
      recordModelInvocation: async () => {
        throw new Error("ledger unavailable");
      },
    });
    const failure = await runtime.execute(depthInput()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RuntimeModelInvocationPersistenceError);
    expect(calls).toBe(1);
    expect(
      runtimeExecutionFailureState(failure)
        ?.usage.filter((entry) => entry.type === "model_tokens")
        .map((entry) => entry.quantity),
    ).toEqual([50]);
  });

  it("reuses the selected mode across approval and completed-tool replay without renumbering slots", async () => {
    const requests: RuntimeModelGenerationRequest[] = [];
    const firstRuntime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "require-approval",
        approvalId: id("21"),
        reason: "Approval is required.",
        toolCallId: id("20"),
      }),
      executeToolCall: async () => {
        throw new Error("Approval is required first");
      },
      generateAssistantMessage: async (request) => {
        requests.push(request);
        if (requests.length === 1) return { assistantMessage: "detailed" };
        return {
          assistantMessage: "",
          toolCalls: [
            {
              input: { resource: "account" },
              modelToolCallId: "read-account",
              toolName: "provider.read",
            },
          ],
        };
      },
    });
    const paused = await firstRuntime.execute(depthInput({ modelToolNames: ["provider.read"] }));
    expect(paused.completionStatus).toBe("waiting-for-approval");
    expect(paused.modelContinuation).toMatchObject({
      modelCallCount: 1,
      responseDepthMode: "detailed",
    });
    const pending = paused.pendingAction;
    if (pending?.kind !== "approval" || !paused.modelContinuation) {
      throw new Error("Expected model-tool approval continuation");
    }
    expect(pending.idempotencyKey).toBe(`${id("7")}:model-tool:0:0`);
    const approved: RuntimeApprovedToolCall = {
      approvalId: pending.approvalId,
      effect: pending.effect,
      idempotencyKey: pending.idempotencyKey,
      ...(pending.input ? { input: pending.input } : {}),
      inputSummary: pending.inputSummary,
      policyReason: pending.policyReason,
      requiredScopes: pending.requiredScopes,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
    };
    let executions = 0;
    const resumedRuntime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("Must reuse approval");
      },
      executeToolCall: async () => {
        executions += 1;
        return { outputSummary: "Account is active.", status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        requests.push(request);
        return { assistantMessage: developedAnswer };
      },
    });
    const resumeInput = depthInput({
      approvedToolCalls: [approved],
      artifactContinuation: paused.artifactContinuation,
      completedToolCalls: paused.completedToolCalls,
      modelContinuation: paused.modelContinuation,
      modelToolNames: ["provider.read"],
      runAttempt: 1,
    });
    const completed = await resumedRuntime.execute(resumeInput);
    const replayed = await resumedRuntime.execute({
      ...resumeInput,
      approvedToolCalls: [],
      artifactContinuation: completed.artifactContinuation,
      completedToolCalls: completed.completedToolCalls,
      runAttempt: 2,
    });
    expect(executions).toBe(1);
    expect(completed.assistantMessage).toBe(developedAnswer);
    expect(replayed.assistantMessage).toBe(developedAnswer);
    expect(requests.map((request) => request.modelCallId)).toEqual([
      `${id("7")}:execution:1:response-depth:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:1:run-attempt:1:fallback:0`,
      `${id("7")}:execution:1:assistant:1:run-attempt:2:fallback:0`,
    ]);
    expect(requests.slice(1).map((request) => request.responseDepthMode)).toEqual([
      "detailed",
      "detailed",
      "detailed",
    ]);
    expect(completed.completedToolCalls.map((call) => call.idempotencyKey)).toEqual([
      `${id("7")}:model-tool:0:0`,
    ]);
    expect(replayed.completedToolCalls).toEqual(completed.completedToolCalls);
  });
});
