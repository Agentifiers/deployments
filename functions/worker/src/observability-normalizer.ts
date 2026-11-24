import type { PlatformRecord } from "@deployments-ai/db";
import type {
  ObservabilityFact,
  ObservabilityFactInput,
  ObservabilityFactType,
} from "@deployments-ai/observability";
import {
  contextualTrace,
  isContextualRecord,
  makeFact,
  source,
  traceFromRun,
  type ObservabilityStreamTransition,
  type ProjectableRecord,
} from "./observability-fact-context.ts";
import {
  approvalSpan,
  artifactSpan,
  memoryFlushSpan,
  memoryRecallSpan,
  modelFacts,
  runSpan,
  sandboxSpan,
  toolSpan,
  traceFact,
  usageFact,
} from "./observability-span-facts.ts";

export type { ObservabilityStreamTransition } from "./observability-fact-context.ts";

const TERMINAL_RUN_STATUSES = new Set(["canceled", "completed", "failed"]);
const TERMINAL_TOOL_STATUSES = new Set(["failed", "succeeded"]);
const TERMINAL_APPROVAL_STATUSES = new Set(["approved", "expired", "rejected"]);
const TERMINAL_MEMORY_RECALL_STATUSES = new Set(["completed", "failed", "skipped"]);
const TERMINAL_MEMORY_FLUSH_STATUSES = new Set(["failed", "succeeded"]);
const TERMINAL_SANDBOX_STATUSES = new Set(["destroyed", "error"]);

function projectedFactTypes(record: ProjectableRecord): readonly ObservabilityFactType[] {
  switch (record.itemType) {
    case "model-invocation":
      return ["model-invocation.recorded", "span.finalized"];
    case "trace":
      return ["trace.finalized"];
    case "meter-event":
      return ["usage.recorded"];
    case "approval":
    case "artifact":
    case "memory-flush":
    case "memory-recall-attempt":
    case "run":
    case "sandbox-lease":
    case "tool-call":
      return ["span.finalized"];
  }
}

function isProjectableRecord(record: PlatformRecord | undefined): record is ProjectableRecord {
  if (!record) return false;
  const projectable = [
    "approval",
    "artifact",
    "memory-flush",
    "memory-recall-attempt",
    "meter-event",
    "model-invocation",
    "run",
    "sandbox-lease",
    "tool-call",
    "trace",
  ].includes(record.itemType);
  if (!projectable) return false;
  if (
    [
      "approval",
      "artifact",
      "memory-flush",
      "memory-recall-attempt",
      "meter-event",
      "sandbox-lease",
      "tool-call",
    ].includes(record.itemType) &&
    !(record.data as Readonly<Record<string, unknown>>).runId
  ) {
    return false;
  }
  return true;
}

function directTrace(record: ProjectableRecord): ObservabilityFactInput["trace"] | undefined {
  if (record.itemType === "run") return traceFromRun(record);
  if (record.itemType === "model-invocation") {
    return {
      parentSpanId: record.data.parentSpanId,
      runId: record.data.runId,
      sessionId: record.data.threadId,
      spanId: record.data.spanId,
      traceId: record.data.traceId,
    };
  }
  if (record.itemType === "trace") {
    return {
      runId: record.data.rootRunId,
      sessionId: record.data.sessionId,
      spanId: record.data.rootSpanId,
      traceId: record.data.traceId,
    };
  }
  if (isContextualRecord(record)) return contextualTrace(record);
  return undefined;
}

function deletionFact(
  transition: ObservabilityStreamTransition,
  record: ProjectableRecord,
): ObservabilityFact {
  const recordSource = source(record, transition);
  const deletedFactTypes = projectedFactTypes(record);
  return makeFact(transition, record, {
    factType: "record.deleted",
    occurredAt: transition.normalizedAt,
    payload: {
      deleteThroughRecordVersion: recordSource.recordVersion,
      deletedFactTypes,
    },
    ...(directTrace(record) ? { trace: directTrace(record) } : {}),
  });
}

function enteredStatus(current: ProjectableRecord, previous: PlatformRecord | undefined) {
  if (!previous || previous.itemType !== current.itemType) return true;
  const currentStatus = (current.data as Readonly<Record<string, unknown>>).status;
  const previousStatus = (previous.data as Readonly<Record<string, unknown>>).status;
  return currentStatus !== previousStatus;
}

function finalizedTraceProjectionChanged(
  current: Extract<ProjectableRecord, { readonly itemType: "trace" }>,
  previous: PlatformRecord | undefined,
) {
  return (
    previous?.itemType === "trace" &&
    previous.data.status === "finalized" &&
    (current.data.outcome !== previous.data.outcome ||
      current.data.totalTokens !== previous.data.totalTokens ||
      current.data.totalCostUsdMicros !== previous.data.totalCostUsdMicros)
  );
}

export async function observabilityFactsForTransition(
  transition: ObservabilityStreamTransition,
): Promise<readonly ObservabilityFact[]> {
  if (transition.eventName === "REMOVE") {
    const previous = transition.previous;
    if (!isProjectableRecord(previous)) return [];
    // Every fact for a contextual record needs its immutable trace context, so a legacy record
    // written before that context existed was never projected and has nothing to delete.
    if (isContextualRecord(previous) && !previous.data.observability) return [];
    return [deletionFact(transition, previous)];
  }
  const current = transition.current;
  if (!isProjectableRecord(current)) return [];
  if (current.itemType === "trace") {
    if (
      current.data.status === "open" &&
      transition.previous?.itemType === "trace" &&
      transition.previous.data.status === "finalized"
    ) {
      return [deletionFact(transition, current)];
    }
    return current.data.status === "finalized" &&
      (enteredStatus(current, transition.previous) ||
        finalizedTraceProjectionChanged(current, transition.previous))
      ? [traceFact(transition, current)]
      : [];
  }
  if (current.itemType === "model-invocation") {
    return transition.previous ? [] : modelFacts(transition, current);
  }
  if (current.itemType === "run") {
    return TERMINAL_RUN_STATUSES.has(current.data.status) &&
      enteredStatus(current, transition.previous)
      ? [runSpan(transition, current)]
      : [];
  }
  if (current.itemType === "tool-call") {
    return TERMINAL_TOOL_STATUSES.has(current.data.status) &&
      enteredStatus(current, transition.previous)
      ? [toolSpan(transition, current)]
      : [];
  }
  if (current.itemType === "approval") {
    return TERMINAL_APPROVAL_STATUSES.has(current.data.status) &&
      enteredStatus(current, transition.previous)
      ? [approvalSpan(transition, current)]
      : [];
  }
  if (current.itemType === "artifact") {
    if (current.data.status === "deleted" && enteredStatus(current, transition.previous)) {
      return [deletionFact(transition, current)];
    }
    return (current.data.status === "available" || current.data.status === "failed") &&
      enteredStatus(current, transition.previous)
      ? [artifactSpan(transition, current)]
      : [];
  }
  if (current.itemType === "memory-recall-attempt") {
    return TERMINAL_MEMORY_RECALL_STATUSES.has(current.data.status) &&
      enteredStatus(current, transition.previous)
      ? [memoryRecallSpan(transition, current)]
      : [];
  }
  if (current.itemType === "memory-flush") {
    return TERMINAL_MEMORY_FLUSH_STATUSES.has(current.data.status) &&
      enteredStatus(current, transition.previous)
      ? [memoryFlushSpan(transition, current)]
      : [];
  }
  if (current.itemType === "sandbox-lease") {
    return TERMINAL_SANDBOX_STATUSES.has(current.data.status) &&
      enteredStatus(current, transition.previous)
      ? [sandboxSpan(transition, current)]
      : [];
  }
  return transition.previous ? [] : [usageFact(transition, current)];
}
