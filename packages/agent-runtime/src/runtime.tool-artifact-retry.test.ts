import { describe, expect, it } from "bun:test";
import { runtimeExecutionFailureState, RuntimeArtifactPublicationError } from "./index.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import type { RuntimeArtifact } from "./types.ts";

describe("agent runtime tool artifact retry", () => {
  it("retains canonical tool artifact metadata in the successful model request", async () => {
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("57"),
      }),
      executeToolCall: async () => ({
        artifacts: [
          {
            content: "result",
            contentType: " text/plain ",
            fileName: "logs/output.txt",
            label: " Result ",
            type: " log ",
          },
        ],
        status: "completed" as const,
      }),
      generateAssistantMessage: async (request) => {
        expect(request.sandboxArtifacts).toEqual([
          {
            content: "result",
            contentType: "text/plain",
            fileName: "logs-output.txt",
            label: "Result",
            type: "log",
          },
        ]);
        return { assistantMessage: "canonical artifact retained" };
      },
      recordArtifact: async () => {},
    });

    expect(
      runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "canonical-tool-artifact",
              inputSummary: "Return canonical evidence",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ assistantMessage: "canonical artifact retained" });
  });

  it("reuses canonical artifact indexes after a retryable partial publication failure", async () => {
    const recorded: Array<{ readonly fileName: string; readonly index: number }> = [];
    let executionCount = 0;
    let failPublication = true;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(58 + executionCount)),
      }),
      executeToolCall: async () => {
        executionCount += 1;
        return {
          artifacts: [
            { content: "persisted", fileName: "persisted.txt", label: "Persisted" },
            { content: "retry", fileName: "retry.txt", label: "Retry" },
          ],
          status: "completed" as const,
        };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "completed after retry" }),
      recordArtifact: async (artifact, index) => {
        recorded.push({ fileName: artifact.fileName, index });
        if (artifact.fileName === "retry.txt" && failPublication) {
          failPublication = false;
          throw new RuntimeArtifactPublicationError("stream publication failed");
        }
      },
    });
    const runInput = input({
      toolRequests: [
        {
          effect: "read",
          idempotencyKey: "tool-artifact-publication",
          inputSummary: "Persist artifacts",
          toolName: "provider.read",
        },
      ],
    });

    let continuation;
    try {
      await runtime.execute(runInput);
      throw new Error("Expected publication failure.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RuntimeArtifactPublicationError);
      continuation = runtimeExecutionFailureState(cause)?.artifactContinuation;
      expect(continuation).toEqual({ artifactBytes: 0, artifactIndexCursor: 0, artifacts: [] });
    }

    expect(
      runtime.execute({ ...runInput, artifactContinuation: continuation! }),
    ).resolves.toMatchObject({ assistantMessage: "completed after retry" });
    expect(executionCount).toBe(2);
    expect(recorded).toEqual([
      { fileName: "persisted.txt", index: 0 },
      { fileName: "retry.txt", index: 1 },
      { fileName: "persisted.txt", index: 0 },
      { fileName: "retry.txt", index: 1 },
    ]);
  });

  it("retries publication without rerunning a completed tool whose artifact was persisted", async () => {
    let executionCount = 0;
    let failPublication = true;
    const retried: number[] = [];
    const persistedArtifacts = new Map<number, RuntimeArtifact>();
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("60"),
      }),
      executeToolCall: async () => {
        executionCount += 1;
        return {
          artifacts: [
            { content: "persisted", fileName: "persisted.txt", label: "Persisted" },
            { content: "pending", fileName: "pending.txt", label: "Pending publication" },
          ],
          status: "completed" as const,
        };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "completed after publication" }),
      loadArtifact: async (index) => ({
        ...persistedArtifacts.get(index)!,
        contentType: "application/octet-stream",
        type: "report",
      }),
      recordArtifact: async (artifact, index) => {
        persistedArtifacts.set(index, artifact);
        if (artifact.fileName === "pending.txt" && failPublication) {
          failPublication = false;
          throw new RuntimeArtifactPublicationError("stream publication failed", {
            artifactPersisted: true,
          });
        }
      },
      retryArtifactPublication: async (index) => void retried.push(index),
    });
    const runInput = input({
      toolRequests: [
        {
          effect: "read",
          idempotencyKey: "persisted-tool-artifact-publication",
          inputSummary: "Persist artifacts once",
          toolName: "provider.read",
        },
      ],
    });

    let failureState;
    try {
      await runtime.execute(runInput);
      throw new Error("Expected publication failure.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RuntimeArtifactPublicationError);
      failureState = runtimeExecutionFailureState(cause);
      expect(failureState?.artifactContinuation).toMatchObject({
        artifactIndexCursor: 2,
        artifacts: [{ fileName: "persisted.txt" }, { fileName: "pending.txt" }],
        pendingArtifactPublicationIndexes: [1],
      });
      expect(failureState?.completedToolCalls).toHaveLength(1);
    }

    expect(
      runtime.execute({
        ...runInput,
        artifactContinuation: failureState!.artifactContinuation,
        completedToolCalls: failureState!.completedToolCalls,
      }),
    ).resolves.toMatchObject({ assistantMessage: "completed after publication" });
    expect(executionCount).toBe(1);
    expect(retried).toEqual([1]);
  });
});
