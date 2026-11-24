import { describe, expect, it } from "bun:test";
import type { SandboxLease } from "@deployments-ai/sandbox-hosts";
import {
  RuntimeArtifactPersistenceError,
  RuntimeArtifactPublicationError,
  runtimeExecutionFailureState,
} from "./index.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import type { RuntimeArtifact } from "./types.ts";

function lease(): SandboxLease {
  return {
    executionTargetId: id("2"),
    executionTargetKind: "agent-deployment",
    environmentId: id("4"),
    externalSandboxId: "sandbox-artifact-publication",
    isolationMode: "run-ephemeral",
    organizationId: id("5"),
    projectId: id("6"),
    provider: "aws_lambda_microvm",
    runId: id("7"),
    status: "ready",
    workspaceId: id("9"),
  };
}

function sandboxProvider(
  exec: () => Promise<{
    readonly durationMs: number;
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
  }>,
) {
  const sandboxLease = lease();
  return {
    checkpoint: async () => ({
      checkpointRef: "checkpoint",
      createdAt: 1,
      provider: "aws_lambda_microvm" as const,
    }),
    create: async () => sandboxLease,
    destroy: async () => undefined,
    download: async () => new Blob([]).stream(),
    exec,
    name: "aws_lambda_microvm" as const,
    resume: async () => sandboxLease,
    upload: async () => undefined,
  };
}

describe("agent runtime sandbox artifact publication", () => {
  it("terminalizes a pre-commit artifact failure without rerunning the sandbox", async () => {
    let executions = 0;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
      recordArtifact: async () => {
        throw new RuntimeArtifactPublicationError("artifact persistence failed");
      },
      sandboxProvider: sandboxProvider(async () => {
        executions += 1;
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "evidence" };
      }),
    });
    const runInput = input({
      sandboxCommands: [{ captureOutput: true, command: ["deploy"] }],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    let failure: unknown;
    try {
      await runtime.execute(runInput);
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(RuntimeArtifactPersistenceError);
    expect(failure).not.toBeInstanceOf(RuntimeArtifactPublicationError);
    expect(runtimeExecutionFailureState(failure)?.artifactContinuation).toMatchObject({
      artifactIndexCursor: 0,
      sandboxCompleted: true,
    });
    expect(executions).toBe(1);
  });

  it("does not let concurrent cancellation hide a pre-commit artifact failure", async () => {
    let canceled = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
      recordArtifact: async () => {
        canceled = true;
        throw new RuntimeArtifactPublicationError("artifact persistence failed");
      },
      sandboxProvider: sandboxProvider(async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "evidence",
      })),
      shouldCancel: async () => canceled,
    });

    let failure: unknown;
    try {
      await runtime.execute(
        input({
          sandboxCommands: [{ captureOutput: true, command: ["deploy"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      );
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(RuntimeArtifactPersistenceError);
    expect(runtimeExecutionFailureState(failure)?.artifactContinuation).toMatchObject({
      artifactIndexCursor: 0,
      sandboxCompleted: true,
    });
  });

  it("retries a persisted event before terminalizing the original sandbox failure", async () => {
    let executions = 0;
    const retried: number[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
      recordArtifact: async () => {
        throw new RuntimeArtifactPublicationError("artifact stream unavailable", {
          artifactPersisted: true,
        });
      },
      retryArtifactPublication: async (index) => void retried.push(index),
      sandboxProvider: sandboxProvider(async () => {
        executions += 1;
        return { durationMs: 1, exitCode: 1, stderr: "deploy failed", stdout: "evidence" };
      }),
    });
    const runInput = input({
      sandboxCommands: [{ captureOutput: true, command: ["deploy"] }],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    let continuation;
    try {
      await runtime.execute(runInput);
    } catch (cause) {
      expect(cause).toBeInstanceOf(RuntimeArtifactPublicationError);
      continuation = runtimeExecutionFailureState(cause)?.artifactContinuation;
      expect(continuation).toMatchObject({
        artifactIndexCursor: 1,
        pendingArtifactPublicationIndexes: [0],
        sandboxCompleted: true,
      });
      expect(continuation?.sandboxFailureMessage).toContain("deploy failed");
    }

    expect(runtime.execute({ ...runInput, artifactContinuation: continuation! })).rejects.toThrow(
      "deploy failed",
    );
    expect(retried).toEqual([0]);
    expect(executions).toBe(1);
  });

  it("persists later artifacts after an earlier post-commit event failure", async () => {
    const recorded: number[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
      recordArtifact: async (_artifact, index) => {
        recorded.push(index);
        if (index === 0) {
          throw new RuntimeArtifactPublicationError("artifact stream unavailable", {
            artifactPersisted: true,
          });
        }
      },
      sandboxProvider: sandboxProvider(async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "evidence",
      })),
    });
    const runInput = input({
      sandboxCommands: [
        { captureOutput: true, command: ["prepare"] },
        { captureOutput: true, command: ["deploy"] },
      ],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    let failure: unknown;
    try {
      await runtime.execute(runInput);
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(RuntimeArtifactPublicationError);
    expect(recorded).toEqual([0, 1]);
    expect(runtimeExecutionFailureState(failure)?.artifactContinuation).toMatchObject({
      artifactIndexCursor: 2,
      pendingArtifactPublicationIndexes: [0],
      sandboxCompleted: true,
    });
  });

  it("rehydrates persisted artifact bodies before model generation on retry", async () => {
    let continuation;
    let executions = 0;
    let persistedArtifact: RuntimeArtifact | undefined;
    const modelArtifacts: RuntimeArtifact[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        modelArtifacts.push(...request.sandboxArtifacts);
        return { assistantMessage: "completed after retry" };
      },
      loadArtifact: async () => persistedArtifact!,
      recordArtifact: async (artifact) => {
        persistedArtifact = artifact;
        throw new RuntimeArtifactPublicationError("artifact stream unavailable", {
          artifactPersisted: true,
        });
      },
      retryArtifactPublication: async () => undefined,
      sandboxProvider: sandboxProvider(async () => {
        executions += 1;
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "original evidence" };
      }),
    });
    const runInput = input({
      sandboxCommands: [{ captureOutput: true, command: ["deploy"] }],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    try {
      await runtime.execute(runInput);
    } catch (cause) {
      expect(cause).toBeInstanceOf(RuntimeArtifactPublicationError);
      continuation = runtimeExecutionFailureState(cause)?.artifactContinuation;
    }
    if (!continuation || !persistedArtifact) throw new Error("Expected a persisted continuation.");

    const result = await runtime.execute({ ...runInput, artifactContinuation: continuation });

    expect(result.assistantMessage).toBe("completed after retry");
    expect(modelArtifacts).toEqual([persistedArtifact]);
    expect(modelArtifacts[0]?.content).toBe("stdout:\noriginal evidence");
    expect(executions).toBe(1);
  });

  it("keeps pending artifact publication retryable when cancellation arrives concurrently", async () => {
    let canceled = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
      recordArtifact: async () => {
        canceled = true;
        throw new RuntimeArtifactPublicationError("artifact stream unavailable", {
          artifactPersisted: true,
        });
      },
      sandboxProvider: sandboxProvider(async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "evidence",
      })),
      shouldCancel: async () => canceled,
    });
    const runInput = input({
      sandboxCommands: [{ captureOutput: true, command: ["deploy"] }],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    let failure: unknown;
    try {
      await runtime.execute(runInput);
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(RuntimeArtifactPublicationError);
    expect(runtimeExecutionFailureState(failure)?.artifactContinuation).toMatchObject({
      artifactIndexCursor: 1,
      pendingArtifactPublicationIndexes: [0],
      sandboxCompleted: true,
    });
  });

  it("publishes an earlier pending event before terminalizing a later persistence failure", async () => {
    const retried: number[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
      recordArtifact: async (_artifact, index) => {
        if (index === 0) {
          throw new RuntimeArtifactPublicationError("artifact stream unavailable", {
            artifactPersisted: true,
          });
        }
        throw new RuntimeArtifactPublicationError("artifact persistence failed");
      },
      retryArtifactPublication: async (index) => void retried.push(index),
      sandboxProvider: sandboxProvider(async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "evidence",
      })),
    });
    const runInput = input({
      sandboxCommands: [
        { captureOutput: true, command: ["prepare"] },
        { captureOutput: true, command: ["deploy"] },
      ],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    let continuation;
    try {
      await runtime.execute(runInput);
    } catch (cause) {
      expect(cause).toBeInstanceOf(RuntimeArtifactPublicationError);
      continuation = runtimeExecutionFailureState(cause)?.artifactContinuation;
      expect(continuation).toMatchObject({
        artifactIndexCursor: 1,
        pendingArtifactPublicationIndexes: [0],
        sandboxCompleted: true,
      });
      expect(continuation?.sandboxFailureMessage).toContain("artifact persistence failed");
    }

    expect(runtime.execute({ ...runInput, artifactContinuation: continuation! })).rejects.toThrow(
      "artifact persistence failed",
    );
    expect(retried).toEqual([0]);
  });

  it("terminalizes a later persistence failure after retaining the persisted artifact prefix", async () => {
    let executions = 0;
    const recorded: number[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "must not generate" }),
      recordArtifact: async (_artifact, index) => {
        recorded.push(index);
        if (index === 1) {
          throw new RuntimeArtifactPublicationError("second artifact persistence failed");
        }
      },
      sandboxProvider: sandboxProvider(async () => {
        executions += 1;
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "evidence" };
      }),
    });
    const runInput = input({
      sandboxCommands: [
        { captureOutput: true, command: ["prepare"] },
        { captureOutput: true, command: ["deploy"] },
      ],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });

    let continuation;
    try {
      await runtime.execute(runInput);
    } catch (cause) {
      continuation = runtimeExecutionFailureState(cause)?.artifactContinuation;
      expect(continuation).toMatchObject({
        artifactIndexCursor: 1,
        artifacts: [{ fileName: "sandbox-command-1.txt" }],
        sandboxCompleted: true,
      });
      expect(continuation?.sandboxFailureMessage).toContain("second artifact persistence failed");
    }
    const executionsAfterFailure = executions;

    expect(runtime.execute({ ...runInput, artifactContinuation: continuation! })).rejects.toThrow(
      "second artifact persistence failed",
    );
    expect(recorded).toEqual([0, 1]);
    expect(executionsAfterFailure).toBe(2);
    expect(executions).toBe(executionsAfterFailure);
  });
});
