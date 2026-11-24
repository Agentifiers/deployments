import { describe, expect, it } from "bun:test";
import {
  MAX_SANDBOX_RESERVED_MEMORY_MIB,
  MAX_SANDBOX_RESERVED_VCPU,
  type SandboxLease,
  type SandboxProvider,
} from "@deployments-ai/sandbox-hosts";
import { createAgentRuntime, runtimeExecutionFailureState } from "./index.ts";
import type { AgentRunInput } from "./types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime", () => {
  it("rejects a ready sandbox lease that weakens the pinned policy", async () => {
    let executed = false;
    const lease: SandboxLease = {
      accessPolicyRef: "weaker-policy",
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-policy-mismatch",
      imageRef: "image@1",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      poolKey: "general",
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      reservedMemoryMiB: 1_024,
      reservedVcpu: 1,
      runId: id("7"),
      status: "ready",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
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
          executed = true;
          return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" };
        },
        name: "aws_lambda_microvm",
        resume: async () => lease,
        upload: async () => undefined,
      },
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ command: ["true"] }],
          sandboxPolicy: {
            accessPolicyRef: "restricted-policy",
            imageRef: "image@1",
            minMemoryMiB: 2_048,
            minVcpu: 2,
            mode: "run-ephemeral",
            poolKey: "general",
            provider: "aws_lambda_microvm",
          },
        }),
      ),
    ).rejects.toThrow("accessPolicyRef");
    expect(executed).toBe(false);
  });

  it("allows provider defaults for sandbox fields the release did not pin", async () => {
    const lease: SandboxLease = {
      accessPolicyRef: "provider-default-policy",
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-provider-defaults",
      imageRef: "provider-default-image@1",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      poolKey: "provider-default-pool",
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "ready",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "completed" }),
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => lease,
        destroy: async () => undefined,
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
    ).resolves.toMatchObject({ completionStatus: "completed" });
  });

  it("rejects a miswired sandbox provider before allocation", async () => {
    let created = false;
    const provider: SandboxProvider = {
      checkpoint: async () => ({
        checkpointRef: "checkpoint",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
      create: async () => {
        created = true;
        throw new Error("unexpected allocation");
      },
      destroy: async () => undefined,
      download: async () => new Blob([]).stream(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "miswired-provider" as SandboxProvider["name"],
      resume: async () => {
        throw new Error("unexpected resume");
      },
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ command: ["true"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("does not match the pinned sandbox provider");
    expect(created).toBe(false);
  });

  it("aborts sandbox capture once the configured byte limit is exceeded", async () => {
    let canceled = false;
    let destroyed = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-bounded",
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
      download: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
          },
          cancel() {
            canceled = true;
          },
        }),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async () => lease,
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [
            {
              captureFiles: [{ maxBytes: 4, path: "/workspace/large.bin" }],
              command: ["true"],
            },
          ],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("exceeds its maximum size");
    expect(canceled).toBe(true);
    expect(destroyed).toBe(true);
  });

  it("rejects non-finite sandbox capture limits before allocation", async () => {
    let created = false;
    let destroyed = false;
    let downloaded = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-invalid-limit",
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
      create: async () => {
        created = true;
        return lease;
      },
      destroy: async () => {
        destroyed = true;
      },
      download: async () => {
        downloaded = true;
        return new Blob([]).stream();
      },
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async () => lease,
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [
            {
              captureFiles: [{ maxBytes: Number.POSITIVE_INFINITY, path: "/workspace/file" }],
              command: ["true"],
            },
          ],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("maximum size");
    expect(created).toBe(false);
    expect(downloaded).toBe(false);
    expect(destroyed).toBe(false);
  });

  it("rejects excessive sandbox capture counts before allocation", async () => {
    let created = false;
    const provider: SandboxProvider = {
      checkpoint: async () => ({
        checkpointRef: "checkpoint",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
      create: async () => {
        created = true;
        throw new Error("unexpected allocation");
      },
      destroy: async () => undefined,
      download: async () => new Blob([]).stream(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async () => {
        throw new Error("unexpected resume");
      },
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [
            {
              captureFiles: Array.from({ length: 33 }, (_, index) => ({
                path: `/workspace/file-${index}`,
              })),
              command: ["true"],
            },
          ],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("capture count");
    expect(created).toBe(false);
  });

  it("rejects zero sandbox resource reservations before allocation", async () => {
    let created = false;
    const provider: SandboxProvider = {
      checkpoint: async () => ({
        checkpointRef: "checkpoint",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
      create: async () => {
        created = true;
        throw new Error("unexpected allocation");
      },
      destroy: async () => undefined,
      download: async () => new Blob([]).stream(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async () => {
        throw new Error("unexpected resume");
      },
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ command: ["true"] }],
          sandboxPolicy: {
            minMemoryMiB: 0,
            mode: "run-ephemeral",
            provider: "aws_lambda_microvm",
          },
        }),
      ),
    ).rejects.toThrow("minMemoryMiB");
    expect(created).toBe(false);
  });

  it("rejects sandbox reservations above platform allocation limits", async () => {
    let created = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => {
          created = true;
          throw new Error("unexpected allocation");
        },
        destroy: async () => undefined,
        download: async () => new Blob([]).stream(),
        exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
        name: "aws_lambda_microvm",
        resume: async () => {
          throw new Error("unexpected resume");
        },
        upload: async () => undefined,
      },
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ command: ["true"] }],
          sandboxPolicy: {
            minMemoryMiB: MAX_SANDBOX_RESERVED_MEMORY_MIB + 1,
            minVcpu: MAX_SANDBOX_RESERVED_VCPU + 1,
            mode: "run-ephemeral",
            provider: "aws_lambda_microvm",
          },
        }),
      ),
    ).rejects.toThrow(`no greater than ${MAX_SANDBOX_RESERVED_MEMORY_MIB}`);
    expect(created).toBe(false);
  });

  it("skips sandbox allocation when no commands are requested", async () => {
    let created = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "No sandbox work." }),
      sandboxProvider: {
        checkpoint: async () => {
          throw new Error("unexpected checkpoint");
        },
        create: async () => {
          created = true;
          throw new Error("unexpected allocation");
        },
        destroy: async () => undefined,
        download: async () => new Blob([]).stream(),
        exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
        name: "aws_lambda_microvm",
        resume: async () => {
          throw new Error("unexpected resume");
        },
        upload: async () => undefined,
      },
    });

    const result = await runtime.execute(
      input({ sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" } }),
    );

    expect(result.completionStatus).toBe("completed");
    expect(created).toBe(false);
  });

  it("rejects sandbox commands unless the policy is run-ephemeral", async () => {
    for (const mode of ["none", "thread-persistent"] as const) {
      let generated = false;
      const runtime = createTestAgentRuntime({
        generateAssistantMessage: async () => {
          generated = true;
          return { assistantMessage: "unexpected" };
        },
      });

      expect(
        runtime.execute(
          input({
            sandboxCommands: [{ command: ["true"] }],
            sandboxPolicy: { mode, provider: "aws_lambda_microvm" },
          }),
        ),
      ).rejects.toThrow("require a run-ephemeral sandbox policy");
      expect(generated).toBe(false);
    }
  });

  it("records captured diagnostics when a sandbox command fails", async () => {
    const recorded: string[] = [];
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-failed-command",
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
      destroy: async () => undefined,
      download: async () => new Blob([]).stream(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 1,
        stderr: "command failed",
        stdout: "partial diagnostics",
      }),
      name: "aws_lambda_microvm",
      resume: async () => lease,
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordArtifact: async (artifact) => void recorded.push(String(artifact.content)),
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ captureOutput: true, command: ["false"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("failed with exit code 1");
    expect(recorded.join("\n")).toContain("partial diagnostics");
  });

  it("reports execution and sandbox destruction failures together", async () => {
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-double-failure",
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
        throw new Error("destroy failed");
      },
      download: async () => new Blob([]).stream(),
      exec: async () => ({ durationMs: 1, exitCode: 1, stderr: "exec failed", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async () => lease,
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ command: ["false"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  it("records captured artifacts and preserves a sandbox destruction failure", async () => {
    const recorded: string[] = [];
    let executions = 0;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-cleanup-artifact",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "ready",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "completed after retry" }),
      recordArtifact: async (artifact) => void recorded.push(artifact.fileName),
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => lease,
        destroy: async () => {
          throw new Error("destroy failed");
        },
        download: async () => new Blob([]).stream(),
        exec: async () => {
          executions += 1;
          return { durationMs: 1, exitCode: 0, stderr: "", stdout: "captured" };
        },
        name: "aws_lambda_microvm",
        resume: async () => lease,
        upload: async () => undefined,
      },
    });

    const runInput = input({
      sandboxCommands: [{ captureOutput: true, command: ["true"] }],
      sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
    });
    let continuation: AgentRunInput["artifactContinuation"];
    try {
      await runtime.execute(runInput);
      throw new Error("Expected sandbox cleanup to fail.");
    } catch (cause) {
      continuation = runtimeExecutionFailureState(cause)?.artifactContinuation;
      expect(continuation).toMatchObject({ artifactIndexCursor: 1, sandboxCompleted: true });
      expect(continuation?.sandboxFailureMessage).toContain("destroy failed");
    }
    expect(recorded).toEqual(["sandbox-command-1.txt"]);
    expect(runtime.execute({ ...runInput, artifactContinuation: continuation! })).rejects.toThrow(
      "destroy failed",
    );
    expect(executions).toBe(1);
  });

  it("requires artifact persistence before sandbox capture side effects", async () => {
    let created = false;
    const runtime = createAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      sandboxProvider: {
        create: async () => {
          created = true;
          throw new Error("unexpected allocation");
        },
      } as unknown as SandboxProvider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ captureOutput: true, command: ["true"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("requires a recordArtifact port");
    expect(created).toBe(false);
  });
});
