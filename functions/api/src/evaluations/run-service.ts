import type { CreateEvaluationRunRequest } from "@deployments-ai/api-contract";
import {
  PersistenceError,
  type EvaluationRunData,
  type EvaluationRunRecord,
  type EvaluationTarget,
} from "@deployments-ai/db";
import { failure } from "../persistence-failure.ts";
import { deterministicEvaluationId } from "./deterministic-ids.ts";
import { evaluationCaseResultResponse, evaluationRunResponse } from "./responses.ts";
import {
  DEFAULT_CASE_TIMEOUT_SECONDS,
  DEFAULT_EVALUATION_CONCURRENCY,
  emptyCounts,
  frozenScoreDefinitions,
  requireAgentDeployment,
  requireAgentRelease,
  requireReplayDataset,
  sendRunStart,
} from "./run-inputs.ts";
import {
  evaluationEvent,
  pageOptions,
  requiredIdempotencyKey,
  requiredParam,
  requiredQueue,
  statusFilter,
  ulid,
  type EvaluationRequestContext,
} from "./service-support.ts";

type DatasetReplayRequest = Extract<
  CreateEvaluationRunRequest,
  { readonly kind: "dataset-replay" }
>;
type TraceScoreRequest = Extract<CreateEvaluationRunRequest, { readonly kind: "trace-score" }>;

async function datasetReplayFields(context: EvaluationRequestContext, body: DatasetReplayRequest) {
  const dataset = await requireReplayDataset(context, body.datasetId);
  let target: EvaluationTarget;
  let runtimeConfigFromAgentDeploymentId: string | undefined;
  if (body.target.type === "release") {
    const release = await requireAgentRelease(context, body.target.agentReleaseId);
    target = { agentReleaseId: release.data.id, type: "release" };
    if (body.target.runtimeConfigFromAgentDeploymentId !== undefined) {
      const deployment = await requireAgentDeployment(
        context,
        body.target.runtimeConfigFromAgentDeploymentId,
      );
      runtimeConfigFromAgentDeploymentId = deployment.data.id;
    }
  } else {
    const deployment = await requireAgentDeployment(context, body.target.agentDeploymentId);
    target = {
      agentDeploymentId: deployment.data.id,
      agentReleaseId: deployment.data.agentReleaseId,
      type: "deployment",
    };
  }
  return {
    caseCount: dataset.data.caseCount,
    caseTimeoutSeconds: body.caseTimeoutSeconds ?? DEFAULT_CASE_TIMEOUT_SECONDS,
    concurrency: body.concurrency ?? DEFAULT_EVALUATION_CONCURRENCY,
    datasetId: dataset.data.id,
    ...(runtimeConfigFromAgentDeploymentId === undefined
      ? {}
      : { runtimeConfigFromAgentDeploymentId: ulid(runtimeConfigFromAgentDeploymentId) }),
    target,
  };
}

async function traceScoreFields(context: EvaluationRequestContext, body: TraceScoreRequest) {
  const traceIds = [...new Set(body.traceIds)];
  for (const traceId of traceIds) {
    const trace =
      (await context.persistence.getTrace(traceId)) ??
      failure("not-found", "trace_not_found", `Trace ${traceId} not found.`);
    if (trace.data.status !== "finalized") {
      failure("conflict", "trace_not_finalized", `Trace ${traceId} is not finalized yet.`);
    }
  }
  return {
    caseCount: traceIds.length,
    caseTimeoutSeconds: DEFAULT_CASE_TIMEOUT_SECONDS,
    concurrency: DEFAULT_EVALUATION_CONCURRENCY,
    traceIds,
  };
}

/**
 * Creates the run for this Idempotency-Key, or returns the one it already created, and
 * (re)sends its start message. The run ID is derived from the caller and key.
 */
async function createEvaluationRun(context: EvaluationRequestContext) {
  const queue = requiredQueue(context);
  const body = context.invocation.body as CreateEvaluationRunRequest;
  const { environmentId, organizationId, projectId } = context.scope;
  const id = deterministicEvaluationId(
    organizationId,
    projectId,
    environmentId,
    context.principalId,
    "evaluation-run",
    requiredIdempotencyKey(context),
  );
  let run: EvaluationRunRecord | undefined = await context.persistence.getEvaluationRun(id);
  if (!run) {
    const fields =
      body.kind === "dataset-replay"
        ? await datasetReplayFields(context, body)
        : await traceScoreFields(context, body);
    const data: EvaluationRunData = {
      ...fields,
      counts: emptyCounts(fields.caseCount),
      createdAt: context.timestamp,
      createdByPrincipalId: context.principalId,
      environmentId,
      id,
      idempotencyKey: requiredIdempotencyKey(context),
      kind: body.kind,
      organizationId,
      projectId,
      scoreDefinitions: await frozenScoreDefinitions(context, body.scoreDefinitionIds),
      status: "queued",
      updatedAt: context.timestamp,
      version: 1,
    };
    run = await createOrReuseRun(context, data);
  }
  await sendRunStart(context, queue, run.data.id);
  return evaluationRunResponse(run);
}

async function createOrReuseRun(context: EvaluationRequestContext, data: EvaluationRunData) {
  try {
    return await context.persistence.createEvaluationRun(
      data,
      await evaluationEvent(context, "evaluation-run.created", {
        evaluationRunId: data.id,
        kind: data.kind,
        status: data.status,
      }),
    );
  } catch (cause) {
    const raced =
      cause instanceof PersistenceError && cause.kind === "conflict"
        ? await context.persistence.getEvaluationRun(data.id)
        : undefined;
    if (raced) return raced;
    throw cause;
  }
}

async function requireEvaluationRun(context: EvaluationRequestContext) {
  return (
    (await context.persistence.getEvaluationRun(requiredParam(context, "evaluationRunId"))) ??
    failure("not-found", "evaluation_run_not_found", "Evaluation run not found.")
  );
}

export async function invokeEvaluationRunRoute(
  routeName:
    | "createEvaluationRun"
    | "getEvaluationRun"
    | "listEvaluationRunResults"
    | "listEvaluationRuns",
  context: EvaluationRequestContext,
) {
  switch (routeName) {
    case "createEvaluationRun":
      return createEvaluationRun(context);
    case "getEvaluationRun":
      return evaluationRunResponse(await requireEvaluationRun(context));
    case "listEvaluationRuns": {
      const { agentReleaseId, datasetId } = context.invocation.query;
      const page = await context.persistence.listEvaluationRuns({
        ...pageOptions(context),
        ...statusFilter<EvaluationRunData["status"]>(context),
        agentReleaseId,
        datasetId,
      });
      return {
        items: page.items.map(evaluationRunResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
    case "listEvaluationRunResults": {
      const run = await requireEvaluationRun(context);
      const page = await context.persistence.listCaseRuns(run.data.id, pageOptions(context));
      return {
        items: page.items.map(evaluationCaseResultResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
  }
}
