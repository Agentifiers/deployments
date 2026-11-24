import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  CaptureMode,
  metadataOnlyAttributes,
  OBSERVABILITY_REDACTION_POLICY_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
} from "./capture.ts";
import { SpanId, TraceId } from "./identifier-codecs.ts";

export type JsonValue = boolean | null | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export const JsonValue: Schema.Codec<JsonValue> = Schema.Union([
  Schema.Boolean,
  Schema.Null,
  Schema.Number,
  Schema.String,
  Schema.Array(Schema.suspend((): Schema.Codec<JsonValue> => JsonValue)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<JsonValue> => JsonValue),
  ),
]);

export const JsonObject: Schema.Codec<JsonObject> = Schema.Record(
  Schema.String,
  Schema.suspend((): Schema.Codec<JsonValue> => JsonValue),
);

export const ObservabilitySpanKind = Schema.Literals([
  "agent",
  "approval_wait",
  "artifact",
  "custom",
  "memory",
  "model",
  "queue_wait",
  "run",
  "sandbox",
  "tool",
]);
export type ObservabilitySpanKind = typeof ObservabilitySpanKind.Type;

export const ObservabilitySpanStatus = Schema.Literals([
  "abandoned",
  "canceled",
  "error",
  "ok",
  "timed_out",
]);

export const ObservabilitySpan = Schema.Struct({
  captureMode: CaptureMode,
  durationMs: Schema.Number,
  endedAt: Schema.String,
  environmentId: Schema.String,
  errorClass: Schema.optional(Schema.String),
  kind: ObservabilitySpanKind,
  name: Schema.String,
  organizationId: Schema.String,
  parentSpanId: Schema.optional(SpanId),
  projectId: Schema.String,
  redactionPolicyVersion: Schema.Number,
  runId: Schema.String,
  schemaVersion: Schema.Number,
  sessionId: Schema.String,
  spanId: SpanId,
  startedAt: Schema.String,
  status: ObservabilitySpanStatus,
  traceId: TraceId,
  workspaceId: Schema.optional(Schema.String),
});
export type ObservabilitySpan = typeof ObservabilitySpan.Type;

export const ObservabilityFactType = Schema.Literals([
  "annotation.recorded",
  "incident.changed",
  "model-invocation.recorded",
  "record.deleted",
  "score.recorded",
  "signal.changed",
  "span.finalized",
  "trace.finalized",
  "usage.recorded",
]);
export type ObservabilityFactType = typeof ObservabilityFactType.Type;

export const ObservabilityFactSource = Schema.Struct({
  recordId: Schema.String,
  recordType: Schema.String,
  recordVersion: Schema.Number,
  streamArn: Schema.optional(Schema.String),
  streamSequenceNumber: Schema.optional(Schema.String),
  table: Schema.Literals(["execution", "usage"]),
});

export const ObservabilityFactScope = Schema.Struct({
  environmentId: Schema.String,
  organizationId: Schema.String,
  projectId: Schema.String,
  workspaceId: Schema.optional(Schema.String),
});

export const ObservabilityFactTrace = Schema.Struct({
  parentSpanId: Schema.optional(SpanId),
  runId: Schema.String,
  sessionId: Schema.String,
  spanId: SpanId,
  traceId: TraceId,
});

export const ObservabilityFact = Schema.Struct({
  captureMode: CaptureMode,
  factId: Schema.String,
  factType: ObservabilityFactType,
  normalizedAt: Schema.String,
  occurredAt: Schema.String,
  payload: JsonObject,
  redactionPolicyVersion: Schema.Literal(OBSERVABILITY_REDACTION_POLICY_VERSION),
  schemaVersion: Schema.Literal(OBSERVABILITY_SCHEMA_VERSION),
  scope: ObservabilityFactScope,
  source: ObservabilityFactSource,
  trace: Schema.optional(ObservabilityFactTrace),
});
export type ObservabilityFact = typeof ObservabilityFact.Type;

export interface ObservabilityFactInput {
  readonly captureMode: CaptureMode;
  readonly factType: ObservabilityFactType;
  readonly normalizedAt: string;
  readonly occurredAt: string;
  readonly payload: JsonObject;
  readonly scope: {
    readonly environmentId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly workspaceId?: string;
  };
  readonly source: {
    readonly recordId: string;
    readonly recordType: string;
    readonly recordVersion: number;
    readonly streamArn?: string;
    readonly streamSequenceNumber?: string;
    readonly table: "execution" | "usage";
  };
  readonly trace?: {
    readonly parentSpanId?: SpanId;
    readonly runId: string;
    readonly sessionId: string;
    readonly spanId: SpanId;
    readonly traceId: TraceId;
  };
}

export function observabilityFactId(
  source: ObservabilityFactInput["source"],
  factType: ObservabilityFactType,
  schemaVersion = OBSERVABILITY_SCHEMA_VERSION,
) {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        source.table,
        source.recordType,
        source.recordId,
        source.recordVersion,
        factType,
        schemaVersion,
      ]),
    )
    .digest("hex")}`;
}

export function makeObservabilityFact(input: ObservabilityFactInput) {
  const payload =
    input.captureMode === "metadata-only"
      ? (metadataOnlyAttributes(input.payload) as JsonObject)
      : input.payload;
  return Schema.decodeUnknownSync(ObservabilityFact)({
    captureMode: input.captureMode,
    factId: observabilityFactId(input.source, input.factType),
    factType: input.factType,
    normalizedAt: input.normalizedAt,
    occurredAt: input.occurredAt,
    payload,
    redactionPolicyVersion: OBSERVABILITY_REDACTION_POLICY_VERSION,
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    scope: input.scope,
    source: input.source,
    ...(input.trace ? { trace: input.trace } : {}),
  });
}

export function parseObservabilityFact(value: unknown): ObservabilityFact {
  return Schema.decodeUnknownSync(ObservabilityFact)(value);
}
