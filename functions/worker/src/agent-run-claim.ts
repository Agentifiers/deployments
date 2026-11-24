/* eslint-disable no-await-in-loop -- Worker transitions and stream events are ordered side effects. */

import { type RuntimeUsageEntry } from "@deployments-ai/agent-runtime";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import {
  UNIQUE_CLAIM_CONDITION,
  executionEventPayload,
  executionPinsPayload,
  key,
  organizationNotStoppedCondition,
  type TransactionOperation,
  workerPersistence,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  heartbeatRun,
  loadRun,
  MAX_RUNTIME_USAGE_ENTRIES,
  canonicalRuntimeUsageIdempotencyKey,
  runningRun,
  runtimeUsageRecord,
  runLookupRecord,
  AgentRunWorkerRecordError,
} from "./records.ts";
import type {
  AgentRunQueueMessage,
  AgentRunQueueDelivery,
  AgentRunWorkerDependencies,
  RunLookupRecordValue,
  RunRecordValue,
  ThreadRecordValue,
} from "./types.ts";
import {
  executionTargetConditions,
  type RunExecutionTarget,
} from "./agent-run-execution-target.ts";
import {
  AgentRunClaimActiveError,
  ExternalCancellationReconciledError,
  MAX_COMPLETION_ATTEMPTS,
  now,
} from "./agent-run-input.ts";
import type {
  AcknowledgeExternalCancellation,
  ClaimedRunState,
  ReconcileCanceledRunClaim,
  ReleaseRunClaim,
  RuntimeLeaseRecordValue,
  WithRunClaimSnapshot,
} from "./agent-run-input.ts";
import {
  isQueuedRunThreadExecutionLease,
  loadThreadExecutionLease,
  preservedThreadExecutionLeaseScope,
  threadExecutionLease,
  threadExecutionLeaseIsActive,
} from "./agent-run-lease.ts";
import { settleExternalCancellation } from "./external-cancellation.ts";
import { cancelStoppedRun, claimStandingCondition } from "./agent-run-standing.ts";

export interface RunClaimBasis {
  readonly lease: RuntimeLeaseRecordValue | undefined;
  readonly run: RunRecordValue;
  readonly runLookup: RunLookupRecordValue | undefined;
  readonly target: RunExecutionTarget;
  readonly thread: ThreadRecordValue;
}

export async function claimRun(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  basis: RunClaimBasis,
  claimTimeoutMs: number,
  executionSlot: number,
  eventType: "run.reclaimed" | "run.started",
): Promise<ClaimedRunState> {
  const {
    lease: previousLease,
    run: previous,
    runLookup: previousRunLookup,
    target,
    thread,
  } = basis;
  const timestamp = now(dependencies);
  const claimId = await dependencies.generateId();
  const run = runningRun(
    previous,
    `${dependencies.workerId}:${claimId}`,
    timestamp,
    { id: queue.userMessageId, sequence: queue.userMessageSequence },
    executionSlot,
  );
  if (!run.data.claimedBy) {
    throw new AgentRunWorkerRecordError(
      "run_claim_lost",
      "Claimed run did not include an owner token.",
    );
  }
  const leaseKey = threadExecutionLease({
    acquiredAt: timestamp.toISOString(),
    environmentId: run.data.environmentId,
    expiresAt: new Date(timestamp.getTime() + claimTimeoutMs).toISOString(),
    organizationId: run.data.organizationId,
    owner: run.data.claimedBy,
    projectId: run.data.projectId,
    runId: run.data.id,
    threadId: thread.data.id,
    version: 0,
  });
  const queuedRunLease = previousLease
    ? isQueuedRunThreadExecutionLease(previousLease, previous)
    : false;
  const runLookup = runLookupRecord(previous);
  if (previousRunLookup && previousRunLookup.data.idempotencyKey !== previous.data.idempotencyKey) {
    throw new AgentRunWorkerRecordError(
      "run_lookup_mismatch",
      `Run lookup ${previous.data.id} does not match its idempotency key.`,
    );
  }
  if (
    previousLease &&
    !queuedRunLease &&
    threadExecutionLeaseIsActive(previousLease, timestamp, claimTimeoutMs)
  ) {
    throw new AgentRunClaimActiveError(previous.data.id);
  }
  if (previousLease && previousLease.data.runId !== previous.data.id) {
    throw new AgentRunClaimActiveError(previous.data.id);
  }
  if (
    previousLease &&
    !queuedRunLease &&
    (!previous.data.claimedBy || previousLease.data.owner !== previous.data.claimedBy)
  ) {
    throw new AgentRunClaimActiveError(previous.data.id);
  }
  const lease = previousLease
    ? threadExecutionLease({
        acquiredAt: timestamp.toISOString(),
        expiresAt: new Date(timestamp.getTime() + claimTimeoutMs).toISOString(),
        owner: run.data.claimedBy,
        runId: run.data.id,
        ...preservedThreadExecutionLeaseScope(previousLease),
        threadId: thread.data.id,
        version: previousLease.data.version + 1,
      })
    : leaseKey;
  const eventId = await dependencies.generateId();
  const event = makeSemanticEventRecord({
    aggregateId: run.data.id,
    aggregateType: "run",
    aggregateVersion: run.data.version + 1,
    environmentId: run.data.environmentId,
    eventId,
    eventType,
    occurredAt: timestamp,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      ...executionPinsPayload(run.data),
      attempt: run.data.attempt,
      status: run.data.status,
      threadId: run.data.threadId,
    }),
    projectId: run.data.projectId,
  });
  const operations: readonly TransactionOperation[] = [
    {
      conditionExpression: "#data.#version = :version",
      expressionAttributeNames: {
        "#data": "data",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":version": thread.data.version,
      },
      key: { pk: thread.pk, sk: thread.sk },
      kind: "condition-check",
      table: "execution",
    },
    ...executionTargetConditions(target, timestamp),
    claimStandingCondition(previous),
    previousLease
      ? { kind: "put", previousRecord: previousLease, record: lease }
      : { conditionExpression: UNIQUE_CLAIM_CONDITION, kind: "put", record: lease },
    ...(previousRunLookup
      ? []
      : [
          {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put" as const,
            record: runLookup,
          },
        ]),
    { kind: "put", previousRecord: previous, record: run },
  ];
  const transactionToken = createHash("sha256")
    .update(JSON.stringify({ event, operations }))
    .digest("hex")
    .slice(0, 36);
  try {
    await transactWithSemanticEvents(dependencies.database, operations, [event], transactionToken);
    return { lease, run };
  } catch (cause) {
    const [persisted, persistedLease] = await Promise.all([
      loadRun(dependencies.database, queue),
      loadThreadExecutionLease(dependencies, lease),
    ]);
    if (
      persisted?.data.status === run.data.status &&
      persisted.data.version === run.data.version &&
      persisted.data.claimedBy === run.data.claimedBy &&
      persisted.data.attempt === run.data.attempt &&
      persisted.data.claimedAt === run.data.claimedAt &&
      persistedLease?.data.owner === lease.data.owner &&
      persistedLease.data.version === lease.data.version
    ) {
      return { lease: persistedLease, run: persisted };
    }
    throw cause;
  }
}

export function claimHeartbeatInterval(
  dependencies: AgentRunWorkerDependencies,
  claimTimeoutMs: number,
): number {
  const interval =
    dependencies.heartbeatIntervalMs ??
    Math.max(10, Math.min(60_000, Math.floor(claimTimeoutMs / 3)));
  if (!Number.isSafeInteger(interval) || interval <= 0 || interval >= claimTimeoutMs) {
    throw new AgentRunWorkerRecordError(
      "invalid_heartbeat_interval",
      "Run heartbeat interval must be a positive integer below the claim timeout.",
    );
  }
  return interval;
}

export function queueVisibilityExtensionTimeout(dependencies: AgentRunWorkerDependencies): number {
  const timeout = dependencies.queueVisibilityExtensionTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new AgentRunWorkerRecordError(
      "invalid_visibility_extension_timeout",
      "Queue visibility extension timeout must be a positive integer.",
    );
  }
  return timeout;
}

export function queueVisibilityRenewalInterval(
  dependencies: AgentRunWorkerDependencies,
): number | undefined {
  const interval = dependencies.extendQueueVisibility?.renewalIntervalMs;
  if (interval === undefined) return undefined;
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new AgentRunWorkerRecordError(
      "invalid_visibility_renewal_interval",
      "Queue visibility renewal interval must be a positive integer.",
    );
  }
  return interval;
}

async function renewRunClaim(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  previous: RunRecordValue,
  previousLease: RuntimeLeaseRecordValue,
  claimTimeoutMs: number,
): Promise<ClaimedRunState> {
  const timestamp = now(dependencies);
  const claimOwner = previous.data.claimedBy;
  if (!claimOwner) {
    throw new AgentRunWorkerRecordError(
      "run_claim_lost",
      "Run heartbeat cannot renew a claim without an owner token.",
    );
  }
  const renewed = heartbeatRun(previous, claimOwner, timestamp);
  if (previousLease.data.owner !== claimOwner) {
    throw new AgentRunWorkerRecordError(
      "thread_execution_lease_lost",
      "Thread execution lease is owned by another run claim.",
    );
  }
  const renewedLease = threadExecutionLease({
    acquiredAt: previousLease.data.acquiredAt,
    expiresAt: new Date(timestamp.getTime() + claimTimeoutMs).toISOString(),
    owner: previousLease.data.owner,
    renewedAt: timestamp.toISOString(),
    runId: renewed.data.id,
    ...preservedThreadExecutionLeaseScope(previousLease),
    threadId: renewed.data.threadId,
    version: previousLease.data.version + 1,
  });
  const event = makeSemanticEventRecord({
    aggregateId: renewed.data.id,
    aggregateType: "run",
    aggregateVersion: renewed.data.version + 1,
    environmentId: renewed.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: "run.heartbeat",
    occurredAt: timestamp,
    organizationId: renewed.data.organizationId,
    payload: executionEventPayload(renewed.data, {
      claimedBy: claimOwner,
      heartbeatAt: renewed.data.heartbeatAt ?? timestamp.toISOString(),
      threadId: renewed.data.threadId,
    }),
    projectId: renewed.data.projectId,
  });
  const operations: readonly TransactionOperation[] = [
    organizationNotStoppedCondition(renewed.data.organizationId),
    { kind: "put", previousRecord: previous, record: renewed },
    { kind: "put", previousRecord: previousLease, record: renewedLease },
  ];
  const transactionToken = createHash("sha256")
    .update(JSON.stringify({ event, operations }))
    .digest("hex")
    .slice(0, 36);
  try {
    await transactWithSemanticEvents(dependencies.database, operations, [event], transactionToken);
    return { lease: renewedLease, run: renewed };
  } catch (cause) {
    const [persisted, persistedLease] = await Promise.all([
      loadRun(dependencies.database, queue),
      loadThreadExecutionLease(dependencies, renewedLease),
    ]);
    if (
      persisted?.data.status === "running" &&
      persisted.data.version === renewed.data.version &&
      persisted.data.claimedBy === renewed.data.claimedBy &&
      persisted.data.attempt === renewed.data.attempt &&
      persisted.data.heartbeatAt === renewed.data.heartbeatAt &&
      persistedLease?.data.owner === renewedLease.data.owner &&
      persistedLease.data.version === renewedLease.data.version
    ) {
      return { lease: persistedLease, run: persisted };
    }
    throw (await cancelStoppedRun(dependencies, previous, previousLease, timestamp)) ?? cause;
  }
}

export async function executeWithClaimHeartbeat<Result>(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  delivery: AgentRunQueueDelivery | undefined,
  initial: RunRecordValue,
  initialLease: RuntimeLeaseRecordValue,
  claimTimeoutMs: number,
  intervalMs: number,
  visibilityRenewalIntervalMs: number | undefined,
  visibilityTimeoutMs: number,
  onRenewed: (state: ClaimedRunState) => void,
  execute: (
    signal: AbortSignal,
    releaseClaim: ReleaseRunClaim,
    withClaimSnapshot: WithRunClaimSnapshot,
    acknowledgeExternalCancellation: AcknowledgeExternalCancellation,
  ) => Promise<Result>,
): Promise<Result> {
  let current = initial;
  let currentLease = initialLease;
  let heartbeatFailure: unknown;
  let claimReleased = false;
  let releaseAttemptActive = false;
  let stopped = false;
  let heartbeatChain = Promise.resolve();
  let visibilityAbort: AbortController | undefined;
  let visibilityInFlight: Promise<void> | undefined;
  let visibilityTimeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const reportVisibilityFailure = (cause: unknown): void => {
    if (!delivery || stopped || !dependencies.reportQueueVisibilityFailure) return;
    void Promise.resolve()
      .then(() => dependencies.reportQueueVisibilityFailure!(delivery, queue, cause))
      .catch(() => undefined);
  };
  const startVisibilityExtension = (): void => {
    if (
      stopped ||
      !delivery ||
      !dependencies.extendQueueVisibility ||
      visibilityInFlight !== undefined
    ) {
      return;
    }
    const abort = new AbortController();
    visibilityAbort = abort;
    let timedOut = false;
    let tracked!: Promise<void>;
    const timeout = setTimeout(() => {
      timedOut = true;
      const cause = new Error(
        `Queue visibility extension exceeded ${visibilityTimeoutMs} milliseconds.`,
      );
      abort.abort(cause);
      if (visibilityTimeout === timeout) visibilityTimeout = undefined;
      reportVisibilityFailure(cause);
    }, visibilityTimeoutMs);
    visibilityTimeout = timeout;
    tracked = Promise.resolve()
      .then(() => dependencies.extendQueueVisibility!(delivery, queue, abort.signal))
      .catch((cause: unknown) => {
        if (!timedOut) reportVisibilityFailure(cause);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (visibilityTimeout === timeout) visibilityTimeout = undefined;
        if (visibilityAbort === abort) visibilityAbort = undefined;
        if (visibilityInFlight === tracked) visibilityInFlight = undefined;
      });
    visibilityInFlight = tracked;
  };
  startVisibilityExtension();
  const visibilityTimer =
    visibilityRenewalIntervalMs === undefined
      ? undefined
      : setInterval(startVisibilityExtension, visibilityRenewalIntervalMs);
  const queueHeartbeat = (force = false): void => {
    heartbeatChain = heartbeatChain
      .then(async () => {
        if (stopped || heartbeatFailure !== undefined || (!force && releaseAttemptActive)) {
          return;
        }
        const renewed = await renewRunClaim(
          dependencies,
          queue,
          current,
          currentLease,
          claimTimeoutMs,
        );
        current = renewed.run;
        currentLease = renewed.lease;
        onRenewed(renewed);
      })
      .catch((cause: unknown) => {
        if (claimReleased) return;
        heartbeatFailure = cause;
        stopped = true;
        controller.abort(cause);
      });
  };
  const heartbeatTimer = setInterval(queueHeartbeat, intervalMs);
  const releaseRenewalIntervalMs = Math.max(intervalMs, claimTimeoutMs - intervalMs);

  const withClaimSnapshot: WithRunClaimSnapshot = async (operation) => {
    releaseAttemptActive = true;
    try {
      await heartbeatChain;
      return await operation({ lease: currentLease, run: current });
    } finally {
      releaseAttemptActive = false;
    }
  };

  const finishClaimRelease = (reason: string): void => {
    claimReleased = true;
    stopped = true;
    releaseAttemptActive = false;
    clearInterval(heartbeatTimer);
    if (visibilityTimer) clearInterval(visibilityTimer);
    if (visibilityTimeout) clearTimeout(visibilityTimeout);
    visibilityAbort?.abort(new Error(reason));
    visibilityAbort = undefined;
  };

  const tryReconcileReleaseCancellation = async (
    reconcileCancellation: ReconcileCanceledRunClaim | undefined,
  ): Promise<void> => {
    if (reconcileCancellation) {
      const reconciled = await reconcileCancellation({ lease: currentLease, run: current });
      if (reconciled) {
        current = reconciled;
        heartbeatFailure = undefined;
        finishClaimRelease("Agent run cancellation was reconciled.");
        throw new ExternalCancellationReconciledError(reconciled);
      }
    }
  };

  const reconcileReleaseCancellation = async (
    reconcileCancellation: ReconcileCanceledRunClaim | undefined,
    cause: unknown,
  ): Promise<never> => {
    await tryReconcileReleaseCancellation(reconcileCancellation);
    heartbeatFailure = cause;
    stopped = true;
    controller.abort(cause);
    throw cause;
  };

  const releaseClaim: ReleaseRunClaim = async (release, reconcileCancellation) => {
    for (let attempt = 0; attempt < MAX_COMPLETION_ATTEMPTS; attempt += 1) {
      releaseAttemptActive = true;
      await heartbeatChain;
      if (heartbeatFailure !== undefined) {
        await reconcileReleaseCancellation(reconcileCancellation, heartbeatFailure);
      }
      try {
        const renewed = await renewRunClaim(
          dependencies,
          queue,
          current,
          currentLease,
          claimTimeoutMs,
        );
        current = renewed.run;
        currentLease = renewed.lease;
        onRenewed(renewed);
      } catch (cause) {
        releaseAttemptActive = false;
        await reconcileReleaseCancellation(reconcileCancellation, cause);
      }
      const snapshot: ClaimedRunState = { lease: currentLease, run: current };
      const releaseHeartbeatTimer = setInterval(
        () => queueHeartbeat(true),
        releaseRenewalIntervalMs,
      );
      try {
        const result = await release(snapshot);
        clearInterval(releaseHeartbeatTimer);
        finishClaimRelease("Agent run claim was released.");
        await heartbeatChain;
        return result;
      } catch (cause) {
        releaseAttemptActive = false;
        clearInterval(releaseHeartbeatTimer);
        await heartbeatChain;
        if (heartbeatFailure !== undefined) throw heartbeatFailure;
        await tryReconcileReleaseCancellation(reconcileCancellation);
        const claimAdvanced =
          current.data.version !== snapshot.run.data.version ||
          currentLease.data.version !== snapshot.lease.data.version;
        if (!claimAdvanced || attempt === MAX_COMPLETION_ATTEMPTS - 1) throw cause;
      }
    }
    throw new Error("Agent run claim release retry limit was exhausted.");
  };

  const acknowledgeExternalCancellation: AcknowledgeExternalCancellation = async () => {
    releaseAttemptActive = true;
    try {
      await heartbeatChain;
      if (!current.data.claimedBy) return undefined;
      const settled = await settleExternalCancellation(dependencies, queue, current, {
        expectedClaimedBy: current.data.claimedBy,
      });
      if (!settled) return undefined;
      current = settled;
      claimReleased = true;
      stopped = true;
      return settled;
    } finally {
      releaseAttemptActive = false;
    }
  };

  const stopHeartbeat = async () => {
    stopped = true;
    clearInterval(heartbeatTimer);
    if (visibilityTimer) clearInterval(visibilityTimer);
    if (visibilityTimeout) clearTimeout(visibilityTimeout);
    visibilityAbort?.abort(new Error("Agent run execution finished."));
    visibilityAbort = undefined;
    await heartbeatChain;
    if (heartbeatFailure !== undefined && !claimReleased) throw heartbeatFailure;
  };

  let result: Result;
  try {
    result = await execute(
      // A draining host stops runs still executing at its deadline with a shutdown reason.
      dependencies.hostDrain
        ? AbortSignal.any([controller.signal, dependencies.hostDrain.signal])
        : controller.signal,
      releaseClaim,
      withClaimSnapshot,
      acknowledgeExternalCancellation,
    );
    if (!claimReleased) {
      throw new AgentRunWorkerRecordError(
        "run_claim_not_released",
        "Agent run processing returned without releasing its run claim.",
      );
    }
  } finally {
    await stopHeartbeat();
  }
  return result;
}

export async function runtimeUsageOperations(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  entries: readonly RuntimeUsageEntry[],
): Promise<readonly TransactionOperation[]> {
  if (entries.length > MAX_RUNTIME_USAGE_ENTRIES) {
    throw new AgentRunWorkerRecordError(
      "invalid_usage_entry",
      `Agent runtime emitted more than ${MAX_RUNTIME_USAGE_ENTRIES} usage entries.`,
    );
  }
  const seen = new Set<string>();
  const operations: TransactionOperation[] = [];
  for (const entry of entries) {
    const idempotencyKey = canonicalRuntimeUsageIdempotencyKey(run.data.id, entry.idempotencyKey);
    if (seen.has(idempotencyKey)) {
      throw new AgentRunWorkerRecordError(
        "invalid_usage_entry",
        `Agent runtime reused usage idempotencyKey ${idempotencyKey}.`,
      );
    }
    seen.add(idempotencyKey);
    const record = runtimeUsageRecord({
      entry,
      id: await dependencies.generateId(),
      run,
    });
    const existing = await workerPersistence.read(
      dependencies.database,
      "usage",
      {
        pk: key("ORG", run.data.organizationId, "ENV", run.data.environmentId),
        sk: key("METER-EVENT", idempotencyKey),
      },
      true,
    );
    if (existing) {
      if (existing.itemType !== "meter-event") {
        throw new AgentRunWorkerRecordError(
          "invalid_usage_entry",
          `Runtime usage idempotencyKey ${idempotencyKey} conflicts with canonical state.`,
        );
      }
      const { id: _existingId, ...existingData } = existing.data;
      const { id: _recordId, ...recordData } = record.data;
      if (isDeepStrictEqual(existingData, recordData)) continue;
      throw new AgentRunWorkerRecordError(
        "invalid_usage_entry",
        `Runtime usage idempotencyKey ${idempotencyKey} conflicts with another value.`,
      );
    }
    operations.push({
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      kind: "put",
      record,
    });
  }
  return operations;
}
