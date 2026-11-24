import { describe, expect, it } from "bun:test";
import { MAX_AGENT_TOOL_REQUESTS } from "@deployments-ai/agent-manifest";
import {
  MAX_MODEL_TOOL_CALLS_PER_GENERATION,
  MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS,
  RuntimeArtifactPublicationError,
  RuntimeToolDeniedError,
} from "./index.ts";
import type { RuntimeProgressEvent } from "./types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime", () => {
  it("pauses before side effects when approval is required", async () => {
    let executed = false;
    let generated = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "require-approval",
        approvalId: id("11"),
        reason: "Production write requires approval.",
        toolCallId: id("12"),
      }),
      executeToolCall: async () => {
        executed = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => {
        generated = true;
        return { assistantMessage: "unexpected" };
      },
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "write",
            idempotencyKey: "tool-1",
            inputSummary: "Update production",
            toolName: "provider.write",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("waiting-for-approval");
    expect(result.pendingAction).toEqual({
      approvalId: id("11"),
      effect: "write",
      idempotencyKey: "tool-1",
      inputSummary: "Update production",
      kind: "approval",
      policyReason: "Production write requires approval.",
      requiredScopes: [],
      toolCallId: id("12"),
      toolName: "provider.write",
    });
    expect(executed).toBe(false);
    expect(generated).toBe(false);
  });

  it("records artifacts returned before an asynchronous tool pause", async () => {
    const recorded: string[] = [];
    const progress: RuntimeProgressEvent[] = [];
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event),
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("14"),
      }),
      executeToolCall: async () => ({
        artifacts: [
          {
            content: "partial output",
            fileName: "partial.txt",
            label: "Partial output",
            type: "generated_file",
          },
        ],
        externalOperationId: "operation-1",
        outputSummary: "Authorization: Basic dXNlcjpwYXNz",
        status: "running",
      }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordArtifact: async (artifact) => void recorded.push(artifact.fileName),
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "write",
            idempotencyKey: "tool-async",
            inputSummary: "Start asynchronous work",
            toolName: "provider.async",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("waiting-for-tool");
    expect(result.assistantMessage).not.toContain("dXNlcjpwYXNz");
    expect(result.assistantMessage).toContain("[redacted]");
    expect(result.pendingAction).toEqual({
      effect: "write",
      externalOperationId: "operation-1",
      idempotencyKey: "tool-async",
      inputSummary: "Start asynchronous work",
      kind: "tool",
      policyReason: "Allowed.",
      requiredScopes: [],
      toolCallId: id("14"),
      toolName: "provider.async",
    });
    expect(recorded).toEqual(["partial.txt"]);
    expect(progress.map((event) => event.eventType)).toContain("tool.policy-decided");
    expect(
      progress.find((event) => event.eventType === "tool.running")?.metadata,
    ).not.toHaveProperty("outputSummary");
  });

  it("preserves asynchronous tool correlation when artifact handling fails", async () => {
    const recorded: string[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("15"),
      }),
      executeToolCall: async () => ({
        artifacts: [
          {
            content: "persisted output",
            fileName: "persisted-output.txt",
            label: "Persisted output",
          },
          {
            content: "provider output",
            fileName: "provider-output.txt",
            label: "Provider output",
          },
        ],
        externalOperationId: "operation-needs-reconciliation",
        status: "running",
      }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordArtifact: async (artifact) => {
        if (artifact.fileName === "provider-output.txt") {
          throw new RuntimeArtifactPublicationError("artifact stream unavailable", {
            artifactPersisted: true,
          });
        }
        recorded.push(artifact.fileName);
      },
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "write",
            idempotencyKey: "tool-async-artifact-failure",
            inputSummary: "Start provider operation",
            toolName: "provider.async",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("waiting-for-tool");
    expect(result.pendingAction).toEqual({
      effect: "write",
      externalOperationId: "operation-needs-reconciliation",
      idempotencyKey: "tool-async-artifact-failure",
      inputSummary: "Start provider operation",
      kind: "tool",
      policyReason: "Allowed.",
      requiredScopes: [],
      toolCallId: id("15"),
      toolName: "provider.async",
    });
    expect(result.assistantMessage).toContain("requires reconciliation");
    expect(result.assistantMessage).toContain("artifact stream unavailable");
    expect(result.artifactContinuation).toMatchObject({
      artifactIndexCursor: 2,
      artifacts: [{ fileName: "persisted-output.txt" }, { fileName: "provider-output.txt" }],
      pendingArtifactPublicationIndexes: [1],
    });
    expect(recorded).toEqual(["persisted-output.txt"]);
  });

  it("pauses for reconciliation when asynchronous operation IDs are malformed", async () => {
    for (const externalOperationId of [
      "x".repeat(513),
      "operation\nwith-control",
      "unknown:provider-supplied",
    ]) {
      let executions = 0;
      const runtime = createTestAgentRuntime({
        authorizeToolCall: async () => ({
          action: "allow",
          reason: "Allowed.",
          toolCallId: id("55"),
        }),
        executeToolCall: async () => {
          executions += 1;
          return { externalOperationId, status: "running" };
        },
        generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      });

      const result = await runtime.execute(
        input({
          toolRequests: [
            {
              effect: "write",
              idempotencyKey: `tool-invalid-operation-${executions}`,
              inputSummary: "Start invalid asynchronous operation",
              toolName: "provider.async",
            },
          ],
        }),
      );

      expect(result.completionStatus).toBe("waiting-for-tool");
      expect(result.pendingAction).toEqual({
        effect: "write",
        externalOperationId: `unknown:${id("55")}`,
        idempotencyKey: "tool-invalid-operation-0",
        inputSummary: "Start invalid asynchronous operation",
        kind: "tool",
        policyReason: "Allowed.",
        requiredScopes: [],
        toolCallId: id("55"),
        toolName: "provider.async",
      });
      expect(result.assistantMessage).toContain("requires reconciliation");
      expect(executions).toBe(1);
    }
  });

  it("keeps canonical tool input out of reconciliation progress events", async () => {
    const progress: RuntimeProgressEvent[] = [];
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event),
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("56"),
      }),
      executeToolCall: async () => ({ status: "running" }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "write",
            idempotencyKey: "tool-secret-input",
            input: { accessToken: "provider-secret-token" },
            inputSummary: "Start provider work.",
            toolName: "provider.async",
          },
        ],
      }),
    );

    expect(result.pendingAction?.input).toEqual({ accessToken: "provider-secret-token" });
    const reconciliation = progress.find(
      (event) => event.eventType === "tool.reconciliation-required",
    );
    expect(reconciliation?.metadata).toMatchObject({
      externalOperationId: `unknown:${id("56")}`,
      kind: "tool",
      toolCallId: id("56"),
      toolName: "provider.async",
    });
    expect(reconciliation?.metadata).not.toHaveProperty("input");
    expect(JSON.stringify(reconciliation)).not.toContain("provider-secret-token");
  });

  it("uses the execution attempt in worker usage identity", async () => {
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "complete" }),
    });

    const first = await runtime.execute(input({ runAttempt: 1 }));
    const second = await runtime.execute(input({ runAttempt: 2 }));

    expect(first.usage[0]?.idempotencyKey).toContain(":attempt:1:worker-ms:completed");
    expect(second.usage[0]?.idempotencyKey).toContain(":attempt:2:worker-ms:completed");
    expect(first.usage[0]?.idempotencyKey).not.toBe(second.usage[0]?.idempotencyKey);
  });

  it("rejects invalid execution attempts before runtime side effects", async () => {
    let generated = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => {
        generated = true;
        return { assistantMessage: "unexpected" };
      },
    });

    expect(runtime.execute(input({ runAttempt: -1 }))).rejects.toThrow("runAttempt");
    expect(generated).toBe(false);
  });

  it("bounds tool requests before policy or execution side effects", async () => {
    let authorized = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorized = true;
        throw new Error("unexpected authorization");
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    expect(
      runtime.execute(
        input({
          toolRequests: Array.from({ length: MAX_AGENT_TOOL_REQUESTS + 1 }, (_, index) => ({
            effect: "read" as const,
            idempotencyKey: `tool-overflow-${index}`,
            inputSummary: `Overflow tool ${index}`,
            toolName: "provider.read",
          })),
        }),
      ),
    ).rejects.toThrow(`release-pinned limit of ${MAX_AGENT_TOOL_REQUESTS}`);
    expect(authorized).toBe(false);
  });

  it("reserves terminal capacity for a possible model-selected tool batch", async () => {
    let generated = false;
    let nextToolId = 100;
    const toolRequests = Array.from(
      {
        length: MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS - MAX_MODEL_TOOL_CALLS_PER_GENERATION + 1,
      },
      (_, index) => ({
        effect: "read" as const,
        idempotencyKey: `completed-tool-${index}`,
        inputSummary: `Completed tool ${index}`,
        toolName: "provider.read",
      }),
    );
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(nextToolId++)),
      }),
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => {
        generated = true;
        return { assistantMessage: "unexpected" };
      },
    });

    expect(
      runtime.execute(input({ modelToolNames: ["provider.read"], toolRequests })),
    ).rejects.toThrow("terminal transaction capacity");
    expect(generated).toBe(false);
  });

  it("fits the maximum completed tools and one model usage entry in terminal capacity", async () => {
    const toolRequests = Array.from(
      { length: MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS },
      (_, index) => ({
        effect: "read" as const,
        idempotencyKey: `completed-tool-${index}`,
        inputSummary: `Completed tool ${index}`,
        toolName: "provider.read",
      }),
    );
    let nextToolId = 100;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(nextToolId++)),
      }),
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async (request) => ({
        assistantMessage: "Capacity retained.",
        usage: [
          {
            idempotencyKey: `${request.runId}:model-capacity`,
            occurredAt: 2,
            quantity: 1,
            source: "model-gateway",
            type: "model_tokens",
            unit: "tokens",
          },
        ],
      }),
    });

    expect(
      runtime.execute(
        input({
          toolRequests,
        }),
      ),
    ).resolves.toMatchObject({
      assistantMessage: "Capacity retained.",
      completionStatus: "completed",
    });
  });

  it("rejects tool and usage combinations that exceed terminal capacity", async () => {
    const toolRequests = Array.from(
      { length: MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS },
      (_, index) => ({
        effect: "read" as const,
        idempotencyKey: `completed-tool-${index}`,
        inputSummary: `Completed tool ${index}`,
        toolName: "provider.read",
      }),
    );
    let nextToolId = 100;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(nextToolId++)),
      }),
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async (request) => ({
        assistantMessage: "Too much usage.",
        usage: ["first", "second"].map((suffix) => ({
          idempotencyKey: `${request.runId}:model-capacity:${suffix}`,
          occurredAt: 2,
          quantity: 1,
          source: "model-gateway",
          type: "model_tokens",
          unit: "tokens",
        })),
      }),
    });

    expect(
      runtime.execute(
        input({
          modelFallbackIds: [],
          toolRequests,
        }),
      ),
    ).rejects.toThrow("terminal transaction capacity");
  });

  it("bounds aggregate tool persistence payloads before policy or execution side effects", async () => {
    let authorized = false;
    let executed = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorized = true;
        throw new Error("unexpected authorization");
      },
      executeToolCall: async () => {
        executed = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    expect(
      runtime.execute(
        input({
          toolRequests: Array.from({ length: 9 }, (_, index) => ({
            effect: "read" as const,
            idempotencyKey: `tool-large-${index}`,
            input: { payload: "x".repeat(120 * 1024) },
            inputSummary: `Large tool ${index}`,
            toolName: "provider.read",
          })),
        }),
      ),
    ).rejects.toThrow("aggregate persistence payload");
    expect(authorized).toBe(false);
    expect(executed).toBe(false);
  });

  it("rejects denied tools without invoking the executor", async () => {
    let executed = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "deny",
        reason: "Missing connection grant.",
        toolCallId: id("13"),
      }),
      executeToolCall: async () => {
        executed = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    expect(
      runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-2",
              inputSummary: "Read provider",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(RuntimeToolDeniedError);
    expect(executed).toBe(false);
  });

  it("fails closed on malformed tool policy actions", async () => {
    let executed = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () =>
        ({ action: "denied", reason: "Malformed action.", toolCallId: id("32") }) as never,
      executeToolCall: async () => {
        executed = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    expect(
      runtime.execute(
        input({
          toolRequests: [
            {
              effect: "write",
              idempotencyKey: "tool-malformed-policy",
              inputSummary: "Malformed policy",
              toolName: "provider.write",
            },
          ],
        }),
      ),
    ).rejects.toThrow("unsupported action");
    expect(executed).toBe(false);
  });
});
