import {
  isDatabaseWriteConflict,
  makeOrganizationHoldReader,
  organizationNotStoppedCondition,
  organizationNotSuspendedCondition,
  type TransactionOperation,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import { admitConsistently } from "@deployments-ai/organization-admission";
import { CodedRunFailure, type RuntimeLeaseRecordValue } from "./agent-run-input.ts";
import { releaseStaleThreadExecutionLease } from "./agent-run-lease-release.ts";
import { failureChain } from "./failure-log.ts";
import { terminalRun } from "./records.ts";
import { runEvent } from "./run-mutations.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

/**
 * A run's first claim stamps `startedAt`, and every worker requeue (checkpoint, interruption,
 * scheduled retry, approval or tool resume) keeps it. Such a run was already admitted, so a
 * payment hold lets it drain; only a run that never started needs `run.admit`.
 */
function wasAdmitted(run: RunRecordValue): boolean {
  return run.data.status === "running" || run.data.startedAt !== undefined;
}

/** Whether the run's organization standing refuses it, read strongly consistently. */
export async function organizationRefusesRun(
  dependencies: Pick<AgentRunWorkerDependencies, "database">,
  run: RunRecordValue,
): Promise<boolean> {
  const { decision } = await admitConsistently({
    activity: wasAdmitted(run) ? "run.continue" : "run.admit",
    organizationId: run.data.organizationId,
    standing: makeOrganizationHoldReader(dependencies.database),
  });
  return decision.kind === "suspended";
}

/** The claim transaction's standing guard, matching `organizationRefusesRun` for the same run. */
export function claimStandingCondition(run: RunRecordValue): TransactionOperation {
  return wasAdmitted(run)
    ? organizationNotStoppedCondition(run.data.organizationId)
    : organizationNotSuspendedCondition(run.data.organizationId);
}

function organizationStopsRun(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
): Promise<boolean> {
  const read = () => organizationRefusesRun(dependencies, run);
  return read()
    .catch(read)
    .catch((cause: unknown) => {
      console.error(
        "Organization standing could not be read after a claim renewal failed; the run was not canceled.",
        {
          failure: failureChain(cause),
          organizationId: run.data.organizationId,
          runId: run.data.id,
        },
      );
      return false;
    });
}

/**
 * Cancels a running run after a stop hold refused its claim renewal. It writes what an external
 * cancellation writes, so the claim's cancellation reconciliation settles the run once execution
 * unwinds. Returns the failure to abort execution with, or undefined when the organization does not
 * stop runs, its standing stays unreadable, or the claim moved on, leaving the renewal's own
 * failure to stand.
 */
export async function cancelStoppedRun(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
  at: Date,
): Promise<CodedRunFailure | undefined> {
  if (!(await organizationStopsRun(dependencies, run))) return undefined;
  const failure = new CodedRunFailure(
    "organization_suspended",
    "The run was canceled because its organization was suspended.",
  );
  const canceled = terminalRun(run, "canceled", at, failure.message, failure.code);
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        releaseStaleThreadExecutionLease(lease),
        { kind: "put", previousRecord: run, record: canceled },
      ],
      [runEvent(canceled, await dependencies.generateId(), "run.canceled", at)],
    );
  } catch (cause) {
    if (isDatabaseWriteConflict(cause)) return undefined;
    throw cause;
  }
  return failure;
}
