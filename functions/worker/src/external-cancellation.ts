import { executionEventPayload } from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { loadMatchingRunThreadExecutionLease } from "./agent-run-lease.ts";
import { now } from "./agent-run-input.ts";
import { loadRun, settledCanceledRun } from "./records.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

export async function settleExternalCancellation(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  expected: RunRecordValue,
  options: {
    readonly expectedClaimedBy: string;
  },
): Promise<RunRecordValue | undefined> {
  const persisted = await loadRun(dependencies.database, queue);
  if (
    persisted?.data.status !== "canceled" ||
    persisted.data.attempt !== expected.data.attempt ||
    persisted.data.traceId !== expected.data.traceId
  ) {
    return undefined;
  }
  if (persisted.data.claimedBy === undefined) return persisted;
  if (persisted.data.claimedBy !== options.expectedClaimedBy) {
    return undefined;
  }
  const timestamp = now(dependencies);
  if (await loadMatchingRunThreadExecutionLease(dependencies, persisted)) return undefined;
  const settled = settledCanceledRun(persisted, timestamp);
  const event = makeSemanticEventRecord({
    aggregateId: settled.data.id,
    aggregateType: "run",
    aggregateVersion: settled.data.version + 1,
    environmentId: settled.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: "run.cancellation-reconciled",
    occurredAt: timestamp,
    organizationId: settled.data.organizationId,
    payload: executionEventPayload(settled.data, {
      attempt: settled.data.attempt,
      status: settled.data.status,
      threadId: settled.data.threadId,
    }),
    projectId: settled.data.projectId,
  });
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [{ kind: "put", previousRecord: persisted, record: settled }],
      [event],
    );
    return settled;
  } catch (cause) {
    const latest = await loadRun(dependencies.database, queue);
    if (
      latest?.data.status === "canceled" &&
      latest.data.claimedBy === undefined &&
      latest.data.attempt === expected.data.attempt
    ) {
      return latest;
    }
    throw cause;
  }
}
