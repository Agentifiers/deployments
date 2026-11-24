import {
  MAX_SANDBOX_RESERVED_MEMORY_MIB,
  MAX_SANDBOX_RESERVED_VCPU,
  type AsyncExecHandle,
  type ExecResult,
  type SandboxLease,
} from "@deployments-ai/sandbox-hosts";
import { agentRunSandboxOwner } from "./execution-pins.ts";
import { redactRuntimeSensitivePrefix } from "./redaction.ts";
import { runtimeArtifactSummary } from "./runtime-artifacts.ts";
import { MAX_CAPTURE_COUNT, MAX_COMMAND_OUTPUT_CHARACTERS } from "./runtime-core.ts";
import { captureMaximumBytes, sandboxReservation } from "./runtime-sandbox.ts";
import type {
  AgentRunInput,
  AgentRuntimeDependencies,
  RuntimeArtifact,
  RuntimeSandboxCommand,
} from "./types.ts";

export function assertSandboxLeaseIdentity(input: AgentRunInput, lease: SandboxLease): void {
  const owner = agentRunSandboxOwner(input);
  const mismatches = [
    lease.organizationId === input.organizationId ? undefined : "organizationId",
    lease.projectId === input.projectId ? undefined : "projectId",
    lease.environmentId === input.environmentId ? undefined : "environmentId",
    lease.workspaceId === input.workspaceId ? undefined : "workspaceId",
    lease.executionTargetKind === owner.executionTargetKind ? undefined : "executionTargetKind",
    lease.executionTargetId === owner.executionTargetId ? undefined : "executionTargetId",
    lease.runId === input.runId ? undefined : "runId",
    lease.provider === input.sandboxPolicy.provider ? undefined : "provider",
    lease.isolationMode === "run-ephemeral" ? undefined : "isolationMode",
    input.sandboxPolicy.accessPolicyRef === undefined ||
    lease.accessPolicyRef === input.sandboxPolicy.accessPolicyRef
      ? undefined
      : "accessPolicyRef",
    input.sandboxPolicy.imageRef === undefined || lease.imageRef === input.sandboxPolicy.imageRef
      ? undefined
      : "imageRef",
    input.sandboxPolicy.poolKey === undefined || lease.poolKey === input.sandboxPolicy.poolKey
      ? undefined
      : "poolKey",
  ].filter((field): field is string => field !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`Sandbox lease does not match standalone run scope: ${mismatches.join(", ")}.`);
  }
}

export function assertSandboxLeaseReady(
  input: AgentRunInput,
  lease: SandboxLease,
  observedAt: number,
): void {
  if (lease.status !== "ready") throw new Error(`Sandbox lease is not ready: ${lease.status}.`);
  if (
    lease.leaseExpiresAt !== undefined &&
    (!Number.isFinite(lease.leaseExpiresAt) || lease.leaseExpiresAt <= observedAt)
  ) {
    throw new Error("Sandbox lease is already expired.");
  }
  if (
    input.sandboxPolicy.minMemoryMiB !== undefined &&
    (lease.reservedMemoryMiB === undefined ||
      lease.reservedMemoryMiB < input.sandboxPolicy.minMemoryMiB)
  ) {
    throw new Error("Sandbox lease reserved less memory than requested.");
  }
  if (
    input.sandboxPolicy.minVcpu !== undefined &&
    (lease.reservedVcpu === undefined || lease.reservedVcpu < input.sandboxPolicy.minVcpu)
  ) {
    throw new Error("Sandbox lease reserved fewer vCPUs than requested.");
  }
}

export function isAsyncExecResult(result: ExecResult | AsyncExecHandle): result is AsyncExecHandle {
  return "operationId" in result;
}

export function commandArtifact(
  command: RuntimeSandboxCommand,
  index: number,
  result: ExecResult,
): RuntimeArtifact {
  const label = command.label ?? `Sandbox command ${index + 1}`;
  const stdout = result.stdout.slice(0, MAX_COMMAND_OUTPUT_CHARACTERS);
  const stderr = result.stderr.slice(0, MAX_COMMAND_OUTPUT_CHARACTERS);
  const output = [
    result.stdout
      ? `stdout:\n${redactRuntimeSensitivePrefix(stdout)}${result.stdout.length > stdout.length ? "\n[truncated]" : ""}`
      : "",
    result.stderr
      ? `stderr:\n${redactRuntimeSensitivePrefix(stderr)}${result.stderr.length > stderr.length ? "\n[truncated]" : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    content: output,
    contentType: "text/plain",
    fileName: `sandbox-command-${index + 1}.txt`,
    label,
    metadata: { durationMs: result.durationMs, exitCode: result.exitCode },
    type: "deploy_log",
  };
}

function sandboxCaptureCount(input: AgentRunInput): number {
  return (input.sandboxCommands ?? []).reduce(
    (count, command) =>
      count + (command.captureOutput ? 1 : 0) + (command.captureFiles?.length ?? 0),
    0,
  );
}

export interface RuntimeSandboxPlan {
  readonly commands: readonly RuntimeSandboxCommand[];
  readonly provider?: NonNullable<AgentRuntimeDependencies["sandboxProvider"]>;
  readonly requestedCaptureCount: number;
}

export function prepareSandboxPlan(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
): RuntimeSandboxPlan {
  const commands = input.sandboxCommands ?? [];
  if (input.sandboxPolicy.mode !== "run-ephemeral") {
    if (commands.length > 0) {
      throw new Error("Sandbox commands require a run-ephemeral sandbox policy.");
    }
    return { commands, requestedCaptureCount: 0 };
  }
  sandboxReservation(
    "minMemoryMiB",
    input.sandboxPolicy.minMemoryMiB,
    MAX_SANDBOX_RESERVED_MEMORY_MIB,
  );
  sandboxReservation("minVcpu", input.sandboxPolicy.minVcpu, MAX_SANDBOX_RESERVED_VCPU);
  for (const command of commands) {
    if (command.captureOutput) {
      runtimeArtifactSummary(
        commandArtifact(command, 0, { durationMs: 0, exitCode: 0, stderr: "", stdout: "" }),
      );
    }
    for (const capture of command.captureFiles ?? []) {
      captureMaximumBytes(capture.maxBytes);
      runtimeArtifactSummary({
        content: "",
        ...(capture.contentType ? { contentType: capture.contentType } : {}),
        fileName: capture.fileName ?? capture.path.split("/").at(-1) ?? "artifact",
        label: capture.label ?? capture.path,
        type: "generated_file",
      });
    }
  }
  const requestedCaptureCount = sandboxCaptureCount(input);
  if (requestedCaptureCount > MAX_CAPTURE_COUNT) {
    throw new Error(`Sandbox capture count exceeds the per-run limit of ${MAX_CAPTURE_COUNT}.`);
  }
  if (commands.length === 0) return { commands, requestedCaptureCount };
  const provider = dependencies.sandboxProvider;
  if (!provider) throw new Error("Sandbox execution was requested without a sandbox provider.");
  if (provider.name !== input.sandboxPolicy.provider) {
    throw new Error(
      `Configured sandbox provider ${String(provider.name)} does not match the pinned sandbox provider ${String(input.sandboxPolicy.provider)}.`,
    );
  }
  if (!dependencies.reportSandboxLeaseMismatch) {
    throw new Error("Sandbox execution requires durable lease mismatch reporting.");
  }
  if (!dependencies.recordSandboxLease) {
    throw new Error("Sandbox execution requires durable lease lifecycle persistence.");
  }
  return { commands, provider, requestedCaptureCount };
}
