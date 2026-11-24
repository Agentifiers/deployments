import type {
  PublicApiPathParameter,
  PublicApiQueryParameter,
  PublicApiRouteContract,
} from "./route-contract.ts";

type EvaluationRouteInput = Omit<
  PublicApiRouteContract,
  "authentication" | "errors" | "idempotency" | "requiredAuthorization" | "scopeHeaders" | "tag"
>;

const readErrors = [400, 401, 403, 404, 422, 429, 500, 503] as const;
const mutationErrors = [400, 401, 403, 404, 409, 413, 422, 429, 500, 503] as const;

function evaluationRoute<const Contract extends EvaluationRouteInput>(
  contract: Contract,
): PublicApiRouteContract & Contract {
  const read = contract.method === "GET";
  return {
    authentication: "platform-bearer",
    errors: read ? readErrors : mutationErrors,
    idempotency: read ? "none" : "required",
    requiredAuthorization: read ? "observability:read" : "observability:write",
    scopeHeaders: "tenant",
    tag: "Evaluations",
    ...contract,
  };
}

const publicIdParameter = (name: string, description: string): PublicApiPathParameter => ({
  description,
  name,
  schema: { pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$", type: "string" },
});
const traceIdParameter: PublicApiPathParameter = {
  description: "W3C trace ID (32 lowercase hex characters).",
  name: "traceId",
  schema: { pattern: "^[a-f0-9]{32}$", type: "string" },
};
const scoreDefinitionIdParameter = publicIdParameter("scoreDefinitionId", "Score definition ID.");
const datasetIdParameter = publicIdParameter("datasetId", "Regression dataset ID.");
const pageParameters = [
  { name: "cursor", schema: { maxLength: 8_192, minLength: 1, type: "string" } },
  { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
] as const satisfies readonly PublicApiQueryParameter[];
const statusParameter = {
  name: "status",
  schema: { enum: ["active", "archived"], type: "string" },
} as const satisfies PublicApiQueryParameter;
const publicIdQueryParameter = (name: string, description: string): PublicApiQueryParameter => ({
  description,
  name,
  schema: { pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$", type: "string" },
});

export const EVALUATION_API_ROUTES = [
  evaluationRoute({
    method: "POST",
    name: "createScoreDefinition",
    path: "/v1/score-definitions",
    requestBody: "CreateScoreDefinitionRequest",
    requestBodyRequired: true,
    responseBody: "ScoreDefinitionResponse",
    successStatus: 201,
  }),
  evaluationRoute({
    method: "GET",
    name: "listScoreDefinitions",
    path: "/v1/score-definitions",
    queryParameters: [...pageParameters, statusParameter],
    responseBody: "ListScoreDefinitionsResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "GET",
    name: "getScoreDefinition",
    path: "/v1/score-definitions/:scoreDefinitionId",
    pathParameters: [scoreDefinitionIdParameter],
    responseBody: "ScoreDefinitionResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "POST",
    name: "reviseScoreDefinition",
    path: "/v1/score-definitions/:scoreDefinitionId/revisions",
    pathParameters: [scoreDefinitionIdParameter],
    requestBody: "ReviseScoreDefinitionRequest",
    requestBodyRequired: true,
    responseBody: "ScoreDefinitionResponse",
    successStatus: 201,
  }),
  evaluationRoute({
    method: "POST",
    name: "archiveScoreDefinition",
    path: "/v1/score-definitions/:scoreDefinitionId/archive",
    pathParameters: [scoreDefinitionIdParameter],
    responseBody: "ScoreDefinitionResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "GET",
    name: "listScoreResults",
    path: "/v1/score-results",
    queryParameters: [
      ...pageParameters,
      {
        description: "Only results for this score definition, newest first.",
        name: "scoreDefinitionId",
        schema: { pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$", type: "string" },
      },
    ],
    responseBody: "ListScoreResultsResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "GET",
    name: "listTraceScoreResults",
    path: "/v1/traces/:traceId/score-results",
    pathParameters: [traceIdParameter],
    queryParameters: pageParameters,
    responseBody: "ListScoreResultsResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "POST",
    name: "recordTraceScoreResult",
    path: "/v1/traces/:traceId/score-results",
    pathParameters: [traceIdParameter],
    requestBody: "RecordScoreResultRequest",
    requestBodyRequired: true,
    responseBody: "ScoreResultResponse",
    successStatus: 201,
  }),
  evaluationRoute({
    method: "GET",
    name: "listTraceAnnotations",
    path: "/v1/traces/:traceId/annotations",
    pathParameters: [traceIdParameter],
    queryParameters: pageParameters,
    responseBody: "ListAnnotationsResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "POST",
    name: "createTraceAnnotation",
    path: "/v1/traces/:traceId/annotations",
    pathParameters: [traceIdParameter],
    requestBody: "CreateAnnotationRequest",
    requestBodyRequired: true,
    responseBody: "AnnotationResponse",
    successStatus: 201,
  }),
  evaluationRoute({
    method: "POST",
    name: "createRegressionDataset",
    path: "/v1/regression-datasets",
    requestBody: "CreateRegressionDatasetRequest",
    requestBodyRequired: true,
    responseBody: "RegressionDatasetResponse",
    successStatus: 201,
  }),
  evaluationRoute({
    method: "GET",
    name: "listRegressionDatasets",
    path: "/v1/regression-datasets",
    queryParameters: [...pageParameters, statusParameter],
    responseBody: "ListRegressionDatasetsResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "GET",
    name: "getRegressionDataset",
    path: "/v1/regression-datasets/:datasetId",
    pathParameters: [datasetIdParameter],
    responseBody: "RegressionDatasetResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "POST",
    name: "archiveRegressionDataset",
    path: "/v1/regression-datasets/:datasetId/archive",
    pathParameters: [datasetIdParameter],
    responseBody: "RegressionDatasetResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "POST",
    name: "addDatasetCase",
    path: "/v1/regression-datasets/:datasetId/cases",
    pathParameters: [datasetIdParameter],
    requestBody: "AddDatasetCaseRequest",
    requestBodyRequired: true,
    responseBody: "AddDatasetCaseResponse",
    successStatus: 201,
  }),
  evaluationRoute({
    method: "POST",
    name: "importDatasetCases",
    path: "/v1/regression-datasets/:datasetId/cases/import",
    pathParameters: [datasetIdParameter],
    requestBody: "ImportDatasetCasesRequest",
    requestBodyRequired: true,
    responseBody: "ImportDatasetCasesResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "GET",
    name: "listDatasetCases",
    path: "/v1/regression-datasets/:datasetId/cases",
    pathParameters: [datasetIdParameter],
    queryParameters: pageParameters,
    responseBody: "ListDatasetCasesResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "POST",
    name: "createEvaluationRun",
    path: "/v1/evaluation-runs",
    requestBody: "CreateEvaluationRunRequest",
    requestBodyRequired: true,
    responseBody: "EvaluationRunResponse",
    successStatus: 202,
  }),
  evaluationRoute({
    method: "GET",
    name: "listEvaluationRuns",
    path: "/v1/evaluation-runs",
    queryParameters: [
      ...pageParameters,
      {
        description: "Only runs in this status.",
        name: "status",
        schema: {
          enum: ["canceled", "completed", "failed", "queued", "running"],
          type: "string",
        },
      },
      publicIdQueryParameter(
        "agentReleaseId",
        "Only dataset replays whose target is this agent release.",
      ),
      publicIdQueryParameter("datasetId", "Only dataset replays of this regression dataset."),
    ],
    responseBody: "ListEvaluationRunsResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "GET",
    name: "getEvaluationRun",
    path: "/v1/evaluation-runs/:evaluationRunId",
    pathParameters: [publicIdParameter("evaluationRunId", "Evaluation run ID.")],
    responseBody: "EvaluationRunResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "GET",
    name: "listEvaluationRunResults",
    path: "/v1/evaluation-runs/:evaluationRunId/results",
    pathParameters: [publicIdParameter("evaluationRunId", "Evaluation run ID.")],
    queryParameters: pageParameters,
    responseBody: "ListEvaluationRunResultsResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "POST",
    name: "createReleaseComparison",
    path: "/v1/release-comparisons",
    requestBody: "CreateReleaseComparisonRequest",
    requestBodyRequired: true,
    responseBody: "ReleaseComparisonResponse",
    successStatus: 202,
  }),
  evaluationRoute({
    method: "GET",
    name: "listReleaseComparisons",
    path: "/v1/release-comparisons",
    queryParameters: [
      ...pageParameters,
      {
        description: "Only comparisons in this status.",
        name: "status",
        schema: { enum: ["completed", "failed", "queued", "running"], type: "string" },
      },
      publicIdQueryParameter("baselineReleaseId", "Only comparisons with this baseline release."),
      publicIdQueryParameter("candidateReleaseId", "Only comparisons with this candidate release."),
    ],
    responseBody: "ListReleaseComparisonsResponse",
    successStatus: 200,
  }),
  evaluationRoute({
    method: "GET",
    name: "getReleaseComparison",
    path: "/v1/release-comparisons/:releaseComparisonId",
    pathParameters: [publicIdParameter("releaseComparisonId", "Release comparison ID.")],
    responseBody: "ReleaseComparisonResponse",
    successStatus: 200,
  }),
] as const satisfies readonly PublicApiRouteContract[];

export type EvaluationApiRouteName = (typeof EVALUATION_API_ROUTES)[number]["name"];
