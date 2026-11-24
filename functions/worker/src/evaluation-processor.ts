import { makeEvaluationPersistence, Ulid } from "@deployments-ai/db";
import type { EvaluationQueueMessage } from "@deployments-ai/observability/evaluators";
import { Schema } from "effect";
import { scoreFinalizedTrace } from "./evaluation-auto-scoring.ts";
import { advanceEvaluationCase } from "./evaluation-case-advance.ts";
import { reconcileReleaseComparison } from "./evaluation-comparison.ts";
import type { EvaluationMessageContext, EvaluationWorkerDependencies } from "./evaluation-ports.ts";
import { reconcileEvaluationRun, startEvaluationRun } from "./evaluation-run-lifecycle.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);

/** Dispatches one evaluation queue message within its environment scope. */
export async function processEvaluationMessage(
  dependencies: EvaluationWorkerDependencies,
  message: EvaluationQueueMessage,
) {
  const scope = {
    environmentId: decodeUlid(message.environmentId),
    organizationId: decodeUlid(message.organizationId),
    projectId: decodeUlid(message.projectId),
  };
  const context: EvaluationMessageContext = {
    ...dependencies,
    persistence: makeEvaluationPersistence(dependencies.database, scope),
    scope,
  };
  switch (message.type) {
    case "evaluation-run.start":
      return startEvaluationRun(context, message.evaluationRunId);
    case "evaluation-run.reconcile":
      return reconcileEvaluationRun(context, message.evaluationRunId);
    case "evaluation-case.advance":
      return advanceEvaluationCase(context, message);
    case "release-comparison.reconcile":
      return reconcileReleaseComparison(context, message.releaseComparisonId);
    case "trace.score":
      return scoreFinalizedTrace(context, message.traceId);
  }
}
