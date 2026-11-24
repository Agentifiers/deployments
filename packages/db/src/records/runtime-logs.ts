import {
  CaptureMode,
  RUNTIME_LOG_LIMITS,
  RuntimeLogLevel,
  RuntimeLogSource,
  SpanId,
  TraceId,
} from "@deployments-ai/observability";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  tenantScopeFields,
} from "../record-schema.ts";

const RuntimeLogAttributes = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Boolean, Schema.Number, Schema.String]),
).pipe(
  Schema.check(
    Schema.makeFilter<Readonly<Record<string, boolean | number | string>>>((attributes) =>
      Object.keys(attributes).length <= RUNTIME_LOG_LIMITS.attributes
        ? undefined
        : `Runtime log lines keep at most ${RUNTIME_LOG_LIMITS.attributes} attributes.`,
    ),
  ),
);

export const RuntimeLogLine = Schema.Struct({
  attributes: Schema.optional(RuntimeLogAttributes),
  level: RuntimeLogLevel,
  message: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(RUNTIME_LOG_LIMITS.messageCharacters)),
  ),
  /** Position within the batch; with the batch it orders lines that share a millisecond. */
  sequence: NonNegativeSafeInteger,
  source: RuntimeLogSource,
  spanId: Schema.optional(SpanId),
  time: Timestamp,
  toolCallId: Schema.optional(Ulid),
});
export type RuntimeLogLine = typeof RuntimeLogLine.Type;

/**
 * Up to `RUNTIME_LOG_LIMITS.batchLines` lines the runtime logged during one claimed execution of
 * a run. Batches are immutable; their sort key orders them by execution attempt, then batch.
 */
export const RuntimeLogBatchRecord = makeRecordSchema(
  "runtime-log-batch",
  {
    ...tenantScopeFields,
    agentDeploymentId: Schema.optional(Ulid),
    attempt: NonNegativeSafeInteger,
    batch: NonNegativeSafeInteger,
    captureMode: CaptureMode,
    createdAt: Timestamp,
    /** `createdAt` plus `RUNTIME_LOG_RETENTION_DAYS`; readers skip the batch from then on. */
    expiresAt: Timestamp,
    lines: Schema.Array(RuntimeLogLine).pipe(
      Schema.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(RUNTIME_LOG_LIMITS.batchLines, {
          message: `Runtime log batches hold at most ${RUNTIME_LOG_LIMITS.batchLines} lines.`,
        }),
      ),
    ),
    runId: Ulid,
    threadId: Ulid,
    traceId: TraceId,
    workerId: Schema.optional(NonEmptyString),
  },
  { expiresAtField: "expiresAt" },
);
