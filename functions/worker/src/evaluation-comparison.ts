import type {
  EvaluationCaseRunRecord,
  EvaluationRunRecord,
  ReleaseComparisonRecord,
  ReleaseComparisonSummary,
} from "@deployments-ai/db";
import {
  boundedText,
  compareReleases,
  comparisonReportObjectKey,
  renderComparisonReport,
  type ComparisonArmInput,
  type ComparisonCaseInput,
  type ReleaseComparisonResult,
} from "@deployments-ai/observability/evaluators";
import type { EvaluationMessageContext } from "./evaluation-ports.ts";
import { evaluationEvent, evaluationFailure } from "./evaluation-run-lifecycle.ts";

const MAX_REASONS = 50;
const MAX_REASON_LENGTH = 1_000;
const TERMINAL_RUN_STATUSES = ["canceled", "completed", "failed"];

function comparisonCase(record: EvaluationCaseRunRecord): ComparisonCaseInput | undefined {
  const status = record.data.status;
  if (status !== "scored" && status !== "failed" && status !== "timed_out") return undefined;
  return {
    caseKey: record.data.caseKey,
    scores: record.data.scores.map((score) => ({
      executionStatus: score.executionStatus,
      revision: score.revision,
      scoreDefinitionId: score.scoreDefinitionId,
      ...(score.passed !== undefined ? { passed: score.passed } : {}),
      ...(score.value !== undefined ? { value: score.value } : {}),
    })),
    status,
    ...(record.data.latencyMs !== undefined ? { latencyMs: record.data.latencyMs } : {}),
    ...(record.data.totalTokens !== undefined ? { totalTokens: record.data.totalTokens } : {}),
    ...(record.data.costUsdMicros !== undefined
      ? { costUsdMicros: record.data.costUsdMicros }
      : {}),
  };
}

async function armInput(
  context: EvaluationMessageContext,
  arm: ReleaseComparisonRecord["data"]["baseline"],
): Promise<ComparisonArmInput> {
  const cases = await context.persistence.listAllCaseRuns(arm.evaluationRunId);
  return {
    agentReleaseId: arm.agentReleaseId,
    cases: cases.flatMap((record) => {
      const mapped = comparisonCase(record);
      return mapped ? [mapped] : [];
    }),
    evaluationRunId: arm.evaluationRunId,
    ...(arm.releaseContentHash ? { releaseContentHash: arm.releaseContentHash } : {}),
  };
}

/** Rounded latency fields, omitting absent values (stored latency fields are integers). */
function latencySummary(result: ReleaseComparisonResult): ReleaseComparisonSummary["latency"] {
  const fields: Record<string, number> = {};
  const values = {
    baselineP50Ms: result.latency.baseline.p50,
    baselineP95Ms: result.latency.baseline.p95,
    candidateP50Ms: result.latency.candidate.p50,
    candidateP95Ms: result.latency.candidate.p95,
    p50DeltaMs: result.latency.p50DeltaMs,
    p95DeltaMs: result.latency.p95DeltaMs,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) fields[name] = Math.round(value);
  }
  return fields;
}

/** Maps a comparison result onto the stored summary shape of the comparison's frozen definitions. */
function comparisonSummary(
  comparison: ReleaseComparisonRecord,
  result: ReleaseComparisonResult,
): ReleaseComparisonSummary {
  return {
    comparableCases: result.comparableCases,
    costUsdMicros: {
      baselineTotal: Math.round(result.costUsdMicros.baselineTotal),
      candidateTotal: Math.round(result.costUsdMicros.candidateTotal),
      delta: Math.round(result.costUsdMicros.delta),
    },
    definitions: comparison.data.scoreDefinitions.flatMap((frozen) => {
      const definition = result.definitions.find(
        (entry) =>
          entry.scoreDefinitionId === frozen.scoreDefinitionId &&
          entry.revision === frozen.revision,
      );
      if (!definition) return [];
      return [
        {
          name: frozen.name,
          revision: frozen.revision,
          scoreDefinitionId: frozen.scoreDefinitionId,
          ...(definition.baseline.mean !== undefined
            ? { baselineMean: definition.baseline.mean }
            : {}),
          ...(definition.baseline.passRate !== undefined
            ? { baselinePassRate: definition.baseline.passRate }
            : {}),
          ...(definition.candidate.mean !== undefined
            ? { candidateMean: definition.candidate.mean }
            : {}),
          ...(definition.candidate.passRate !== undefined
            ? { candidatePassRate: definition.candidate.passRate }
            : {}),
          ...(definition.meanDelta !== undefined ? { meanDelta: definition.meanDelta } : {}),
          ...(definition.passRateDelta !== undefined
            ? { passRateDelta: definition.passRateDelta }
            : {}),
        },
      ];
    }),
    evaluatorErrors: result.evaluatorErrors,
    latency: latencySummary(result),
    missingEvidence: result.missingEvidence,
    regressions: result.cases.reduce((sum, entry) => sum + entry.regressions.length, 0),
    tokens: {
      baselineTotal: Math.round(result.tokens.baselineTotal),
      candidateTotal: Math.round(result.tokens.candidateTotal),
      delta: Math.round(result.tokens.delta),
    },
    totalCases: result.totalCases,
  };
}

async function failComparison(
  context: EvaluationMessageContext,
  comparison: ReleaseComparisonRecord,
  runs: readonly EvaluationRunRecord[],
) {
  const failedRun = runs.find((run) => run.data.status !== "completed");
  const failure = evaluationFailure(
    "evaluation_run_failed",
    `The ${failedRun?.data.comparison?.role ?? "evaluation"} run ended ${failedRun?.data.status ?? "unexpectedly"}${
      failedRun?.data.error ? `: ${failedRun.data.error.message}` : "."
    }`,
  );
  const now = context.now().toISOString();
  await context.persistence.updateReleaseComparison(
    comparison,
    {
      ...comparison.data,
      completedAt: now,
      error: failure,
      status: "failed",
      updatedAt: now,
      version: comparison.data.version + 1,
    },
    await evaluationEvent(context, "release-comparison.failed", {
      errorCode: failure.code,
      releaseComparisonId: comparison.data.id,
      status: "failed",
    }),
  );
}

/**
 * `release-comparison.reconcile`: once both arms are terminal, compares them, stores the
 * markdown and JSON reports, and completes the comparison with its advisory verdict.
 */
export async function reconcileReleaseComparison(
  context: EvaluationMessageContext,
  releaseComparisonId: string,
) {
  const comparison = await context.persistence.getReleaseComparison(releaseComparisonId);
  if (
    !comparison ||
    comparison.data.status === "completed" ||
    comparison.data.status === "failed"
  ) {
    return;
  }
  const runs = await Promise.all(
    [comparison.data.baseline, comparison.data.candidate].map((arm) =>
      context.persistence.getEvaluationRun(arm.evaluationRunId),
    ),
  );
  const [baselineRun, candidateRun] = runs;
  if (!baselineRun || !candidateRun) {
    throw new Error(
      `Release comparison ${releaseComparisonId} references a missing evaluation run.`,
    );
  }
  if (!runs.every((run) => run && TERMINAL_RUN_STATUSES.includes(run.data.status))) return;
  if (baselineRun.data.status !== "completed" || candidateRun.data.status !== "completed") {
    await failComparison(context, comparison, [baselineRun, candidateRun]);
    return;
  }
  const [baseline, candidate, dataset] = await Promise.all([
    armInput(context, comparison.data.baseline),
    armInput(context, comparison.data.candidate),
    context.persistence.getRegressionDataset(comparison.data.datasetId),
  ]);
  const result = compareReleases({
    baseline,
    candidate,
    definitions: comparison.data.scoreDefinitions.map((definition) => ({
      evaluatorVersionHash: definition.evaluatorVersionHash,
      name: definition.name,
      revision: definition.revision,
      scoreDefinitionId: definition.scoreDefinitionId,
      threshold: definition.threshold,
    })),
    policy: comparison.data.gatePolicy,
  });
  const now = context.now().toISOString();
  const markdown = renderComparisonReport(result, {
    comparisonId: comparison.data.id,
    datasetId: comparison.data.datasetId,
    generatedAt: now,
    ...(dataset ? { datasetName: dataset.data.name } : {}),
  });
  const organizationId = context.scope.organizationId;
  const [reportMarkdown, reportJson] = await Promise.all([
    context.artifacts.putReport({
      body: markdown,
      contentType: "text/markdown",
      key: comparisonReportObjectKey(organizationId, comparison.data.id, "md"),
    }),
    context.artifacts.putReport({
      body: JSON.stringify(result),
      contentType: "application/json",
      key: comparisonReportObjectKey(organizationId, comparison.data.id, "json"),
    }),
  ]);
  await context.persistence.updateReleaseComparison(
    comparison,
    {
      ...comparison.data,
      completedAt: now,
      reasons: result.reasons
        .slice(0, MAX_REASONS)
        .map((reason) => boundedText(reason, MAX_REASON_LENGTH)),
      reportJson,
      reportMarkdown,
      status: "completed",
      summary: comparisonSummary(comparison, result),
      updatedAt: now,
      version: comparison.data.version + 1,
      verdict: result.verdict,
    },
    await evaluationEvent(context, "release-comparison.completed", {
      releaseComparisonId: comparison.data.id,
      status: "completed",
      verdict: result.verdict,
    }),
  );
}
