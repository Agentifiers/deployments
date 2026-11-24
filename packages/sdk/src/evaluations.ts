import type {
  AddDatasetCaseRequest,
  AnnotationResponse,
  CreateAnnotationRequest,
  CreateEvaluationRunRequest,
  CreateRegressionDatasetRequest,
  CreateReleaseComparisonRequest,
  CreateScoreDefinitionRequest,
  DatasetCaseResponse,
  EvaluationCaseResultResponse,
  EvaluationRunResponse,
  ImportDatasetCasesRequest,
  ImportDatasetCasesResponse,
  RecordScoreResultRequest,
  RegressionDatasetResponse,
  ReleaseComparisonResponse,
  ReviseScoreDefinitionRequest,
  ScoreDefinitionResponse,
  ScoreResultResponse,
} from "@deployments-ai/api-contract";
import type { PlatformContext, PlatformResponse, PlatformSdk } from "./index.ts";
import { validatedIdempotencyKey } from "./runtime-sdk-client.ts";
import { segment } from "./validated-path-segment.ts";

export interface EvaluationsContext extends PlatformContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export interface EvaluationMutationOptions {
  /** Defaults to a generated UUID; reuse a key to retry the same mutation safely. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface EvaluationPageOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface EvaluationStatusPageOptions extends EvaluationPageOptions {
  readonly status?: "active" | "archived";
}

export interface ScoreResultListOptions extends EvaluationPageOptions {
  readonly scoreDefinitionId?: string;
}

export interface EvaluationRunListOptions extends EvaluationPageOptions {
  /** Only dataset replays whose target is this agent release. */
  readonly agentReleaseId?: string;
  readonly datasetId?: string;
  readonly status?: EvaluationRunResponse["status"];
}

export interface ReleaseComparisonListOptions extends EvaluationPageOptions {
  readonly baselineReleaseId?: string;
  readonly candidateReleaseId?: string;
  readonly status?: ReleaseComparisonResponse["status"];
}

export interface EvaluationPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
}

export interface AddDatasetCaseResult {
  readonly case: DatasetCaseResponse;
  readonly created: boolean;
}

export interface EvaluationWaitOptions {
  /** Maximum total wait; defaults to 10 minutes. */
  readonly timeoutMs?: number;
  /** Delay between polls; defaults to 2 seconds. */
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

export class EvaluationWaitTimeoutError extends Error {
  constructor(
    readonly resource: "evaluation run" | "release comparison",
    readonly resourceId: string,
    readonly lastStatus: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Timed out after ${timeoutMs}ms waiting for ${resource} ${resourceId} to finish (last status: ${lastStatus}).`,
    );
    this.name = "EvaluationWaitTimeoutError";
  }
}

type Response<T> = Promise<PlatformResponse<T>>;

export interface EvaluationsSdk {
  readonly createScoreDefinition: (
    input: CreateScoreDefinitionRequest,
    options?: EvaluationMutationOptions,
  ) => Response<ScoreDefinitionResponse>;
  readonly listScoreDefinitions: (
    options?: EvaluationStatusPageOptions,
  ) => Response<EvaluationPage<ScoreDefinitionResponse>>;
  readonly getScoreDefinition: (scoreDefinitionId: string) => Response<ScoreDefinitionResponse>;
  readonly reviseScoreDefinition: (
    scoreDefinitionId: string,
    input: ReviseScoreDefinitionRequest,
    options?: EvaluationMutationOptions,
  ) => Response<ScoreDefinitionResponse>;
  readonly archiveScoreDefinition: (
    scoreDefinitionId: string,
    options?: EvaluationMutationOptions,
  ) => Response<ScoreDefinitionResponse>;
  readonly listScoreResults: (
    options?: ScoreResultListOptions,
  ) => Response<EvaluationPage<ScoreResultResponse>>;
  readonly listTraceScoreResults: (
    traceId: string,
    options?: EvaluationPageOptions,
  ) => Response<EvaluationPage<ScoreResultResponse>>;
  readonly recordTraceScoreResult: (
    traceId: string,
    input: RecordScoreResultRequest,
    options?: EvaluationMutationOptions,
  ) => Response<ScoreResultResponse>;
  readonly listTraceAnnotations: (
    traceId: string,
    options?: EvaluationPageOptions,
  ) => Response<EvaluationPage<AnnotationResponse>>;
  readonly createTraceAnnotation: (
    traceId: string,
    input: CreateAnnotationRequest,
    options?: EvaluationMutationOptions,
  ) => Response<AnnotationResponse>;
  readonly createRegressionDataset: (
    input: CreateRegressionDatasetRequest,
    options?: EvaluationMutationOptions,
  ) => Response<RegressionDatasetResponse>;
  readonly listRegressionDatasets: (
    options?: EvaluationStatusPageOptions,
  ) => Response<EvaluationPage<RegressionDatasetResponse>>;
  readonly getRegressionDataset: (datasetId: string) => Response<RegressionDatasetResponse>;
  readonly archiveRegressionDataset: (
    datasetId: string,
    options?: EvaluationMutationOptions,
  ) => Response<RegressionDatasetResponse>;
  readonly addDatasetCase: (
    datasetId: string,
    input: AddDatasetCaseRequest,
    options?: EvaluationMutationOptions,
  ) => Response<AddDatasetCaseResult>;
  readonly importDatasetCases: (
    datasetId: string,
    input: ImportDatasetCasesRequest,
    options?: EvaluationMutationOptions,
  ) => Response<ImportDatasetCasesResponse>;
  readonly listDatasetCases: (
    datasetId: string,
    options?: EvaluationPageOptions,
  ) => Response<EvaluationPage<DatasetCaseResponse>>;
  readonly createEvaluationRun: (
    input: CreateEvaluationRunRequest,
    options?: EvaluationMutationOptions,
  ) => Response<EvaluationRunResponse>;
  /** Environment evaluation runs, newest created first. */
  readonly listEvaluationRuns: (
    options?: EvaluationRunListOptions,
  ) => Response<EvaluationPage<EvaluationRunResponse>>;
  readonly getEvaluationRun: (evaluationRunId: string) => Response<EvaluationRunResponse>;
  readonly listEvaluationRunResults: (
    evaluationRunId: string,
    options?: EvaluationPageOptions,
  ) => Response<EvaluationPage<EvaluationCaseResultResponse>>;
  readonly createReleaseComparison: (
    input: CreateReleaseComparisonRequest,
    options?: EvaluationMutationOptions,
  ) => Response<ReleaseComparisonResponse>;
  /** Environment release comparisons, newest created first; items omit `report`. */
  readonly listReleaseComparisons: (
    options?: ReleaseComparisonListOptions,
  ) => Response<EvaluationPage<ReleaseComparisonResponse>>;
  readonly getReleaseComparison: (
    releaseComparisonId: string,
  ) => Response<ReleaseComparisonResponse>;
  /** Polls the run until it is completed, failed, or canceled. */
  readonly waitForEvaluationRun: (
    evaluationRunId: string,
    options?: EvaluationWaitOptions,
  ) => Response<EvaluationRunResponse>;
  /** Polls the comparison until it is completed or failed. */
  readonly waitForReleaseComparison: (
    releaseComparisonId: string,
    options?: EvaluationWaitOptions,
  ) => Response<ReleaseComparisonResponse>;
}

const TERMINAL_STATUSES: Readonly<Record<string, true>> = {
  canceled: true,
  completed: true,
  failed: true,
};
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WAIT_INTERVAL_MS = 2_000;

function positiveDuration(value: number | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds.`);
  }
  return value;
}

function delay(milliseconds: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForTerminal<T extends { readonly status: string }>(
  resource: EvaluationWaitTimeoutError["resource"],
  resourceId: string,
  load: () => Response<T>,
  options: EvaluationWaitOptions = {},
): Response<T> {
  const timeoutMs = positiveDuration(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, "timeoutMs");
  const intervalMs = positiveDuration(options.intervalMs, DEFAULT_WAIT_INTERVAL_MS, "intervalMs");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await load();
    if (TERMINAL_STATUSES[response.data.status]) return response;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new EvaluationWaitTimeoutError(resource, resourceId, response.data.status, timeoutMs);
    }
    await delay(Math.min(intervalMs, remaining), options.signal);
  }
}

export function createEvaluationsSdk(
  sdk: PlatformSdk,
  context: EvaluationsContext,
): EvaluationsSdk {
  const get = <T>(
    path: string,
    query?: EvaluationPageOptions & {
      readonly agentReleaseId?: string;
      readonly baselineReleaseId?: string;
      readonly candidateReleaseId?: string;
      readonly datasetId?: string;
      readonly scoreDefinitionId?: string;
      readonly status?: string;
    },
  ) =>
    sdk.request<T>({
      context,
      method: "GET",
      path,
      ...(query
        ? {
            query: {
              agentReleaseId: query.agentReleaseId,
              baselineReleaseId: query.baselineReleaseId,
              candidateReleaseId: query.candidateReleaseId,
              cursor: query.cursor,
              datasetId: query.datasetId,
              limit: query.limit,
              scoreDefinitionId: query.scoreDefinitionId,
              status: query.status,
            },
          }
        : {}),
    });
  const post = <T>(
    path: string,
    body: unknown,
    options: EvaluationMutationOptions | undefined,
    label: string,
  ) =>
    sdk.request<T>({
      ...(body === undefined ? {} : { body }),
      context,
      idempotencyKey:
        options?.idempotencyKey === undefined
          ? globalThis.crypto.randomUUID()
          : validatedIdempotencyKey(options.idempotencyKey, label),
      method: "POST",
      path,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  const scoreDefinition = (id: string) =>
    `/v1/score-definitions/${segment(id, "scoreDefinitionId")}`;
  const trace = (id: string) => `/v1/traces/${segment(id, "traceId")}`;
  const dataset = (id: string) => `/v1/regression-datasets/${segment(id, "datasetId")}`;
  const run = (id: string) => `/v1/evaluation-runs/${segment(id, "evaluationRunId")}`;
  const comparison = (id: string) =>
    `/v1/release-comparisons/${segment(id, "releaseComparisonId")}`;

  const evaluations: EvaluationsSdk = {
    createScoreDefinition: (input, options) =>
      post("/v1/score-definitions", input, options, "createScoreDefinition"),
    listScoreDefinitions: (options = {}) => get("/v1/score-definitions", options),
    getScoreDefinition: (id) => get(scoreDefinition(id)),
    reviseScoreDefinition: (id, input, options) =>
      post(`${scoreDefinition(id)}/revisions`, input, options, "reviseScoreDefinition"),
    archiveScoreDefinition: (id, options) =>
      post(`${scoreDefinition(id)}/archive`, undefined, options, "archiveScoreDefinition"),
    listScoreResults: (options = {}) => get("/v1/score-results", options),
    listTraceScoreResults: (traceId, options = {}) =>
      get(`${trace(traceId)}/score-results`, options),
    recordTraceScoreResult: (traceId, input, options) =>
      post(`${trace(traceId)}/score-results`, input, options, "recordTraceScoreResult"),
    listTraceAnnotations: (traceId, options = {}) => get(`${trace(traceId)}/annotations`, options),
    createTraceAnnotation: (traceId, input, options) =>
      post(`${trace(traceId)}/annotations`, input, options, "createTraceAnnotation"),
    createRegressionDataset: (input, options) =>
      post("/v1/regression-datasets", input, options, "createRegressionDataset"),
    listRegressionDatasets: (options = {}) => get("/v1/regression-datasets", options),
    getRegressionDataset: (id) => get(dataset(id)),
    archiveRegressionDataset: (id, options) =>
      post(`${dataset(id)}/archive`, undefined, options, "archiveRegressionDataset"),
    addDatasetCase: (id, input, options) =>
      post(`${dataset(id)}/cases`, input, options, "addDatasetCase"),
    importDatasetCases: (id, input, options) =>
      post(`${dataset(id)}/cases/import`, input, options, "importDatasetCases"),
    listDatasetCases: (id, options = {}) => get(`${dataset(id)}/cases`, options),
    createEvaluationRun: (input, options) =>
      post("/v1/evaluation-runs", input, options, "createEvaluationRun"),
    listEvaluationRuns: (options = {}) => get("/v1/evaluation-runs", options),
    getEvaluationRun: (id) => get(run(id)),
    listEvaluationRunResults: (id, options = {}) => get(`${run(id)}/results`, options),
    createReleaseComparison: (input, options) =>
      post("/v1/release-comparisons", input, options, "createReleaseComparison"),
    listReleaseComparisons: (options = {}) => get("/v1/release-comparisons", options),
    getReleaseComparison: (id) => get(comparison(id)),
    waitForEvaluationRun: (id, options) =>
      waitForTerminal("evaluation run", id, () => evaluations.getEvaluationRun(id), options),
    waitForReleaseComparison: (id, options) =>
      waitForTerminal(
        "release comparison",
        id,
        () => evaluations.getReleaseComparison(id),
        options,
      ),
  };
  return evaluations;
}
