import type {
  AnnotationResponse,
  DatasetCaseResponse,
  EvaluationCaseResultResponse,
  EvaluationRunResponse,
  RegressionDatasetResponse,
  ReleaseComparisonResponse,
  ScoreDefinitionResponse,
  ScoreResultResponse,
} from "@deployments-ai/api-contract";
import type {
  AnnotationRecord,
  DatasetCaseRecord,
  EvaluationCaseRunRecord,
  EvaluationRunRecord,
  RegressionDatasetRecord,
  ReleaseComparisonRecord,
  ScoreDefinitionRecord,
  ScoreDefinitionRevisionRecord,
  ScoreResultRecord,
} from "@deployments-ai/db";
import type { EvaluationBlobReference, EvaluationReportDownload } from "./service-contracts.ts";

/** Wire shape before contract decoding (the handler decodes every response). */
type Wire<S extends { readonly Encoded: unknown }> = S["Encoded"];

type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drops undefined members so responses satisfy exact optional properties and strict decoding. */
function compact<T extends Readonly<Record<string, unknown>>>(value: T): Compact<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as Compact<T>;
}

export function scoreDefinitionResponse(
  definition: ScoreDefinitionRecord,
  revision: ScoreDefinitionRevisionRecord,
): Wire<typeof ScoreDefinitionResponse> {
  const { data } = definition;
  const current = revision.data;
  return compact({
    archivedAt: data.archivedAt,
    createdAt: data.createdAt,
    currentRevision: data.currentRevision,
    description: data.description,
    id: data.id,
    name: data.name,
    ownerPrincipalId: data.ownerPrincipalId,
    revision: compact({
      createdAt: current.createdAt,
      evaluator: current.evaluator,
      evaluatorVersionHash: current.evaluatorVersionHash,
      judgeModelId: current.judgeModelId,
      judgePromptHash: current.judgePromptHash,
      revision: current.revision,
      sampling: current.sampling,
      status: current.status,
      supersededAt: current.supersededAt,
      target: current.target,
      threshold: current.threshold,
      weight: current.weight,
    }),
    status: data.status,
    type: data.type,
    updatedAt: data.updatedAt,
    version: data.version,
  });
}

export function scoreResultResponse(record: ScoreResultRecord): Wire<typeof ScoreResultResponse> {
  const { data } = record;
  return compact({
    agentDeploymentId: data.agentDeploymentId,
    agentReleaseId: data.agentReleaseId,
    createdAt: data.createdAt,
    datasetCaseId: data.datasetCaseId,
    durationMs: data.durationMs,
    errorClass: data.errorClass,
    errorMessage: data.errorMessage,
    evaluationRunId: data.evaluationRunId,
    evaluatorVersionHash: data.evaluatorVersionHash,
    evidenceRefs: data.evidenceRefs,
    executionStatus: data.executionStatus,
    humanActorPrincipalId: data.humanActorPrincipalId,
    id: data.id,
    judge: data.judge,
    label: data.label,
    passed: data.passed,
    rationale: data.rationale,
    revision: data.revision,
    runId: data.runId,
    scoreDefinitionId: data.scoreDefinitionId,
    scoreType: data.scoreType,
    source: data.source,
    spanId: data.spanId,
    threshold: data.threshold,
    traceId: data.traceId,
    updatedAt: data.updatedAt,
    value: data.value,
    version: data.version,
  });
}

export function annotationResponse(record: AnnotationRecord): Wire<typeof AnnotationResponse> {
  const { data } = record;
  return compact({
    authorPrincipalId: data.authorPrincipalId,
    body: data.body,
    createdAt: data.createdAt,
    id: data.id,
    label: data.label,
    runId: data.runId,
    spanId: data.spanId,
    tags: data.tags,
    traceId: data.traceId,
  });
}

export function regressionDatasetResponse(
  record: RegressionDatasetRecord,
): Wire<typeof RegressionDatasetResponse> {
  const { data } = record;
  return compact({
    archivedAt: data.archivedAt,
    caseCount: data.caseCount,
    createdAt: data.createdAt,
    description: data.description,
    id: data.id,
    name: data.name,
    ownerPrincipalId: data.ownerPrincipalId,
    retentionDays: data.retentionDays,
    status: data.status,
    updatedAt: data.updatedAt,
    version: data.version,
  });
}

export function datasetCaseResponse(record: DatasetCaseRecord): Wire<typeof DatasetCaseResponse> {
  const { data } = record;
  return compact({
    consentBasis: data.consentBasis,
    contentSha256: data.contentSha256,
    createdAt: data.createdAt,
    datasetId: data.datasetId,
    expectationKinds: data.expectationKinds,
    externalId: data.externalId,
    id: data.id,
    inputPreview: data.inputPreview,
    provenance: data.provenance,
    sourceRunId: data.sourceRunId,
    sourceThreadId: data.sourceThreadId,
    sourceTraceId: data.sourceTraceId,
    tags: data.tags,
  });
}

export function evaluationRunResponse(
  record: EvaluationRunRecord,
): Wire<typeof EvaluationRunResponse> {
  const { data } = record;
  return compact({
    caseCount: data.caseCount,
    caseTimeoutSeconds: data.caseTimeoutSeconds,
    comparison: data.comparison,
    completedAt: data.completedAt,
    concurrency: data.concurrency,
    counts: data.counts,
    createdAt: data.createdAt,
    datasetId: data.datasetId,
    error: data.error,
    executionBindingId: data.executionBindingId,
    id: data.id,
    kind: data.kind,
    scoreDefinitions: data.scoreDefinitions,
    startedAt: data.startedAt,
    status: data.status,
    summary: data.summary,
    target: data.target,
    traceIds: data.traceIds,
    updatedAt: data.updatedAt,
    version: data.version,
  });
}

export function evaluationCaseResultResponse(
  record: EvaluationCaseRunRecord,
): Wire<typeof EvaluationCaseResultResponse> {
  const { data } = record;
  return compact({
    caseKey: data.caseKey,
    completedAt: data.completedAt,
    costUsdMicros: data.costUsdMicros,
    datasetCaseId: data.datasetCaseId,
    error: data.error,
    latencyMs: data.latencyMs,
    notApplicable: data.notApplicable,
    runId: data.runId,
    runStatus: data.runStatus,
    scores: data.scores,
    sourceTraceId: data.sourceTraceId,
    status: data.status,
    submittedAt: data.submittedAt,
    threadId: data.threadId,
    totalTokens: data.totalTokens,
    traceId: data.traceId,
  });
}

export interface ComparisonReportDownloads {
  readonly json: EvaluationReportDownload;
  readonly markdown: EvaluationReportDownload;
}

function reportArtifact(reference: EvaluationBlobReference, download: EvaluationReportDownload) {
  return {
    contentType: reference.contentType,
    downloadUrl: download.downloadUrl,
    downloadUrlExpiresAt: download.downloadUrlExpiresAt,
    sha256: reference.sha256,
    sizeBytes: reference.byteSize,
  };
}

export function releaseComparisonResponse(
  record: ReleaseComparisonRecord,
  downloads?: ComparisonReportDownloads,
): Wire<typeof ReleaseComparisonResponse> {
  const { data } = record;
  const arm = (value: ReleaseComparisonRecord["data"]["baseline"]) =>
    compact({
      agentReleaseId: value.agentReleaseId,
      evaluationRunId: value.evaluationRunId,
      releaseContentHash: value.releaseContentHash,
    });
  return compact({
    baseline: arm(data.baseline),
    candidate: arm(data.candidate),
    completedAt: data.completedAt,
    createdAt: data.createdAt,
    datasetId: data.datasetId,
    error: data.error,
    gateMode: data.gateMode,
    gatePolicy: data.gatePolicy,
    id: data.id,
    reasons: data.reasons,
    report:
      downloads && data.reportJson && data.reportMarkdown
        ? {
            json: reportArtifact(data.reportJson, downloads.json),
            markdown: reportArtifact(data.reportMarkdown, downloads.markdown),
          }
        : undefined,
    runtimeConfigFromAgentDeploymentId: data.runtimeConfigFromAgentDeploymentId,
    scoreDefinitions: data.scoreDefinitions,
    status: data.status,
    summary: data.summary,
    updatedAt: data.updatedAt,
    verdict: data.verdict,
    version: data.version,
  });
}
