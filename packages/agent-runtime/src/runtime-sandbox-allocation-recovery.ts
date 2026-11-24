import {
  SandboxAllocationCleanupError,
  SandboxAllocationLeaseError,
  SandboxAllocationUnknownError,
} from "@deployments-ai/sandbox-hosts";
import type { AgentRunInput, AgentRuntimeDependencies } from "./types.ts";
import { executionContext, progressContext } from "./runtime-core.ts";
import { assertSandboxLeaseIdentity } from "./sandbox-plan.ts";

export async function handleSandboxAllocationFailure(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  provider: NonNullable<AgentRuntimeDependencies["sandboxProvider"]>,
  cause:
    | SandboxAllocationCleanupError
    | SandboxAllocationLeaseError
    | SandboxAllocationUnknownError,
): Promise<void> {
  const recordRecovery = dependencies.recordSandboxAllocationRecovery;
  if (cause instanceof SandboxAllocationUnknownError) {
    if (!recordRecovery) {
      throw new AggregateError(
        [cause, new Error("Sandbox allocation recovery persistence is not configured.")],
        "Sandbox allocation failed without a recovery persistence port.",
      );
    }
    try {
      await recordRecovery({
        ...progressContext(input),
        allocationToken: cause.allocationToken,
        automaticReconciliation: cause.automaticReconciliation,
        kind: "unknown",
        provider: provider.name,
      });
    } catch (recoveryCause) {
      throw new AggregateError(
        [cause, recoveryCause],
        "Unknown sandbox allocation recovery persistence failed.",
      );
    }
    return;
  }

  const identityVerified =
    cause instanceof SandboxAllocationLeaseError ? cause.identityVerified : true;
  const cleanupCompletedAt =
    cause instanceof SandboxAllocationLeaseError ? cause.cleanupCompletedAt : undefined;
  const failures: unknown[] = [cause];
  if (recordRecovery) {
    try {
      await recordRecovery({
        ...progressContext(input),
        ...(cleanupCompletedAt !== undefined ? { cleanupCompletedAt } : {}),
        identityVerified,
        kind: "lease",
        lease: cause.lease,
        provider: provider.name,
      });
    } catch (recoveryCause) {
      failures.push(recoveryCause);
    }
  } else {
    failures.push(new Error("Sandbox allocation recovery persistence is not configured."));
  }
  if (!identityVerified) {
    try {
      await dependencies.reportSandboxLeaseMismatch?.({
        expected: executionContext(input),
        lease: cause.lease,
      });
    } catch (reportCause) {
      failures.push(reportCause);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Sandbox allocation recovery reporting failed.");
    }
    return;
  }
  try {
    assertSandboxLeaseIdentity(input, cause.lease);
  } catch {
    try {
      await dependencies.reportSandboxLeaseMismatch?.({
        expected: executionContext(input),
        lease: cause.lease,
      });
    } catch (reportCause) {
      failures.push(reportCause);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Sandbox allocation recovery reporting failed.");
    }
    return;
  }
  if (cleanupCompletedAt !== undefined) {
    try {
      await dependencies.recordSandboxLease!({
        context: progressContext(input),
        lease: { ...cause.lease, status: "destroyed" },
        phase: "destroyed",
      });
    } catch (recordCause) {
      failures.push(recordCause);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Sandbox allocation recovery persistence failed.");
    }
    return;
  }
  try {
    await dependencies.recordSandboxLease!({
      context: progressContext(input),
      lease: cause.lease,
      phase: "created",
    });
  } catch (recordCause) {
    failures.push(recordCause);
  }
  let cleanupSucceeded = false;
  try {
    await provider.destroy({ lease: cause.lease });
    cleanupSucceeded = true;
  } catch (cleanupCause) {
    failures.push(cleanupCause);
  }
  if (cleanupSucceeded) {
    try {
      await dependencies.recordSandboxLease!({
        context: progressContext(input),
        lease: { ...cause.lease, status: "destroyed" },
        phase: "destroyed",
      });
    } catch (recordCause) {
      failures.push(recordCause);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Sandbox allocation recovery and cleanup failed.");
  }
}
