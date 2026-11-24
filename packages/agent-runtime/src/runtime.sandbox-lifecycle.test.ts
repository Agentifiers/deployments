import { describe, expect, it } from "bun:test";
import { type SandboxLease, type SandboxProvider } from "@deployments-ai/sandbox-hosts";
import { RuntimeArtifactPublicationError } from "./index.ts";
import type { RuntimeSandboxAllocationRecovery } from "./types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime", () => {
  it("runs and destroys an ephemeral sandbox while recording artifacts", async () => {
    const lifecycle: string[] = [];
    const recorded: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const controller = new AbortController();
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-1",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "ready",
      workspaceId: id("9"),
    };
    const provider: SandboxProvider = {
      checkpoint: async () => ({
        checkpointRef: "checkpoint",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
      create: async (request) => {
        signals.push(request.signal);
        expect(request.allocationId).toBe(id("7"));
        lifecycle.push("create");
        return lease;
      },
      destroy: async () => void lifecycle.push("destroy"),
      download: async (request) => {
        signals.push(request.signal);
        return new Blob(["artifact body"]).stream();
      },
      exec: async (request) => {
        signals.push(request.signal);
        return { durationMs: 5, exitCode: 0, stderr: "", stdout: "ok" };
      },
      name: "aws_lambda_microvm",
      resume: async () => lease,
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async (request) => {
        expect(request.sandboxArtifacts).toHaveLength(2);
        return { assistantMessage: "Sandbox complete." };
      },
      recordArtifact: async (artifact) => void recorded.push(artifact.fileName),
      recordSandboxLease: async ({ phase }) => void lifecycle.push(phase),
      sandboxProvider: provider,
    });

    const result = await runtime.execute(
      input({
        sandboxCommands: [
          {
            captureFiles: [{ path: "/workspace/output.txt" }],
            captureOutput: true,
            command: ["sh", "-lc", "echo ok"],
          },
        ],
        sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        signal: controller.signal,
      }),
    );

    expect(result.completionStatus).toBe("completed");
    expect(lifecycle).toEqual(["create", "created", "destroy", "destroyed"]);
    expect(recorded).toEqual(["sandbox-command-1.txt", "output.txt"]);
    expect(signals).toEqual([controller.signal, controller.signal, controller.signal]);
  });

  it("does not run sandbox after ambiguous tool artifact publication", async () => {
    const recorded: Array<{ fileName: string; index: number }> = [];
    const progress: string[] = [];
    let executions = 0;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-indexes",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "ready",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event.eventType),
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("70"),
      }),
      executeToolCall: async () => ({
        artifacts: [
          { content: "tool", fileName: "tool.txt", label: "Tool artifact" },
          { content: "unknown", fileName: "unknown.txt", label: "Unknown artifact" },
        ],
        status: "completed",
      }),
      generateAssistantMessage: async () => ({ assistantMessage: "Indexed artifacts." }),
      recordArtifact: async (artifact, index, context) => {
        expect(context.runId).toBe(id("7"));
        expect(context.organizationId).toBe(id("5"));
        recorded.push({ fileName: artifact.fileName, index });
        if (artifact.fileName === "unknown.txt") throw new Error("artifact outcome unknown");
      },
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
          executions += 1;
          return { durationMs: 1, exitCode: 0, stderr: "", stdout: "sandbox" };
        },
        name: "aws_lambda_microvm",
        resume: async () => lease,
        upload: async () => undefined,
      },
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ captureOutput: true, command: ["true"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-before-sandbox",
              inputSummary: "Produce tool artifact",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(RuntimeArtifactPublicationError);
    expect(recorded).toEqual([
      { fileName: "tool.txt", index: 0 },
      { fileName: "unknown.txt", index: 1 },
    ]);
    expect(executions).toBe(0);
    expect(progress).toContain("tool.running");
    expect(progress).not.toContain("tool.completed");
  });

  it("destroys a created sandbox when lease recording fails", async () => {
    let destroyed = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-cleanup",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "ready",
      workspaceId: id("9"),
    };
    const provider: SandboxProvider = {
      checkpoint: async () => ({
        checkpointRef: "checkpoint",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
      create: async () => lease,
      destroy: async () => {
        destroyed = true;
      },
      download: async () => new Blob([]).stream(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async () => lease,
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordSandboxLease: async ({ phase }) => {
        if (phase === "created") throw new Error("persistence unavailable");
      },
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ command: ["true"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("persistence unavailable");
    expect(destroyed).toBe(true);
  });

  it("records recovery when destroyed lease persistence fails after provider cleanup", async () => {
    let destroyed = false;
    const recoveries: RuntimeSandboxAllocationRecovery[] = [];
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-destroyed-persistence",
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
      now: () => 1_721_778_400_000,
      recordSandboxAllocationRecovery: async (recovery) => void recoveries.push(recovery),
      recordSandboxLease: async ({ phase }) => {
        if (phase === "destroyed") throw new Error("destroyed lease persistence unavailable");
      },
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => lease,
        destroy: async () => {
          destroyed = true;
        },
        download: async () => new Blob([]).stream(),
        exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
        name: "aws_lambda_microvm",
        resume: async () => lease,
        upload: async () => undefined,
      },
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ command: ["true"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("destroyed lease persistence unavailable");
    expect(destroyed).toBe(true);
    expect(recoveries).toEqual([
      expect.objectContaining({
        cleanupCompletedAt: 1_721_778_400_000,
        identityVerified: true,
        kind: "lease",
        lease,
        provider: "aws_lambda_microvm",
      }),
    ]);
  });
});
