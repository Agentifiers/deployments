import type { CreateReleaseComparisonRequest } from "@deployments-ai/api-contract";
import {
  PersistenceError,
  type EvaluationRunData,
  type ReleaseComparisonData,
  type ReleaseComparisonRecord,
  type Ulid,
} from "@deployments-ai/db";
import { DEFAULT_COMPARISON_GATE_POLICY } from "@deployments-ai/observability/evaluators";
import { failure } from "../persistence-failure.ts";
import { deterministicEvaluationId } from "./deterministic-ids.ts";
import { releaseComparisonResponse } from "./responses.ts";
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
  type EvaluationRequestContext,
} from "./service-support.ts";

type ComparisonRole = "baseline" | "candidate";

async function newComparison(
  context: EvaluationRequestContext,
  id: Ulid,
  runIds: Readonly<Record<ComparisonRole, Ulid>>,
) {
  const body = context.invocation.body as CreateReleaseComparisonRequest;
  const idempotencyKey = requiredIdempotencyKey(context);
  const dataset = await requireReplayDataset(context, body.datasetId);
  const baselineRelease = await requireAgentRelease(context, body.baselineReleaseId);
  const candidateRelease = await requireAgentRelease(context, body.candidateReleaseId);
  const runtimeDeployment =
    body.runtimeConfigFromAgentDeploymentId === undefined
      ? undefined
      : await requireAgentDeployment(context, body.runtimeConfigFromAgentDeploymentId);
  const scoreDefinitions = await frozenScoreDefinitions(context, body.scoreDefinitionIds);
  const requestedPolicy = Object.fromEntries(
    Object.entries(body.gatePolicy ?? {}).filter(([, value]) => value !== undefined),
  );
  const common = {
    createdAt: context.timestamp,
    createdByPrincipalId: context.principalId,
    environmentId: context.scope.environmentId,
    organizationId: context.scope.organizationId,
    projectId: context.scope.projectId,
    ...(runtimeDeployment ? { runtimeConfigFromAgentDeploymentId: runtimeDeployment.data.id } : {}),
    scoreDefinitions,
    status: "queued" as const,
    updatedAt: context.timestamp,
    version: 1,
  };
  const run = (role: ComparisonRole, agentReleaseId: Ulid): EvaluationRunData => ({
    ...common,
    caseCount: dataset.data.caseCount,
    caseTimeoutSeconds: body.caseTimeoutSeconds ?? DEFAULT_CASE_TIMEOUT_SECONDS,
    comparison: { releaseComparisonId: id, role },
    concurrency: body.concurrency ?? DEFAULT_EVALUATION_CONCURRENCY,
    counts: emptyCounts(dataset.data.caseCount),
    datasetId: dataset.data.id,
    id: runIds[role],
    idempotencyKey: `${idempotencyKey}#${role}`,
    kind: "dataset-replay",
    target: { agentReleaseId, type: "release" },
  });
  const comparison: ReleaseComparisonData = {
    ...common,
    baseline: {
      agentReleaseId: baselineRelease.data.id,
      evaluationRunId: runIds.baseline,
      releaseContentHash: baselineRelease.data.contentHash,
    },
    candidate: {
      agentReleaseId: candidateRelease.data.id,
      evaluationRunId: runIds.candidate,
      releaseContentHash: candidateRelease.data.contentHash,
    },
    datasetId: dataset.data.id,
    gateMode: "advisory",
    gatePolicy: { ...DEFAULT_COMPARISON_GATE_POLICY, ...requestedPolicy },
    id,
    idempotencyKey,
    reasons: [],
  };
  return {
    baseline: run("baseline", baselineRelease.data.id),
    candidate: run("candidate", candidateRelease.data.id),
    comparison,
  };
}

/**
 * Creates the comparison and both replay runs for this Idempotency-Key (or reuses the ones
 * it already created) and (re)sends both start messages.
 */
async function createReleaseComparison(context: EvaluationRequestContext) {
  const queue = requiredQueue(context);
  const { environmentId, organizationId, projectId } = context.scope;
  const id = deterministicEvaluationId(
    organizationId,
    projectId,
    environmentId,
    context.principalId,
    "release-comparison",
    requiredIdempotencyKey(context),
  );
  let comparison: ReleaseComparisonRecord | undefined =
    await context.persistence.getReleaseComparison(id);
  if (!comparison) {
    const input = await newComparison(context, id, {
      baseline: deterministicEvaluationId(id, "baseline"),
      candidate: deterministicEvaluationId(id, "candidate"),
    });
    try {
      comparison = (
        await context.persistence.createReleaseComparison(input, {
          baseline: await evaluationEvent(context, "evaluation-run.created", {
            evaluationRunId: input.baseline.id,
            kind: input.baseline.kind,
            releaseComparisonId: id,
            status: input.baseline.status,
          }),
          candidate: await evaluationEvent(context, "evaluation-run.created", {
            evaluationRunId: input.candidate.id,
            kind: input.candidate.kind,
            releaseComparisonId: id,
            status: input.candidate.status,
          }),
          comparison: await evaluationEvent(context, "release-comparison.created", {
            baselineEvaluationRunId: input.baseline.id,
            candidateEvaluationRunId: input.candidate.id,
            releaseComparisonId: id,
            status: "queued",
          }),
        })
      ).comparison;
    } catch (cause) {
      comparison =
        cause instanceof PersistenceError && cause.kind === "conflict"
          ? await context.persistence.getReleaseComparison(id)
          : undefined;
      if (!comparison) throw cause;
    }
  }
  await sendRunStart(context, queue, comparison.data.baseline.evaluationRunId);
  await sendRunStart(context, queue, comparison.data.candidate.evaluationRunId);
  return releaseComparisonResponse(comparison);
}

async function getReleaseComparison(context: EvaluationRequestContext) {
  const comparison =
    (await context.persistence.getReleaseComparison(
      requiredParam(context, "releaseComparisonId"),
    )) ?? failure("not-found", "release_comparison_not_found", "Release comparison not found.");
  const { reportJson, reportMarkdown, status } = comparison.data;
  if (status !== "completed" || !reportJson || !reportMarkdown) {
    return releaseComparisonResponse(comparison);
  }
  const [json, markdown] = await Promise.all([
    context.dependencies.artifacts.createDownloadUrl(reportJson),
    context.dependencies.artifacts.createDownloadUrl(reportMarkdown),
  ]);
  return releaseComparisonResponse(comparison, { json, markdown });
}

async function listReleaseComparisons(context: EvaluationRequestContext) {
  const { baselineReleaseId, candidateReleaseId } = context.invocation.query;
  const page = await context.persistence.listReleaseComparisons({
    ...pageOptions(context),
    ...statusFilter<ReleaseComparisonData["status"]>(context),
    baselineReleaseId,
    candidateReleaseId,
  });
  // Report download URLs are presigned per read; list items omit them.
  return {
    items: page.items.map((comparison) => releaseComparisonResponse(comparison)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function invokeReleaseComparisonRoute(
  routeName: "createReleaseComparison" | "getReleaseComparison" | "listReleaseComparisons",
  context: EvaluationRequestContext,
) {
  switch (routeName) {
    case "createReleaseComparison":
      return createReleaseComparison(context);
    case "getReleaseComparison":
      return getReleaseComparison(context);
    case "listReleaseComparisons":
      return listReleaseComparisons(context);
  }
}
