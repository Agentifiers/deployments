import {
  Ulid,
  type EvaluationCaseRunData,
  type EvaluationCaseRunRecord,
  type EvaluationRunEvidenceRecord,
  type EvaluationRunRecord,
} from "@deployments-ai/db";
import { TraceId } from "@deployments-ai/observability";
import type { CaseExpectations } from "@deployments-ai/observability/evaluator-config";
import {
  parseCaseMaterial,
  type EvaluationCaseMaterial,
} from "@deployments-ai/observability/evaluators";
import { Schema } from "effect";
import type { EvaluationMessageContext, SubmittedEvaluationTurn } from "./evaluation-ports.ts";
import {
  EvaluationTerminalError,
  evaluationFailure,
  isTerminalCase,
  type EvaluationFailure,
} from "./evaluation-run-lifecycle.ts";
import { runLatencyMs, scoreRun, traceTotals } from "./evaluation-scoring.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const decodeTraceId = Schema.decodeUnknownSync(TraceId);
const TERMINAL_RUN_FAILURES = ["canceled", "failed"];

export interface AdvanceCaseMessage {
  readonly evaluationRunId: string;
  readonly caseKey: string;
  readonly attempt: number;
}

async function sendReconcile(context: EvaluationMessageContext, record: EvaluationCaseRunRecord) {
  await context.queue.send({
    ...context.scope,
    evaluationRunId: record.data.evaluationRunId,
    trigger: `case-${record.data.caseKey}`,
    type: "evaluation-run.reconcile",
  });
}

async function sendAdvance(context: EvaluationMessageContext, record: EvaluationCaseRunRecord) {
  await context.queue.send({
    ...context.scope,
    attempt: record.data.attempts,
    caseKey: record.data.caseKey,
    evaluationRunId: record.data.evaluationRunId,
    type: "evaluation-case.advance",
  });
}

async function finishCase(
  context: EvaluationMessageContext,
  record: EvaluationCaseRunRecord,
  fields: Partial<EvaluationCaseRunData> & Pick<EvaluationCaseRunData, "status">,
) {
  const now = context.now().toISOString();
  const finished = await context.persistence.updateCaseRun(record, {
    ...record.data,
    completedAt: now,
    updatedAt: now,
    version: record.data.version + 1,
    ...fields,
  });
  await sendReconcile(context, finished);
}

function failCase(
  context: EvaluationMessageContext,
  record: EvaluationCaseRunRecord,
  status: "failed" | "timed_out",
  error: EvaluationFailure,
  runStatus?: string,
) {
  return finishCase(context, record, { error, status, ...(runStatus ? { runStatus } : {}) });
}

async function caseMaterial(
  context: EvaluationMessageContext,
  run: EvaluationRunRecord,
  record: EvaluationCaseRunRecord,
): Promise<EvaluationCaseMaterial | EvaluationFailure> {
  const datasetCase =
    run.data.datasetId && record.data.datasetCaseId
      ? await context.persistence.getDatasetCase(run.data.datasetId, record.data.datasetCaseId)
      : undefined;
  if (!datasetCase)
    return evaluationFailure("dataset_case_not_found", "The dataset case is missing.");
  const bytes = await context.artifacts.readCaseMaterial(datasetCase.data.material);
  try {
    return parseCaseMaterial(bytes, datasetCase.data.contentSha256);
  } catch (cause) {
    return evaluationFailure(
      "case_material_invalid",
      cause instanceof Error ? cause.message : "Dataset case material is invalid.",
    );
  }
}

async function scoreCase(
  context: EvaluationMessageContext,
  run: EvaluationRunRecord,
  record: EvaluationCaseRunRecord,
  target: EvaluationRunEvidenceRecord,
  expectations: CaseExpectations,
) {
  const trace = await context.persistence.getTrace(target.data.traceId);
  const outcome = await scoreRun(context, {
    definitions: run.data.scoreDefinitions,
    evaluationRunId: run.data.id,
    expectations,
    run: target,
    source: "evaluation-run",
    ...(trace ? { trace } : {}),
    ...(record.data.datasetCaseId ? { datasetCaseId: record.data.datasetCaseId } : {}),
  });
  const latencyMs = runLatencyMs(target);
  await finishCase(context, record, {
    notApplicable: outcome.notApplicable,
    runId: target.data.id,
    runStatus: target.data.status,
    scores: outcome.scores,
    status: "scored",
    threadId: target.data.threadId,
    traceId: target.data.traceId,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...traceTotals(trace),
  });
}

async function scoreTraceCase(
  context: EvaluationMessageContext,
  run: EvaluationRunRecord,
  record: EvaluationCaseRunRecord,
) {
  const trace = await context.persistence.getTrace(record.data.caseKey);
  if (!trace || trace.data.status !== "finalized") {
    await failCase(
      context,
      record,
      "failed",
      evaluationFailure("trace_not_finalized", "The trace is missing or not finalized."),
    );
    return;
  }
  const root = await context.persistence.getRun(trace.data.sessionId, trace.data.rootRunId);
  if (!root) {
    await failCase(
      context,
      record,
      "failed",
      evaluationFailure("run_not_found", "The trace root run is missing."),
    );
    return;
  }
  await scoreCase(context, run, record, root, {});
}

async function submitCase(
  context: EvaluationMessageContext,
  run: EvaluationRunRecord,
  record: EvaluationCaseRunRecord,
) {
  if (!run.data.executionBindingId) {
    await failCase(
      context,
      record,
      "failed",
      evaluationFailure(
        "execution_binding_missing",
        "The evaluation run has no execution binding.",
      ),
    );
    return;
  }
  const material = await caseMaterial(context, run, record);
  if ("code" in material) {
    await failCase(context, record, "failed", material);
    return;
  }
  let submitted: SubmittedEvaluationTurn;
  try {
    submitted = await context.execution.submitTurn({
      actor: { id: run.data.createdByPrincipalId, type: "principal" },
      content: material.input.content,
      executionBindingId: run.data.executionBindingId,
      idempotencyKey: `evaluation:${run.data.id}:${record.data.caseKey}`,
      scope: context.scope,
      title: `eval:${run.data.id}:${record.data.caseKey}`,
    });
  } catch (cause) {
    if (!(cause instanceof EvaluationTerminalError)) throw cause;
    await failCase(context, record, "failed", evaluationFailure(cause.code, cause.message));
    return;
  }
  const now = context.now();
  const updated = await context.persistence.updateCaseRun(record, {
    ...record.data,
    attempts: record.data.attempts + 1,
    deadlineAt: new Date(now.getTime() + run.data.caseTimeoutSeconds * 1_000).toISOString(),
    runId: decodeUlid(submitted.runId),
    runIdempotencyKey: submitted.runIdempotencyKey,
    status: "submitted",
    submittedAt: now.toISOString(),
    threadId: decodeUlid(submitted.threadId),
    traceId: decodeTraceId(submitted.traceId),
    updatedAt: now.toISOString(),
    version: record.data.version + 1,
  });
  await sendAdvance(context, updated);
}

async function pollCase(
  context: EvaluationMessageContext,
  run: EvaluationRunRecord,
  record: EvaluationCaseRunRecord,
) {
  const { runId, threadId } = record.data;
  if (!runId || !threadId) {
    await failCase(
      context,
      record,
      "failed",
      evaluationFailure("run_not_found", "The submitted case has no run reference."),
    );
    return;
  }
  const target = await context.persistence.getRun(threadId, runId);
  if (target?.data.status === "completed") {
    const material = await caseMaterial(context, run, record);
    if ("code" in material) {
      await failCase(context, record, "failed", material, target.data.status);
      return;
    }
    await scoreCase(context, run, record, target, material.expectations);
    return;
  }
  if (target && TERMINAL_RUN_FAILURES.includes(target.data.status)) {
    await failCase(
      context,
      record,
      "failed",
      evaluationFailure("run_failed", `The evaluated run ended ${target.data.status}.`),
      target.data.status,
    );
    return;
  }
  const now = context.now();
  const deadline = record.data.deadlineAt ? Date.parse(record.data.deadlineAt) : Number.NaN;
  if (!Number.isFinite(deadline) || now.getTime() >= deadline) {
    await failCase(
      context,
      record,
      "timed_out",
      evaluationFailure(
        "case_timeout",
        `The evaluated run did not finish within ${run.data.caseTimeoutSeconds}s.`,
      ),
      target?.data.status,
    );
    return;
  }
  const updated = await context.persistence.updateCaseRun(record, {
    ...record.data,
    attempts: record.data.attempts + 1,
    updatedAt: now.toISOString(),
    version: record.data.version + 1,
    ...(target ? { runStatus: target.data.status } : {}),
  });
  await sendAdvance(context, updated);
}

/**
 * `evaluation-case.advance`: moves one case forward. The queue-level delay between advance
 * messages is the poll interval; `attempt` tracks the case's advance sequence so duplicate
 * deliveries are ignored and a lost follow-up send is replayed.
 */
export async function advanceEvaluationCase(
  context: EvaluationMessageContext,
  message: AdvanceCaseMessage,
) {
  const run = await context.persistence.getEvaluationRun(message.evaluationRunId);
  const record = await context.persistence.getCaseRun(message.evaluationRunId, message.caseKey);
  if (!run || !record) return;
  if (isTerminalCase(record)) {
    await sendReconcile(context, record);
    return;
  }
  if (run.data.status !== "running") return;
  if (message.attempt === record.data.attempts - 1) {
    await sendAdvance(context, record);
    return;
  }
  if (message.attempt !== record.data.attempts) return;
  if (record.data.status === "dispatched") {
    await (run.data.kind === "trace-score"
      ? scoreTraceCase(context, run, record)
      : submitCase(context, run, record));
  } else if (record.data.status === "submitted") {
    await pollCase(context, run, record);
  }
}
