import {
  MAX_EVALUATION_TRACE_RUNS,
  Ulid,
  type CaseScoreSummary,
  type EvaluationMessageEvidenceRecord,
  type EvaluationRunEvidenceRecord,
  type EvaluationTraceEvidenceRecord,
  type ScoreResultData,
  type ScoreResultRecord,
} from "@deployments-ai/db";
import {
  MAX_SCORE_LABEL_LENGTH,
  MAX_SCORE_RATIONALE_LENGTH,
  type CaseExpectations,
  type ScoreTarget,
} from "@deployments-ai/observability/evaluator-config";
import {
  boundedText,
  runEvaluator,
  scoreDefinitionTypeForEvaluator,
  scorePassed,
  type EvaluationEvidence,
  type EvaluationToolCallEvidence,
  type EvaluatorOutcome,
} from "@deployments-ai/observability/evaluators";
import { Schema } from "effect";
import type { EvaluationMessageContext } from "./evaluation-ports.ts";

/** Final responses larger than this are treated as missing evidence rather than read. */
export const MAX_EVALUATION_OUTPUT_BYTES = 262_144;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;

interface ScoredDefinition {
  readonly scoreDefinitionId: string;
  readonly revision: number;
}

export interface RunScoringInput {
  readonly run: EvaluationRunEvidenceRecord;
  readonly trace?: EvaluationTraceEvidenceRecord;
  readonly definitions: readonly ScoredDefinition[];
  readonly expectations: CaseExpectations;
  readonly source: "automatic" | "evaluation-run";
  readonly evaluationRunId?: string;
  readonly datasetCaseId?: string;
}

export interface RunScoringOutcome {
  readonly scores: readonly CaseScoreSummary[];
  readonly notApplicable: readonly Ulid[];
}

interface AssembledEvidence {
  readonly evidence: EvaluationEvidence;
  readonly outputMessageId?: string;
}

const decodeUlid = Schema.decodeUnknownSync(Ulid);

async function messageText(
  context: EvaluationMessageContext,
  message: EvaluationMessageEvidenceRecord,
  maximum: number,
): Promise<string | undefined> {
  if (message.data.body !== undefined) {
    return message.data.body.length > maximum
      ? message.data.body.slice(0, maximum)
      : message.data.body;
  }
  const reference = message.data.bodyRef;
  if (!reference || reference.byteSize > maximum) return undefined;
  return context.artifacts.readMessageBody(message);
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The scored runs' tool calls; `undefined` when any run's tool calls exceed the evidence bound. */
async function toolCallEvidence(
  context: EvaluationMessageContext,
  run: EvaluationRunEvidenceRecord,
  trace: EvaluationTraceEvidenceRecord | undefined,
  target: ScoreTarget,
): Promise<readonly EvaluationToolCallEvidence[] | undefined> {
  const runIds =
    target === "trace" && trace
      ? trace.data.runIds.slice(0, MAX_EVALUATION_TRACE_RUNS)
      : [run.data.id];
  const calls = await Promise.all(
    runIds.map((runId) => context.persistence.listRunToolCalls(runId)),
  );
  const evidence: EvaluationToolCallEvidence[] = [];
  for (const runCalls of calls) {
    if (runCalls === undefined) return undefined;
    for (const call of runCalls) {
      evidence.push({ name: call.data.toolName, status: call.data.status });
    }
  }
  return evidence;
}

/** Builds evaluator evidence for a run from canonical run, message, and tool-call records. */
async function assembleRunEvidence(
  context: EvaluationMessageContext,
  input: {
    readonly run: EvaluationRunEvidenceRecord;
    readonly trace?: EvaluationTraceEvidenceRecord;
    readonly expectations: CaseExpectations;
    readonly target: ScoreTarget;
  },
): Promise<AssembledEvidence> {
  const { run } = input;
  const messages = await context.persistence.listRunMessages(run);
  const userMessage =
    messages.find((message) => message.data.id === run.data.userMessageId) ??
    messages.find((message) => message.data.role === "user" && message.data.runId === run.data.id);
  const outputMessage = messages.findLast(
    (message) => message.data.role === "assistant" && message.data.runId === run.data.id,
  );
  const [inputText, outputText, toolCalls] = await Promise.all([
    userMessage ? messageText(context, userMessage, MAX_EVALUATION_OUTPUT_BYTES) : undefined,
    outputMessage ? messageText(context, outputMessage, MAX_EVALUATION_OUTPUT_BYTES) : undefined,
    toolCallEvidence(context, run, input.trace, input.target),
  ]);
  const structuredOutput =
    run.data.responseFormat && outputText !== undefined ? parsedJson(outputText) : undefined;
  return {
    evidence: {
      expectations: input.expectations,
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(inputText !== undefined ? { input: inputText } : {}),
      ...(outputText !== undefined ? { output: outputText } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    },
    ...(outputMessage ? { outputMessageId: outputMessage.data.id } : {}),
  };
}

function nonEmpty(text: string | undefined, maximum: number) {
  const bounded = text === undefined ? "" : boundedText(text, maximum);
  return bounded.length > 0 ? bounded : undefined;
}

function outcomeFields(
  outcome: Exclude<EvaluatorOutcome, { readonly status: "not_applicable" }>,
  threshold: number,
) {
  const usage = outcome.usage
    ? {
        judge: {
          internalEvaluator: true as const,
          modelId: outcome.usage.modelId,
          ...(outcome.usage.inputTokens !== undefined
            ? { inputTokens: outcome.usage.inputTokens }
            : {}),
          ...(outcome.usage.outputTokens !== undefined
            ? { outputTokens: outcome.usage.outputTokens }
            : {}),
          ...(outcome.usage.costUsdMicros !== undefined
            ? { costUsdMicros: outcome.usage.costUsdMicros }
            : {}),
        },
      }
    : {};
  if (outcome.status === "error") {
    const errorMessage = nonEmpty(outcome.message, MAX_ERROR_MESSAGE_LENGTH);
    return {
      durationMs: Math.max(0, Math.round(outcome.durationMs)),
      errorClass: outcome.errorClass,
      executionStatus: "error" as const,
      ...(errorMessage ? { errorMessage } : {}),
      ...usage,
    };
  }
  const label = nonEmpty(outcome.label, MAX_SCORE_LABEL_LENGTH);
  const rationale = nonEmpty(outcome.rationale, MAX_SCORE_RATIONALE_LENGTH);
  return {
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
    executionStatus: "succeeded" as const,
    passed: scorePassed(outcome.value, threshold),
    value: outcome.value,
    ...(label ? { label } : {}),
    ...(rationale ? { rationale } : {}),
    ...usage,
  };
}

function caseScoreSummary(result: ScoreResultRecord): CaseScoreSummary {
  return {
    executionStatus: result.data.executionStatus,
    revision: result.data.revision,
    scoreDefinitionId: result.data.scoreDefinitionId,
    ...(result.data.errorClass !== undefined ? { errorClass: result.data.errorClass } : {}),
    ...(result.data.passed !== undefined ? { passed: result.data.passed } : {}),
    ...(result.data.value !== undefined ? { value: result.data.value } : {}),
  };
}

/**
 * Runs each definition revision against the run's evidence and records one idempotent score
 * result per trace and revision. Not-applicable evaluators produce no score.
 */
export async function scoreRun(
  context: EvaluationMessageContext,
  input: RunScoringInput,
): Promise<RunScoringOutcome> {
  const { run } = input;
  const evidenceByTarget = new Map<ScoreTarget, Promise<AssembledEvidence>>();
  const evidenceFor = (target: ScoreTarget) => {
    let pending = evidenceByTarget.get(target);
    if (!pending) {
      pending = assembleRunEvidence(context, {
        expectations: input.expectations,
        run,
        target,
        ...(input.trace ? { trace: input.trace } : {}),
      });
      evidenceByTarget.set(target, pending);
    }
    return pending;
  };
  const scores: CaseScoreSummary[] = [];
  const notApplicable: Ulid[] = [];
  for (const definition of input.definitions) {
    const revision = await context.persistence.getScoreDefinitionRevision(
      definition.scoreDefinitionId,
      definition.revision,
    );
    if (!revision) {
      throw new Error(
        `Score definition ${definition.scoreDefinitionId} revision ${definition.revision} is missing.`,
      );
    }
    const assembled = await evidenceFor(revision.data.target);
    const { evaluator } = revision.data;
    const judgeAdmission =
      evaluator.kind === "model_judge"
        ? await context.admitJudgeModel(context.scope, evaluator.modelId)
        : undefined;
    // Re-admitted before every judge call: a policy edit or catalog retirement after the
    // definition was saved must stop further judge spend.
    const outcome: EvaluatorOutcome =
      judgeAdmission && !judgeAdmission.allowed
        ? {
            durationMs: 0,
            errorClass: "invalid_configuration",
            message: `Judge model ${judgeAdmission.modelId} is not admitted in this environment (${judgeAdmission.reason}): ${judgeAdmission.message}`,
            status: "error",
          }
        : await runEvaluator(evaluator, assembled.evidence, {
            judge: context.judgeFor({
              environmentId: context.scope.environmentId,
              organizationId: context.scope.organizationId,
              projectId: context.scope.projectId,
              revision: revision.data.revision,
              runId: run.data.id,
              scoreDefinitionId: revision.data.scoreDefinitionId,
              traceId: run.data.traceId,
            }),
          });
    if (outcome.status === "not_applicable") {
      notApplicable.push(revision.data.scoreDefinitionId);
      continue;
    }
    const now = context.now().toISOString();
    const data: ScoreResultData = {
      ...context.scope,
      agentReleaseId: run.data.agentReleaseId,
      createdAt: now,
      evaluatorVersionHash: revision.data.evaluatorVersionHash,
      evidenceRefs: [
        { id: run.data.id, kind: "run" },
        { id: run.data.traceId, kind: "trace" },
        ...(assembled.outputMessageId
          ? [{ id: assembled.outputMessageId, kind: "message" as const }]
          : []),
      ],
      id: await context.generateId(),
      idempotencyKey: `${run.data.traceId}:${revision.data.scoreDefinitionId}:${revision.data.revision}`,
      revision: revision.data.revision,
      runId: run.data.id,
      scoreDefinitionId: revision.data.scoreDefinitionId,
      scoreType: scoreDefinitionTypeForEvaluator(revision.data.evaluator),
      source: input.source,
      spanId: run.data.spanId,
      threadId: run.data.threadId,
      threshold: revision.data.threshold,
      traceId: run.data.traceId,
      updatedAt: now,
      version: 1,
      ...(input.source === "automatic" ? { agentDeploymentId: run.data.agentDeploymentId } : {}),
      ...(input.evaluationRunId ? { evaluationRunId: decodeUlid(input.evaluationRunId) } : {}),
      ...(input.datasetCaseId ? { datasetCaseId: decodeUlid(input.datasetCaseId) } : {}),
      ...outcomeFields(outcome, revision.data.threshold),
    };
    const recorded = await context.persistence.recordAutomatedScore(data);
    scores.push(caseScoreSummary(recorded.result));
  }
  return { notApplicable, scores };
}

/** Wall-clock latency of a finished run, when its timestamps allow it. */
export function runLatencyMs(run: EvaluationRunEvidenceRecord): number | undefined {
  const started = Date.parse(run.data.startedAt ?? run.data.createdAt);
  const completed = run.data.completedAt ? Date.parse(run.data.completedAt) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return undefined;
  }
  return Math.round(completed - started);
}

/** Token and cost totals from a finalized trace. */
export function traceTotals(trace: EvaluationTraceEvidenceRecord | undefined) {
  return {
    ...(trace?.data.totalTokens !== undefined ? { totalTokens: trace.data.totalTokens } : {}),
    ...(trace?.data.totalCostUsdMicros !== undefined
      ? { costUsdMicros: trace.data.totalCostUsdMicros }
      : {}),
  };
}
