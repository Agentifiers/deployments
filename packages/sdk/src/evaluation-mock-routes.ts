import {
  EVALUATION_API_ROUTES,
  type AddDatasetCaseRequest,
  type AnnotationResponse,
  type CreateAnnotationRequest,
  type CreateEvaluationRunRequest,
  type CreateRegressionDatasetRequest,
  type CreateReleaseComparisonRequest,
  type CreateScoreDefinitionRequest,
  type EvaluationApiRouteName,
  type EvaluationCaseResultResponse,
  type EvaluationRunResponse,
  type ImportDatasetCasesRequest,
  type RecordScoreResultRequest,
  type RegressionDatasetResponse,
  type ReleaseComparisonResponse,
  type ReviseScoreDefinitionRequest,
  type ScoreDefinitionResponse,
  type ScoreResultResponse,
} from "@deployments-ai/api-contract";
import type { PublicId } from "@deployments-ai/api-contract/primitives";
import { decodePublicRequest, decodePublicResponse } from "@deployments-ai/api-contract/validation";
import {
  activeDataset,
  addCase,
  createDataset,
  createScoreDefinition,
  definitionRevision,
  type EvaluationMockResult,
  type EvaluationMockState,
  found,
  importCases,
  MOCK_OWNER,
  nextId,
  nextTraceId,
  scoreType,
} from "./evaluation-mock-state.ts";
import { PlatformRequestError, type PlatformRequest } from "./index.ts";
import { canonicalValue, decodeCursor, encodeCursor } from "./tenancy-mock.ts";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type FrozenScoreDefinition = EvaluationRunResponse["scoreDefinitions"][number];

const DEFAULT_GATE_POLICY = {
  maxEvaluatorErrorRate: 0.05,
  maxMeanDecrease: 0.05,
  maxMissingEvidenceRate: 0.05,
  maxNewFailures: 0,
  maxPassRateDecrease: 0.05,
  minComparableCases: 1,
} as const;

function frozenDefinitions(state: EvaluationMockState, ids: readonly string[]) {
  return ids.map((id): FrozenScoreDefinition => {
    const definition = found(state.scoreDefinitions, id, "Score definition");
    return {
      evaluatorVersionHash: definition.revision.evaluatorVersionHash,
      name: definition.name,
      revision: definition.currentRevision,
      scoreDefinitionId: definition.id,
      threshold: definition.revision.threshold,
      type: definition.type,
    };
  });
}

interface RunPlan {
  readonly caseTimeoutSeconds?: number;
  readonly cases: readonly { readonly datasetCaseId?: PublicId; readonly key: string }[];
  readonly comparison?: EvaluationRunResponse["comparison"];
  readonly concurrency?: number;
  readonly datasetId?: PublicId;
  readonly definitions: readonly FrozenScoreDefinition[];
  readonly kind: EvaluationRunResponse["kind"];
  readonly target?: EvaluationRunResponse["target"];
  readonly traceIds?: readonly string[];
}

function completeRun(state: EvaluationMockState, now: string, plan: RunPlan) {
  const id = nextId(state);
  const caseCount = plan.cases.length;
  const results = plan.cases.map((entry): EvaluationCaseResultResponse => {
    const traceId = entry.datasetCaseId ? nextTraceId(state) : entry.key;
    return {
      caseKey: entry.key,
      completedAt: now,
      costUsdMicros: 1_200,
      ...(entry.datasetCaseId ? { datasetCaseId: entry.datasetCaseId } : {}),
      latencyMs: 850,
      notApplicable: [],
      ...(entry.datasetCaseId ? { runId: nextId(state), threadId: nextId(state) } : {}),
      runStatus: "completed",
      scores: plan.definitions.map((definition) => ({
        executionStatus: "succeeded" as const,
        passed: true,
        revision: definition.revision,
        scoreDefinitionId: definition.scoreDefinitionId,
        value: 1,
      })),
      ...(entry.datasetCaseId ? {} : { sourceTraceId: traceId }),
      status: "scored",
      submittedAt: now,
      totalTokens: 640,
      traceId,
    };
  });
  const run: EvaluationRunResponse = {
    caseCount,
    caseTimeoutSeconds: plan.caseTimeoutSeconds ?? 300,
    ...(plan.comparison ? { comparison: plan.comparison } : {}),
    completedAt: now,
    concurrency: plan.concurrency ?? 4,
    counts: { failed: 0, pending: 0, running: 0, scored: caseCount, timedOut: 0 },
    createdAt: now,
    ...(plan.datasetId ? { datasetId: plan.datasetId } : {}),
    id,
    kind: plan.kind,
    scoreDefinitions: [...plan.definitions],
    startedAt: now,
    status: "completed",
    summary: {
      costUsdMicros: 1_200 * caseCount,
      definitions: plan.definitions.map((definition) => ({
        errors: 0,
        ...(caseCount > 0 ? { mean: 1, passRate: 1 } : {}),
        passed: caseCount,
        revision: definition.revision,
        scoreDefinitionId: definition.scoreDefinitionId,
        scored: caseCount,
      })),
      ...(caseCount > 0 ? { latencyP50Ms: 850, latencyP95Ms: 1_400 } : {}),
      totalTokens: 640 * caseCount,
    },
    ...(plan.target ? { target: plan.target } : {}),
    ...(plan.traceIds ? { traceIds: [...plan.traceIds] } : {}),
    updatedAt: now,
    version: 2,
  };
  state.runs.set(id, run);
  state.runResults.set(id, results);
  return run;
}

function datasetCasePlan(state: EvaluationMockState, datasetId: PublicId) {
  activeDataset(state, datasetId);
  return state.cases
    .get(datasetId)!
    .map((entry) => ({ datasetCaseId: entry.id, key: entry.externalId ?? entry.id }));
}

function createRun(state: EvaluationMockState, now: string, input: CreateEvaluationRunRequest) {
  const definitions = frozenDefinitions(state, input.scoreDefinitionIds);
  if (input.kind === "trace-score") {
    return completeRun(state, now, {
      cases: input.traceIds.map((traceId) => ({ key: traceId })),
      definitions,
      kind: "trace-score",
      traceIds: input.traceIds,
    });
  }
  return completeRun(state, now, {
    ...(input.caseTimeoutSeconds === undefined
      ? {}
      : { caseTimeoutSeconds: input.caseTimeoutSeconds }),
    cases: datasetCasePlan(state, input.datasetId),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    datasetId: input.datasetId,
    definitions,
    kind: "dataset-replay",
    target:
      input.target.type === "release"
        ? { agentReleaseId: input.target.agentReleaseId, type: "release" }
        : {
            agentDeploymentId: input.target.agentDeploymentId,
            agentReleaseId: nextId(state),
            type: "deployment",
          },
  });
}

function createComparison(
  state: EvaluationMockState,
  now: string,
  input: CreateReleaseComparisonRequest,
): ReleaseComparisonResponse {
  const definitions = frozenDefinitions(state, input.scoreDefinitionIds);
  const cases = datasetCasePlan(state, input.datasetId);
  const id = nextId(state);
  const arm = (role: "baseline" | "candidate", agentReleaseId: PublicId) => {
    const run = completeRun(state, now, {
      ...(input.caseTimeoutSeconds === undefined
        ? {}
        : { caseTimeoutSeconds: input.caseTimeoutSeconds }),
      cases,
      comparison: { releaseComparisonId: id, role },
      ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
      datasetId: input.datasetId,
      definitions,
      kind: "dataset-replay",
      target: { agentReleaseId, type: "release" },
    });
    return { agentReleaseId, evaluationRunId: run.id };
  };
  const totalCases = cases.length;
  const tokens = 640 * totalCases;
  const cost = 1_200 * totalCases;
  const comparison: ReleaseComparisonResponse = {
    baseline: arm("baseline", input.baselineReleaseId),
    candidate: arm("candidate", input.candidateReleaseId),
    completedAt: now,
    createdAt: now,
    datasetId: input.datasetId,
    gateMode: "advisory",
    gatePolicy: {
      ...DEFAULT_GATE_POLICY,
      ...Object.fromEntries(
        Object.entries(input.gatePolicy ?? {}).filter(([, value]) => value !== undefined),
      ),
    },
    id,
    reasons: [`No regressions across ${totalCases} comparable cases.`],
    ...(input.runtimeConfigFromAgentDeploymentId === undefined
      ? {}
      : { runtimeConfigFromAgentDeploymentId: input.runtimeConfigFromAgentDeploymentId }),
    scoreDefinitions: definitions,
    status: "completed",
    summary: {
      comparableCases: totalCases,
      costUsdMicros: { baselineTotal: cost, candidateTotal: cost, delta: 0 },
      definitions: definitions.map((definition) => ({
        ...(totalCases > 0
          ? {
              baselineMean: 1,
              baselinePassRate: 1,
              candidateMean: 1,
              candidatePassRate: 1,
              meanDelta: 0,
              passRateDelta: 0,
            }
          : {}),
        name: definition.name,
        revision: definition.revision,
        scoreDefinitionId: definition.scoreDefinitionId,
      })),
      evaluatorErrors: { baseline: 0, candidate: 0 },
      latency:
        totalCases > 0
          ? {
              baselineP50Ms: 850,
              baselineP95Ms: 1_400,
              candidateP50Ms: 850,
              candidateP95Ms: 1_400,
              p50DeltaMs: 0,
              p95DeltaMs: 0,
            }
          : {},
      missingEvidence: { baseline: 0, candidate: 0 },
      regressions: 0,
      tokens: { baselineTotal: tokens, candidateTotal: tokens, delta: 0 },
      totalCases,
    },
    updatedAt: now,
    verdict: "pass",
    version: 2,
  };
  state.comparisons.set(id, comparison);
  return comparison;
}

function page<Item>(items: readonly Item[], query: PlatformRequest["query"]) {
  const offset = decodeCursor(typeof query?.cursor === "string" ? query.cursor : undefined);
  const limit = query?.limit === undefined ? 50 : Number(query.limit);
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    ...(offset + selected.length < items.length
      ? { nextCursor: encodeCursor(offset + selected.length) }
      : {}),
  };
}

function matchRoute(request: PlatformRequest) {
  const pathSegments = request.path.split("/").filter(Boolean);
  const candidates = EVALUATION_API_ROUTES.flatMap((route) => {
    const templateSegments = route.path.split("/").filter(Boolean);
    if (templateSegments.length !== pathSegments.length) return [];
    const params: Record<string, string> = {};
    for (const [index, segment] of templateSegments.entries()) {
      const actual = pathSegments[index]!;
      if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(actual);
      else if (segment !== actual) return [];
    }
    return [{ params, route }];
  });
  if (candidates.length === 0) return undefined;
  const match = candidates.find((candidate) => candidate.route.method === request.method);
  if (!match) {
    throw new PlatformRequestError(`${request.method} is not supported for ${request.path}.`);
  }
  return match;
}

function handle(
  state: EvaluationMockState,
  now: string,
  name: EvaluationApiRouteName,
  params: Readonly<Record<string, string>>,
  body: unknown,
  request: PlatformRequest,
): unknown {
  const definitionId = params.scoreDefinitionId ?? "";
  const datasetId = (params.datasetId ?? "") as PublicId;
  const traceId = params.traceId ?? "";
  switch (name) {
    case "createScoreDefinition":
      return createScoreDefinition(state, now, body as CreateScoreDefinitionRequest);
    case "listScoreDefinitions":
      return page(
        [...state.scoreDefinitions.values()].filter(
          (definition) => !request.query?.status || definition.status === request.query.status,
        ),
        request.query,
      );
    case "getScoreDefinition":
      return found(state.scoreDefinitions, definitionId, "Score definition");
    case "reviseScoreDefinition": {
      const input = body as ReviseScoreDefinitionRequest;
      const definition = found(state.scoreDefinitions, definitionId, "Score definition");
      if (definition.status !== "active") {
        throw new PlatformRequestError(`Score definition ${definitionId} is archived.`);
      }
      if (input.expectedRevision !== definition.currentRevision) {
        throw new PlatformRequestError(
          `Score definition ${definitionId} is at revision ${definition.currentRevision}, not ${input.expectedRevision}.`,
        );
      }
      const revision = definition.currentRevision + 1;
      const revised: ScoreDefinitionResponse = {
        ...definition,
        currentRevision: revision,
        revision: definitionRevision(now, input, revision),
        type: scoreType(input.evaluator.kind),
        updatedAt: now,
        version: definition.version + 1,
      };
      state.scoreDefinitions.set(definitionId, revised);
      return revised;
    }
    case "archiveScoreDefinition": {
      const definition = found(state.scoreDefinitions, definitionId, "Score definition");
      const archived: ScoreDefinitionResponse = {
        ...definition,
        archivedAt: definition.archivedAt ?? now,
        revision: { ...definition.revision, status: "archived" },
        status: "archived",
        updatedAt: now,
        version: definition.version + 1,
      };
      state.scoreDefinitions.set(definitionId, archived);
      return archived;
    }
    case "listScoreResults":
      return page(
        state.scoreResults
          .filter(
            (result) =>
              !request.query?.scoreDefinitionId ||
              result.scoreDefinitionId === request.query.scoreDefinitionId,
          )
          .toReversed(),
        request.query,
      );
    case "listTraceScoreResults":
      return page(
        state.scoreResults.filter((result) => result.traceId === traceId),
        request.query,
      );
    case "recordTraceScoreResult": {
      const input = body as RecordScoreResultRequest;
      const definition = found(state.scoreDefinitions, input.scoreDefinitionId, "Score definition");
      const result: Mutable<ScoreResultResponse> = {
        createdAt: now,
        durationMs: 0,
        evaluatorVersionHash: definition.revision.evaluatorVersionHash,
        evidenceRefs: [{ id: traceId, kind: "trace" }],
        executionStatus: "succeeded",
        humanActorPrincipalId: MOCK_OWNER,
        id: nextId(state),
        passed: input.value >= definition.revision.threshold,
        revision: definition.currentRevision,
        scoreDefinitionId: definition.id,
        scoreType: definition.type,
        source: "api",
        threshold: definition.revision.threshold,
        traceId,
        updatedAt: now,
        value: input.value,
        version: 0,
      };
      if (input.label !== undefined) result.label = input.label;
      if (input.rationale !== undefined) result.rationale = input.rationale;
      if (input.runId !== undefined) result.runId = input.runId;
      if (input.spanId !== undefined) result.spanId = input.spanId;
      state.scoreResults.push(result);
      return result;
    }
    case "listTraceAnnotations":
      return page(
        state.annotations.filter((annotation) => annotation.traceId === traceId),
        request.query,
      );
    case "createTraceAnnotation": {
      const input = body as CreateAnnotationRequest;
      const annotation: AnnotationResponse = {
        ...input,
        authorPrincipalId: MOCK_OWNER,
        createdAt: now,
        id: nextId(state),
        tags: [...(input.tags ?? [])],
        traceId,
      };
      state.annotations.push(annotation);
      return annotation;
    }
    case "createRegressionDataset":
      return createDataset(state, now, body as CreateRegressionDatasetRequest);
    case "listRegressionDatasets":
      return page(
        [...state.datasets.values()].filter(
          (dataset) => !request.query?.status || dataset.status === request.query.status,
        ),
        request.query,
      );
    case "getRegressionDataset":
      return found(state.datasets, datasetId, "Regression dataset");
    case "archiveRegressionDataset": {
      const dataset = found(state.datasets, datasetId, "Regression dataset");
      const archived: RegressionDatasetResponse = {
        ...dataset,
        archivedAt: dataset.archivedAt ?? now,
        status: "archived",
        updatedAt: now,
        version: dataset.version + 1,
      };
      state.datasets.set(datasetId, archived);
      return archived;
    }
    case "addDatasetCase":
      return addCase(state, now, datasetId, body as AddDatasetCaseRequest);
    case "importDatasetCases":
      return importCases(state, now, datasetId, body as ImportDatasetCasesRequest);
    case "listDatasetCases":
      found(state.datasets, datasetId, "Regression dataset");
      return page(state.cases.get(datasetId)!, request.query);
    case "createEvaluationRun":
      return createRun(state, now, body as CreateEvaluationRunRequest);
    case "listEvaluationRuns": {
      const query = request.query ?? {};
      return page(
        [...state.runs.values()]
          .filter(
            (run) =>
              (query.status === undefined || run.status === query.status) &&
              (query.datasetId === undefined || run.datasetId === query.datasetId) &&
              (query.agentReleaseId === undefined ||
                run.target?.agentReleaseId === query.agentReleaseId),
          )
          .toReversed(),
        request.query,
      );
    }
    case "getEvaluationRun":
      return found(state.runs, params.evaluationRunId ?? "", "Evaluation run");
    case "listEvaluationRunResults":
      found(state.runs, params.evaluationRunId ?? "", "Evaluation run");
      return page(state.runResults.get(params.evaluationRunId!)!, request.query);
    case "createReleaseComparison":
      return createComparison(state, now, body as CreateReleaseComparisonRequest);
    case "listReleaseComparisons": {
      const query = request.query ?? {};
      return page(
        [...state.comparisons.values()]
          .filter(
            (comparison) =>
              (query.status === undefined || comparison.status === query.status) &&
              (query.baselineReleaseId === undefined ||
                comparison.baseline.agentReleaseId === query.baselineReleaseId) &&
              (query.candidateReleaseId === undefined ||
                comparison.candidate.agentReleaseId === query.candidateReleaseId),
          )
          .map(({ report: _report, ...comparison }) => comparison)
          .toReversed(),
        request.query,
      );
    }
    case "getReleaseComparison":
      return found(state.comparisons, params.releaseComparisonId ?? "", "Release comparison");
  }
}

/** Serves every evaluation route from deterministic in-memory state, validated by the contract. */
export function mockEvaluationData(
  request: PlatformRequest,
  now: string,
  state: EvaluationMockState,
): EvaluationMockResult {
  const match = matchRoute(request);
  if (!match) return { matched: false };
  const { params, route } = match;
  try {
    const body = "requestBody" in route ? decodePublicRequest(route.name, request.body) : undefined;
    if (!("requestBody" in route) && request.body !== undefined) {
      throw new TypeError(`Route ${route.name} does not accept a request body.`);
    }
    if (route.method !== "POST") {
      return {
        data: decodePublicResponse(
          route.name,
          handle(state, now, route.name, params, body, request),
        ),
        matched: true,
      };
    }
    const key = request.idempotencyKey;
    if (!key) throw new TypeError(`Route ${route.name} requires an Idempotency-Key.`);
    const fingerprint = JSON.stringify(
      canonicalValue({ body: body ?? null, context: request.context ?? null, path: request.path }),
    );
    const prior = state.idempotencyResults.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new TypeError("The idempotency key was already used for a different request.");
      }
      return { data: structuredClone(prior.data), matched: true };
    }
    const data = decodePublicResponse(
      route.name,
      handle(state, now, route.name, params, body, request),
    );
    state.idempotencyResults.set(key, { data: structuredClone(data), fingerprint });
    return { data, matched: true };
  } catch (error) {
    if (error instanceof PlatformRequestError) throw error;
    throw new PlatformRequestError(
      error instanceof Error ? error.message : "Invalid evaluation mock request.",
    );
  }
}
