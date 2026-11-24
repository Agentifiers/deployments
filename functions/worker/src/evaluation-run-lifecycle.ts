import {
  EVALUATION_CASE_TERMINAL_STATUSES,
  Ulid,
  type EvaluationCaseRunData,
  type EvaluationCaseRunRecord,
  type EvaluationCounts,
  type EvaluationPersistenceEvent,
  type EvaluationRunRecord,
  type EvaluationRunSummary,
} from "@deployments-ai/db";
import { internalSemanticEventPayload } from "@deployments-ai/events";
import { boundedText } from "@deployments-ai/observability/evaluators";
import { Schema } from "effect";
import type { EvaluationMessageContext } from "./evaluation-ports.ts";

const MAX_BINDING_TTL_SECONDS = 604_800;
const MIN_BINDING_TTL_SECONDS = 3_600;
/** Dispatched cases without progress for this long are advanced again. */
const STUCK_DISPATCH_MS = 5 * 60 * 1_000;

export interface EvaluationFailure {
  readonly code: string;
  readonly message: string;
}

/** A failure that is written to the run or case record instead of being retried. */
export class EvaluationTerminalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function evaluationFailure(code: string, message: string): EvaluationFailure {
  return { code, message: boundedText(message.trim() || code, 1_000) };
}

export async function evaluationEvent(
  context: EvaluationMessageContext,
  eventType: string,
  payload: Readonly<Record<string, string | number>>,
): Promise<EvaluationPersistenceEvent> {
  return {
    eventId: await context.generateId(),
    eventType,
    occurredAt: context.now().toISOString(),
    payload: internalSemanticEventPayload(payload),
  };
}

export function isTerminalCase(record: EvaluationCaseRunRecord) {
  return (EVALUATION_CASE_TERMINAL_STATUSES as readonly string[]).includes(record.data.status);
}

function caseCounts(cases: readonly EvaluationCaseRunRecord[]): EvaluationCounts {
  const counts = { failed: 0, pending: 0, running: 0, scored: 0, timedOut: 0 };
  for (const record of cases) {
    switch (record.data.status) {
      case "pending":
        counts.pending += 1;
        break;
      case "dispatched":
      case "submitted":
        counts.running += 1;
        break;
      case "scored":
        counts.scored += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "timed_out":
        counts.timedOut += 1;
        break;
    }
  }
  return counts;
}

/** Nearest-rank percentile over ascending values. */
function nearestRank(sorted: readonly number[], percent: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)];
}

function summarizeEvaluationRun(
  run: EvaluationRunRecord,
  cases: readonly EvaluationCaseRunRecord[],
): EvaluationRunSummary {
  const definitions = run.data.scoreDefinitions.map((definition) => {
    let scored = 0;
    let passed = 0;
    let errors = 0;
    let total = 0;
    for (const record of cases) {
      for (const score of record.data.scores) {
        if (
          score.scoreDefinitionId !== definition.scoreDefinitionId ||
          score.revision !== definition.revision
        ) {
          continue;
        }
        if (score.executionStatus === "error" || score.value === undefined) {
          errors += 1;
          continue;
        }
        scored += 1;
        total += score.value;
        if (score.passed) passed += 1;
      }
    }
    return {
      errors,
      passed,
      revision: definition.revision,
      scoreDefinitionId: definition.scoreDefinitionId,
      scored,
      ...(scored > 0 ? { mean: total / scored, passRate: passed / scored } : {}),
    };
  });
  const latencies = cases
    .flatMap((record) => (record.data.latencyMs === undefined ? [] : [record.data.latencyMs]))
    .sort((left, right) => left - right);
  const latencyP50Ms = nearestRank(latencies, 50);
  const latencyP95Ms = nearestRank(latencies, 95);
  return {
    costUsdMicros: cases.reduce((sum, record) => sum + (record.data.costUsdMicros ?? 0), 0),
    definitions,
    totalTokens: cases.reduce((sum, record) => sum + (record.data.totalTokens ?? 0), 0),
    ...(latencyP50Ms !== undefined ? { latencyP50Ms } : {}),
    ...(latencyP95Ms !== undefined ? { latencyP95Ms } : {}),
  };
}

async function notifyComparison(context: EvaluationMessageContext, run: EvaluationRunRecord) {
  if (!run.data.comparison) return;
  await context.queue.send({
    ...context.scope,
    releaseComparisonId: run.data.comparison.releaseComparisonId,
    trigger: run.data.comparison.role,
    type: "release-comparison.reconcile",
  });
}

async function failEvaluationRun(
  context: EvaluationMessageContext,
  run: EvaluationRunRecord,
  failure: EvaluationFailure,
) {
  const now = context.now().toISOString();
  const failed = await context.persistence.updateEvaluationRun(
    run,
    {
      ...run.data,
      completedAt: now,
      error: failure,
      status: "failed",
      updatedAt: now,
      version: run.data.version + 1,
    },
    await evaluationEvent(context, "evaluation-run.failed", {
      errorCode: failure.code,
      evaluationRunId: run.data.id,
      status: "failed",
    }),
  );
  await notifyComparison(context, failed);
  return failed;
}

const decodeUlid = Schema.decodeUnknownSync(Ulid);

interface PlannedCases {
  readonly cases: readonly EvaluationCaseRunData[];
  readonly executionBindingId?: string;
}

function initialCaseRun(
  context: EvaluationMessageContext,
  run: EvaluationRunRecord,
  now: string,
  fields: Pick<EvaluationCaseRunData, "caseKey" | "datasetCaseId" | "sourceTraceId">,
): EvaluationCaseRunData {
  return {
    ...context.scope,
    attempts: 0,
    createdAt: now,
    evaluationRunId: run.data.id,
    notApplicable: [],
    scores: [],
    status: "pending",
    updatedAt: now,
    version: 1,
    ...fields,
  };
}

async function plannedCases(
  context: EvaluationMessageContext,
  run: EvaluationRunRecord,
  now: string,
): Promise<PlannedCases> {
  if (run.data.kind === "trace-score") {
    return {
      cases: (run.data.traceIds ?? []).map((traceId) =>
        initialCaseRun(context, run, now, { caseKey: traceId, sourceTraceId: traceId }),
      ),
    };
  }
  const datasetId = run.data.datasetId;
  const target = run.data.target;
  if (!datasetId || !target) {
    throw new EvaluationTerminalError(
      "invalid_evaluation_run",
      "Dataset replay has no dataset or target.",
    );
  }
  const dataset = await context.persistence.getRegressionDataset(datasetId);
  if (!dataset || dataset.data.status !== "active") {
    throw new EvaluationTerminalError(
      "regression_dataset_unavailable",
      "The regression dataset is missing or archived.",
    );
  }
  const datasetCases = await context.persistence.listAllDatasetCases(datasetId);
  if (datasetCases.length === 0) {
    throw new EvaluationTerminalError(
      "regression_dataset_empty",
      "The regression dataset has no cases.",
    );
  }
  const ttlSeconds = Math.min(
    MAX_BINDING_TTL_SECONDS,
    Math.max(
      MIN_BINDING_TTL_SECONDS,
      Math.ceil((datasetCases.length * run.data.caseTimeoutSeconds) / run.data.concurrency) +
        MIN_BINDING_TTL_SECONDS,
    ),
  );
  const runtimeConfigFrom = target.agentDeploymentId ?? run.data.runtimeConfigFromAgentDeploymentId;
  let executionBindingId: string;
  try {
    ({ executionBindingId } = await context.execution.createBinding({
      createdBy: { id: run.data.createdByPrincipalId, type: "principal" },
      idempotencyKey: `evaluation-run:${run.data.id}`,
      purpose: "evaluation",
      scope: context.scope,
      source: { agentReleaseId: target.agentReleaseId, type: "release" },
      toolPolicy: "evaluation",
      ttlSeconds,
      ...(runtimeConfigFrom ? { runtimeConfigFromAgentDeploymentId: runtimeConfigFrom } : {}),
    }));
  } catch (cause) {
    if (cause instanceof EvaluationTerminalError) throw cause;
    throw new EvaluationTerminalError(
      "execution_binding_failed",
      cause instanceof Error ? cause.message : "The execution binding could not be created.",
    );
  }
  return {
    cases: datasetCases.map((record) =>
      initialCaseRun(context, run, now, {
        caseKey: record.data.id,
        datasetCaseId: decodeUlid(record.data.id),
      }),
    ),
    executionBindingId,
  };
}

/** `evaluation-run.start`: plans case runs, binds the release, and starts reconciliation. */
export async function startEvaluationRun(
  context: EvaluationMessageContext,
  evaluationRunId: string,
) {
  const run = await context.persistence.getEvaluationRun(evaluationRunId);
  if (!run) return;
  if (run.data.status === "queued") {
    const now = context.now().toISOString();
    let planned: PlannedCases;
    try {
      planned = await plannedCases(context, run, now);
    } catch (cause) {
      if (!(cause instanceof EvaluationTerminalError)) throw cause;
      await failEvaluationRun(context, run, evaluationFailure(cause.code, cause.message));
      return;
    }
    await context.persistence.createCaseRuns(run.data.id, planned.cases);
    await context.persistence.updateEvaluationRun(
      run,
      {
        ...run.data,
        caseCount: planned.cases.length,
        counts: { failed: 0, pending: planned.cases.length, running: 0, scored: 0, timedOut: 0 },
        startedAt: now,
        status: "running",
        updatedAt: now,
        version: run.data.version + 1,
        ...(planned.executionBindingId ? { executionBindingId: planned.executionBindingId } : {}),
      },
      await evaluationEvent(context, "evaluation-run.started", {
        caseCount: planned.cases.length,
        evaluationRunId: run.data.id,
        status: "running",
      }),
    );
  } else if (run.data.status !== "running") {
    return;
  }
  await context.queue.send({
    ...context.scope,
    evaluationRunId: run.data.id,
    trigger: "start",
    type: "evaluation-run.reconcile",
  });
}

function sameCounts(left: EvaluationCounts, right: EvaluationCounts) {
  return (
    left.failed === right.failed &&
    left.pending === right.pending &&
    left.running === right.running &&
    left.scored === right.scored &&
    left.timedOut === right.timedOut
  );
}

async function sendAdvance(
  context: EvaluationMessageContext,
  record: EvaluationCaseRunRecord,
  attempt: number,
) {
  await context.queue.send({
    ...context.scope,
    attempt,
    caseKey: record.data.caseKey,
    evaluationRunId: record.data.evaluationRunId,
    type: "evaluation-case.advance",
  });
}

/**
 * `evaluation-run.reconcile`: dispatches pending cases within the concurrency limit, re-advances
 * stuck dispatches, refreshes counts, and completes the run once every case is terminal.
 */
export async function reconcileEvaluationRun(
  context: EvaluationMessageContext,
  evaluationRunId: string,
) {
  const run = await context.persistence.getEvaluationRun(evaluationRunId);
  if (!run) return;
  if (run.data.status === "completed" || run.data.status === "failed") {
    await notifyComparison(context, run);
    return;
  }
  if (run.data.status !== "running") return;
  const nowDate = context.now();
  const now = nowDate.toISOString();
  const cases = [...(await context.persistence.listAllCaseRuns(run.data.id))].sort((left, right) =>
    left.data.caseKey.localeCompare(right.data.caseKey),
  );
  if (cases.length > 0 && cases.every(isTerminalCase)) {
    const completed = await context.persistence.updateEvaluationRun(
      run,
      {
        ...run.data,
        completedAt: now,
        counts: caseCounts(cases),
        status: "completed",
        summary: summarizeEvaluationRun(run, cases),
        updatedAt: now,
        version: run.data.version + 1,
      },
      await evaluationEvent(context, "evaluation-run.completed", {
        evaluationRunId: run.data.id,
        status: "completed",
      }),
    );
    await notifyComparison(context, completed);
    return;
  }
  const current = new Map(cases.map((record) => [record.data.caseKey, record]));
  let inFlight = cases.filter(
    (record) => record.data.status === "dispatched" || record.data.status === "submitted",
  ).length;
  for (const record of cases) {
    if (record.data.status !== "dispatched") continue;
    const dispatchedAt = Date.parse(record.data.dispatchedAt ?? record.data.updatedAt);
    if (nowDate.getTime() - dispatchedAt <= STUCK_DISPATCH_MS) {
      // Replays a possibly lost send; FIFO deduplication drops it when the first send landed.
      await sendAdvance(context, record, record.data.attempts);
      continue;
    }
    const attempts = record.data.attempts + 1;
    const updated = await context.persistence.updateCaseRun(record, {
      ...record.data,
      attempts,
      dispatchedAt: now,
      updatedAt: now,
      version: record.data.version + 1,
    });
    current.set(record.data.caseKey, updated);
    await sendAdvance(context, updated, attempts);
  }
  for (const record of cases) {
    if (inFlight >= run.data.concurrency) break;
    if (record.data.status !== "pending") continue;
    const dispatched = await context.persistence.updateCaseRun(record, {
      ...record.data,
      dispatchedAt: now,
      status: "dispatched",
      updatedAt: now,
      version: record.data.version + 1,
    });
    current.set(record.data.caseKey, dispatched);
    inFlight += 1;
    await sendAdvance(context, dispatched, dispatched.data.attempts);
  }
  const counts = caseCounts([...current.values()]);
  if (!sameCounts(counts, run.data.counts)) {
    await context.persistence.updateEvaluationRun(
      run,
      { ...run.data, counts, updatedAt: now, version: run.data.version + 1 },
      await evaluationEvent(context, "evaluation-run.progressed", {
        evaluationRunId: run.data.id,
        failed: counts.failed,
        pending: counts.pending,
        running: counts.running,
        scored: counts.scored,
        status: "running",
        timedOut: counts.timedOut,
      }),
    );
  }
}
