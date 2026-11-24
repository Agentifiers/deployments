import {
  CaseExpectations,
  CaseInputContent,
  EvaluatorConfig,
  EvaluatorErrorClass,
  MAX_SCORE_LABEL_LENGTH,
  MAX_SCORE_RATIONALE_LENGTH,
  ScoreDefinitionType,
  ScoreSamplingPolicy,
  ScoreTarget,
  ScoreThreshold,
} from "@deployments-ai/observability/evaluator-config";
import { Schema } from "effect";
import { PublicId, Timestamp } from "./primitives.ts";

export { EVALUATION_API_ROUTES, type EvaluationApiRouteName } from "./evaluation-routes.ts";

function boundedText(label: string, maximum: number) {
  return Schema.String.check(
    Schema.isMinLength(1, { message: `${label} must not be empty.` }),
    Schema.isMaxLength(maximum, { message: `${label} must not exceed ${maximum} characters.` }),
  );
}

function boundedInteger(label: string, minimum: number, maximum: number) {
  return Schema.Number.check(
    Schema.isInt({ message: `${label} must be an integer.` }),
    Schema.isGreaterThanOrEqualTo(minimum, { message: `${label} must be at least ${minimum}.` }),
    Schema.isLessThanOrEqualTo(maximum, { message: `${label} must not exceed ${maximum}.` }),
  );
}

function boundedList<S extends Schema.Top>(
  item: S,
  label: string,
  minimum: number,
  maximum: number,
) {
  return Schema.Array(item).check(
    Schema.isMinLength(minimum, { message: `${label} must include at least ${minimum} entries.` }),
    Schema.isMaxLength(maximum, { message: `${label} must not exceed ${maximum} entries.` }),
  );
}

const NonNegativeInteger = boundedInteger("Counts", 0, Number.MAX_SAFE_INTEGER);
const SignedNumber = Schema.Number.check(Schema.isFinite());
export const EvaluationTraceId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{32}$/u, {
    message: "Trace IDs must be 32 lowercase hex characters.",
  }),
);
export const EvaluationSpanId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{16}$/u, { message: "Span IDs must be 16 lowercase hex characters." }),
);
export const EvaluationSha256 = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u, { message: "Hashes must be lowercase SHA-256 hex." }),
);
export const EvaluationResourceName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u, {
    message:
      "Names must be 1-64 lowercase letters, digits, '.', '_', or '-' and start with a letter or digit.",
  }),
);
const Description = boundedText("Descriptions", 500);
const Tags = boundedList(boundedText("Tags", 64), "Tags", 0, 20);
const Weight = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(100),
);
const ScoreDefinitionIds = boundedList(PublicId, "Score definition IDs", 1, 20);
const CaseTimeoutSeconds = boundedInteger("Case timeouts", 30, 3_600);
const Concurrency = boundedInteger("Concurrency", 1, 20);
const EvaluationError = Schema.Struct({ code: Schema.String, message: Schema.String });
const ListPage = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.optional(Schema.String) });

export const ScoreDefinitionRevisionResponse = Schema.Struct({
  createdAt: Timestamp,
  evaluator: EvaluatorConfig,
  evaluatorVersionHash: EvaluationSha256,
  judgeModelId: Schema.optional(Schema.String),
  judgePromptHash: Schema.optional(EvaluationSha256),
  revision: boundedInteger("Revisions", 1, Number.MAX_SAFE_INTEGER),
  sampling: ScoreSamplingPolicy,
  status: Schema.Literals(["active", "archived", "superseded"]),
  supersededAt: Schema.optional(Timestamp),
  target: ScoreTarget,
  threshold: ScoreThreshold,
  weight: Schema.optional(Weight),
});

export const ScoreDefinitionResponse = Schema.Struct({
  archivedAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
  currentRevision: boundedInteger("Revisions", 1, Number.MAX_SAFE_INTEGER),
  description: Schema.optional(Description),
  id: PublicId,
  name: EvaluationResourceName,
  ownerPrincipalId: Schema.String,
  revision: ScoreDefinitionRevisionResponse,
  status: Schema.Literals(["active", "archived"]),
  type: ScoreDefinitionType,
  updatedAt: Timestamp,
  version: NonNegativeInteger,
});

export const ListScoreDefinitionsResponse = ListPage(ScoreDefinitionResponse);

const scoreDefinitionConfigurationFields = {
  evaluator: EvaluatorConfig,
  /** Automatic scoring of finalized hosted customer traces; defaults to a rate of 0 (off). */
  sampling: Schema.optional(ScoreSamplingPolicy),
  /** Defaults to "root-run". */
  target: Schema.optional(ScoreTarget),
  /** Defaults to 1 (the value must be perfect to pass). */
  threshold: Schema.optional(ScoreThreshold),
  weight: Schema.optional(Weight),
} as const;

export const CreateScoreDefinitionRequest = Schema.Struct({
  ...scoreDefinitionConfigurationFields,
  description: Schema.optional(Description),
  name: EvaluationResourceName,
});

export const ReviseScoreDefinitionRequest = Schema.Struct({
  ...scoreDefinitionConfigurationFields,
  expectedRevision: boundedInteger("Revisions", 1, Number.MAX_SAFE_INTEGER),
});

export const ScoreResultResponse = Schema.Struct({
  agentDeploymentId: Schema.optional(PublicId),
  agentReleaseId: Schema.optional(PublicId),
  createdAt: Timestamp,
  datasetCaseId: Schema.optional(PublicId),
  durationMs: NonNegativeInteger,
  errorClass: Schema.optional(EvaluatorErrorClass),
  errorMessage: Schema.optional(Schema.String),
  evaluationRunId: Schema.optional(PublicId),
  evaluatorVersionHash: EvaluationSha256,
  evidenceRefs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["message", "run", "tool-call", "trace"]),
    }),
  ),
  executionStatus: Schema.Literals(["error", "succeeded"]),
  humanActorPrincipalId: Schema.optional(Schema.String),
  id: PublicId,
  judge: Schema.optional(
    Schema.Struct({
      costUsdMicros: Schema.optional(NonNegativeInteger),
      inputTokens: Schema.optional(NonNegativeInteger),
      internalEvaluator: Schema.Literal(true),
      modelId: Schema.String,
      outputTokens: Schema.optional(NonNegativeInteger),
    }),
  ),
  label: Schema.optional(Schema.String),
  passed: Schema.optional(Schema.Boolean),
  rationale: Schema.optional(Schema.String),
  revision: boundedInteger("Revisions", 1, Number.MAX_SAFE_INTEGER),
  runId: Schema.optional(PublicId),
  scoreDefinitionId: PublicId,
  scoreType: ScoreDefinitionType,
  source: Schema.Literals(["api", "automatic", "evaluation-run"]),
  spanId: Schema.optional(EvaluationSpanId),
  threshold: ScoreThreshold,
  traceId: EvaluationTraceId,
  updatedAt: Timestamp,
  value: Schema.optional(ScoreThreshold),
  version: NonNegativeInteger,
});

export const ListScoreResultsResponse = ListPage(ScoreResultResponse);

export const RecordScoreResultRequest = Schema.Struct({
  label: Schema.optional(boundedText("Score labels", MAX_SCORE_LABEL_LENGTH)),
  rationale: Schema.optional(boundedText("Score rationales", MAX_SCORE_RATIONALE_LENGTH)),
  runId: Schema.optional(PublicId),
  scoreDefinitionId: PublicId,
  spanId: Schema.optional(EvaluationSpanId),
  value: ScoreThreshold,
});

export const AnnotationResponse = Schema.Struct({
  authorPrincipalId: Schema.String,
  body: Schema.String,
  createdAt: Timestamp,
  id: PublicId,
  label: Schema.optional(Schema.String),
  runId: Schema.optional(PublicId),
  spanId: Schema.optional(EvaluationSpanId),
  tags: Schema.Array(Schema.String),
  traceId: EvaluationTraceId,
});

export const ListAnnotationsResponse = ListPage(AnnotationResponse);

export const CreateAnnotationRequest = Schema.Struct({
  body: boundedText("Annotation bodies", 4_000),
  label: Schema.optional(boundedText("Annotation labels", MAX_SCORE_LABEL_LENGTH)),
  runId: Schema.optional(PublicId),
  spanId: Schema.optional(EvaluationSpanId),
  tags: Schema.optional(boundedList(boundedText("Tags", 64), "Tags", 0, 10)),
});

export const RegressionDatasetResponse = Schema.Struct({
  archivedAt: Schema.optional(Timestamp),
  caseCount: NonNegativeInteger,
  createdAt: Timestamp,
  description: Schema.optional(Description),
  id: PublicId,
  name: EvaluationResourceName,
  ownerPrincipalId: Schema.String,
  retentionDays: Schema.optional(boundedInteger("Retention days", 1, 3_650)),
  status: Schema.Literals(["active", "archived"]),
  updatedAt: Timestamp,
  version: NonNegativeInteger,
});

export const ListRegressionDatasetsResponse = ListPage(RegressionDatasetResponse);

export const CreateRegressionDatasetRequest = Schema.Struct({
  description: Schema.optional(Description),
  name: EvaluationResourceName,
  retentionDays: Schema.optional(boundedInteger("Retention days", 1, 3_650)),
});

export const DatasetCaseResponse = Schema.Struct({
  consentBasis: Schema.optional(Schema.String),
  contentSha256: EvaluationSha256,
  createdAt: Timestamp,
  datasetId: PublicId,
  expectationKinds: Schema.Array(Schema.String),
  externalId: Schema.optional(Schema.String),
  id: PublicId,
  inputPreview: Schema.String,
  provenance: Schema.Literals(["annotation", "import", "manual", "trace"]),
  sourceRunId: Schema.optional(PublicId),
  sourceThreadId: Schema.optional(PublicId),
  sourceTraceId: Schema.optional(EvaluationTraceId),
  tags: Schema.Array(Schema.String),
});

export const ListDatasetCasesResponse = ListPage(DatasetCaseResponse);

const caseMetadataFields = {
  consentBasis: Schema.optional(boundedText("Consent basis", 200)),
  externalId: Schema.optional(boundedText("External case IDs", 128)),
  tags: Schema.optional(Tags),
} as const;

/**
 * Adds one case. Supply `input` inline, or `source` to capture the user input of an existing
 * run (by thread and run) or of a trace's root run.
 */
export const AddDatasetCaseRequest = Schema.Struct({
  ...caseMetadataFields,
  expectations: Schema.optional(CaseExpectations),
  input: Schema.optional(Schema.Struct({ content: CaseInputContent })),
  source: Schema.optional(
    Schema.Union([
      Schema.Struct({ runId: PublicId, threadId: PublicId, type: Schema.Literal("run") }),
      Schema.Struct({ traceId: EvaluationTraceId, type: Schema.Literal("trace") }),
    ]),
  ),
}).check(
  Schema.makeFilter((request) =>
    (request.input === undefined) !== (request.source === undefined)
      ? undefined
      : "Provide exactly one of input or source.",
  ),
);

export const AddDatasetCaseResponse = Schema.Struct({
  case: DatasetCaseResponse,
  created: Schema.Boolean,
});

/**
 * One entry of a JSON case file. `message` is the user input; `expected.mustInclude`,
 * `mustNot`, `mustUseTools`, `mustNotUseTools`, `matches`, and `jsonSchema` map to the
 * built-in evaluators, and any other expected or top-level fields are kept as opaque
 * expected constraints.
 */
export const ImportedCase = Schema.StructWithRest(
  Schema.Struct({
    consentBasis: Schema.optional(boundedText("Consent basis", 200)),
    expected: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    id: Schema.optional(boundedText("External case IDs", 128)),
    message: CaseInputContent,
    tags: Schema.optional(Tags),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export const ImportDatasetCasesRequest = Schema.Struct({
  cases: boundedList(ImportedCase, "Imported cases", 1, 100),
});

export const ImportDatasetCasesResponse = Schema.Struct({
  created: NonNegativeInteger,
  existing: NonNegativeInteger,
  items: Schema.Array(
    Schema.Struct({
      case: DatasetCaseResponse,
      created: Schema.Boolean,
      externalId: Schema.optional(Schema.String),
    }),
  ),
});

export const EvaluationTargetRequest = Schema.Union([
  Schema.Struct({
    agentReleaseId: PublicId,
    /** Snapshot this deployment's runtime configuration (connections, policy) at creation. */
    runtimeConfigFromAgentDeploymentId: Schema.optional(PublicId),
    type: Schema.Literal("release"),
  }),
  Schema.Struct({ agentDeploymentId: PublicId, type: Schema.Literal("deployment") }),
]);

export const CreateEvaluationRunRequest = Schema.Union([
  Schema.Struct({
    caseTimeoutSeconds: Schema.optional(CaseTimeoutSeconds),
    concurrency: Schema.optional(Concurrency),
    datasetId: PublicId,
    kind: Schema.Literal("dataset-replay"),
    scoreDefinitionIds: ScoreDefinitionIds,
    target: EvaluationTargetRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("trace-score"),
    scoreDefinitionIds: ScoreDefinitionIds,
    traceIds: boundedList(EvaluationTraceId, "Trace IDs", 1, 100),
  }),
]);

export const FrozenScoreDefinitionResponse = Schema.Struct({
  evaluatorVersionHash: EvaluationSha256,
  name: EvaluationResourceName,
  revision: boundedInteger("Revisions", 1, Number.MAX_SAFE_INTEGER),
  scoreDefinitionId: PublicId,
  threshold: ScoreThreshold,
  type: ScoreDefinitionType,
});

const DefinitionSummary = Schema.Struct({
  errors: NonNegativeInteger,
  mean: Schema.optional(ScoreThreshold),
  passRate: Schema.optional(ScoreThreshold),
  passed: NonNegativeInteger,
  revision: NonNegativeInteger,
  scoreDefinitionId: PublicId,
  scored: NonNegativeInteger,
});

export const EvaluationRunResponse = Schema.Struct({
  caseCount: NonNegativeInteger,
  caseTimeoutSeconds: NonNegativeInteger,
  comparison: Schema.optional(
    Schema.Struct({
      releaseComparisonId: PublicId,
      role: Schema.Literals(["baseline", "candidate"]),
    }),
  ),
  completedAt: Schema.optional(Timestamp),
  concurrency: NonNegativeInteger,
  counts: Schema.Struct({
    failed: NonNegativeInteger,
    pending: NonNegativeInteger,
    running: NonNegativeInteger,
    scored: NonNegativeInteger,
    timedOut: NonNegativeInteger,
  }),
  createdAt: Timestamp,
  datasetId: Schema.optional(PublicId),
  error: Schema.optional(EvaluationError),
  executionBindingId: Schema.optional(Schema.String),
  id: PublicId,
  kind: Schema.Literals(["dataset-replay", "trace-score"]),
  scoreDefinitions: Schema.Array(FrozenScoreDefinitionResponse),
  startedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["canceled", "completed", "failed", "queued", "running"]),
  summary: Schema.optional(
    Schema.Struct({
      costUsdMicros: NonNegativeInteger,
      definitions: Schema.Array(DefinitionSummary),
      latencyP50Ms: Schema.optional(NonNegativeInteger),
      latencyP95Ms: Schema.optional(NonNegativeInteger),
      totalTokens: NonNegativeInteger,
    }),
  ),
  target: Schema.optional(
    Schema.Struct({
      agentDeploymentId: Schema.optional(PublicId),
      agentReleaseId: PublicId,
      type: Schema.Literals(["deployment", "release"]),
    }),
  ),
  traceIds: Schema.optional(Schema.Array(EvaluationTraceId)),
  updatedAt: Timestamp,
  version: NonNegativeInteger,
});

export const ListEvaluationRunsResponse = ListPage(EvaluationRunResponse);

export const EvaluationCaseResultResponse = Schema.Struct({
  caseKey: Schema.String,
  completedAt: Schema.optional(Timestamp),
  costUsdMicros: Schema.optional(NonNegativeInteger),
  datasetCaseId: Schema.optional(PublicId),
  error: Schema.optional(EvaluationError),
  latencyMs: Schema.optional(NonNegativeInteger),
  notApplicable: Schema.Array(PublicId),
  runId: Schema.optional(PublicId),
  runStatus: Schema.optional(Schema.String),
  scores: Schema.Array(
    Schema.Struct({
      errorClass: Schema.optional(EvaluatorErrorClass),
      executionStatus: Schema.Literals(["error", "succeeded"]),
      passed: Schema.optional(Schema.Boolean),
      revision: NonNegativeInteger,
      scoreDefinitionId: PublicId,
      value: Schema.optional(ScoreThreshold),
    }),
  ),
  sourceTraceId: Schema.optional(EvaluationTraceId),
  status: Schema.Literals(["dispatched", "failed", "pending", "scored", "submitted", "timed_out"]),
  submittedAt: Schema.optional(Timestamp),
  threadId: Schema.optional(PublicId),
  totalTokens: Schema.optional(NonNegativeInteger),
  traceId: Schema.optional(EvaluationTraceId),
});

export const ListEvaluationRunResultsResponse = ListPage(EvaluationCaseResultResponse);

export const ComparisonGatePolicy = Schema.Struct({
  maxEvaluatorErrorRate: ScoreThreshold,
  maxMeanDecrease: ScoreThreshold,
  maxMissingEvidenceRate: ScoreThreshold,
  maxNewFailures: boundedInteger("Allowed new failures", 0, 500),
  maxPassRateDecrease: ScoreThreshold,
  minComparableCases: boundedInteger("Minimum comparable cases", 1, 500),
});

export const CreateReleaseComparisonRequest = Schema.Struct({
  baselineReleaseId: PublicId,
  candidateReleaseId: PublicId,
  caseTimeoutSeconds: Schema.optional(CaseTimeoutSeconds),
  concurrency: Schema.optional(Concurrency),
  datasetId: PublicId,
  gatePolicy: Schema.optional(
    Schema.Struct({
      maxEvaluatorErrorRate: Schema.optional(ScoreThreshold),
      maxMeanDecrease: Schema.optional(ScoreThreshold),
      maxMissingEvidenceRate: Schema.optional(ScoreThreshold),
      maxNewFailures: Schema.optional(boundedInteger("Allowed new failures", 0, 500)),
      maxPassRateDecrease: Schema.optional(ScoreThreshold),
      minComparableCases: Schema.optional(boundedInteger("Minimum comparable cases", 1, 500)),
    }),
  ),
  /** Both releases run with this deployment's runtime configuration snapshot. */
  runtimeConfigFromAgentDeploymentId: Schema.optional(PublicId),
  scoreDefinitionIds: ScoreDefinitionIds,
}).check(
  Schema.makeFilter((request) =>
    request.baselineReleaseId !== request.candidateReleaseId
      ? undefined
      : "Baseline and candidate releases must differ.",
  ),
);

const ReportArtifact = Schema.Struct({
  contentType: Schema.String,
  downloadUrl: Schema.String,
  downloadUrlExpiresAt: Timestamp,
  sha256: EvaluationSha256,
  sizeBytes: NonNegativeInteger,
});

const ComparisonArm = Schema.Struct({
  agentReleaseId: PublicId,
  evaluationRunId: PublicId,
  releaseContentHash: Schema.optional(Schema.String),
});

const ArmTotals = Schema.Struct({ baseline: NonNegativeInteger, candidate: NonNegativeInteger });

export const ReleaseComparisonResponse = Schema.Struct({
  baseline: ComparisonArm,
  candidate: ComparisonArm,
  completedAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
  datasetId: PublicId,
  error: Schema.optional(EvaluationError),
  gateMode: Schema.Literal("advisory"),
  gatePolicy: ComparisonGatePolicy,
  id: PublicId,
  reasons: Schema.Array(Schema.String),
  report: Schema.optional(Schema.Struct({ json: ReportArtifact, markdown: ReportArtifact })),
  runtimeConfigFromAgentDeploymentId: Schema.optional(PublicId),
  scoreDefinitions: Schema.Array(FrozenScoreDefinitionResponse),
  status: Schema.Literals(["completed", "failed", "queued", "running"]),
  summary: Schema.optional(
    Schema.Struct({
      comparableCases: NonNegativeInteger,
      costUsdMicros: Schema.Struct({
        baselineTotal: NonNegativeInteger,
        candidateTotal: NonNegativeInteger,
        delta: SignedNumber,
      }),
      definitions: Schema.Array(
        Schema.Struct({
          baselineMean: Schema.optional(ScoreThreshold),
          baselinePassRate: Schema.optional(ScoreThreshold),
          candidateMean: Schema.optional(ScoreThreshold),
          candidatePassRate: Schema.optional(ScoreThreshold),
          meanDelta: Schema.optional(SignedNumber),
          name: EvaluationResourceName,
          passRateDelta: Schema.optional(SignedNumber),
          revision: NonNegativeInteger,
          scoreDefinitionId: PublicId,
        }),
      ),
      evaluatorErrors: ArmTotals,
      latency: Schema.Struct({
        baselineP50Ms: Schema.optional(NonNegativeInteger),
        baselineP95Ms: Schema.optional(NonNegativeInteger),
        candidateP50Ms: Schema.optional(NonNegativeInteger),
        candidateP95Ms: Schema.optional(NonNegativeInteger),
        p50DeltaMs: Schema.optional(SignedNumber),
        p95DeltaMs: Schema.optional(SignedNumber),
      }),
      missingEvidence: ArmTotals,
      regressions: NonNegativeInteger,
      tokens: Schema.Struct({
        baselineTotal: NonNegativeInteger,
        candidateTotal: NonNegativeInteger,
        delta: SignedNumber,
      }),
      totalCases: NonNegativeInteger,
    }),
  ),
  updatedAt: Timestamp,
  verdict: Schema.optional(Schema.Literals(["error", "fail", "pass"])),
  version: NonNegativeInteger,
});

/** List items omit `report`; fetch the comparison for fresh report download URLs. */
export const ListReleaseComparisonsResponse = ListPage(ReleaseComparisonResponse);

export const EVALUATION_API_SCHEMAS = {
  AddDatasetCaseRequest,
  AddDatasetCaseResponse,
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
  ListAnnotationsResponse,
  ListDatasetCasesResponse,
  ListEvaluationRunResultsResponse,
  ListEvaluationRunsResponse,
  ListRegressionDatasetsResponse,
  ListReleaseComparisonsResponse,
  ListScoreDefinitionsResponse,
  ListScoreResultsResponse,
  RecordScoreResultRequest,
  RegressionDatasetResponse,
  ReleaseComparisonResponse,
  ReviseScoreDefinitionRequest,
  ScoreDefinitionResponse,
  ScoreResultResponse,
} as const;

export type EvaluationApiSchemaName = keyof typeof EVALUATION_API_SCHEMAS;
export type CreateScoreDefinitionRequest = typeof CreateScoreDefinitionRequest.Type;
export type ReviseScoreDefinitionRequest = typeof ReviseScoreDefinitionRequest.Type;
export type ScoreDefinitionResponse = typeof ScoreDefinitionResponse.Type;
export type ScoreResultResponse = typeof ScoreResultResponse.Type;
export type RecordScoreResultRequest = typeof RecordScoreResultRequest.Type;
export type AnnotationResponse = typeof AnnotationResponse.Type;
export type CreateAnnotationRequest = typeof CreateAnnotationRequest.Type;
export type RegressionDatasetResponse = typeof RegressionDatasetResponse.Type;
export type CreateRegressionDatasetRequest = typeof CreateRegressionDatasetRequest.Type;
export type DatasetCaseResponse = typeof DatasetCaseResponse.Type;
export type AddDatasetCaseRequest = typeof AddDatasetCaseRequest.Type;
export type ImportedCase = typeof ImportedCase.Type;
export type ImportDatasetCasesRequest = typeof ImportDatasetCasesRequest.Type;
export type ImportDatasetCasesResponse = typeof ImportDatasetCasesResponse.Type;
export type CreateEvaluationRunRequest = typeof CreateEvaluationRunRequest.Type;
export type EvaluationRunResponse = typeof EvaluationRunResponse.Type;
export type EvaluationCaseResultResponse = typeof EvaluationCaseResultResponse.Type;
export type CreateReleaseComparisonRequest = typeof CreateReleaseComparisonRequest.Type;
export type ReleaseComparisonResponse = typeof ReleaseComparisonResponse.Type;
