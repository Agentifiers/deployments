import { claimRun, type RunClaimBasis } from "./agent-run-claim.ts";
import {
  CodedRunFailure,
  now,
  type ClaimedRunState,
  type RuntimeLeaseRecordValue,
} from "./agent-run-input.ts";
import { publishPersistedTerminalRun } from "./agent-run-replay-publication.ts";
import { organizationRefusesRun } from "./agent-run-standing.ts";
import { persistFailedRun } from "./agent-run-terminal.ts";
import { AgentRunWorkerRecordError } from "./records.ts";
import {
  ADMITTED_RUN_RECEIVE_RESERVE,
  MAX_CONCURRENCY_WAIT_MS,
  MAX_DEFERRAL_SECONDS,
  MIN_DEFERRAL_SECONDS,
} from "./run-capacity-deferral.ts";
import type {
  AgentRunQueueMessage,
  AgentRunWorkerDependencies,
  ProcessAgentRunResult,
  RunRecordValue,
} from "./types.ts";

export type RunAdmission =
  | { readonly kind: "claimed"; readonly claim: ClaimedRunState }
  | { readonly kind: "settled"; readonly result: ProcessAgentRunResult };

export async function admitRun(input: {
  readonly basis: RunClaimBasis;
  readonly claimTimeoutMs: number;
  readonly dependencies: AgentRunWorkerDependencies;
  readonly queue: AgentRunQueueMessage;
  readonly receiveCount: number | undefined;
  readonly runLease: RuntimeLeaseRecordValue | undefined;
}): Promise<RunAdmission> {
  const { basis, claimTimeoutMs, dependencies, queue } = input;
  const run = basis.run;
  if (await organizationRefusesRun(dependencies, run)) {
    const cause = new CodedRunFailure(
      "organization_suspended",
      "The run was stopped at claim because its organization is suspended.",
    );
    const failed = await persistFailedRun(dependencies, run, cause, input.runLease);
    await publishPersistedTerminalRun(dependencies, queue, failed, input.runLease);
    return {
      kind: "settled",
      result: { action: "skipped", reason: "Run's organization is suspended.", run: failed },
    };
  }
  if (run.data.status === "running") {
    const claim = await claimRun(
      dependencies,
      queue,
      basis,
      claimTimeoutMs,
      heldExecutionSlot(run),
      "run.reclaimed",
    );
    return { claim, kind: "claimed" };
  }
  const organizationId = run.data.organizationId;
  const limit = (await dependencies.tenantLimits.limitsFor(organizationId)).concurrentRuns;
  const acquisition = await dependencies.organizationCapacity.acquire({
    commit: (slot) => claimRun(dependencies, queue, basis, claimTimeoutMs, slot, "run.started"),
    holderId: run.data.id,
    limit,
    organizationId,
    resource: "run-execution",
  });
  if (acquisition.kind === "acquired") return { claim: acquisition.value, kind: "claimed" };
  const hit = { inUse: acquisition.inUse, limit, organizationId, runId: run.data.id };
  const queuedAt = Date.parse(run.data.queuedAt ?? run.data.createdAt);
  const maxReceiveCount = dependencies.queueMaxReceiveCount;
  const receivesLeft = maxReceiveCount - (input.receiveCount ?? 0);
  const failure =
    now(dependencies).getTime() - queuedAt > MAX_CONCURRENCY_WAIT_MS
      ? `Run waited more than ${MAX_CONCURRENCY_WAIT_MS / 3_600_000} hours for one of its organization's ${limit} concurrent run slots.`
      : receivesLeft <= ADMITTED_RUN_RECEIVE_RESERVE
        ? `Run stopped waiting for one of its organization's ${limit} concurrent run slots: its queue message has ${receivesLeft} of ${maxReceiveCount} receives left.`
        : undefined;
  if (failure) {
    dependencies.tenantLimitMetrics.record({ metric: "RunConcurrencyWaitExpired", ...hit });
    const cause = new CodedRunFailure("organization_concurrency_wait_expired", failure);
    const failed = await persistFailedRun(dependencies, run, cause, input.runLease);
    await publishPersistedTerminalRun(dependencies, queue, failed, input.runLease);
    return {
      kind: "settled",
      result: {
        action: "skipped",
        reason: "Run waited too long for organization capacity.",
        run: failed,
      },
    };
  }
  dependencies.tenantLimitMetrics.record({ metric: "RunsDeferred", ...hit });
  return {
    kind: "settled",
    result: {
      action: "deferred",
      inUse: acquisition.inUse,
      limit,
      reason: "organization_concurrency_limited",
      retryAfterSeconds:
        MIN_DEFERRAL_SECONDS +
        Math.floor(Math.random() * (MAX_DEFERRAL_SECONDS - MIN_DEFERRAL_SECONDS + 1)),
    },
  };
}

function heldExecutionSlot(run: RunRecordValue): number {
  if (run.data.executionSlot === undefined) {
    throw new AgentRunWorkerRecordError(
      "run_execution_slot_missing",
      `Running run ${run.data.id} holds no organization execution slot.`,
    );
  }
  return run.data.executionSlot;
}
