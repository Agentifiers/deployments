import type {
  CreateAnnotationRequest,
  RecordScoreResultRequest,
} from "@deployments-ai/api-contract";
import type { ScoreResultData } from "@deployments-ai/db";
import { scorePassed } from "@deployments-ai/observability/evaluators";
import { failure } from "../persistence-failure.ts";
import { requireScoreDefinition } from "./definition-service.ts";
import { annotationResponse, scoreResultResponse } from "./responses.ts";
import {
  pageOptions,
  requiredIdempotencyKey,
  requiredParam,
  type EvaluationRequestContext,
} from "./service-support.ts";

async function requireTrace(context: EvaluationRequestContext, traceId: string) {
  return (
    (await context.persistence.getTrace(traceId)) ??
    failure("not-found", "trace_not_found", "Trace not found.")
  );
}

async function requireRunInTrace(
  context: EvaluationRequestContext,
  runId: string | undefined,
  runIds: readonly string[],
) {
  if (runId === undefined) return undefined;
  if (!runIds.includes(runId)) {
    failure("unprocessable", "run_not_in_trace", "The run does not belong to this trace.");
  }
  return (
    (await context.persistence.locateRun(runId)) ??
    failure("unprocessable", "run_not_in_trace", "The run does not belong to this trace.")
  );
}

async function recordTraceScoreResult(context: EvaluationRequestContext) {
  const body = context.invocation.body as RecordScoreResultRequest;
  const traceId = requiredParam(context, "traceId");
  const { definition, revision } = await requireScoreDefinition(context, body.scoreDefinitionId);
  const { evaluator } = revision.data;
  if (
    definition.data.status !== "active" ||
    (evaluator.kind !== "human" && evaluator.kind !== "imported")
  ) {
    failure(
      "conflict",
      "score_definition_not_recordable",
      "Only active human or imported score definitions accept recorded scores.",
    );
  }
  if (
    evaluator.kind === "human" &&
    evaluator.labels !== undefined &&
    body.label !== undefined &&
    !evaluator.labels.includes(body.label)
  ) {
    failure("unprocessable", "invalid_score_label", "The label is not defined by this score.");
  }
  const trace = await requireTrace(context, traceId);
  const run = await requireRunInTrace(context, body.runId, trace.data.runIds);
  const data: ScoreResultData = {
    createdAt: context.timestamp,
    durationMs: 0,
    environmentId: context.scope.environmentId,
    evaluatorVersionHash: revision.data.evaluatorVersionHash,
    evidenceRefs: [
      { id: traceId, kind: "trace" },
      ...(body.runId === undefined ? [] : [{ id: body.runId, kind: "run" as const }]),
    ],
    executionStatus: "succeeded",
    ...(evaluator.kind === "human" ? { humanActorPrincipalId: context.principalId } : {}),
    id: await context.newId(),
    idempotencyKey: requiredIdempotencyKey(context),
    ...(body.label === undefined ? {} : { label: body.label }),
    organizationId: context.scope.organizationId,
    passed: scorePassed(body.value, revision.data.threshold),
    projectId: context.scope.projectId,
    ...(body.rationale === undefined ? {} : { rationale: body.rationale }),
    revision: revision.data.revision,
    ...(run === undefined ? {} : { runId: run.data.id }),
    scoreDefinitionId: definition.data.id,
    scoreType: definition.data.type,
    source: "api",
    ...(body.spanId === undefined ? {} : { spanId: body.spanId }),
    threadId: run?.data.threadId ?? trace.data.sessionId,
    threshold: revision.data.threshold,
    traceId,
    updatedAt: context.timestamp,
    value: body.value,
    version: 1,
  };
  const { result } = await context.persistence.recordSubmittedScore(data);
  return scoreResultResponse(result);
}

async function createTraceAnnotation(context: EvaluationRequestContext) {
  const body = context.invocation.body as CreateAnnotationRequest;
  const traceId = requiredParam(context, "traceId");
  const trace = await requireTrace(context, traceId);
  const run = await requireRunInTrace(context, body.runId, trace.data.runIds);
  const annotation = await context.persistence.createAnnotation({
    authorPrincipalId: context.principalId,
    body: body.body,
    createdAt: context.timestamp,
    environmentId: context.scope.environmentId,
    id: await context.newId(),
    ...(body.label === undefined ? {} : { label: body.label }),
    organizationId: context.scope.organizationId,
    projectId: context.scope.projectId,
    ...(run === undefined ? {} : { runId: run.data.id }),
    ...(body.spanId === undefined ? {} : { spanId: body.spanId }),
    tags: body.tags ?? [],
    threadId: run?.data.threadId ?? trace.data.sessionId,
    traceId,
  });
  return annotationResponse(annotation);
}

export async function invokeScoreRoute(
  routeName:
    | "createTraceAnnotation"
    | "listScoreResults"
    | "listTraceAnnotations"
    | "listTraceScoreResults"
    | "recordTraceScoreResult",
  context: EvaluationRequestContext,
) {
  switch (routeName) {
    case "recordTraceScoreResult":
      return recordTraceScoreResult(context);
    case "createTraceAnnotation":
      return createTraceAnnotation(context);
    case "listScoreResults": {
      const { scoreDefinitionId } = context.invocation.query;
      const page = await context.persistence.listScoreResults({
        ...pageOptions(context),
        ...(scoreDefinitionId === undefined ? {} : { scoreDefinitionId }),
      });
      return {
        items: page.items.map(scoreResultResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
    case "listTraceScoreResults": {
      const page = await context.persistence.listTraceScoreResults(
        requiredParam(context, "traceId"),
        pageOptions(context),
      );
      return {
        items: page.items.map(scoreResultResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
    case "listTraceAnnotations": {
      const page = await context.persistence.listAnnotations(
        requiredParam(context, "traceId"),
        pageOptions(context),
      );
      return {
        items: page.items.map(annotationResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
  }
}
