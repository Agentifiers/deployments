import { describe, expect, test } from "bun:test";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";
import type {
  RuntimeApprovedToolCall,
  RuntimeModelGenerationRequest,
  RuntimePendingAction,
} from "./types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import { RuntimeHostShutdownError } from "./errors.ts";
import { validateRuntimeModelContinuation } from "./sandbox-continuation.ts";
import { stableSpanId } from "@deployments-ai/observability";

describe("model-native tool loop", () => {
  test("executes a release-pinned model tool and returns the next model answer", async () => {
    const generations: RuntimeModelGenerationRequest[] = [];
    const executed: string[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Read is allowed.",
        toolCallId: id("20"),
      }),
      executeToolCall: async (request) => {
        executed.push(request.toolName);
        return {
          artifacts: [
            {
              content: '{"resourceId":"account-123","status":"active"}',
              fileName: "resource.json",
              label: "Resource result",
              visibility: "private",
            },
          ],
          outputSummary: "resource value",
          status: "completed",
          transientArtifacts: [
            {
              content: '{"accessUrl":"https://temporary.example/resource"}',
              fileName: "resource-access.json",
              label: "Transient resource access",
              visibility: "private",
            },
          ],
        };
      },
      generateAssistantMessage: async (request) => {
        generations.push(request);
        return generations.length === 1
          ? {
              assistantMessage: "",
              toolCalls: [
                {
                  input: { resource: "account" },
                  modelToolCallId: "provider-call-1",
                  toolName: "provider.read",
                },
              ],
            }
          : { assistantMessage: "The resource value is ready." };
      },
    });

    const result = await runtime.execute(input({ modelToolNames: ["provider.read"] }));

    expect(result.completionStatus).toBe("completed");
    expect(result.assistantMessage).toBe("The resource value is ready.");
    expect(executed).toEqual(["provider.read"]);
    expect(generations).toHaveLength(2);
    expect(generations.map((request) => request.modelCallId)).toEqual([
      `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      `${id("7")}:execution:1:assistant:1:run-attempt:0:fallback:0`,
    ]);
    expect(generations[0]?.tools.map((tool) => tool.toolName)).toEqual(["provider.read"]);
    expect(generations[1]?.completedToolCalls).toHaveLength(1);
    expect(generations[1]?.sandboxArtifacts).toEqual([
      expect.objectContaining({ content: expect.stringContaining('"resourceId":"account-123"') }),
      expect.objectContaining({ content: expect.stringContaining("temporary.example") }),
    ]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.completedToolCalls[0]).toMatchObject({
      effect: "read",
      idempotencyKey: `${id("7")}:model-tool:0:0`,
      input: { resource: "account" },
      toolName: "provider.read",
    });
  });

  test("names the page a model-requested read targets in its running log line", async () => {
    const running: unknown[] = [];
    let calls = 0;
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => {
        if (event.eventType === "tool.running") running.push(event.metadata?.inputSummary);
      },
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(21 + calls++)),
      }),
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async (request) =>
        request.completedToolCalls.length > 0
          ? { assistantMessage: "Read it." }
          : {
              assistantMessage: "",
              toolCalls: [
                {
                  input: { url: "https://hotel.example/rooms" },
                  modelToolCallId: "fetch-1",
                  toolName: "provider.fetch",
                },
                { input: {}, modelToolCallId: "fetch-2", toolName: "provider.fetch" },
              ],
            },
    });

    await runtime.execute(input({ modelFallbackIds: [], modelToolNames: ["provider.fetch"] }));

    expect(running).toEqual([
      "Model requested provider.fetch for https://hotel.example/rooms.",
      "Model requested provider.fetch.",
    ]);
  });

  test("passes prior in-memory completions to later tool executions", async () => {
    const seenCompletedCounts: number[] = [];
    let generations = 0;
    let authorizations = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(30 + authorizations++)),
      }),
      executeToolCall: async (request) => {
        seenCompletedCounts.push(
          (
            (request as unknown as { readonly completedToolCalls?: readonly unknown[] })
              .completedToolCalls ?? []
          ).length,
        );
        return { outputSummary: request.toolName, status: "completed" };
      },
      generateAssistantMessage: async () => {
        generations += 1;
        return generations <= 2
          ? {
              assistantMessage: "",
              toolCalls: [
                {
                  modelToolCallId: `model-call-${generations}`,
                  toolName: "provider.read",
                },
              ],
            }
          : { assistantMessage: "done" };
      },
    });

    await runtime.execute(input({ modelToolNames: ["provider.read"] }));

    expect(seenCompletedCounts).toEqual([0, 1]);
  });

  test("does not charge provider-boundary invocation records to terminal capacity", async () => {
    const priorRequests = Array.from({ length: 26 }, (_, index) => ({
      effect: "read" as const,
      idempotencyKey: `completed-tool-${index}`,
      inputSummary: `Completed tool ${index}`,
      toolName: "provider.read",
    }));
    const priorCompleted = priorRequests.map((request, index) => ({
      ...request,
      policyAction: "allow" as const,
      policyReason: "Previously allowed.",
      requiredScopes: [],
      toolCallId: id(String(100 + index)),
    }));
    let generations = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Read is allowed.",
        toolCallId: id("500"),
      }),
      executeToolCall: async () => ({ outputSummary: "resource value", status: "completed" }),
      generateAssistantMessage: async () => {
        generations += 1;
        return generations === 1
          ? {
              assistantMessage: "",
              toolCalls: [
                {
                  input: { resource: "account" },
                  modelToolCallId: "capacity-tool-call",
                  toolName: "provider.read",
                },
              ],
            }
          : { assistantMessage: "Capacity-safe final answer." };
      },
    });

    const result = await runtime.execute(
      input({
        completedToolCalls: priorCompleted,
        modelToolNames: ["provider.read"],
        toolRequests: priorRequests,
      }),
    );

    expect(result.assistantMessage).toBe("Capacity-safe final answer.");
    expect(result.completedToolCalls).toHaveLength(27);
    expect(generations).toBe(2);
  });

  test("persists a selected model tool across approval without replaying the model", async () => {
    let pending: RuntimePendingAction | undefined;
    let firstGenerations = 0;
    const firstRuntime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "require-approval",
        approvalId: id("21"),
        reason: "Approval is required.",
        toolCallId: id("20"),
      }),
      executeToolCall: async () => {
        throw new Error("Tool must not execute before approval.");
      },
      generateAssistantMessage: async () => {
        firstGenerations += 1;
        return {
          assistantMessage: "",
          toolCalls: [
            {
              input: { resource: "account" },
              modelToolCallId: "provider-call-approval",
              toolName: "provider.read",
            },
          ],
        };
      },
    });

    const paused = await firstRuntime.execute(input({ modelToolNames: ["provider.read"] }));
    pending = paused.pendingAction;
    expect(paused.completionStatus).toBe("waiting-for-approval");
    expect(paused.modelContinuation).toMatchObject({ modelCallCount: 1 });
    expect(firstGenerations).toBe(1);
    if (pending?.kind !== "approval") throw new Error("Expected an approval continuation.");
    if (!paused.modelContinuation) throw new Error("Expected a model continuation.");
    const requester = {
      modelAttemptId: `${id("7")}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      modelCallIndex: 0,
    };
    expect(pending).toMatchObject(requester);
    expect(paused.modelContinuation.toolRequests).toEqual([expect.objectContaining(requester)]);

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
    let resumedGenerations = 0;
    let executions = 0;
    const resumedRuntime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("Approved continuation must not be reauthorized.");
      },
      executeToolCall: async () => {
        executions += 1;
        return { outputSummary: "approved result", status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        resumedGenerations += 1;
        expect(request.modelCallId).toBe(
          `${id("7")}:execution:1:assistant:1:run-attempt:0:fallback:0`,
        );
        expect(request.completedToolCalls).toHaveLength(1);
        return { assistantMessage: "Approved result delivered." };
      },
    });

    const completed = await resumedRuntime.execute(
      input({
        approvedToolCalls: [approved],
        artifactContinuation: paused.artifactContinuation,
        completedToolCalls: paused.completedToolCalls,
        modelContinuation: paused.modelContinuation,
        modelToolNames: ["provider.read"],
      }),
    );

    expect(completed.completionStatus).toBe("completed");
    expect(completed.assistantMessage).toBe("Approved result delivered.");
    expect(executions).toBe(1);
    expect(resumedGenerations).toBe(1);
    expect(completed.completedToolCalls).toEqual([expect.objectContaining(requester)]);
  });

  test("an approved tool call lets the resumed model call more tools", async () => {
    const paused = await createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "require-approval",
        approvalId: id("21"),
        reason: "Approval is required.",
        toolCallId: id("20"),
      }),
      executeToolCall: async () => {
        throw new Error("Tool must not execute before approval.");
      },
      generateAssistantMessage: async () => ({
        assistantMessage: "",
        toolCalls: [
          { input: { resource: "a" }, modelToolCallId: "first", toolName: "provider.read" },
        ],
      }),
    }).execute(input({ modelToolNames: ["provider.read"] }));
    const pending = paused.pendingAction;
    if (pending?.kind !== "approval") throw new Error("Expected an approval continuation.");
    if (!paused.modelContinuation) throw new Error("Expected a model continuation.");
    let nextToolId = 30;
    let generations = 0;
    const executed: unknown[] = [];
    const completed = await createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "allowed",
        toolCallId: id(String(nextToolId++)),
      }),
      executeToolCall: async (request) => {
        executed.push(request.input);
        return { outputSummary: "read", status: "completed" };
      },
      generateAssistantMessage: async () => {
        generations += 1;
        return generations === 1
          ? {
              assistantMessage: "",
              toolCalls: [
                { input: { resource: "b" }, modelToolCallId: "second", toolName: "provider.read" },
              ],
            }
          : { assistantMessage: "Both reads done." };
      },
    }).execute(
      input({
        approvedToolCalls: [
          {
            approvalId: pending.approvalId,
            effect: pending.effect,
            idempotencyKey: pending.idempotencyKey,
            ...(pending.input ? { input: pending.input } : {}),
            inputSummary: pending.inputSummary,
            policyReason: pending.policyReason,
            requiredScopes: pending.requiredScopes,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
          },
        ],
        artifactContinuation: paused.artifactContinuation,
        completedToolCalls: paused.completedToolCalls,
        modelContinuation: paused.modelContinuation,
        modelToolNames: ["provider.read"],
      }),
    );

    expect(completed.completionStatus).toBe("completed");
    expect(executed).toEqual([{ resource: "a" }, { resource: "b" }]);
    expect(completed.completedToolCalls).toHaveLength(2);
  });

  test("resumes a persisted model tool without making it selectable in the next generation", async () => {
    const persistedRequest = {
      effect: "read" as const,
      idempotencyKey: `${id("7")}:model-tool:0:0`,
      input: { resource: "account" },
      inputSummary: "Model requested provider.read.",
      requiredScopes: [],
      toolName: "provider.read",
    };
    const approved: RuntimeApprovedToolCall = {
      ...persistedRequest,
      approvalId: id("21"),
      policyReason: "Approved before the selectable tool catalog changed.",
      toolCallId: id("20"),
    };
    let executions = 0;
    const generations: RuntimeModelGenerationRequest[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("Approved continuation must not be reauthorized.");
      },
      executeToolCall: async () => {
        executions += 1;
        return { outputSummary: "account is active", status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        generations.push(request);
        return { assistantMessage: "The account is active." };
      },
    });

    const completed = await runtime.execute(
      input({
        approvedToolCalls: [approved],
        modelContinuation: {
          generationReasoning: [],
          modelCallCount: 1,
          toolRequests: [persistedRequest],
        },
        modelToolNames: [],
      }),
    );

    expect(completed.completionStatus).toBe("completed");
    expect(executions).toBe(1);
    expect(generations).toHaveLength(1);
    expect(generations[0]?.tools).toEqual([]);
    expect(generations[0]?.completedToolCalls).toHaveLength(1);
  });

  test("executes every call of one generation in order under per-call slots", async () => {
    const executed: string[] = [];
    const generations: RuntimeModelGenerationRequest[] = [];
    let nextToolId = 20;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "allowed",
        toolCallId: id(String(nextToolId++)),
      }),
      executeToolCall: async (request) => {
        executed.push(request.idempotencyKey);
        return { outputSummary: request.idempotencyKey, status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        generations.push(request);
        return generations.length === 1
          ? {
              assistantMessage: "",
              toolCalls: [
                { input: { resource: "first" }, modelToolCallId: "a", toolName: "provider.read" },
                { input: { resource: "second" }, modelToolCallId: "b", toolName: "provider.read" },
              ],
            }
          : { assistantMessage: "Both reads are done." };
      },
    });

    const result = await runtime.execute(input({ modelToolNames: ["provider.read"] }));

    expect(result.completionStatus).toBe("completed");
    expect(executed).toEqual([`${id("7")}:model-tool:0:0`, `${id("7")}:model-tool:0:1`]);
    expect(generations[1]?.modelToolCallSlots).toEqual([
      { idempotencyKey: `${id("7")}:model-tool:0:0`, modelCallIndex: 0, toolCallIndex: 0 },
      { idempotencyKey: `${id("7")}:model-tool:0:1`, modelCallIndex: 0, toolCallIndex: 1 },
    ]);
  });

  test.each([
    ["more than eight calls in one generation", 9, {}, "at most 8 model-native tool calls"],
    ["calls beyond the per-run tool-call limit", 3, { maxToolCalls: 2 }, "tool call limit of 2"],
  ] as const)("rejects %s before tool side effects", async (_name, count, limits, message) => {
    let authorizations = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorizations += 1;
        return { action: "allow", reason: "allowed", toolCallId: id("20") };
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({
        assistantMessage: "",
        toolCalls: Array.from({ length: count }, (_, index) => ({
          modelToolCallId: `call-${index}`,
          toolName: "provider.read",
        })),
      }),
    });

    expect(
      runtime.execute(
        input({ modelFallbackIds: [], modelToolNames: ["provider.read"], ...limits }),
      ),
    ).rejects.toThrow(message);
    expect(authorizations).toBe(0);
  });

  test.each([
    ["in canonical order", [0, 1], undefined],
    ["out of canonical order", [1, 0], "idempotencyKey does not match its canonical call slot"],
  ] as const)("resumes a multi-call continuation %s", async (_name, order, rejection) => {
    const requests = order.map((toolCallIndex) => ({
      effect: "read" as const,
      idempotencyKey: `${id("7")}:model-tool:0:${toolCallIndex}`,
      input: { resource: `resource-${toolCallIndex}` },
      inputSummary: "Model requested provider.read.",
      requiredScopes: [],
      toolName: "provider.read",
    }));
    const executed: string[] = [];
    let nextToolId = 20;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "allowed",
        toolCallId: id(String(nextToolId++)),
      }),
      executeToolCall: async (request) => {
        executed.push(request.idempotencyKey);
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "Resumed." }),
    });
    const execution = runtime.execute(
      input({
        modelContinuation: { generationReasoning: [], modelCallCount: 1, toolRequests: requests },
        modelToolNames: ["provider.read"],
      }),
    );

    if (rejection) {
      expect(execution).rejects.toThrow(rejection);
      expect(executed).toEqual([]);
    } else {
      expect(execution).resolves.toMatchObject({ completionStatus: "completed" });
      expect(executed).toEqual(requests.map((request) => request.idempotencyKey));
    }
  });

  test("checkpoints after a completed tool batch once the host requests a checkpoint", async () => {
    let draining = false;
    let generations = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({ action: "allow", reason: "allowed", toolCallId: id("20") }),
      executeToolCall: async () => {
        draining = true;
        return { outputSummary: "read", status: "completed" };
      },
      generateAssistantMessage: async () => {
        generations += 1;
        return {
          assistantMessage: "",
          toolCalls: [{ modelToolCallId: "a", toolName: "provider.read" }],
        };
      },
    });

    const result = await runtime.execute(
      input({ checkpointRequested: () => draining, modelToolNames: ["provider.read"] }),
    );

    expect(generations).toBe(1);
    expect(result.completionStatus).toBe("checkpointed");
    expect(result.assistantMessage).toBe("");
    expect(result.pendingAction).toBeUndefined();
    expect(result.completedToolCalls.map((call) => call.idempotencyKey)).toEqual([
      `${id("7")}:model-tool:0:0`,
    ]);
    expect(result.modelContinuation).toMatchObject({
      modelCallCount: 1,
      toolRequests: [expect.objectContaining({ idempotencyKey: `${id("7")}:model-tool:0:0` })],
    });
    expect(result.usage[0]?.idempotencyKey).toEndWith(":worker-ms:checkpointed");
  });

  test("links model-requested tool calls to their requesting attempt across a checkpoint resume", async () => {
    const attempt = (execution: number, modelCallIndex: number, fallback: number) =>
      `${id("7")}:execution:${execution}:assistant:${modelCallIndex}:run-attempt:0:fallback:${fallback}`;
    let draining = false;
    let firstGenerations = 0;
    const firstInvocations: RuntimeModelInvocationAttempt[] = [];
    const firstRuntime = createTestAgentRuntime({
      authorizeToolCall: async () => ({ action: "allow", reason: "allowed", toolCallId: id("20") }),
      executeToolCall: async () => {
        draining = true;
        return { outputSummary: "read", status: "completed" };
      },
      generateAssistantMessage: async () => {
        firstGenerations += 1;
        if (firstGenerations === 1) throw new Error("primary model unavailable");
        return {
          assistantMessage: "",
          toolCalls: [{ modelToolCallId: "a", toolName: "provider.read" }],
        };
      },
      recordModelInvocation: async (invocation) => void firstInvocations.push(invocation),
    });

    const checkpointed = await firstRuntime.execute(
      input({ checkpointRequested: () => draining, modelToolNames: ["provider.read"] }),
    );

    const firstRequester = { modelAttemptId: attempt(1, 0, 1), modelCallIndex: 0 };
    expect(checkpointed.completionStatus).toBe("checkpointed");
    expect(
      firstInvocations.map(({ attemptId, invocationKind, modelCallIndex, status }) => ({
        attemptId,
        invocationKind,
        modelCallIndex,
        status,
      })),
    ).toEqual([
      {
        attemptId: attempt(1, 0, 0),
        invocationKind: "assistant",
        modelCallIndex: 0,
        status: "failed",
      },
      {
        attemptId: attempt(1, 0, 1),
        invocationKind: "assistant",
        modelCallIndex: 0,
        status: "succeeded",
      },
    ]);
    // Tool spans derive their parent from modelAttemptId the same way.
    expect(firstInvocations[1]?.spanId).toBe(
      stableSpanId(input().traceId, `model:${firstRequester.modelAttemptId}`),
    );
    expect(checkpointed.completedToolCalls).toEqual([expect.objectContaining(firstRequester)]);
    // The worker stores the continuation as JSON and validates it again before resuming.
    const continued = validateRuntimeModelContinuation(
      JSON.parse(JSON.stringify(checkpointed.modelContinuation)),
    );
    if (!continued) throw new Error("Expected a model continuation.");
    expect(continued.toolRequests).toEqual([expect.objectContaining(firstRequester)]);

    let resumedGenerations = 0;
    const resumedRuntime = createTestAgentRuntime({
      authorizeToolCall: async () => ({ action: "allow", reason: "allowed", toolCallId: id("21") }),
      executeToolCall: async () => ({ outputSummary: "second read", status: "completed" }),
      generateAssistantMessage: async () => {
        resumedGenerations += 1;
        return resumedGenerations === 1
          ? {
              assistantMessage: "",
              toolCalls: [{ modelToolCallId: "b", toolName: "provider.read" }],
            }
          : { assistantMessage: "Both reads are done." };
      },
    });

    const resumed = await resumedRuntime.execute(
      input({
        artifactContinuation: checkpointed.artifactContinuation,
        completedToolCalls: checkpointed.completedToolCalls,
        modelContinuation: continued,
        modelToolNames: ["provider.read"],
        runExecutionVersion: 2,
      }),
    );

    const secondRequester = { modelAttemptId: attempt(2, 1, 0), modelCallIndex: 1 };
    expect(resumed.completionStatus).toBe("completed");
    expect(resumed.completedToolCalls).toEqual([
      expect.objectContaining({ ...firstRequester, toolCallId: id("20") }),
      expect.objectContaining({ ...secondRequester, toolCallId: id("21") }),
    ]);
  });

  test.each([
    ["names only one requesting field", { modelCallIndex: 0 }, "or neither"],
    [
      "names another generation than its slot",
      { modelAttemptId: "attempt", modelCallIndex: 1 },
      "does not match its canonical call slot",
    ],
  ] as const)("rejects a continued tool request that %s", async (_name, link, message) => {
    const request = {
      effect: "read" as const,
      idempotencyKey: `${id("7")}:model-tool:0:0`,
      inputSummary: "Model requested provider.read.",
      requiredScopes: [],
      toolName: "provider.read",
      ...link,
    };
    const continuation = { generationReasoning: [], modelCallCount: 1, toolRequests: [request] };
    const resume = async () => {
      const modelContinuation = validateRuntimeModelContinuation(continuation);
      if (!modelContinuation) throw new Error("Expected a model continuation.");
      return createTestAgentRuntime({
        generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      }).execute(input({ modelContinuation, modelToolNames: ["provider.read"] }));
    };
    expect(resume()).rejects.toThrow(message);
  });

  test("returns an interrupted run without generating when a drain finds nothing to checkpoint", async () => {
    let generations = 0;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => {
        generations += 1;
        return { assistantMessage: "unexpected" };
      },
    });

    const result = await runtime.execute(
      input({ checkpointRequested: () => true, modelToolNames: ["provider.read"] }),
    );

    expect(generations).toBe(0);
    expect(result.completionStatus).toBe("interrupted");
    expect(result.completedToolCalls).toEqual([]);
    expect(result.usage[0]?.idempotencyKey).toEndWith(":worker-ms:interrupted");
  });

  test("reports a host-shutdown abort as an interruption that keeps completed tools", async () => {
    const controller = new AbortController();
    const progress: string[] = [];
    let generations = 0;
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event.eventType),
      authorizeToolCall: async () => ({ action: "allow", reason: "allowed", toolCallId: id("20") }),
      executeToolCall: async () => ({ outputSummary: "read", status: "completed" }),
      generateAssistantMessage: async () => {
        generations += 1;
        if (generations === 1) {
          return {
            assistantMessage: "",
            toolCalls: [{ modelToolCallId: "a", toolName: "provider.read" }],
          };
        }
        controller.abort(new RuntimeHostShutdownError());
        throw new Error("model stream aborted");
      },
    });

    const result = await runtime.execute(
      input({ modelToolNames: ["provider.read"], signal: controller.signal }),
    );

    expect(result.completionStatus).toBe("interrupted");
    expect(progress).not.toContain("run.canceled");
    expect(result.completedToolCalls.map((call) => call.toolCallId)).toEqual([id("20")]);
    expect(result.modelContinuation?.modelCallCount).toBe(1);
  });

  test("checkpoints before a generation whose worst-case batch could not be persisted", async () => {
    let generations = 0;
    let nextToolId = 20;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "allowed",
        toolCallId: id(String(nextToolId++)),
      }),
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => {
        generations += 1;
        return {
          assistantMessage: "",
          toolCalls: Array.from({ length: 8 }, (_, index) => ({
            modelToolCallId: `call-${generations}-${index}`,
            toolName: "provider.read",
          })),
        };
      },
    });

    const result = await runtime.execute(input({ modelToolNames: ["provider.read"] }));

    // Eight completed tools plus another worst-case batch of eight still fit the 17-tool limit;
    // sixteen plus eight do not, so the run checkpoints before a third generation.
    expect(generations).toBe(2);
    expect(result.completionStatus).toBe("checkpointed");
    expect(result.completedToolCalls).toHaveLength(16);
    expect(result.modelContinuation?.modelCallCount).toBe(2);
  });
});
