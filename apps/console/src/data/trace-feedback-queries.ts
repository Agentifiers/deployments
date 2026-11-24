import type {
  CreateAnnotationRequest,
  RecordScoreResultRequest,
} from "@deployments-ai/api-contract";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import { decodeRequestBody } from "../server/request-body.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  createTraceAnnotation,
  loadScoreDefinitionDirectory,
  loadTraceAnnotations,
  loadTraceScores,
  recordTraceScore,
} from "../server/trace-feedback-data.ts";
import {
  fields,
  keyedInput,
  requireBody,
  requireIds,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

/** The evaluation routes' W3C trace ID rule. */
const TRACE_ID = /^[a-f0-9]{32}$/u;
/** Score definitions change rarely; one read names every trace's scores for a while. */
const DEFINITIONS_STALE_MS = 5 * 60_000;

function requireTraceId(input: unknown): string {
  const { traceId } = fields(input);
  if (typeof traceId !== "string" || !TRACE_ID.test(traceId)) {
    throw new TypeError("traceId must be 32 lowercase hex characters.");
  }
  return traceId;
}

interface TraceInput extends ScopedInput {
  readonly traceId: string;
}

interface TraceMutationInput<Body> extends KeyedInput, TraceInput {
  readonly body: Body;
}

const fetchTraceScores = createServerFn({ method: "GET" })
  .validator((input: TraceInput) => ({ ...scopedInput(input), traceId: requireTraceId(input) }))
  .handler(async ({ data }) =>
    loadTraceScores(await requireAccessToken(), data.scope, data.traceId),
  );

const fetchTraceAnnotations = createServerFn({ method: "GET" })
  .validator((input: TraceInput) => ({ ...scopedInput(input), traceId: requireTraceId(input) }))
  .handler(async ({ data }) =>
    loadTraceAnnotations(await requireAccessToken(), data.scope, data.traceId),
  );

const fetchScoreDefinitions = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadScoreDefinitionDirectory(await requireAccessToken(), data));

export const recordTraceScoreFn = createServerFn({ method: "POST" })
  .validator((input: TraceMutationInput<(typeof RecordScoreResultRequest)["Encoded"]>) => ({
    ...keyedInput(input),
    body: requireBody(input),
    traceId: requireTraceId(input),
  }))
  .handler(async ({ data }) =>
    recordTraceScore(
      await requireAccessToken(),
      data.scope,
      data.traceId,
      decodeRequestBody("recordTraceScoreResult", "RecordScoreResultRequest", data.body),
      data.idempotencyKey,
    ),
  );

export const createTraceAnnotationFn = createServerFn({ method: "POST" })
  .validator((input: TraceMutationInput<(typeof CreateAnnotationRequest)["Encoded"]>) => ({
    ...keyedInput(input),
    body: requireBody(input),
    traceId: requireTraceId(input),
  }))
  .handler(async ({ data }) =>
    createTraceAnnotation(
      await requireAccessToken(),
      data.scope,
      data.traceId,
      decodeRequestBody("createTraceAnnotation", "CreateAnnotationRequest", data.body),
      data.idempotencyKey,
    ),
  );

/** Query-key prefix of one trace's scores and annotations. */
const traceFeedbackKey = (scope: EnvironmentScope, traceId: string) =>
  ["trace-feedback", ...scopeKey(scope), traceId] as const;

export const traceScoresQuery = (scope: EnvironmentScope, traceId: string) =>
  queryOptions({
    queryFn: () => fetchTraceScores({ data: { scope, traceId } }),
    queryKey: [...traceFeedbackKey(scope, traceId), "scores"],
  });

export const traceAnnotationsQuery = (scope: EnvironmentScope, traceId: string) =>
  queryOptions({
    queryFn: () => fetchTraceAnnotations({ data: { scope, traceId } }),
    queryKey: [...traceFeedbackKey(scope, traceId), "annotations"],
  });

/** Score definitions for naming results and choosing what to record. */
export const scoreDefinitionDirectoryQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchScoreDefinitions({ data: scope }),
    queryKey: ["score-definition-directory", ...scopeKey(scope)],
    staleTime: DEFINITIONS_STALE_MS,
  });

/** After annotating or scoring a trace: refetch its scores and annotations. */
export function invalidateTraceFeedback(
  queryClient: QueryClient,
  scope: EnvironmentScope,
  traceId: string,
) {
  return queryClient.invalidateQueries({ queryKey: traceFeedbackKey(scope, traceId) });
}
