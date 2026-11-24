import { agentRunActorId, type RuntimeAgentPlanEvent } from "@deployments-ai/agent-runtime";
import { makeAgentRunPlanPersistence, Ulid, type Ulid as UlidValue } from "@deployments-ai/db";
import { createThreadStreamEvent, parseAgentPlanUpdate } from "@deployments-ai/streaming";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { appendChannelAgentPlan } from "./channel-agent-stream.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";
import type { RuntimeLeaseRecordValue } from "./agent-run-input.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function planEventId(
  runId: UlidValue,
  runExecutionVersion: number,
  revision: number,
  kind: "semantic" | "thread" | "thread-snapshot",
): UlidValue {
  const bytes = createHash("sha256")
    .update(`deployments-ai:agent-plan:${kind}:${runId}:${runExecutionVersion}:${revision}`)
    .digest()
    .subarray(0, 10);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(value & 31n)]! + suffix;
    value >>= 5n;
  }
  return Schema.decodeUnknownSync(Ulid)(`${runId.slice(0, 10)}${suffix}`);
}

export async function replayAgentPlanSnapshot(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
): Promise<void> {
  const record = await makeAgentRunPlanPersistence(dependencies.database).load({
    organizationId: run.data.organizationId,
    runId: run.data.id,
  });
  if (
    !record ||
    record.data.runAttempt !== run.data.attempt ||
    record.data.runClaimedAt !== (run.data.claimedAt ?? run.data.updatedAt)
  ) {
    return;
  }
  await dependencies.appendThreadEvent?.(
    createThreadStreamEvent({
      actor: { id: agentRunActorId(run.data), type: "agent" },
      environmentId: run.data.environmentId,
      eventId: planEventId(
        run.data.id,
        record.data.runExecutionVersion,
        record.data.planRevision,
        "thread-snapshot",
      ),
      eventType: "agent.plan.updated",
      occurredAt: record.data.updatedAt,
      organizationId: run.data.organizationId,
      payload: {
        plan: {
          revision: record.data.planRevision,
          tasks: record.data.tasks,
          title: record.data.title,
        },
        runAttempt: record.data.runAttempt,
        runExecutionVersion: record.data.runExecutionVersion,
      },
      projectId: run.data.projectId,
      runId: run.data.id,
      threadId: run.data.threadId,
    }),
  );
}

function assertEventScope(event: RuntimeAgentPlanEvent, run: RunRecordValue) {
  if (
    event.runId !== run.data.id ||
    event.organizationId !== run.data.organizationId ||
    event.projectId !== run.data.projectId ||
    event.environmentId !== run.data.environmentId ||
    event.workspaceId !== run.data.workspaceId ||
    event.threadId !== run.data.threadId ||
    event.agentDeploymentId !== run.data.agentDeploymentId ||
    event.executionBindingId !== run.data.executionBindingId ||
    event.traceId !== run.data.traceId ||
    event.runAttempt !== run.data.attempt ||
    event.runExecutionVersion > run.data.version
  ) {
    throw new Error("Agent plan event does not match the active run scope.");
  }
}

export async function publishAgentPlanUpdate(
  dependencies: AgentRunWorkerDependencies,
  event: RuntimeAgentPlanEvent,
  run: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
): Promise<void> {
  assertEventScope(event, run);
  const update = parseAgentPlanUpdate(event);
  const persistence = makeAgentRunPlanPersistence(dependencies.database);
  const result = await persistence.persist({
    environmentId: run.data.environmentId,
    eventId: planEventId(run.data.id, event.runExecutionVersion, update.plan.revision, "semantic"),
    expectedLease: lease,
    expectedRun: run,
    occurredAt: event.occurredAt,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    runAttempt: event.runAttempt,
    runClaimedAt: run.data.claimedAt ?? run.data.updatedAt,
    runExecutionVersion: event.runExecutionVersion,
    runId: run.data.id,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
    update,
    ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
  });
  if (!result.shouldPublish) return;
  if (
    result.record.data.runExecutionVersion !== event.runExecutionVersion ||
    result.record.data.planRevision !== update.plan.revision
  ) {
    return;
  }
  const threadEvent = createThreadStreamEvent({
    actor: { id: agentRunActorId(run.data), type: "agent" },
    environmentId: run.data.environmentId,
    eventId: planEventId(run.data.id, event.runExecutionVersion, update.plan.revision, "thread"),
    eventType: update.eventType,
    occurredAt: event.occurredAt,
    organizationId: run.data.organizationId,
    payload: {
      plan: update.plan,
      runAttempt: event.runAttempt,
      runExecutionVersion: event.runExecutionVersion,
      ...(update.eventType === "agent.task.updated" ? { task: update.task } : {}),
    },
    projectId: run.data.projectId,
    runId: run.data.id,
    threadId: run.data.threadId,
  });
  const publications = await Promise.allSettled([
    dependencies.appendThreadEvent?.(threadEvent) ?? Promise.resolve(),
    appendChannelAgentPlan(dependencies, run, event.runExecutionVersion, update),
  ]);
  if (publications[0]?.status === "rejected") throw publications[0].reason;
}
