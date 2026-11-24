import {
  MAX_ACTIVE_SCORE_DEFINITIONS,
  PersistenceError,
  type EvaluationRunEvidenceRecord,
  type ScoreDefinitionRevisionRecord,
} from "@deployments-ai/db";
import {
  evaluatorIsAutomated,
  sampledForAutomaticScoring,
} from "@deployments-ai/observability/evaluators";
import type { EvaluationMessageContext } from "./evaluation-ports.ts";
import { scoreRun } from "./evaluation-scoring.ts";

/**
 * Only hosted customer runs are scored automatically. Evaluation and preview runs, and any run
 * executed through an execution binding, are excluded. Runs recorded before the execution
 * purpose field existed are customer runs.
 */
function isCustomerRun(run: EvaluationRunEvidenceRecord): boolean {
  const data: object = run.data;
  const purpose = "executionPurpose" in data ? data.executionPurpose : undefined;
  const bindingId = "executionBindingId" in data ? data.executionBindingId : undefined;
  return (purpose === undefined || purpose === "customer") && bindingId === undefined;
}

/** `trace.score`: samples active automated definitions against a finalized customer trace. */
export async function scoreFinalizedTrace(context: EvaluationMessageContext, traceId: string) {
  const trace = await context.persistence.getTrace(traceId);
  if (!trace || trace.data.status !== "finalized") return;
  const run = await context.persistence.getRun(trace.data.sessionId, trace.data.rootRunId);
  if (!run || !isCustomerRun(run)) return;
  let active: readonly ScoreDefinitionRevisionRecord[];
  try {
    active = await context.persistence.listActiveScoreDefinitionRevisions();
  } catch (cause) {
    // Creation enforces the cap, so overflow means concurrent creates raced past it. Retrying
    // cannot shrink the set, so skip this trace instead of dead-lettering the message.
    if (!(cause instanceof PersistenceError) || cause.code !== "evaluation_collection_too_large")
      throw cause;
    console.warn("Automatic scoring skipped: too many active score definitions.", {
      environmentId: context.scope.environmentId,
      maximum: MAX_ACTIVE_SCORE_DEFINITIONS,
      organizationId: context.scope.organizationId,
      traceId,
    });
    return;
  }
  const definitions = active.filter(
    (revision) =>
      evaluatorIsAutomated(revision.data.evaluator) &&
      revision.data.sampling.rate > 0 &&
      sampledForAutomaticScoring(
        traceId,
        revision.data.scoreDefinitionId,
        revision.data.sampling.rate,
      ),
  );
  if (definitions.length === 0) return;
  await scoreRun(context, {
    definitions: definitions.map((revision) => ({
      revision: revision.data.revision,
      scoreDefinitionId: revision.data.scoreDefinitionId,
    })),
    expectations: {},
    run,
    source: "automatic",
    trace,
  });
}
