/* eslint-disable no-await-in-loop -- Worker transitions and stream events are ordered side effects. */

import { type RuntimeProgressEvent } from "@deployments-ai/agent-runtime";
import { leaseIsMessagePublicationBarrier } from "@deployments-ai/conversations";
import { createThreadStreamEvent, type ThreadStreamEvent } from "@deployments-ai/streaming";
import {
  RuntimeLeaseRecord,
  Ulid,
  withCanonicalRecordKeys,
  workerPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { loadThreadRunById, AgentRunWorkerRecordError } from "./records.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";
import { agentRunRecoveryQueueMessageGroupId } from "./types.ts";
import { replayCallbackPublication } from "./approvals.ts";
import { queueMessage as runQueueMessage } from "./approval-shared.ts";
import {
  releaseExactThreadExecutionLease,
  releaseStaleThreadExecutionLease,
} from "./agent-run-lease-release.ts";
export { requireThreadExecutionLease } from "./agent-run-lease-release.ts";
import {
  AgentRunClaimActiveError,
  agentRunRetryAttemptsExhausted,
  TERMINAL_PROGRESS_EVENT_TYPES,
  TERMINAL_STATUSES,
  agentRunRetryExhaustedError,
  metadata,
  now,
} from "./agent-run-input.ts";
import type { RuntimeLeaseRecordValue } from "./agent-run-input.ts";
import {
  appendCanonicalRunTerminalEvent,
  appendFinalizedMessage,
  appendPausedRunEvent,
  finalizedMessageForRun,
  persistFailedRun,
  persistedPendingAction,
} from "./agent-run-terminal.ts";
import {
  appendChannelAgentProgress,
  reconcileRecoveredChannelAgentStreams,
  type ChannelAgentStreamProvider,
} from "./channel-agent-stream.ts";

const PROGRESS_EVENT_PUBLICATION_TIMEOUT_MS = 1_000;

async function reconcileRecoveredChannelStreams(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  run: RunRecordValue,
) {
  return reconcileRecoveredChannelAgentStreams(dependencies, run, async () => {
    const finalized = await finalizedMessageForRun(dependencies, queue, run);
    if (!finalized) {
      throw new AgentRunWorkerRecordError(
        "finalized_message_not_found",
        `Completed prior run ${run.data.id} is missing its finalized message.`,
      );
    }
    return (
      finalized.data.body ??
      (dependencies.readMessageBody
        ? await dependencies.readMessageBody(finalized)
        : "Agent response is available in Deployments.ai.")
    );
  });
}

async function enqueueRecoveredStreamReconciliation(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
  provider: ChannelAgentStreamProvider,
) {
  if (!dependencies.enqueueRun) {
    throw new Error("Channel stream recovery requires an agent run queue enqueue dependency.");
  }
  const message = runQueueMessage(run);
  await dependencies.enqueueRun({
    deduplicationId: `${provider}-terminal-recovery:${run.data.id}:${lease.data.version}`,
    message,
    messageGroupId: agentRunRecoveryQueueMessageGroupId(message),
  });
}

export async function appendEvent(
  dependencies: AgentRunWorkerDependencies,
  event: ThreadStreamEvent,
  signal?: AbortSignal,
): Promise<void> {
  await dependencies.appendThreadEvent?.(event, signal);
}

export async function progressEvent(
  dependencies: AgentRunWorkerDependencies,
  progress: RuntimeProgressEvent,
  run?: RunRecordValue,
): Promise<void> {
  if (TERMINAL_PROGRESS_EVENT_TYPES.has(progress.eventType)) return;
  const eventId = await dependencies.generateId();
  const progressMetadata = metadata(progress.metadata);
  const approvalId =
    typeof progressMetadata.approvalId === "string" ? progressMetadata.approvalId : undefined;
  const artifactId =
    typeof progressMetadata.artifactId === "string" ? progressMetadata.artifactId : undefined;
  const messageId =
    typeof progressMetadata.messageId === "string" ? progressMetadata.messageId : undefined;
  const toolCallId =
    typeof progressMetadata.toolCallId === "string" ? progressMetadata.toolCallId : undefined;
  const threadEvent = createThreadStreamEvent({
    actor: { id: dependencies.workerId, type: "worker" },
    environmentId: progress.environmentId,
    eventId,
    eventType: progress.eventType,
    occurredAt: progress.occurredAt,
    organizationId: progress.organizationId,
    payload: {
      level: progress.level,
      message: progress.message,
      ...(progress.metadata ? { metadata: progress.metadata } : {}),
    },
    projectId: progress.projectId,
    ...(approvalId ? { approvalId } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(messageId ? { messageId } : {}),
    runId: progress.runId,
    threadId: progress.threadId,
    ...(toolCallId ? { toolCallId } : {}),
  });
  const progressPublicationSignal = AbortSignal.timeout(PROGRESS_EVENT_PUBLICATION_TIMEOUT_MS);
  const publications: Promise<void>[] = [
    appendEvent(dependencies, threadEvent, progressPublicationSignal),
  ];
  if (run?.data.id === progress.runId) {
    publications.push(appendChannelAgentProgress(dependencies, run, progress));
  }
  const results = await Promise.allSettled(publications);
  const threadFailure = results[0];
  if (threadFailure?.status === "rejected") throw threadFailure.reason;
}

export function threadExecutionLease(input: {
  readonly acquiredAt: string;
  readonly environmentId?: Ulid;
  readonly expiresAt: string;
  readonly organizationId?: Ulid;
  readonly owner: string;
  readonly projectId?: Ulid;
  readonly renewedAt?: string;
  readonly runId: Ulid;
  readonly threadId: Ulid;
  readonly version: number;
}): RuntimeLeaseRecordValue {
  return Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: input.acquiredAt,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        expiresAt: input.expiresAt,
        id: input.threadId,
        leaseKey: `agent-run-thread/${input.threadId}`,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        owner: input.owner,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.renewedAt ? { renewedAt: input.renewedAt } : {}),
        runId: input.runId,
        threadId: input.threadId,
        version: input.version,
      },
      itemType: "runtime-lease" as const,
    }),
  );
}

export function preservedThreadExecutionLeaseScope(previous: RuntimeLeaseRecordValue) {
  return {
    ...(previous.data.environmentId ? { environmentId: previous.data.environmentId } : {}),
    ...(previous.data.organizationId ? { organizationId: previous.data.organizationId } : {}),
    ...(previous.data.projectId ? { projectId: previous.data.projectId } : {}),
  };
}

const QUEUED_RUN_LEASE_OWNER_PREFIX = "queued-run/";

export function isQueuedRunThreadExecutionLease(
  lease: RuntimeLeaseRecordValue,
  run: RunRecordValue,
): boolean {
  return (
    run.data.status === "queued" &&
    lease.data.runId === run.data.id &&
    lease.data.owner === `${QUEUED_RUN_LEASE_OWNER_PREFIX}${run.data.id}`
  );
}

export function queuedRunThreadExecutionLease(
  previous: RuntimeLeaseRecordValue,
  run: RunRecordValue,
  timestamp: Date,
): RuntimeLeaseRecordValue {
  const acquiredAt = Date.parse(previous.data.renewedAt ?? previous.data.acquiredAt);
  const expiresAt = Date.parse(previous.data.expiresAt);
  const durationMs = expiresAt - acquiredAt;
  if (!Number.isFinite(durationMs) || durationMs <= 1) {
    throw new AgentRunWorkerRecordError(
      "thread_execution_lease_invalid",
      "Thread execution lease duration is invalid.",
    );
  }
  return threadExecutionLease({
    acquiredAt: timestamp.toISOString(),
    expiresAt: new Date(timestamp.getTime() + durationMs).toISOString(),
    owner: `${QUEUED_RUN_LEASE_OWNER_PREFIX}${run.data.id}`,
    renewedAt: timestamp.toISOString(),
    runId: run.data.id,
    ...preservedThreadExecutionLeaseScope(previous),
    threadId: run.data.threadId,
    version: previous.data.version + 1,
  });
}

async function replaceThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  previous: RuntimeLeaseRecordValue,
  replacement: RuntimeLeaseRecordValue,
): Promise<void> {
  const operation = { kind: "put" as const, previousRecord: previous, record: replacement };
  const transactionToken = createHash("sha256")
    .update(JSON.stringify(operation))
    .digest("hex")
    .slice(0, 36);
  try {
    await workerPersistence.commit(dependencies.database, [operation], transactionToken);
  } catch (cause) {
    const latest = await loadThreadExecutionLease(dependencies, replacement);
    if (
      latest?.data.owner === replacement.data.owner &&
      latest.data.runId === replacement.data.runId &&
      latest.data.version === replacement.data.version
    ) {
      return;
    }
    throw cause;
  }
}

export async function loadThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  key: Pick<RuntimeLeaseRecordValue, "pk" | "sk">,
): Promise<RuntimeLeaseRecordValue | undefined> {
  const found = await workerPersistence.read(
    dependencies.database,
    "execution",
    { pk: key.pk, sk: key.sk },
    true,
  );
  if (found === undefined) return undefined;
  if (found.itemType !== "runtime-lease") {
    throw new AgentRunWorkerRecordError(
      "thread_execution_lease_invalid",
      "Thread execution lease key contains an unexpected record.",
    );
  }
  return found;
}

export async function loadRunThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
): Promise<RuntimeLeaseRecordValue | undefined> {
  const probe = threadExecutionLease({
    acquiredAt: run.data.claimedAt ?? run.data.createdAt,
    expiresAt: run.data.heartbeatAt ?? run.data.updatedAt,
    owner: run.data.claimedBy ?? `expired-run/${run.data.id}`,
    runId: run.data.id,
    threadId: run.data.threadId,
    version: 0,
  });
  return loadThreadExecutionLease(dependencies, probe);
}

export function matchingRunThreadExecutionLease(
  lease: RuntimeLeaseRecordValue | undefined,
  run: RunRecordValue,
): RuntimeLeaseRecordValue | undefined {
  if (!lease || lease.data.runId !== run.data.id) return undefined;
  if (isQueuedRunThreadExecutionLease(lease, run)) return lease;
  return run.data.claimedBy && lease.data.owner === run.data.claimedBy ? lease : undefined;
}

export async function loadMatchingRunThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
): Promise<RuntimeLeaseRecordValue | undefined> {
  return matchingRunThreadExecutionLease(await loadRunThreadExecutionLease(dependencies, run), run);
}

export async function replaySameRunCallbackPublication(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
): Promise<"queued" | "terminal" | undefined> {
  const timestamp = now(dependencies);
  const probe = threadExecutionLease({
    acquiredAt: timestamp.toISOString(),
    expiresAt: timestamp.toISOString(),
    owner: `callback-probe/${run.data.id}`,
    runId: run.data.id,
    threadId: run.data.threadId,
    version: 0,
  });
  const lease = await loadThreadExecutionLease(dependencies, probe);
  if (!lease || lease.data.runId !== run.data.id) return undefined;
  if (isQueuedRunThreadExecutionLease(lease, run)) return undefined;
  return replayCallbackPublication(run, lease, {
    ...(dependencies.appendThreadEvent
      ? { appendThreadEvent: dependencies.appendThreadEvent }
      : {}),
    database: dependencies.database,
    // The current SQS delivery already represents this resumed run. Replaying
    // the same FIFO deduplication ID and then acknowledging this delivery could
    // otherwise leave no runnable message when SQS suppresses the duplicate.
    enqueueRun: async () => undefined,
    generateId: dependencies.generateId,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
}

export async function releasePublishedRunThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  knownLease?: RuntimeLeaseRecordValue,
): Promise<void> {
  const lease = knownLease ?? (await loadMatchingRunThreadExecutionLease(dependencies, run));
  if (!lease) return;
  await releaseExactThreadExecutionLease(dependencies, lease);
}

export function threadExecutionLeaseIsActive(
  lease: RuntimeLeaseRecordValue,
  timestamp: Date,
  claimTimeoutMs: number,
): boolean {
  const expiresAt = Date.parse(lease.data.expiresAt);
  const renewedAt = Date.parse(lease.data.renewedAt ?? lease.data.acquiredAt);
  const renewalAge = timestamp.getTime() - renewedAt;
  return (
    Number.isFinite(expiresAt) &&
    expiresAt > timestamp.getTime() &&
    Number.isFinite(renewedAt) &&
    renewalAge >= -claimTimeoutMs
  );
}

async function clearStaleOrphanThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  lease: RuntimeLeaseRecordValue,
): Promise<void> {
  const operation = releaseStaleThreadExecutionLease(lease);
  const transactionToken = createHash("sha256")
    .update(JSON.stringify(operation))
    .digest("hex")
    .slice(0, 36);
  try {
    await workerPersistence.commit(dependencies.database, [operation], transactionToken);
  } catch (cause) {
    const latest = await loadThreadExecutionLease(dependencies, lease);
    if (!latest) return;
    if (
      latest.data.owner !== lease.data.owner ||
      latest.data.expiresAt !== lease.data.expiresAt ||
      latest.data.runId !== lease.data.runId ||
      latest.data.version !== lease.data.version
    ) {
      throw new AgentRunClaimActiveError(latest.data.runId ?? queue.runId);
    }
    throw cause;
  }
}

export async function recoverStaleForeignThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  claimTimeoutMs: number,
): Promise<boolean> {
  const timestamp = now(dependencies);
  const probe = threadExecutionLease({
    acquiredAt: timestamp.toISOString(),
    expiresAt: new Date(timestamp.getTime() + claimTimeoutMs).toISOString(),
    owner: `lease-probe/${queue.runId}`,
    runId: queue.runId,
    threadId: queue.threadId,
    version: 0,
  });
  const lease = await loadThreadExecutionLease(dependencies, probe);
  if (!lease) return false;
  if (leaseIsMessagePublicationBarrier(lease)) {
    throw new AgentRunClaimActiveError(lease.data.runId ?? queue.runId);
  }
  if (lease.data.runId === queue.runId) return false;
  if (threadExecutionLeaseIsActive(lease, timestamp, claimTimeoutMs)) {
    throw new AgentRunClaimActiveError(lease.data.runId ?? queue.runId);
  }
  if (!lease.data.runId) {
    await clearStaleOrphanThreadExecutionLease(dependencies, queue, lease);
    return false;
  }

  const prior = await loadThreadRunById(dependencies.database, queue, lease.data.runId);
  if (!prior) {
    await clearStaleOrphanThreadExecutionLease(dependencies, queue, lease);
    return false;
  }
  if (isQueuedRunThreadExecutionLease(lease, prior)) {
    if (agentRunRetryAttemptsExhausted(prior)) {
      const failed = await persistFailedRun(
        dependencies,
        prior,
        agentRunRetryExhaustedError(),
        lease,
      );
      const failedStream = await reconcileRecoveredChannelStreams(dependencies, queue, failed);
      await appendCanonicalRunTerminalEvent(dependencies, failed);
      if (failedStream) {
        await enqueueRecoveredStreamReconciliation(dependencies, failed, lease, failedStream);
      }
      await releaseExactThreadExecutionLease(dependencies, lease);
      return false;
    }
    if (!dependencies.enqueueRun) {
      throw new Error("Queued run recovery requires an agent run queue enqueue dependency.");
    }
    const recoveredQueue = runQueueMessage(prior);
    await dependencies.enqueueRun({
      deduplicationId: `queued-run-recovery:${prior.data.id}:${lease.data.version}`,
      message: recoveredQueue,
      messageGroupId: agentRunRecoveryQueueMessageGroupId(recoveredQueue),
    });
    await replaceThreadExecutionLease(
      dependencies,
      lease,
      queuedRunThreadExecutionLease(lease, prior, timestamp),
    );
    return true;
  }
  const callbackReplay = await replayCallbackPublication(prior, lease, {
    ...(dependencies.appendThreadEvent
      ? { appendThreadEvent: dependencies.appendThreadEvent }
      : {}),
    database: dependencies.database,
    ...(dependencies.enqueueRun
      ? {
          enqueueRun: async (input) => {
            await dependencies.enqueueRun!({
              ...input,
              messageGroupId: agentRunRecoveryQueueMessageGroupId(input.message),
            });
          },
        }
      : {}),
    completePublicationBarrier: async (barrier) => {
      if (prior.data.status !== "queued") {
        return;
      }
      await replaceThreadExecutionLease(
        dependencies,
        barrier,
        queuedRunThreadExecutionLease(barrier, prior, now(dependencies)),
      );
    },
    generateId: dependencies.generateId,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  if (callbackReplay === "queued") return true;
  if (callbackReplay === "terminal") {
    const failedStream = await reconcileRecoveredChannelStreams(dependencies, queue, prior);
    if (failedStream) {
      await enqueueRecoveredStreamReconciliation(dependencies, prior, lease, failedStream);
    }
    await releaseExactThreadExecutionLease(dependencies, lease);
    return false;
  }
  if (TERMINAL_STATUSES.has(prior.data.status)) {
    if (prior.data.status === "completed") {
      const finalized = await finalizedMessageForRun(dependencies, queue, prior);
      if (!finalized) {
        throw new AgentRunWorkerRecordError(
          "finalized_message_not_found",
          `Completed prior run ${prior.data.id} is missing its finalized message.`,
        );
      }
      await appendFinalizedMessage(dependencies, finalized);
    }
    const failedStream = await reconcileRecoveredChannelStreams(dependencies, queue, prior);
    await appendCanonicalRunTerminalEvent(dependencies, prior);
    if (failedStream) {
      await enqueueRecoveredStreamReconciliation(dependencies, prior, lease, failedStream);
    }
    await releaseExactThreadExecutionLease(dependencies, lease);
    return false;
  }
  if (prior.data.status === "waiting-for-approval" || prior.data.status === "waiting-for-tool") {
    const pendingAction = await persistedPendingAction(dependencies, prior);
    const failedStream = await reconcileRecoveredChannelStreams(dependencies, queue, prior);
    await appendPausedRunEvent(dependencies, prior, pendingAction);
    if (failedStream) {
      await enqueueRecoveredStreamReconciliation(dependencies, prior, lease, failedStream);
    }
    await releaseExactThreadExecutionLease(dependencies, lease);
    return false;
  }
  if (prior.data.status === "running") {
    const failed = await persistFailedRun(
      dependencies,
      prior,
      new AgentRunWorkerRecordError(
        "run_abandoned",
        `Run ${prior.data.id} was abandoned after its thread execution lease expired.`,
      ),
      lease,
    );
    const failedStream = await reconcileRecoveredChannelStreams(dependencies, queue, failed);
    await appendCanonicalRunTerminalEvent(dependencies, failed);
    if (failedStream) {
      await enqueueRecoveredStreamReconciliation(dependencies, failed, lease, failedStream);
    }
    await releaseExactThreadExecutionLease(dependencies, lease);
    return false;
  }
  throw new AgentRunWorkerRecordError(
    "thread_execution_lease_invalid",
    `Expired thread execution lease references ${prior.data.status} run ${prior.data.id}.`,
  );
}
