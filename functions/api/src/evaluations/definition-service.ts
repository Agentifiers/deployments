import type {
  CreateScoreDefinitionRequest,
  ReviseScoreDefinitionRequest,
} from "@deployments-ai/api-contract";
import type { ScoreDefinitionRecord, ScoreDefinitionRevisionData, Ulid } from "@deployments-ai/db";
import {
  evaluatorVersionHash,
  judgePromptHash,
  MAX_MODEL_JUDGE_SAMPLING_RATE,
  scoreDefinitionTypeForEvaluator,
  validateEvaluatorConfig,
} from "@deployments-ai/observability/evaluators";
import { failure } from "../persistence-failure.ts";
import { scoreDefinitionResponse } from "./responses.ts";
import {
  evaluationEvent,
  pageOptions,
  requiredParam,
  statusFilter,
  ulid,
  type EvaluationRequestContext,
} from "./service-support.ts";

type ScoreDefinitionConfiguration = Pick<
  CreateScoreDefinitionRequest,
  "evaluator" | "sampling" | "target" | "threshold" | "weight"
>;

/** Validates an evaluator configuration and builds the immutable revision it describes. */
async function revisionData(
  context: EvaluationRequestContext,
  scoreDefinitionId: Ulid,
  revision: number,
  configuration: ScoreDefinitionConfiguration,
): Promise<ScoreDefinitionRevisionData> {
  const { evaluator } = configuration;
  const invalid = validateEvaluatorConfig(evaluator);
  if (invalid) failure("unprocessable", "invalid_evaluator", invalid);
  if (evaluator.kind === "model_judge") {
    const admission = await context.dependencies.admitJudgeModel(context.scope, evaluator.modelId);
    if (!admission.allowed) failure("unprocessable", admission.reason, admission.message);
  }
  const sampling = configuration.sampling ?? { rate: 0 };
  if (evaluator.kind === "model_judge" && sampling.rate > MAX_MODEL_JUDGE_SAMPLING_RATE) {
    failure(
      "unprocessable",
      "invalid_sampling_rate",
      `Model-judged definitions sample at most ${MAX_MODEL_JUDGE_SAMPLING_RATE} of traces.`,
    );
  }
  if ((evaluator.kind === "human" || evaluator.kind === "imported") && sampling.rate !== 0) {
    failure(
      "unprocessable",
      "invalid_sampling_rate",
      "Human and imported definitions are never scored automatically; sampling must be 0.",
    );
  }
  const target = configuration.target ?? "root-run";
  const threshold = configuration.threshold ?? 1;
  return {
    createdAt: context.timestamp,
    createdByPrincipalId: context.principalId,
    environmentId: context.scope.environmentId,
    evaluator,
    evaluatorVersionHash: evaluatorVersionHash({ evaluator, target, threshold }),
    id: await context.newId(),
    ...(evaluator.kind === "model_judge"
      ? { judgeModelId: evaluator.modelId, judgePromptHash: judgePromptHash(evaluator.prompt) }
      : {}),
    organizationId: context.scope.organizationId,
    projectId: context.scope.projectId,
    revision,
    sampling,
    scoreDefinitionId,
    status: "active",
    target,
    threshold,
    updatedAt: context.timestamp,
    version: 1,
    ...(configuration.weight === undefined ? {} : { weight: configuration.weight }),
  };
}

export async function requireScoreDefinition(
  context: EvaluationRequestContext,
  scoreDefinitionId: string,
) {
  const definition =
    (await context.persistence.getScoreDefinition(scoreDefinitionId)) ??
    failure("not-found", "score_definition_not_found", "Score definition not found.");
  const revision =
    (await context.persistence.getScoreDefinitionRevision(
      definition.data.id,
      definition.data.currentRevision,
    )) ??
    failure(
      "not-found",
      "score_definition_revision_not_found",
      "Score definition revision not found.",
    );
  return { definition, revision };
}

export async function invokeScoreDefinitionRoute(
  routeName:
    | "archiveScoreDefinition"
    | "createScoreDefinition"
    | "getScoreDefinition"
    | "listScoreDefinitions"
    | "reviseScoreDefinition",
  context: EvaluationRequestContext,
) {
  const { persistence } = context;
  switch (routeName) {
    case "createScoreDefinition": {
      const body = context.invocation.body as CreateScoreDefinitionRequest;
      const id = await context.newId();
      const revision = await revisionData(context, id, 1, body);
      const definition: ScoreDefinitionRecord["data"] = {
        createdAt: context.timestamp,
        createdByPrincipalId: context.principalId,
        currentRevision: 1,
        ...(body.description === undefined ? {} : { description: body.description }),
        environmentId: context.scope.environmentId,
        id,
        name: body.name,
        organizationId: context.scope.organizationId,
        ownerPrincipalId: context.principalId,
        projectId: context.scope.projectId,
        status: "active",
        type: scoreDefinitionTypeForEvaluator(body.evaluator),
        updatedAt: context.timestamp,
        version: 1,
      };
      const created = await persistence.createScoreDefinition(
        { definition, revision },
        await evaluationEvent(context, "score-definition.created", {
          currentRevision: 1,
          scoreDefinitionId: id,
          status: "active",
        }),
      );
      return scoreDefinitionResponse(created.definition, created.revision);
    }
    case "reviseScoreDefinition": {
      const body = context.invocation.body as ReviseScoreDefinitionRequest;
      const scoreDefinitionId = ulid(requiredParam(context, "scoreDefinitionId"));
      const revision = await revisionData(
        context,
        scoreDefinitionId,
        body.expectedRevision + 1,
        body,
      );
      const revised = await persistence.reviseScoreDefinition(
        { expectedRevision: body.expectedRevision, revision, updatedAt: context.timestamp },
        await evaluationEvent(context, "score-definition.revised", {
          currentRevision: revision.revision,
          scoreDefinitionId,
          status: "active",
        }),
      );
      return scoreDefinitionResponse(revised.definition, revised.revision);
    }
    case "archiveScoreDefinition": {
      const scoreDefinitionId = ulid(requiredParam(context, "scoreDefinitionId"));
      const archived = await persistence.archiveScoreDefinition(
        { archivedAt: context.timestamp, scoreDefinitionId },
        await evaluationEvent(context, "score-definition.archived", {
          scoreDefinitionId,
          status: "archived",
        }),
      );
      return scoreDefinitionResponse(archived.definition, archived.revision);
    }
    case "getScoreDefinition": {
      const { definition, revision } = await requireScoreDefinition(
        context,
        requiredParam(context, "scoreDefinitionId"),
      );
      return scoreDefinitionResponse(definition, revision);
    }
    case "listScoreDefinitions": {
      const page = await persistence.listScoreDefinitions({
        ...pageOptions(context),
        ...statusFilter<ScoreDefinitionRecord["data"]["status"]>(context),
      });
      const items = await Promise.all(
        page.items.map(async (definition) => {
          const revision =
            (await persistence.getScoreDefinitionRevision(
              definition.data.id,
              definition.data.currentRevision,
            )) ??
            failure(
              "internal",
              "score_definition_revision_missing",
              "A score definition is missing its current revision.",
            );
          return scoreDefinitionResponse(definition, revision);
        }),
      );
      return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }
  }
}
