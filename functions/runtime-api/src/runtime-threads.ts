import { assertRunAdmissible } from "@deployments-ai/conversations";
import {
  RunRecord,
  ThreadRecord,
  TraceRecord,
  isDatabaseWriteConflict,
  key,
  usageScopeOf,
  withCanonicalRecordKeys,
  type Ulid,
  executionEventPayload,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { releaseStaleThreadExecutionLease } from "@deployments-ai/worker/agent-run";
import {
  cancelRun as cancelRunRecord,
  loadRuntimeMutationPublication,
  matchingRunThreadExecutionLease,
  publicationRunSnapshot,
  runEvent,
  runRequestedEvent,
  runtimeMutationPublication,
} from "@deployments-ai/worker/run-mutations";
import { Schema } from "effect";
import { publicRun } from "./public-projections.ts";
import { principalActorId, recordActor } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  assertRecord,
  getRecord,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

import { loadRunById } from "./runtime-cursors.ts";
import { type CancelRunResult, type RunMutationResult } from "./runtime-listing.ts";
import { loadRunnableRunContext, runnableRunConditionChecks } from "./runtime-run-context.ts";
import { authorizeRunInputArtifacts } from "./run-input-artifacts.ts";

export async function cancelRun(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  runId: Ulid,
): Promise<CancelRunResult> {
  const result = await cancelRunRecord(dependencies, {
    actorId: principalActorId(principal),
    loadRun: () => loadRunById(dependencies, principal, runId),
  });
  return { ...result, run: publicRun(result.snapshot) };
}

async function retryRunAttempt(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  runId: Ulid,
  remainingConflictRetries: number,
): Promise<RunMutationResult> {
  const previous = await loadRunById(dependencies, principal, runId);
  if (previous.data.status === "failed") {
    const publication = await loadRuntimeMutationPublication(
      dependencies.database,
      previous,
      "runtime-api.retry-publication",
    );
    if (publication) {
      const snapshot = scoped(publicationRunSnapshot(publication), principal);
      if (previous.data.version >= snapshot.data.version) {
        return { publication, run: publicRun(snapshot), snapshot };
      }
      throw new RuntimeApiError(
        409,
        "run_state_conflict",
        "Run retry publication is newer than the current run state.",
      );
    }
  }
  if (previous.data.status !== "failed") {
    if (previous.data.status !== "canceled" && previous.data.status !== "completed") {
      const publication = await loadRuntimeMutationPublication(
        dependencies.database,
        previous,
        "runtime-api.retry-publication",
      );
      if (publication) {
        const snapshot = scoped(publicationRunSnapshot(publication), principal);
        return { publication, run: publicRun(snapshot), snapshot };
      }
    }
    throw new RuntimeApiError(409, "run_not_retryable", "Only failed runs can be retried.");
  }
  await authorizeRunInputArtifacts(dependencies, principal, previous);
  const trace = scoped(
    assertRecord(
      await getRecord(dependencies.database, "execution", {
        pk: key("ORG", previous.data.organizationId, "TRACE", previous.data.traceId),
        sk: key("TRACE", previous.data.traceId),
      }),
      "trace",
      "Trace",
    ),
    principal,
  );
  if (
    trace.data.traceId !== previous.data.traceId ||
    !trace.data.runIds.includes(previous.data.id)
  ) {
    throw new RuntimeApiError(409, "run_not_retryable", "Run trace identity is invalid.");
  }
  const context = await loadRunnableRunContext(dependencies, principal, previous);
  const executionLease = await matchingRunThreadExecutionLease(dependencies.database, previous);
  const now = dependencies.now?.() ?? new Date();
  await assertRunAdmissible(dependencies.database, usageScopeOf(previous.data), now);
  const {
    claimedAt: _claimedAt,
    claimedBy: _claimedBy,
    completedAt: _completedAt,
    error: _error,
    heartbeatAt: _heartbeatAt,
    ...data
  } = previous.data;
  const replacement = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...data,
        attempt: 0,
        queuedAt: now.toISOString(),
        status: "queued" as const,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
    }),
  );
  const {
    completedAt: _traceCompletedAt,
    durationMs: _traceDurationMs,
    errorClass: _traceErrorClass,
    finalizedAt: _traceFinalizedAt,
    graphWatermark: _graphWatermark,
    outcome: _outcome,
    totalCostUsdMicros: _totalCostUsdMicros,
    totalTokens: _totalTokens,
    ...traceData
  } = trace.data;
  const retryTrace = Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      ...trace,
      data: {
        ...traceData,
        status: "open" as const,
        terminalRunIds: (trace.data.terminalRunIds ?? []).filter(
          (terminalRunId) => terminalRunId !== previous.data.id,
        ),
        updatedAt: now.toISOString(),
        version: trace.data.version + 1,
      },
    }),
  );
  const retryThread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      ...context.thread,
      data: {
        ...context.thread.data,
        updatedAt: now.toISOString(),
        version: context.thread.data.version + 1,
      },
    }),
  );
  const [retryEventId, dispatchEventId, threadEventId] = await Promise.all([
    dependencies.generateId(),
    dependencies.generateId(),
    dependencies.generateId(),
  ]);
  const publication = runtimeMutationPublication(
    replacement,
    retryEventId,
    "runtime-api.retry-publication",
    now,
    { runVersion: replacement.data.version },
  );
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        ...runnableRunConditionChecks(context, false),
        ...(executionLease ? [releaseStaleThreadExecutionLease(executionLease)] : []),
        { kind: "put", previousRecord: context.thread, record: retryThread },
        { kind: "put", previousRecord: previous, record: replacement },
        { kind: "put", previousRecord: trace, record: retryTrace },
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: publication,
        },
      ],
      [
        makeSemanticEventRecord({
          actor: recordActor(principal),
          aggregateId: retryThread.data.id,
          aggregateType: "thread",
          aggregateVersion: retryThread.data.version + 1,
          environmentId: retryThread.data.environmentId,
          eventId: threadEventId,
          eventType: "thread.run-retried",
          occurredAt: now,
          organizationId: retryThread.data.organizationId,
          payload: executionEventPayload(replacement.data, {
            runId: replacement.data.id,
            threadId: retryThread.data.id,
          }),
          projectId: retryThread.data.projectId,
        }),
        runEvent(replacement, retryEventId, "run.retry-requested", now),
        runRequestedEvent(replacement, dispatchEventId, now),
      ],
    );
  } catch (cause) {
    if (!isDatabaseWriteConflict(cause)) throw cause;
    const winner = await loadRunById(dependencies, principal, runId);
    const winnerPublication = await loadRuntimeMutationPublication(
      dependencies.database,
      winner,
      "runtime-api.retry-publication",
    );
    if (winnerPublication) {
      const snapshot = scoped(publicationRunSnapshot(winnerPublication), principal);
      if (
        snapshot.data.version === previous.data.version + 1 &&
        winner.data.version >= snapshot.data.version
      ) {
        return {
          publication: winnerPublication,
          run: publicRun(snapshot),
          snapshot,
        };
      }
    }
    if (
      remainingConflictRetries > 0 &&
      winner.data.status === "failed" &&
      winner.data.version === previous.data.version
    ) {
      return retryRunAttempt(dependencies, principal, runId, remainingConflictRetries - 1);
    }
    throw new RuntimeApiError(
      409,
      "run_state_conflict",
      "Run state changed while retry was being applied.",
    );
  }
  return { publication, run: publicRun(replacement), snapshot: replacement };
}

export function retryRun(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  runId: Ulid,
): Promise<RunMutationResult> {
  return retryRunAttempt(dependencies, principal, runId, 1);
}
