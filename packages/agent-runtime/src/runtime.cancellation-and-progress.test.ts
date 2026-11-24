import { describe, expect, it } from "bun:test";
import type { SandboxLease } from "@deployments-ai/sandbox-hosts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime cancellation and progress", () => {
  it("returns a canceled terminal result before model execution", async () => {
    let generated = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => {
        generated = true;
        return { assistantMessage: "unexpected" };
      },
      shouldCancel: async () => true,
    });

    const result = await runtime.execute(input());
    expect(result.completionStatus).toBe("canceled");
    expect(generated).toBe(false);
  });

  it("retries pending artifact publications before honoring cancellation", async () => {
    const retried: number[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      retryArtifactPublication: async (index) => void retried.push(index),
      shouldCancel: async () => true,
    });

    const result = await runtime.execute(
      input({
        artifactContinuation: {
          artifactBytes: 8,
          artifactIndexCursor: 1,
          artifacts: [{ fileName: "evidence.txt", label: "Evidence" }],
          pendingArtifactPublicationIndexes: [0],
          sandboxCompleted: true,
        },
      }),
    );

    expect(result.completionStatus).toBe("canceled");
    expect(retried).toEqual([0]);
    expect(result.artifactContinuation.pendingArtifactPublicationIndexes).toBeUndefined();
  });

  it("advances recorded sandbox artifact indexes before cancellation escapes", async () => {
    let canceled = false;
    const recordedIndexes: number[] = [];
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-canceled-after-capture",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "ready",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordArtifact: async (_artifact, index) => void recordedIndexes.push(index),
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => lease,
        destroy: async () => undefined,
        download: async () => new Blob([]).stream(),
        exec: async () => {
          canceled = true;
          return { durationMs: 1, exitCode: 0, stderr: "", stdout: "captured" };
        },
        name: "aws_lambda_microvm",
        resume: async () => lease,
        upload: async () => undefined,
      },
      shouldCancel: async () => canceled,
    });

    const result = await runtime.execute(
      input({
        sandboxCommands: [{ captureOutput: true, command: ["first"] }, { command: ["second"] }],
        sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
      }),
    );

    expect(result.completionStatus).toBe("canceled");
    expect(recordedIndexes).toEqual([0]);
    expect(result.artifactContinuation).toMatchObject({
      artifactIndexCursor: 1,
      artifacts: [{ fileName: "sandbox-command-1.txt" }],
    });
  });

  it("honors cancellation requested while model generation is in flight", async () => {
    let canceled = false;
    let modelSignal: AbortSignal | undefined;
    const invocations: { readonly status: string; readonly usageIdempotencyKey?: string }[] = [];
    const controller = new AbortController();
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        modelSignal = request.signal;
        canceled = true;
        return {
          assistantMessage: "must not complete",
          resolvedModelId: "provider/billable-model",
          usage: [
            {
              costUsdMicros: 25,
              idempotencyKey: "canceled-model-call",
              occurredAt: 2,
              quantity: 10,
              source: "model-gateway",
              type: "model_tokens",
              unit: "tokens",
            },
          ],
        };
      },
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
      shouldCancel: async () => canceled,
    });

    const result = await runtime.execute(input({ signal: controller.signal }));

    expect(result.completionStatus).toBe("canceled");
    expect(modelSignal).toBe(controller.signal);
    expect(result.assistantMessage).toContain("canceled");
    expect(result.modelId).toBe("openrouter/primary");
    expect(result.usage.map((usage) => usage.idempotencyKey)).toContain("canceled-model-call");
    expect(invocations).toEqual([
      expect.objectContaining({
        status: "canceled",
        usageIdempotencyKey: "canceled-model-call",
      }),
    ]);
  });

  it("completes when progress delivery is unavailable", async () => {
    let generated = false;
    const runtime = createTestAgentRuntime({
      appendProgress: async () => {
        throw new Error("stream unavailable");
      },
      generateAssistantMessage: async () => {
        generated = true;
        return { assistantMessage: "Canonical result." };
      },
    });

    const result = await runtime.execute(input());

    expect(result.completionStatus).toBe("completed");
    expect(result.assistantMessage).toBe("Canonical result.");
    expect(generated).toBe(true);
  });
});
