import type { PlatformRecord } from "@deployments-ai/db";
import {
  DEFAULT_CAPTURE_MODE,
  makeObservabilityFact,
  stableSpanId,
  type CaptureMode,
  type JsonObject,
  type ObservabilityFactInput,
  type ObservabilityFactType,
} from "@deployments-ai/observability";

type ProjectableTable = "execution" | "usage";
export type ProjectableRecord = Extract<
  PlatformRecord,
  {
    readonly itemType:
      | "approval"
      | "artifact"
      | "memory-flush"
      | "memory-recall-attempt"
      | "meter-event"
      | "model-invocation"
      | "run"
      | "sandbox-lease"
      | "tool-call"
      | "trace";
  }
>;
export type ContextualRecord = Extract<
  ProjectableRecord,
  {
    readonly itemType:
      | "approval"
      | "artifact"
      | "memory-flush"
      | "memory-recall-attempt"
      | "meter-event"
      | "sandbox-lease"
      | "tool-call";
  }
>;

export interface ObservabilityStreamTransition {
  readonly current?: PlatformRecord;
  readonly eventName: "INSERT" | "MODIFY" | "REMOVE";
  readonly normalizedAt: string;
  readonly previous?: PlatformRecord;
  readonly streamArn: string;
  readonly streamSequenceNumber: string;
  readonly table: ProjectableTable;
}

function recordVersion(record: ProjectableRecord): number {
  const version = (record.data as Readonly<Record<string, unknown>>).version;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

export function source(
  record: ProjectableRecord,
  transition: ObservabilityStreamTransition,
): ObservabilityFactInput["source"] {
  return {
    recordId: record.data.id,
    recordType: record.itemType,
    recordVersion: recordVersion(record),
    streamArn: transition.streamArn,
    streamSequenceNumber: transition.streamSequenceNumber,
    table: transition.table,
  };
}

const SOURCE_FAILURES = {
  "missing-run": "has no run",
  "missing-tenant-scope": "has no tenant scope",
  "missing-trace-context": "has no immutable trace context",
} as const;

/** Quarantine and failure logs keep `code` and drop the message. */
export class ObservabilitySourceError extends Error {
  override readonly name = "ObservabilitySourceError";

  constructor(
    readonly code: keyof typeof SOURCE_FAILURES,
    record: ProjectableRecord,
  ) {
    super(`Observability source ${record.itemType}/${record.data.id} ${SOURCE_FAILURES[code]}.`);
  }
}

export function sourceContext(record: ContextualRecord) {
  const context = record.data.observability;
  if (!context) throw new ObservabilitySourceError("missing-trace-context", record);
  return context;
}

export function isContextualRecord(record: ProjectableRecord): record is ContextualRecord {
  return [
    "approval",
    "artifact",
    "memory-flush",
    "memory-recall-attempt",
    "meter-event",
    "sandbox-lease",
    "tool-call",
  ].includes(record.itemType);
}

function contextualRunId(record: ContextualRecord) {
  const runId = record.data.runId;
  if (!runId) throw new ObservabilitySourceError("missing-run", record);
  return runId;
}

function scope(record: ProjectableRecord): ObservabilityFactInput["scope"] {
  const data = record.data as Readonly<Record<string, unknown>>;
  const context = isContextualRecord(record) ? sourceContext(record) : undefined;
  const organizationId = data.organizationId;
  const projectId = data.projectId;
  const environmentId = data.environmentId;
  const workspaceId = data.workspaceId ?? context?.workspaceId;
  if (
    typeof organizationId !== "string" ||
    typeof projectId !== "string" ||
    typeof environmentId !== "string"
  ) {
    throw new ObservabilitySourceError("missing-tenant-scope", record);
  }
  return {
    environmentId,
    organizationId,
    projectId,
    ...(typeof workspaceId === "string" ? { workspaceId } : {}),
  };
}

export function traceFromRun(
  run: Extract<ProjectableRecord, { readonly itemType: "run" }>,
  spanId = run.data.spanId,
  parentSpanId = run.data.parentSpanId,
) {
  return {
    ...(parentSpanId ? { parentSpanId } : {}),
    runId: run.data.id,
    sessionId: run.data.threadId,
    spanId,
    traceId: run.data.traceId,
  };
}

function captureMode(record: ProjectableRecord): CaptureMode {
  const value = (record.data as Readonly<Record<string, unknown>>).captureMode;
  return value === "metadata-only" || value === "redacted-content" || value === "full-content"
    ? value
    : isContextualRecord(record)
      ? sourceContext(record).captureMode
      : DEFAULT_CAPTURE_MODE;
}

export function durationMs(startedAt: string, endedAt: string) {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

export function makeFact(
  transition: ObservabilityStreamTransition,
  record: ProjectableRecord,
  input: {
    readonly factType: ObservabilityFactType;
    readonly occurredAt: string;
    readonly payload: JsonObject;
    readonly trace?: ObservabilityFactInput["trace"];
  },
) {
  return makeObservabilityFact({
    captureMode: captureMode(record),
    factType: input.factType,
    normalizedAt: transition.normalizedAt,
    occurredAt: input.occurredAt,
    payload: input.payload,
    scope: scope(record),
    source: source(record, transition),
    ...(input.trace ? { trace: input.trace } : {}),
  });
}

export function contextualTrace(record: ContextualRecord) {
  const context = sourceContext(record);
  return {
    parentSpanId: context.runSpanId,
    runId: contextualRunId(record),
    sessionId: context.sessionId,
    spanId: stableSpanId(context.traceId, `${record.itemType}:${record.data.id}`),
    traceId: context.traceId,
  };
}
