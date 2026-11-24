import { describe, expect, it } from "bun:test";
import { RuntimeModelInvocationPersistenceError } from "./index.ts";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime observability", () => {
  it("does not classify invocation persistence failures as provider fallback failures", async () => {
    let generations = 0;
    let persistedAttempt: RuntimeModelInvocationAttempt | undefined;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => {
        generations += 1;
        return { assistantMessage: "Valid provider response." };
      },
      recordModelInvocation: async (attempt) => {
        persistedAttempt = attempt;
        throw new Error("database unavailable");
      },
    });

    const failure = await runtime.execute(input()).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RuntimeModelInvocationPersistenceError);
    if (!persistedAttempt) throw new Error("Expected the invocation persistence port to run.");
    expect((failure as RuntimeModelInvocationPersistenceError).attempt).toBe(persistedAttempt);
    expect(generations).toBe(1);
  });

  it("records provider response identity instead of the deterministic model call id", async () => {
    const invocations: Array<{ readonly providerRequestId?: string }> = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => ({
        assistantMessage: "Completed.",
        metadata: {
          modelCallId: request.modelCallId,
          providerRequestId: "provider-response-1",
        },
      }),
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    });

    await runtime.execute(input());

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.providerRequestId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(invocations[0]?.providerRequestId).not.toContain("provider-response-1");
  });

  it("sanitizes provider-controlled invocation metadata", async () => {
    const invocations: RuntimeModelInvocationAttempt[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({
        assistantMessage: "Completed.",
        metadata: {
          finishReason: "patient-name-and-diagnosis",
          providerRequestId: "patient name and diagnosis",
        },
        resolvedModelId: "openai/patient-name-and-diagnosis",
        usage: [
          {
            idempotencyKey: "provider-sensitive-model-id",
            modelId: "openai/patient-name-and-diagnosis",
            occurredAt: 2,
            provider: "patient-name-and-diagnosis",
            quantity: 3,
            source: "model-gateway",
            type: "model_tokens",
            unit: "tokens",
          },
        ],
      }),
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    });

    await runtime.execute(input({ modelFallbackIds: [] }));

    expect(invocations[0]).toMatchObject({
      actualModelId: "openrouter/primary",
      stopReason: "other",
    });
    expect(invocations[0]?.providerRequestId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(invocations[0])).not.toContain("patient-name");
  });

  it("preserves the canonical provider for an unprefixed configured model", async () => {
    const invocations: RuntimeModelInvocationAttempt[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({
        assistantMessage: "Completed.",
        resolvedModelId: "openai/gpt-5.2",
        usage: [
          {
            idempotencyKey: "unprefixed-model-usage",
            modelId: "openai/gpt-5.2",
            occurredAt: 2,
            provider: "openai",
            quantity: 3,
            source: "model-gateway",
            type: "model_tokens",
            unit: "tokens",
          },
        ],
      }),
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    });

    const result = await runtime.execute(input({ modelFallbackIds: [], modelId: "gpt-5.2" }));

    expect(result.modelId).toBe("openai/gpt-5.2");
    expect(result.usage).toContainEqual(
      expect.objectContaining({ modelId: "openai/gpt-5.2", provider: "openai" }),
    );
    expect(invocations[0]).toMatchObject({
      actualModelId: "openai/gpt-5.2",
      actualProvider: "openai",
      requestedModelId: "gpt-5.2",
      requestedProvider: "openai",
    });
  });

  it("uses the durable run version to separate manual retry model identities", async () => {
    const modelCallIds: string[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        modelCallIds.push(request.modelCallId);
        return { assistantMessage: "Completed." };
      },
    });

    await runtime.execute(input({ runAttempt: 1, runExecutionVersion: 4 }));
    await runtime.execute(input({ runAttempt: 1, runExecutionVersion: 9 }));

    expect(modelCallIds).toEqual([
      `${id("7")}:execution:4:assistant:0:run-attempt:1:fallback:0`,
      `${id("7")}:execution:9:assistant:0:run-attempt:1:fallback:0`,
    ]);
  });
});
