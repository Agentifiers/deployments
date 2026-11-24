import {
  TraceRecord,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  workerPersistence,
} from "@deployments-ai/db";
import { evaluateTraceCompletion, type TraceId } from "@deployments-ai/observability";
import { Schema } from "effect";
import { traceRootSummary } from "./trace-root-summary.ts";

type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
type Trace = Extract<PlatformRecord, { readonly itemType: "trace" }>;
type Invocation = Extract<PlatformRecord, { readonly itemType: "model-invocation" }>;
type MeterEvent = Extract<PlatformRecord, { readonly itemType: "meter-event" }>;
type ProviderMutationClaim = Extract<
  PlatformRecord,
  { readonly itemType: "provider-mutation-claim" }
>;

const TRACE_USAGE_QUERY_CONCURRENCY = 16;

async function get(
  database: DynamoDatabaseService,
  table: "control" | "execution" | "usage",
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return workerPersistence.read(database, table, recordKey, true);
}

async function loadTrace(database: DynamoDatabaseService, run: Run): Promise<Trace | undefined> {
  const record = await get(database, "execution", {
    pk: key("ORG", run.data.organizationId, "TRACE", run.data.traceId),
    sk: key("TRACE", run.data.traceId),
  });
  if (!record) return undefined;
  if (record.itemType !== "trace" || record.data.traceId !== run.data.traceId) {
    throw new Error(`Trace ${run.data.traceId} has invalid canonical state.`);
  }
  return record;
}

async function loadRun(database: DynamoDatabaseService, trace: Trace, runId: Ulid): Promise<Run> {
  const locator = await get(database, "control", {
    pk: key("ORG", trace.data.organizationId, "ENV", trace.data.environmentId),
    sk: key("RUN-LOCATOR", runId),
  });
  if (!locator || locator.itemType !== "run-locator" || locator.data.id !== runId) {
    throw new Error(`Trace ${trace.data.traceId} is missing run locator ${runId}.`);
  }
  const run = await get(database, "execution", {
    pk: locator.data.runPk,
    sk: locator.data.runSk,
  });
  if (
    !run ||
    run.itemType !== "run" ||
    run.data.id !== runId ||
    run.data.traceId !== trace.data.traceId ||
    run.data.organizationId !== trace.data.organizationId ||
    run.data.projectId !== trace.data.projectId ||
    run.data.environmentId !== trace.data.environmentId
  ) {
    throw new Error(`Trace ${trace.data.traceId} run ${runId} does not match its scope.`);
  }
  return run;
}

async function loadRunObservabilityRecords(
  database: DynamoDatabaseService,
  run: Run,
): Promise<readonly PlatformRecord[]> {
  const records: PlatformRecord[] = [];
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = await workerPersistence.find(database, "execution", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: {
        ":pk": key("ORG", run.data.organizationId, "RUN", run.data.id),
      },
      KeyConditionExpression: "#pk = :pk",
      Limit: 100,
    });
    records.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

/** A provider mutation claim holds its operation open until it settles. */
export function providerMutationClaimSettled(claim: ProviderMutationClaim): boolean {
  return ["failed", "reconciled", "releasable", "succeeded"].includes(claim.data.status);
}

function openOperationIds(records: readonly PlatformRecord[]): readonly string[] {
  return records.flatMap((record) => {
    if (
      record.itemType === "tool-call" &&
      ["pending", "running", "waiting"].includes(record.data.status)
    ) {
      return [`tool:${record.data.id}`];
    }
    if (record.itemType === "approval" && record.data.status === "pending") {
      return [`approval:${record.data.id}`];
    }
    if (record.itemType === "provider-mutation-claim" && !providerMutationClaimSettled(record)) {
      return [`provider-mutation:${record.data.id}`];
    }
    if (record.itemType === "memory-flush" && ["queued", "running"].includes(record.data.status)) {
      return [`memory-flush:${record.data.id}`];
    }
    return [];
  });
}

function saturatedSafeTotal(total: number, value: number): number {
  return value > Number.MAX_SAFE_INTEGER - total ? Number.MAX_SAFE_INTEGER : total + value;
}

async function reconcileInvocationUsage(
  database: DynamoDatabaseService,
  trace: Trace,
  invocations: readonly Invocation[],
) {
  const missingUsage: string[] = [];
  for (const invocation of invocations) {
    if (!invocation.data.usageIdempotencyKey) continue;
    const usage = await get(database, "usage", {
      pk: key("ORG", trace.data.organizationId, "ENV", trace.data.environmentId),
      sk: key("METER-EVENT", invocation.data.usageIdempotencyKey),
    });
    if (
      !usage ||
      usage.itemType !== "meter-event" ||
      usage.data.runId !== invocation.data.runId ||
      usage.data.quantity !== invocation.data.totalTokens ||
      usage.data.dimensions.costUsdMicros !== invocation.data.costUsdMicros
    ) {
      missingUsage.push(invocation.data.id);
    }
  }
  return missingUsage;
}

function traceModelUsageEvent(
  trace: Trace,
  run: Run,
  record: PlatformRecord,
): record is MeterEvent {
  return (
    record.itemType === "meter-event" &&
    record.data.organizationId === trace.data.organizationId &&
    record.data.projectId === trace.data.projectId &&
    record.data.environmentId === trace.data.environmentId &&
    record.data.runId === run.data.id &&
    record.data.observability?.traceId === trace.data.traceId &&
    record.data.metric === "model_tokens" &&
    record.data.unit === "tokens"
  );
}

function nonNegativeSafeUsageValue(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Trace model usage has invalid ${label}.`);
  }
  return value;
}

async function runTraceUsage(database: DynamoDatabaseService, trace: Trace, run: Run) {
  let totalTokens = 0;
  let totalCostUsdMicros = 0;
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = await workerPersistence.find(database, "usage", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeValues: {
        ":pk": key("ORG", trace.data.organizationId, "ENV", trace.data.environmentId),
        ":prefix": key("METER-EVENT", run.data.id),
      },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      Limit: 100,
    });
    for (const record of page.items) {
      if (!traceModelUsageEvent(trace, run, record)) continue;
      totalTokens = saturatedSafeTotal(
        totalTokens,
        nonNegativeSafeUsageValue(record.data.quantity, "token quantity"),
      );
      const costUsdMicros = record.data.dimensions.costUsdMicros;
      if (typeof costUsdMicros === "number") {
        totalCostUsdMicros = saturatedSafeTotal(
          totalCostUsdMicros,
          nonNegativeSafeUsageValue(costUsdMicros, "costUsdMicros"),
        );
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return { totalCostUsdMicros, totalTokens };
}

async function reconcileTraceUsage(
  database: DynamoDatabaseService,
  trace: Trace,
  runs: readonly Run[],
) {
  let totalTokens = 0;
  let totalCostUsdMicros = 0;
  for (let offset = 0; offset < runs.length; offset += TRACE_USAGE_QUERY_CONCURRENCY) {
    const batch = await Promise.all(
      runs
        .slice(offset, offset + TRACE_USAGE_QUERY_CONCURRENCY)
        .map((run) => runTraceUsage(database, trace, run)),
    );
    for (const usage of batch) {
      totalTokens = saturatedSafeTotal(totalTokens, usage.totalTokens);
      totalCostUsdMicros = saturatedSafeTotal(totalCostUsdMicros, usage.totalCostUsdMicros);
    }
  }
  return { totalCostUsdMicros, totalTokens };
}

async function markTerminalTraceRun(
  database: DynamoDatabaseService,
  triggeringRun: Run,
  initialTrace: Trace,
  timestamp: Date,
): Promise<Trace> {
  if (!["canceled", "completed", "failed"].includes(triggeringRun.data.status)) {
    return initialTrace;
  }
  let trace = initialTrace;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (trace.data.status === "finalized") return trace;
    if (!trace.data.runIds.includes(triggeringRun.data.id)) {
      throw new Error(`Trace ${trace.data.traceId} does not contain run ${triggeringRun.data.id}.`);
    }
    const terminalRunIds = [
      ...new Set([...(trace.data.terminalRunIds ?? []), triggeringRun.data.id]),
    ];
    if (terminalRunIds.length === (trace.data.terminalRunIds?.length ?? 0)) return trace;
    const replacement = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        ...trace,
        data: {
          ...trace.data,
          terminalRunIds,
          updatedAt: timestamp.toISOString(),
          version: trace.data.version + 1,
        },
      }),
    );
    try {
      await workerPersistence.commit(database, [
        { kind: "put", previousRecord: trace, record: replacement },
      ]);
      return replacement;
    } catch (cause) {
      const latest = await loadTrace(database, triggeringRun);
      if (!latest) throw cause;
      if (
        latest.data.status === "finalized" ||
        latest.data.terminalRunIds?.includes(triggeringRun.data.id)
      ) {
        return latest;
      }
      trace = latest;
      if (attempt === 7) throw cause;
    }
  }
  return trace;
}

async function reopenTraceForLateOperation(
  database: DynamoDatabaseService,
  triggeringRun: Run,
  initialTrace: Trace,
  timestamp: Date,
): Promise<Trace> {
  let trace = initialTrace;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (trace.data.status === "open") return trace;
    const {
      completedAt: _completedAt,
      durationMs: _durationMs,
      errorClass: _errorClass,
      finalizedAt: _finalizedAt,
      graphWatermark: _graphWatermark,
      outcome: _outcome,
      totalCostUsdMicros: _totalCostUsdMicros,
      totalTokens: _totalTokens,
      ...openData
    } = trace.data;
    const replacement = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        ...trace,
        data: {
          ...openData,
          status: "open" as const,
          updatedAt: timestamp.toISOString(),
          version: trace.data.version + 1,
        },
      }),
    );
    try {
      await workerPersistence.commit(database, [
        { kind: "put", previousRecord: trace, record: replacement },
      ]);
      return replacement;
    } catch (cause) {
      const latest = await loadTrace(database, triggeringRun);
      if (!latest) throw cause;
      if (latest.data.status === "open") return latest;
      trace = latest;
      if (attempt === 7) throw cause;
    }
  }
  return trace;
}

export async function reconcileTraceFinalization(
  database: DynamoDatabaseService,
  triggeringRun: Run,
  finalizedAt = new Date(),
): Promise<Trace | undefined> {
  let trace = await loadTrace(database, triggeringRun);
  if (!trace) return undefined;
  trace = await markTerminalTraceRun(database, triggeringRun, trace, finalizedAt);
  const terminalRunIds = new Set(trace.data.terminalRunIds ?? []);
  if (trace.data.runIds.some((runId) => !terminalRunIds.has(runId))) return trace;

  const runs = await Promise.all(trace.data.runIds.map((runId) => loadRun(database, trace, runId)));
  const recordsByRun = await Promise.all(
    runs.map((run) => loadRunObservabilityRecords(database, run)),
  );
  // Trace records and run-partitioned provider claims launch together. Older
  // environment-partitioned claims belong to pre-observability runs and cannot
  // be members of a trace, so finalization never scans that legacy partition.
  const allRecords = recordsByRun.flat();
  const edges = allRecords
    .filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "run-edge" }> =>
        record.itemType === "run-edge",
    )
    .map((edge) => ({
      childRunId: edge.data.childRunId,
      parentRunId: edge.data.parentRunId,
      traceId: edge.data.traceId,
      version: 0,
    }));
  const graph = evaluateTraceCompletion({
    edges,
    rootRunId: trace.data.rootRunId,
    runs: runs.map((run) => ({
      id: run.data.id,
      status: run.data.status,
      traceId: run.data.traceId,
      version: run.data.version,
    })),
    traceId: trace.data.traceId,
  });
  const operations = openOperationIds(allRecords);
  const invocations = allRecords.filter(
    (record): record is Invocation => record.itemType === "model-invocation",
  );
  const missingUsage = await reconcileInvocationUsage(database, trace, invocations);
  const usage = await reconcileTraceUsage(database, trace, runs);
  const unsettledCancellation = runs.some(
    (run) => run.data.status === "canceled" && run.data.claimedBy !== undefined,
  );
  if (
    !graph.complete ||
    unsettledCancellation ||
    operations.length > 0 ||
    missingUsage.length > 0
  ) {
    if (trace.data.status === "open") return trace;
    await reopenTraceForLateOperation(database, triggeringRun, trace, finalizedAt);
    return reconcileTraceFinalization(database, triggeringRun, finalizedAt);
  }

  if (
    trace.data.status === "finalized" &&
    trace.data.outcome !== undefined &&
    trace.data.totalTokens === usage.totalTokens &&
    trace.data.totalCostUsdMicros === usage.totalCostUsdMicros
  ) {
    return trace;
  }

  const completedAt = new Date(
    Math.max(...runs.map((run) => Date.parse(run.data.completedAt ?? run.data.updatedAt))),
  ).toISOString();
  const rootRun = runs.find((run) => run.data.id === trace.data.rootRunId);
  if (!rootRun) throw new Error(`Trace ${trace.data.traceId} is missing its root run.`);
  const outcome =
    rootRun.data.status === "completed"
      ? "ok"
      : rootRun.data.status === "canceled"
        ? "canceled"
        : "error";
  const completedTraceAt = trace.data.completedAt ?? completedAt;
  const summary = await traceRootSummary(database, {
    completedAt: completedTraceAt,
    invocations,
    outcome,
    root: rootRun,
  });
  const { errorClass: _previousErrorClass, ...traceData } = trace.data;
  const replacement = Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      ...trace,
      data: {
        ...traceData,
        ...summary,
        completedAt: completedTraceAt,
        finalizedAt: trace.data.finalizedAt ?? finalizedAt.toISOString(),
        graphWatermark: trace.data.graphWatermark ?? graph.graphWatermark,
        outcome,
        status: "finalized" as const,
        totalCostUsdMicros: usage.totalCostUsdMicros,
        totalTokens: usage.totalTokens,
        updatedAt: finalizedAt.toISOString(),
        version: trace.data.version + 1,
      },
    }),
  );
  try {
    await workerPersistence.commit(database, [
      { kind: "put", previousRecord: trace, record: replacement },
    ]);
    return replacement;
  } catch (cause) {
    const latest = await loadTrace(database, triggeringRun);
    if (
      latest?.data.status === "finalized" &&
      latest.data.outcome === replacement.data.outcome &&
      latest.data.graphWatermark === replacement.data.graphWatermark &&
      latest.data.totalTokens === replacement.data.totalTokens &&
      latest.data.totalCostUsdMicros === replacement.data.totalCostUsdMicros
    ) {
      return latest;
    }
    throw cause;
  }
}

export async function attemptTraceFinalization(
  database: DynamoDatabaseService,
  run: Run,
  finalizedAt?: Date,
): Promise<void> {
  try {
    await reconcileTraceFinalization(database, run, finalizedAt);
  } catch (cause) {
    console.error("Trace finalization reconciliation failed after canonical run persistence.", {
      errorType: cause instanceof Error ? cause.name : "UnknownError",
      runId: run.data.id,
      traceId: run.data.traceId,
    });
  }
}

export interface TraceFinalizationRepairEvent {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly runId: Ulid;
  readonly runPk: string;
  readonly runSk: string;
  readonly traceId: TraceId;
}

export interface RunScopedTraceFinalizationRepairEvent {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly runId: Ulid;
}

export async function repairTraceFinalizationForRunId(
  database: DynamoDatabaseService,
  event: RunScopedTraceFinalizationRepairEvent,
  options?: { readonly allowMissingRun?: boolean; readonly now?: Date },
) {
  const locator = await get(database, "control", {
    pk: key("ORG", event.organizationId, "ENV", event.environmentId),
    sk: key("RUN-LOCATOR", event.runId),
  });
  if (!locator && options?.allowMissingRun) return undefined;
  if (!locator || locator.itemType !== "run-locator" || locator.data.id !== event.runId) {
    throw new Error("Trace finalization repair could not resolve its canonical run locator.");
  }
  const run = await get(database, "execution", {
    pk: locator.data.runPk,
    sk: locator.data.runSk,
  });
  if (!run && options?.allowMissingRun) return undefined;
  if (
    !run ||
    run.itemType !== "run" ||
    run.data.id !== event.runId ||
    run.data.organizationId !== event.organizationId ||
    run.data.projectId !== event.projectId ||
    run.data.environmentId !== event.environmentId
  ) {
    throw new Error("Trace finalization repair run does not match its triggering record scope.");
  }
  return reconcileTraceFinalization(database, run, options?.now);
}

export async function repairTraceFinalization(
  database: DynamoDatabaseService,
  event: TraceFinalizationRepairEvent,
  now?: Date,
) {
  const record = await get(database, "execution", {
    pk: event.runPk,
    sk: event.runSk,
  });
  if (
    !record ||
    record.itemType !== "run" ||
    record.data.id !== event.runId ||
    record.data.organizationId !== event.organizationId ||
    record.data.environmentId !== event.environmentId ||
    record.data.traceId !== event.traceId
  ) {
    throw new Error("Trace finalization repair event does not match its canonical run.");
  }
  return reconcileTraceFinalization(database, record, now);
}
