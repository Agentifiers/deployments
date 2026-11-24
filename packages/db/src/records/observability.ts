import {
  CaptureMode,
  OBSERVABILITY_REDACTION_POLICY_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
  SpanId,
  TraceId,
} from "@deployments-ai/observability";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  BlobReference,
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  stateVersionFields,
  workspaceScopeFields,
} from "../record-schema.ts";
import {
  ExecutionPurpose,
  hasConsistentExecutionPins,
  type BoundExecutionPins,
  type CustomerExecutionPins,
  type WithExecutionPins,
} from "./execution-bindings.ts";

export const MAX_TRACE_RUNS = 1_024;

/**
 * Agent identity (definition, deployment, release, release selection, trigger, purpose) is
 * snapshotted from the root run when the trace finalizes. `errorClass` and `durationMs` describe
 * the finalized outcome, so they exist only on finalized traces, and `errorClass` only on errors.
 */
const TraceRecordBase = makeRecordSchema("trace", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDefinitionId: Schema.optional(Ulid),
  agentDeploymentId: Schema.optional(Ulid),
  agentReleaseId: Schema.optional(Ulid),
  captureMode: CaptureMode,
  completedAt: Schema.optional(Timestamp),
  durationMs: Schema.optional(NonNegativeSafeInteger),
  errorClass: Schema.optional(NonEmptyString),
  executionPurpose: Schema.optional(ExecutionPurpose),
  finalizedAt: Schema.optional(Timestamp),
  graphWatermark: Schema.optional(NonEmptyString),
  id: TraceId,
  outcome: Schema.optional(Schema.Literals(["canceled", "error", "ok"])),
  redactionPolicyVersion: Schema.Literal(OBSERVABILITY_REDACTION_POLICY_VERSION),
  releaseSelection: Schema.optional(Schema.Literals(["candidate", "primary"])),
  rootRunId: Ulid,
  rootSpanId: SpanId,
  runIds: Schema.Array(Ulid).pipe(
    Schema.check(
      Schema.isMaxLength(MAX_TRACE_RUNS, {
        message: `Trace graphs must not exceed ${MAX_TRACE_RUNS} runs.`,
      }),
    ),
  ),
  terminalRunIds: Schema.optional(
    Schema.Array(Ulid).pipe(
      Schema.check(
        Schema.isMaxLength(MAX_TRACE_RUNS, {
          message: `Trace terminal watermarks must not exceed ${MAX_TRACE_RUNS} runs.`,
        }),
      ),
    ),
  ),
  schemaVersion: Schema.Literal(OBSERVABILITY_SCHEMA_VERSION),
  sessionId: Ulid,
  status: Schema.Literals(["finalized", "open"]),
  totalCostUsdMicros: Schema.optional(NonNegativeSafeInteger),
  totalTokens: Schema.optional(NonNegativeSafeInteger),
  traceId: TraceId,
  trigger: Schema.optional(NonEmptyString),
});

export const TraceRecord = TraceRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof TraceRecordBase.Type>((record) => {
      if (
        record.data.status !== "finalized" &&
        (record.data.durationMs !== undefined || record.data.errorClass !== undefined)
      ) {
        return "Trace durationMs and errorClass exist only on finalized traces.";
      }
      return record.data.errorClass !== undefined && record.data.outcome !== "error"
        ? "Trace errorClass exists only when the trace outcome is error."
        : undefined;
    }),
  ),
);

const ModelInvocationRecordBase = makeRecordSchema("model-invocation", {
  ...stateVersionFields,
  ...workspaceScopeFields,
  actualModelId: Schema.optional(NonEmptyString),
  actualProvider: Schema.optional(NonEmptyString),
  agentDefinitionId: Schema.optional(Ulid),
  agentDeploymentId: Schema.optional(Ulid),
  agentManifestHash: NonEmptyString,
  agentReleaseId: Schema.optional(Ulid),
  attemptId: NonEmptyString,
  cachedTokens: Schema.optional(NonNegativeSafeInteger),
  captureMode: CaptureMode,
  completedAt: Timestamp,
  costUsdMicros: Schema.optional(NonNegativeSafeInteger),
  currency: Schema.Literal("USD"),
  errorClass: Schema.optional(NonEmptyString),
  fallbackAttempt: NonNegativeSafeInteger,
  fallbackReason: Schema.optional(NonEmptyString),
  firstTokenAt: Schema.optional(Timestamp),
  executionBindingId: Schema.optional(Ulid),
  executionPurpose: Schema.optional(ExecutionPurpose),
  id: Ulid,
  inputTokens: Schema.optional(NonNegativeSafeInteger),
  internalEvaluator: Schema.Boolean,
  invocationId: NonEmptyString,
  /** Absent only on records written before invocation kinds were stamped. */
  invocationKind: Schema.optional(Schema.Literals(["assistant", "response-depth"])),
  /** Per-run model generation index; absent only on records written before it was stamped. */
  modelCallIndex: Schema.optional(NonNegativeSafeInteger),
  outputTokens: Schema.optional(NonNegativeSafeInteger),
  parentSpanId: SpanId,
  persistedAt: Timestamp,
  pricingVersion: Schema.optional(NonEmptyString),
  providerRequestId: Schema.optional(NonEmptyString),
  providerTokenDetails: Schema.optional(Metadata),
  redactionPolicyVersion: Schema.Literal(OBSERVABILITY_REDACTION_POLICY_VERSION),
  requestBodyRef: Schema.optional(BlobReference),
  requestSummary: Schema.optional(Schema.String),
  requestedModelId: NonEmptyString,
  requestedProvider: Schema.optional(NonEmptyString),
  responseBodyRef: Schema.optional(BlobReference),
  responseSummary: Schema.optional(Schema.String),
  runAttempt: NonNegativeSafeInteger,
  runExecutionVersion: NonNegativeSafeInteger,
  runId: Ulid,
  schemaVersion: Schema.Literal(OBSERVABILITY_SCHEMA_VERSION),
  spanId: SpanId,
  startedAt: Timestamp,
  status: Schema.Literals(["canceled", "failed", "succeeded"]),
  stopReason: Schema.optional(NonEmptyString),
  streaming: Schema.Boolean,
  threadId: Ulid,
  totalTokens: Schema.optional(NonNegativeSafeInteger),
  traceId: TraceId,
  usageIdempotencyKey: Schema.optional(NonEmptyString),
});

/**
 * Customer invocations pin a deployment, release and definition. Preview/evaluation invocations
 * pin an execution binding and carry a release/definition only when the binding came from a
 * published release (manifest-sourced bindings have neither).
 */
export type ModelInvocationRecord = WithExecutionPins<
  typeof ModelInvocationRecordBase.Type,
  CustomerExecutionPins & { readonly agentDefinitionId: Ulid; readonly agentReleaseId: Ulid },
  BoundExecutionPins & { readonly agentDefinitionId?: Ulid; readonly agentReleaseId?: Ulid }
>;

export const ModelInvocationRecord = ModelInvocationRecordBase.pipe(
  Schema.refine(
    (record): record is ModelInvocationRecord =>
      hasConsistentExecutionPins(record.data) &&
      (record.data.agentDeploymentId === undefined ||
        (record.data.agentReleaseId !== undefined && record.data.agentDefinitionId !== undefined)),
    {
      identifier: "ModelInvocationExecutionPins",
      message:
        "Customer model invocations require agentDeploymentId, agentDefinitionId and agentReleaseId; preview and evaluation invocations require executionBindingId.",
    },
  ),
  Schema.refine(
    (record): record is ModelInvocationRecord => {
      const startedAt = Date.parse(record.data.startedAt);
      const completedAt = Date.parse(record.data.completedAt);
      const firstTokenAt = record.data.firstTokenAt
        ? Date.parse(record.data.firstTokenAt)
        : undefined;
      const metadataOnlyHasContent =
        record.data.captureMode === "metadata-only" &&
        (record.data.requestSummary !== undefined ||
          record.data.responseSummary !== undefined ||
          record.data.requestBodyRef !== undefined ||
          record.data.responseBodyRef !== undefined);
      const usageMismatch =
        record.data.totalTokens !== undefined && record.data.usageIdempotencyKey === undefined;
      return (
        completedAt >= startedAt &&
        (firstTokenAt === undefined ||
          (firstTokenAt >= startedAt && firstTokenAt <= completedAt)) &&
        !metadataOnlyHasContent &&
        !usageMismatch
      );
    },
    {
      identifier: "ModelInvocationTimingAndCapture",
      message:
        "Model invocation timing must be ordered, metered attempts need usage identity, and metadata-only records cannot retain content.",
    },
  ),
);
