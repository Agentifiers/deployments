import { SpanId, TraceId } from "@deployments-ai/observability";
import {
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
import { Ulid } from "../ids.ts";
import {
  BlobReference,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

export const MAX_EVALUATION_SCORE_DEFINITIONS = 20;
export const MAX_EVALUATION_TRACE_IDS = 100;
export const MAX_EVALUATION_DATASET_CASES = 500;

function boundedString(label: string, maximum: number) {
  return Schema.String.check(
    Schema.isMinLength(1, { message: `${label} must not be empty.` }),
    Schema.isMaxLength(maximum, { message: `${label} must not exceed ${maximum} characters.` }),
  );
}

function boundedList<S extends Schema.Top>(item: S, label: string, maximum: number) {
  return Schema.Array(item).check(
    Schema.isMaxLength(maximum, { message: `${label} must not exceed ${maximum} entries.` }),
  );
}

const PositiveSafeInteger = NonNegativeSafeInteger.check(
  Schema.isGreaterThanOrEqualTo(1, { message: "Value must be at least 1." }),
);

export const EvaluationResourceName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u, {
    message:
      "Names must be 1-64 lowercase letters, digits, '.', '_', or '-' and start with a letter or digit.",
  }),
);
export const EvaluationDescription = boundedString("Descriptions", 500);
export const Sha256Hex = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u, { message: "Hashes must be lowercase SHA-256 hex." }),
);
const ResourceStatus = Schema.Literals(["active", "archived"]);

const EvaluationError = Schema.Struct({
  code: boundedString("Error codes", 128),
  message: boundedString("Error messages", 1_000),
});

export const ScoreDefinitionRecord = makeRecordSchema("score-definition", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  archivedAt: Schema.optional(Timestamp),
  createdByPrincipalId: NonEmptyString,
  currentRevision: PositiveSafeInteger,
  description: Schema.optional(EvaluationDescription),
  id: Ulid,
  name: EvaluationResourceName,
  ownerPrincipalId: NonEmptyString,
  status: ResourceStatus,
  type: ScoreDefinitionType,
});
export type ScoreDefinitionRecord = typeof ScoreDefinitionRecord.Type;

/** One immutable evaluator configuration; later revisions supersede it without mutating it. */
export const ScoreDefinitionRevisionRecord = makeRecordSchema("score-definition-revision", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  createdByPrincipalId: NonEmptyString,
  evaluator: EvaluatorConfig,
  evaluatorVersionHash: Sha256Hex,
  id: Ulid,
  judgeModelId: Schema.optional(NonEmptyString),
  judgePromptHash: Schema.optional(Sha256Hex),
  revision: PositiveSafeInteger,
  sampling: ScoreSamplingPolicy,
  scoreDefinitionId: Ulid,
  status: Schema.Literals(["active", "archived", "superseded"]),
  supersededAt: Schema.optional(Timestamp),
  target: ScoreTarget,
  threshold: ScoreThreshold,
  weight: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type ScoreDefinitionRevisionRecord = typeof ScoreDefinitionRevisionRecord.Type;

export const RegressionDatasetRecord = makeRecordSchema("regression-dataset", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  archivedAt: Schema.optional(Timestamp),
  caseCount: NonNegativeSafeInteger.check(
    Schema.isLessThanOrEqualTo(MAX_EVALUATION_DATASET_CASES, {
      message: `Regression datasets support at most ${MAX_EVALUATION_DATASET_CASES} cases.`,
    }),
  ),
  createdByPrincipalId: NonEmptyString,
  description: Schema.optional(EvaluationDescription),
  id: Ulid,
  name: EvaluationResourceName,
  ownerPrincipalId: NonEmptyString,
  retentionDays: Schema.optional(
    NonNegativeSafeInteger.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(3_650),
    ),
  ),
  status: ResourceStatus,
});
export type RegressionDatasetRecord = typeof RegressionDatasetRecord.Type;

export const DatasetCaseExpectationKind = Schema.Literals([
  "constraints",
  "jsonSchema",
  "matches",
  "mustInclude",
  "mustNot",
  "mustNotUseTools",
  "mustUseTools",
]);

/** Immutable case metadata; the case material bytes live in the artifact bucket. */
export const DatasetCaseRecord = makeRecordSchema("dataset-case", {
  ...tenantScopeFields,
  consentBasis: Schema.optional(boundedString("Consent basis", 200)),
  contentSha256: Sha256Hex,
  createdAt: Timestamp,
  createdByPrincipalId: NonEmptyString,
  datasetId: Ulid,
  expectationKinds: boundedList(DatasetCaseExpectationKind, "Expectation kinds", 7),
  externalId: Schema.optional(boundedString("External case IDs", 128)),
  id: Ulid,
  inputPreview: boundedString("Input previews", 200),
  material: BlobReference,
  provenance: Schema.Literals(["annotation", "import", "manual", "trace"]),
  sourceRunId: Schema.optional(Ulid),
  sourceThreadId: Schema.optional(Ulid),
  sourceTraceId: Schema.optional(TraceId),
  tags: boundedList(boundedString("Tags", 64), "Tags", 20),
}).pipe(
  Schema.refine(
    (record): record is typeof record => record.data.material.sha256 === record.data.contentSha256,
    {
      message: "Dataset case material must match its content hash.",
    },
  ),
);
export type DatasetCaseRecord = typeof DatasetCaseRecord.Type;

export const FrozenScoreDefinition = Schema.Struct({
  evaluatorVersionHash: Sha256Hex,
  name: EvaluationResourceName,
  revision: PositiveSafeInteger,
  scoreDefinitionId: Ulid,
  threshold: ScoreThreshold,
  type: ScoreDefinitionType,
});
export type FrozenScoreDefinition = typeof FrozenScoreDefinition.Type;

export const EvaluationTarget = Schema.Struct({
  agentDeploymentId: Schema.optional(Ulid),
  agentReleaseId: Ulid,
  type: Schema.Literals(["deployment", "release"]),
});
export type EvaluationTarget = typeof EvaluationTarget.Type;

export const EvaluationCounts = Schema.Struct({
  failed: NonNegativeSafeInteger,
  pending: NonNegativeSafeInteger,
  running: NonNegativeSafeInteger,
  scored: NonNegativeSafeInteger,
  timedOut: NonNegativeSafeInteger,
});
export type EvaluationCounts = typeof EvaluationCounts.Type;

export const EvaluationDefinitionSummary = Schema.Struct({
  errors: NonNegativeSafeInteger,
  mean: Schema.optional(ScoreThreshold),
  passRate: Schema.optional(ScoreThreshold),
  passed: NonNegativeSafeInteger,
  revision: PositiveSafeInteger,
  scoreDefinitionId: Ulid,
  scored: NonNegativeSafeInteger,
});

export const EvaluationRunSummary = Schema.Struct({
  costUsdMicros: NonNegativeSafeInteger,
  definitions: boundedList(
    EvaluationDefinitionSummary,
    "Definition summaries",
    MAX_EVALUATION_SCORE_DEFINITIONS,
  ),
  latencyP50Ms: Schema.optional(NonNegativeSafeInteger),
  latencyP95Ms: Schema.optional(NonNegativeSafeInteger),
  totalTokens: NonNegativeSafeInteger,
});
export type EvaluationRunSummary = typeof EvaluationRunSummary.Type;

export const EvaluationRunRecord = makeRecordSchema("evaluation-run", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  caseCount: NonNegativeSafeInteger,
  caseTimeoutSeconds: NonNegativeSafeInteger.check(
    Schema.isGreaterThanOrEqualTo(30),
    Schema.isLessThanOrEqualTo(3_600),
  ),
  comparison: Schema.optional(
    Schema.Struct({
      releaseComparisonId: Ulid,
      role: Schema.Literals(["baseline", "candidate"]),
    }),
  ),
  completedAt: Schema.optional(Timestamp),
  concurrency: NonNegativeSafeInteger.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(20),
  ),
  counts: EvaluationCounts,
  createdByPrincipalId: NonEmptyString,
  datasetId: Schema.optional(Ulid),
  error: Schema.optional(EvaluationError),
  executionBindingId: Schema.optional(NonEmptyString),
  id: Ulid,
  idempotencyKey: NonEmptyString,
  kind: Schema.Literals(["dataset-replay", "trace-score"]),
  runtimeConfigFromAgentDeploymentId: Schema.optional(Ulid),
  scoreDefinitions: boundedList(
    FrozenScoreDefinition,
    "Score definitions",
    MAX_EVALUATION_SCORE_DEFINITIONS,
  ).check(Schema.isMinLength(1, { message: "Evaluation runs require a score definition." })),
  startedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["canceled", "completed", "failed", "queued", "running"]),
  summary: Schema.optional(EvaluationRunSummary),
  target: Schema.optional(EvaluationTarget),
  traceIds: Schema.optional(boundedList(TraceId, "Trace IDs", MAX_EVALUATION_TRACE_IDS)),
}).pipe(
  Schema.refine(
    (record): record is typeof record =>
      record.data.kind === "dataset-replay"
        ? record.data.datasetId !== undefined &&
          record.data.target !== undefined &&
          record.data.traceIds === undefined
        : record.data.traceIds !== undefined &&
          record.data.traceIds.length > 0 &&
          record.data.datasetId === undefined &&
          record.data.target === undefined,
    {
      message:
        "Dataset replays require a dataset and target; trace scoring requires trace IDs only.",
    },
  ),
);
export type EvaluationRunRecord = typeof EvaluationRunRecord.Type;

export const CaseScoreSummary = Schema.Struct({
  errorClass: Schema.optional(EvaluatorErrorClass),
  executionStatus: Schema.Literals(["error", "succeeded"]),
  passed: Schema.optional(Schema.Boolean),
  revision: PositiveSafeInteger,
  scoreDefinitionId: Ulid,
  value: Schema.optional(ScoreThreshold),
});
export type CaseScoreSummary = typeof CaseScoreSummary.Type;

export const EVALUATION_CASE_TERMINAL_STATUSES = ["failed", "scored", "timed_out"] as const;

export const EvaluationCaseRunRecord = makeRecordSchema("evaluation-case-run", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  attempts: NonNegativeSafeInteger,
  caseKey: boundedString("Case keys", 64),
  completedAt: Schema.optional(Timestamp),
  datasetCaseId: Schema.optional(Ulid),
  deadlineAt: Schema.optional(Timestamp),
  dispatchedAt: Schema.optional(Timestamp),
  error: Schema.optional(EvaluationError),
  evaluationRunId: Ulid,
  latencyMs: Schema.optional(NonNegativeSafeInteger),
  costUsdMicros: Schema.optional(NonNegativeSafeInteger),
  notApplicable: boundedList(Ulid, "Not applicable definitions", MAX_EVALUATION_SCORE_DEFINITIONS),
  runId: Schema.optional(Ulid),
  runIdempotencyKey: Schema.optional(NonEmptyString),
  runStatus: Schema.optional(NonEmptyString),
  scores: boundedList(CaseScoreSummary, "Case scores", MAX_EVALUATION_SCORE_DEFINITIONS),
  sourceTraceId: Schema.optional(TraceId),
  status: Schema.Literals(["dispatched", "failed", "pending", "scored", "submitted", "timed_out"]),
  submittedAt: Schema.optional(Timestamp),
  threadId: Schema.optional(Ulid),
  totalTokens: Schema.optional(NonNegativeSafeInteger),
  traceId: Schema.optional(TraceId),
});
export type EvaluationCaseRunRecord = typeof EvaluationCaseRunRecord.Type;

export const ScoreEvidenceReference = Schema.Struct({
  id: boundedString("Evidence IDs", 128),
  kind: Schema.Literals(["message", "run", "tool-call", "trace"]),
});

export const ScoreResultRecord = makeRecordSchema("score-result", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  agentDeploymentId: Schema.optional(Ulid),
  agentReleaseId: Schema.optional(Ulid),
  datasetCaseId: Schema.optional(Ulid),
  durationMs: NonNegativeSafeInteger,
  errorClass: Schema.optional(EvaluatorErrorClass),
  errorMessage: Schema.optional(boundedString("Evaluator error messages", 1_000)),
  evaluationRunId: Schema.optional(Ulid),
  evaluatorVersionHash: Sha256Hex,
  evidenceRefs: boundedList(ScoreEvidenceReference, "Evidence references", 20),
  executionStatus: Schema.Literals(["error", "succeeded"]),
  humanActorPrincipalId: Schema.optional(NonEmptyString),
  id: Ulid,
  idempotencyKey: NonEmptyString,
  judge: Schema.optional(
    Schema.Struct({
      costUsdMicros: Schema.optional(NonNegativeSafeInteger),
      inputTokens: Schema.optional(NonNegativeSafeInteger),
      internalEvaluator: Schema.Literal(true),
      modelId: NonEmptyString,
      outputTokens: Schema.optional(NonNegativeSafeInteger),
    }),
  ),
  label: Schema.optional(boundedString("Score labels", MAX_SCORE_LABEL_LENGTH)),
  passed: Schema.optional(Schema.Boolean),
  rationale: Schema.optional(boundedString("Score rationales", MAX_SCORE_RATIONALE_LENGTH)),
  revision: PositiveSafeInteger,
  runId: Schema.optional(Ulid),
  scoreDefinitionId: Ulid,
  scoreType: ScoreDefinitionType,
  source: Schema.Literals(["api", "automatic", "evaluation-run"]),
  spanId: Schema.optional(SpanId),
  threadId: Schema.optional(Ulid),
  threshold: ScoreThreshold,
  traceId: TraceId,
  value: Schema.optional(ScoreThreshold),
}).pipe(
  Schema.refine(
    (record): record is typeof record =>
      record.data.executionStatus === "succeeded"
        ? record.data.value !== undefined &&
          record.data.passed === record.data.value >= record.data.threshold &&
          record.data.errorClass === undefined
        : record.data.value === undefined &&
          record.data.passed === undefined &&
          record.data.errorClass !== undefined,
    {
      message:
        "Succeeded scores require a value whose pass state matches the threshold; evaluator errors carry an error class and never a value.",
    },
  ),
);
export type ScoreResultRecord = typeof ScoreResultRecord.Type;

export const AnnotationRecord = makeRecordSchema("annotation", {
  ...tenantScopeFields,
  authorPrincipalId: NonEmptyString,
  body: boundedString("Annotation bodies", 4_000),
  createdAt: Timestamp,
  id: Ulid,
  label: Schema.optional(boundedString("Annotation labels", MAX_SCORE_LABEL_LENGTH)),
  runId: Schema.optional(Ulid),
  spanId: Schema.optional(SpanId),
  tags: boundedList(boundedString("Tags", 64), "Tags", 10),
  threadId: Schema.optional(Ulid),
  traceId: TraceId,
});
export type AnnotationRecord = typeof AnnotationRecord.Type;

export const ComparisonArm = Schema.Struct({
  agentDeploymentId: Schema.optional(Ulid),
  agentReleaseId: Ulid,
  evaluationRunId: Ulid,
  releaseContentHash: Schema.optional(NonEmptyString),
});

const ComparisonGatePolicyRecord = Schema.Struct({
  maxEvaluatorErrorRate: ScoreThreshold,
  maxMeanDecrease: ScoreThreshold,
  maxMissingEvidenceRate: ScoreThreshold,
  maxNewFailures: NonNegativeSafeInteger,
  maxPassRateDecrease: ScoreThreshold,
  minComparableCases: PositiveSafeInteger,
});

const ArmTotals = Schema.Struct({
  baseline: NonNegativeSafeInteger,
  candidate: NonNegativeSafeInteger,
});
const SignedNumber = Schema.Number.check(Schema.isFinite());

export const ReleaseComparisonSummary = Schema.Struct({
  comparableCases: NonNegativeSafeInteger,
  costUsdMicros: Schema.Struct({
    baselineTotal: NonNegativeSafeInteger,
    candidateTotal: NonNegativeSafeInteger,
    delta: SignedNumber,
  }),
  definitions: boundedList(
    Schema.Struct({
      baselineMean: Schema.optional(ScoreThreshold),
      baselinePassRate: Schema.optional(ScoreThreshold),
      candidateMean: Schema.optional(ScoreThreshold),
      candidatePassRate: Schema.optional(ScoreThreshold),
      meanDelta: Schema.optional(SignedNumber),
      name: EvaluationResourceName,
      passRateDelta: Schema.optional(SignedNumber),
      revision: PositiveSafeInteger,
      scoreDefinitionId: Ulid,
    }),
    "Definition comparisons",
    MAX_EVALUATION_SCORE_DEFINITIONS,
  ),
  evaluatorErrors: ArmTotals,
  latency: Schema.Struct({
    baselineP50Ms: Schema.optional(NonNegativeSafeInteger),
    baselineP95Ms: Schema.optional(NonNegativeSafeInteger),
    candidateP50Ms: Schema.optional(NonNegativeSafeInteger),
    candidateP95Ms: Schema.optional(NonNegativeSafeInteger),
    p50DeltaMs: Schema.optional(SignedNumber),
    p95DeltaMs: Schema.optional(SignedNumber),
  }),
  missingEvidence: ArmTotals,
  regressions: NonNegativeSafeInteger,
  tokens: Schema.Struct({
    baselineTotal: NonNegativeSafeInteger,
    candidateTotal: NonNegativeSafeInteger,
    delta: SignedNumber,
  }),
  totalCases: NonNegativeSafeInteger,
});
export type ReleaseComparisonSummary = typeof ReleaseComparisonSummary.Type;

export const ReleaseComparisonRecord = makeRecordSchema("release-comparison", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  baseline: ComparisonArm,
  candidate: ComparisonArm,
  completedAt: Schema.optional(Timestamp),
  createdByPrincipalId: NonEmptyString,
  datasetId: Ulid,
  error: Schema.optional(EvaluationError),
  gateMode: Schema.Literal("advisory"),
  gatePolicy: ComparisonGatePolicyRecord,
  id: Ulid,
  idempotencyKey: NonEmptyString,
  reasons: boundedList(boundedString("Verdict reasons", 1_000), "Verdict reasons", 50),
  reportJson: Schema.optional(BlobReference),
  reportMarkdown: Schema.optional(BlobReference),
  runtimeConfigFromAgentDeploymentId: Schema.optional(Ulid),
  scoreDefinitions: boundedList(
    FrozenScoreDefinition,
    "Score definitions",
    MAX_EVALUATION_SCORE_DEFINITIONS,
  ).check(Schema.isMinLength(1, { message: "Comparisons require a score definition." })),
  status: Schema.Literals(["completed", "failed", "queued", "running"]),
  summary: Schema.optional(ReleaseComparisonSummary),
  verdict: Schema.optional(Schema.Literals(["error", "fail", "pass"])),
}).pipe(
  Schema.refine(
    (record): record is typeof record =>
      record.data.status !== "completed" ||
      (record.data.verdict !== undefined &&
        record.data.summary !== undefined &&
        record.data.reportMarkdown !== undefined &&
        record.data.reportJson !== undefined),
    { message: "Completed comparisons require a verdict, summary, and report artifacts." },
  ),
);
export type ReleaseComparisonRecord = typeof ReleaseComparisonRecord.Type;

export const EVALUATION_CONTROL_RECORD_SCHEMAS = {
  "dataset-case": DatasetCaseRecord,
  "regression-dataset": RegressionDatasetRecord,
  "score-definition": ScoreDefinitionRecord,
  "score-definition-revision": ScoreDefinitionRevisionRecord,
} as const;

export const EVALUATION_EXECUTION_RECORD_SCHEMAS = {
  annotation: AnnotationRecord,
  "evaluation-case-run": EvaluationCaseRunRecord,
  "evaluation-run": EvaluationRunRecord,
  "release-comparison": ReleaseComparisonRecord,
  "score-result": ScoreResultRecord,
} as const;
