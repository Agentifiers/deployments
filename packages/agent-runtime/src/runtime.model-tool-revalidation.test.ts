import { describe, expect, test } from "bun:test";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import type { RuntimeModelGenerationRequest } from "./types.ts";

describe("model-native tool loop", () => {
  test("rejects model tool arguments that do not match the code-owned schema", async () => {
    let authorizations = 0;
    let executions = 0;
    let generations = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorizations += 1;
        return { action: "allow", reason: "allowed", toolCallId: id("20") };
      },
      executeToolCall: async () => {
        executions += 1;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => {
        generations += 1;
        return {
          assistantMessage: "",
          toolCalls: [
            {
              input: { resource: 42 },
              modelToolCallId: "invalid-input",
              toolName: "provider.read",
            },
          ],
        };
      },
    });

    expect(
      runtime.execute(input({ modelFallbackIds: [], modelToolNames: ["provider.read"] })),
    ).rejects.toThrow("input does not match its code-owned schema");
    expect(generations).toBe(2);
    expect(authorizations).toBe(0);
    expect(executions).toBe(0);
  });

  test("retries a generation whose tool arguments do not match the code-owned schema", async () => {
    const executed: unknown[] = [];
    const recoveries: RuntimeModelGenerationRequest["responseRecovery"][] = [];
    const invocations: RuntimeModelInvocationAttempt[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({ action: "allow", reason: "allowed", toolCallId: id("20") }),
      executeToolCall: async (request) => {
        executed.push(request.input);
        return { status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        recoveries.push(request.responseRecovery);
        if (request.completedToolCalls.length > 0) {
          return { assistantMessage: "Read the account." };
        }
        return {
          assistantMessage: "",
          toolCalls: [
            {
              input: recoveries.length === 1 ? { resource: 42 } : { resource: "account" },
              modelToolCallId: `call-${recoveries.length}`,
              toolName: "provider.read",
            },
          ],
        };
      },
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    });

    const result = await runtime.execute(
      input({ modelFallbackIds: [], modelToolNames: ["provider.read"] }),
    );

    expect(result.assistantMessage).toBe("Read the account.");
    expect(executed).toEqual([{ resource: "account" }]);
    expect(recoveries).toEqual([undefined, "same-model-retry", undefined]);
    expect(
      invocations.map(({ fallbackAttempt, invocationId, status }) => ({
        fallbackAttempt,
        invocationId,
        status,
      })),
    ).toEqual([
      {
        fallbackAttempt: 0,
        invocationId: `${id("7")}:execution:1:assistant:0`,
        status: "failed",
      },
      {
        fallbackAttempt: 1,
        invocationId: `${id("7")}:execution:1:assistant:0`,
        status: "succeeded",
      },
      {
        fallbackAttempt: 0,
        invocationId: `${id("7")}:execution:1:assistant:1`,
        status: "succeeded",
      },
    ]);
  });

  test("revalidates persisted model tool input before resumed side effects", async () => {
    let authorizations = 0;
    let generations = 0;
    let artifactPublicationRetries = 0;
    let artifactLoads = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorizations += 1;
        return { action: "allow", reason: "allowed", toolCallId: id("20") };
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => {
        generations += 1;
        return { assistantMessage: "must not generate" };
      },
      loadArtifact: async () => {
        artifactLoads += 1;
        return { content: "persisted", fileName: "persisted.txt", label: "Persisted" };
      },
      retryArtifactPublication: async () => {
        artifactPublicationRetries += 1;
      },
    });

    expect(
      runtime.execute(
        input({
          artifactContinuation: {
            artifactBytes: 9,
            artifactIndexCursor: 1,
            artifacts: [{ fileName: "persisted.txt", label: "Persisted" }],
            pendingArtifactPublicationIndexes: [0],
            sandboxCompleted: true,
          },
          modelContinuation: {
            generationReasoning: [],
            modelCallCount: 1,
            toolRequests: [
              {
                effect: "read",
                idempotencyKey: `${id("7")}:model-tool:0:0`,
                input: { resource: 42 },
                inputSummary: "Model requested provider.read.",
                requiredScopes: [],
                toolName: "provider.read",
              },
            ],
          },
          modelToolNames: ["provider.read"],
        }),
      ),
    ).rejects.toThrow("input does not match its code-owned schema");
    expect(authorizations).toBe(0);
    expect(artifactLoads).toBe(0);
    expect(artifactPublicationRetries).toBe(0);
    expect(generations).toBe(0);
  });

  test("revalidates persisted model effect and scopes before resumed side effects", async () => {
    let artifactPublicationRetries = 0;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "must not generate" }),
      retryArtifactPublication: async () => {
        artifactPublicationRetries += 1;
      },
    });

    expect(
      runtime.execute(
        input({
          artifactContinuation: {
            artifactBytes: 9,
            artifactIndexCursor: 1,
            artifacts: [{ fileName: "persisted.txt", label: "Persisted" }],
            pendingArtifactPublicationIndexes: [0],
            sandboxCompleted: true,
          },
          modelContinuation: {
            generationReasoning: [],
            modelCallCount: 1,
            toolRequests: [
              {
                effect: "write",
                idempotencyKey: `${id("7")}:model-tool:0:0`,
                input: { resource: "account" },
                inputSummary: "Model requested provider.read.",
                requiredScopes: ["stale.scope"],
                toolName: "provider.read",
              },
            ],
          },
          modelToolNames: ["provider.read"],
        }),
      ),
    ).rejects.toThrow("effect does not match its code-owned definition");
    expect(artifactPublicationRetries).toBe(0);
  });

  test("rejects a persisted model tool outside its canonical call slot", async () => {
    let authorizations = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorizations += 1;
        return { action: "allow", reason: "allowed", toolCallId: id("20") };
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({ assistantMessage: "must not generate" }),
    });

    expect(
      runtime.execute(
        input({
          modelContinuation: {
            generationReasoning: [],
            modelCallCount: 1,
            toolRequests: [
              {
                effect: "read",
                idempotencyKey: "tampered-idempotency-key",
                input: { resource: "account" },
                inputSummary: "Model requested provider.read.",
                requiredScopes: [],
                toolName: "provider.read",
              },
            ],
          },
          modelToolNames: ["provider.read"],
        }),
      ),
    ).rejects.toThrow("idempotencyKey does not match its canonical call slot");
    expect(authorizations).toBe(0);
  });
});
