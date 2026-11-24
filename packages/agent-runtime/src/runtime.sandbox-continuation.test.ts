import { describe, expect, it } from "bun:test";
import type { SandboxLease } from "@deployments-ai/sandbox-hosts";
import { RuntimeArtifactPublicationError, runtimeExecutionFailureState } from "./index.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import type { AgentRunInput, RuntimeArtifact } from "./types.ts";

function lease(externalSandboxId: string): SandboxLease {
  return {
    executionTargetId: id("2"),
    executionTargetKind: "agent-deployment",
    environmentId: id("4"),
    externalSandboxId,
    isolationMode: "run-ephemeral",
    organizationId: id("5"),
    projectId: id("6"),
    provider: "aws_lambda_microvm",
    runId: id("7"),
    status: "ready",
    workspaceId: id("9"),
  };
}

function sandboxProvider(sandboxLease: SandboxLease, onExecute: () => void) {
  return {
    checkpoint: async () => ({
      checkpointRef: "checkpoint",
      createdAt: 1,
      provider: "aws_lambda_microvm" as const,
    }),
    create: async () => sandboxLease,
    destroy: async () => undefined,
    download: async () => new Blob([]).stream(),
    exec: async () => {
      onExecute();
      return { durationMs: 1, exitCode: 0, stderr: "", stdout: "evidence" };
    },
    name: "aws_lambda_microvm" as const,
    resume: async () => sandboxLease,
    upload: async () => undefined,
  };
}

describe("agent runtime sandbox continuation", () => {
  it("does not rerun a completed sandbox after model retry", async () => {
    let executions = 0;
    let modelCalls = 0;
    const persistedArtifacts = new Map<number, RuntimeArtifact>();
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => {
        modelCalls += 1;
        if (modelCalls === 1) throw new Error("model gateway unavailable");
        return { assistantMessage: "completed after retry" };
      },
      loadArtifact: async (index) => persistedArtifacts.get(index)!,
      recordArtifact: async (artifact, index) => void persistedArtifacts.set(index, artifact),
      sandboxProvider: sandboxProvider(lease("sandbox-model-retry"), () => {
        executions += 1;
      }),
    });
    const runInput = input({
      modelFallbackIds: [],
      sandboxCommands: [{ captureOutput: true, command: ["deploy"] }],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    expect(runtime.execute(runInput)).resolves.toMatchObject({
      assistantMessage: "completed after retry",
      completionStatus: "completed",
    });
    expect(executions).toBe(1);
    expect(modelCalls).toBe(2);
  });

  it("does not rerun sandbox commands after artifact publication fails", async () => {
    let executions = 0;
    let publications = 0;
    const retried: number[] = [];
    const persistedArtifacts = new Map<number, RuntimeArtifact>();
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "completed after retry" }),
      loadArtifact: async (index) => persistedArtifacts.get(index)!,
      recordArtifact: async (artifact, index) => {
        persistedArtifacts.set(index, artifact);
        publications += 1;
        if (publications === 2) {
          throw new RuntimeArtifactPublicationError("artifact stream unavailable", {
            artifactPersisted: true,
          });
        }
      },
      retryArtifactPublication: async (index) => void retried.push(index),
      sandboxProvider: sandboxProvider(lease("sandbox-artifact-failure"), () => {
        executions += 1;
      }),
    });
    const runInput = input({
      sandboxCommands: [
        { captureOutput: true, command: ["prepare"] },
        { captureOutput: true, command: ["deploy"] },
      ],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    let continuation: AgentRunInput["artifactContinuation"];
    try {
      await runtime.execute(runInput);
      throw new Error("Expected artifact publication to fail.");
    } catch (cause) {
      continuation = runtimeExecutionFailureState(cause)?.artifactContinuation;
      expect(continuation).toMatchObject({
        artifactIndexCursor: 2,
        artifacts: [{ fileName: "sandbox-command-1.txt" }, { fileName: "sandbox-command-2.txt" }],
        pendingArtifactPublicationIndexes: [1],
        sandboxCompleted: true,
      });
    }
    expect(
      runtime.execute({ ...runInput, artifactContinuation: continuation! }),
    ).resolves.toMatchObject({ assistantMessage: "completed after retry" });
    expect(retried).toEqual([1]);
    expect(executions).toBe(2);
  });
});
