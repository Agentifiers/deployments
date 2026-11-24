import type { FrozenScoreDefinition, RegressionDatasetRecord } from "@deployments-ai/db";
import { evaluatorIsAutomated } from "@deployments-ai/observability/evaluators";
import { failure } from "../persistence-failure.ts";
import { requireActiveDataset } from "./dataset-service.ts";
import { requireScoreDefinition } from "./definition-service.ts";
import type { EvaluationQueue } from "./service-contracts.ts";
import type { EvaluationRequestContext } from "./service-support.ts";

export const DEFAULT_CASE_TIMEOUT_SECONDS = 600;
export const DEFAULT_EVALUATION_CONCURRENCY = 5;

/** Freezes the current revision of each requested automated, active score definition. */
export async function frozenScoreDefinitions(
  context: EvaluationRequestContext,
  scoreDefinitionIds: readonly string[],
): Promise<FrozenScoreDefinition[]> {
  return Promise.all(
    [...new Set(scoreDefinitionIds)].map(async (scoreDefinitionId) => {
      const { definition, revision } = await requireScoreDefinition(context, scoreDefinitionId);
      if (definition.data.status !== "active") {
        failure("conflict", "score_definition_archived", "The score definition is archived.");
      }
      if (!evaluatorIsAutomated(revision.data.evaluator)) {
        failure(
          "unprocessable",
          "score_definition_not_automated",
          "Evaluation runs only use automated score definitions.",
        );
      }
      return {
        evaluatorVersionHash: revision.data.evaluatorVersionHash,
        name: definition.data.name,
        revision: revision.data.revision,
        scoreDefinitionId: definition.data.id,
        threshold: revision.data.threshold,
        type: definition.data.type,
      };
    }),
  );
}

/** An active dataset with at least one case to replay. */
export async function requireReplayDataset(
  context: EvaluationRequestContext,
  datasetId: string,
): Promise<RegressionDatasetRecord> {
  const dataset = await requireActiveDataset(context, datasetId);
  if (dataset.data.caseCount < 1) {
    failure("unprocessable", "regression_dataset_empty", "The regression dataset has no cases.");
  }
  return dataset;
}

export async function requireAgentRelease(context: EvaluationRequestContext, id: string) {
  return (
    (await context.persistence.getAgentRelease(id)) ??
    failure("not-found", "agent_release_not_found", "Agent release not found in this environment.")
  );
}

export async function requireAgentDeployment(context: EvaluationRequestContext, id: string) {
  return (
    (await context.persistence.getAgentDeployment(id)) ??
    failure(
      "not-found",
      "agent_deployment_not_found",
      "Agent deployment not found in this environment.",
    )
  );
}

/** (Re)sends a run start; FIFO deduplication makes a resend of an existing run safe. */
export async function sendRunStart(
  context: EvaluationRequestContext,
  queue: EvaluationQueue,
  evaluationRunId: string,
) {
  await queue.send({
    environmentId: context.scope.environmentId,
    evaluationRunId,
    organizationId: context.scope.organizationId,
    projectId: context.scope.projectId,
    type: "evaluation-run.start",
  });
}

export function emptyCounts(pending: number) {
  return { failed: 0, pending, running: 0, scored: 0, timedOut: 0 };
}
