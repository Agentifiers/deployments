import { describe, expect, it } from "bun:test";
import {
  SandboxAllocationCleanupError,
  SandboxAllocationLeaseError,
  SandboxAllocationUnknownError,
  type SandboxLease,
  type SandboxProvider,
} from "@deployments-ai/sandbox-hosts";
import { createAgentRuntime } from "./index.ts";
import type { RuntimeSandboxAllocationRecovery, RuntimeSandboxLeaseUpdate } from "./types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime", () => {
  it("records and cleans up a known lease returned by allocation failure", async () => {
    const recoveries: RuntimeSandboxAllocationRecovery[] = [];
    const leaseUpdates: RuntimeSandboxLeaseUpdate[] = [];
    let destroyed = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-allocation-failed",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "error",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordSandboxAllocationRecovery: async (recovery) => void recoveries.push(recovery),
      recordSandboxLease: async (update) => void leaseUpdates.push(update),
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => {
          throw new SandboxAllocationLeaseError({
            allocationError: new Error("invalid allocation response"),
            lease,
          });
        },
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
    ).rejects.toBeInstanceOf(SandboxAllocationLeaseError);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({ kind: "lease", lease });
    expect(leaseUpdates).toHaveLength(2);
    expect(leaseUpdates.every((update) => update.context?.traceId === input().traceId)).toBe(true);
    expect(destroyed).toBe(true);
  });

  it("cleans up a known allocation lease when recovery persistence is unavailable", async () => {
    let destroyed = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-no-recovery-port",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "error",
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
        create: async () => {
          throw new SandboxAllocationLeaseError({
            allocationError: new Error("invalid allocation response"),
            lease,
          });
        },
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
    ).rejects.toBeInstanceOf(AggregateError);
    expect(destroyed).toBe(true);
  });

  it("cleans up a known allocation lease after recovery persistence fails", async () => {
    let destroyed = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-recovery-write-failed",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "error",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordSandboxAllocationRecovery: async () => {
        throw new Error("recovery persistence failed");
      },
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => {
          throw new SandboxAllocationLeaseError({
            allocationError: new Error("invalid allocation response"),
            lease,
          });
        },
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
    ).rejects.toBeInstanceOf(AggregateError);
    expect(destroyed).toBe(true);
  });

  it("retries cleanup for allocation cleanup errors with a known lease", async () => {
    const recoveries: RuntimeSandboxAllocationRecovery[] = [];
    let destroyed = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-provider-cleanup-failed",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "error",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordSandboxAllocationRecovery: async (recovery) => void recoveries.push(recovery),
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => {
          throw new SandboxAllocationCleanupError({
            allocationError: new Error("allocation invalid"),
            cleanupError: new Error("initial cleanup timed out"),
            lease,
          });
        },
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
    ).rejects.toBeInstanceOf(SandboxAllocationCleanupError);
    expect(recoveries).toEqual([expect.objectContaining({ identityVerified: true, lease })]);
    expect(destroyed).toBe(true);
  });

  it("does not mark a known allocation lease destroyed when retry cleanup fails", async () => {
    const phases: string[] = [];
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-retry-cleanup-failed",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "error",
      workspaceId: id("9"),
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordSandboxAllocationRecovery: async () => undefined,
      recordSandboxLease: async ({ phase }) => void phases.push(phase),
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => {
          throw new SandboxAllocationCleanupError({
            allocationError: new Error("allocation invalid"),
            cleanupError: new Error("initial cleanup timed out"),
            lease,
          });
        },
        destroy: async () => {
          throw new Error("retry cleanup timed out");
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
    ).rejects.toBeInstanceOf(AggregateError);
    expect(phases).toEqual(["created"]);
  });

  it("records unknown sandbox allocation outcomes for reconciliation", async () => {
    const recoveries: RuntimeSandboxAllocationRecovery[] = [];
    let destroyed = false;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordSandboxAllocationRecovery: async (recovery) => void recoveries.push(recovery),
      sandboxProvider: {
        checkpoint: async () => ({
          checkpointRef: "checkpoint",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        }),
        create: async () => {
          throw new SandboxAllocationUnknownError({
            allocationError: new Error("request timed out"),
            allocationToken: "allocation-token-1",
          });
        },
        destroy: async () => {
          destroyed = true;
        },
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
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxAllocationUnknownError);
    expect(recoveries).toEqual([
      expect.objectContaining({
        allocationToken: "allocation-token-1",
        automaticReconciliation: true,
        kind: "unknown",
        provider: "aws_lambda_microvm",
      }),
    ]);
    expect(destroyed).toBe(false);
  });

  it("destroys a same-scope sandbox lease that is not ready", async () => {
    let destroyed = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-error",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("7"),
      status: "error",
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
    ).rejects.toThrow("Sandbox lease is not ready: error");
    expect(destroyed).toBe(true);
  });

  it("reports but does not destroy a sandbox lease from another run scope", async () => {
    let destroyed = false;
    let reported = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-foreign",
      isolationMode: "run-ephemeral",
      organizationId: id("5"),
      projectId: id("6"),
      provider: "aws_lambda_microvm",
      runId: id("99"),
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
      reportSandboxLeaseMismatch: async () => {
        reported = true;
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
    ).rejects.toThrow("does not match standalone run scope");
    expect(reported).toBe(true);
    expect(destroyed).toBe(false);
  });

  it("requires durable sandbox mismatch reporting before allocation", async () => {
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
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async (request) => request.lease,
      upload: async () => undefined,
    };
    const runtime = createAgentRuntime({
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
    ).rejects.toThrow("mismatch reporting");
    expect(created).toBe(false);
  });

  it("requires durable sandbox lifecycle persistence before allocation", async () => {
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
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async (request) => request.lease,
      upload: async () => undefined,
    };
    const runtime = createAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      reportSandboxLeaseMismatch: async () => undefined,
      sandboxProvider: provider,
    });

    expect(
      runtime.execute(
        input({
          sandboxCommands: [{ command: ["true"] }],
          sandboxPolicy: { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        }),
      ),
    ).rejects.toThrow("lifecycle persistence");
    expect(created).toBe(false);
  });

  it("surfaces sandbox mismatch reporting failures", async () => {
    let destroyed = false;
    const lease: SandboxLease = {
      executionTargetId: id("2"),
      executionTargetKind: "agent-deployment",
      environmentId: id("4"),
      externalSandboxId: "sandbox-report-failure",
      isolationMode: "run-ephemeral",
      organizationId: id("99"),
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
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      name: "aws_lambda_microvm",
      resume: async () => lease,
      upload: async () => undefined,
    };
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      reportSandboxLeaseMismatch: async () => {
        throw new Error("mismatch reporter unavailable");
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
    ).rejects.toThrow("mismatch reporting failed");
    expect(destroyed).toBe(false);
  });
});
