import {
  MAX_TRACE_RUNS,
  RunEdgeRecord,
  TraceRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  OBSERVABILITY_REDACTION_POLICY_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
} from "@deployments-ai/observability";
import { Schema } from "effect";
import {
  ConversationError,
  expected,
  record,
  type SubmitConversationTurnInput,
} from "./submission.ts";
import {
  loadParentRunDelegation,
  runDelegationRecord,
  type ConversationRunDelegation,
} from "./run-delegation.ts";

type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
type Trace = Extract<PlatformRecord, { readonly itemType: "trace" }>;

export async function loadParentTraceContext(
  database: DynamoDatabaseService,
  input: SubmitConversationTurnInput,
  parentThreadId: Ulid | undefined,
): Promise<{
  readonly parentDelegation?: ConversationRunDelegation;
  readonly parentRun?: Run;
  readonly parentTrace?: Trace;
}> {
  if (!input.traceContext) return {};
  if (parentThreadId !== input.traceContext.parentThreadId) {
    throw new ConversationError("trace_mismatch", "Parent thread does not match trace context.");
  }
  const parentTrace = expected(
    await record(database, {
      kind: "trace",
      organizationId: input.organizationId,
      traceId: input.traceContext.traceId,
    }),
    "trace",
    "Parent trace",
  );
  const parentLookup = parentThreadId
    ? expected(
        await record(database, {
          kind: "run-lookup",
          organizationId: input.organizationId,
          runId: input.traceContext.parentRunId,
          threadId: parentThreadId,
        }),
        "run-lookup",
        "Parent run lookup",
      )
    : undefined;
  const parentRun = parentLookup
    ? expected(
        await record(database, {
          idempotencyKey: parentLookup.data.idempotencyKey,
          kind: "run",
          organizationId: input.organizationId,
          threadId: parentLookup.data.threadId,
        }),
        "run",
        "Parent run",
      )
    : undefined;
  if (
    parentTrace.data.status !== "open" ||
    parentTrace.data.organizationId !== input.organizationId ||
    parentTrace.data.projectId !== input.projectId ||
    parentTrace.data.environmentId !== input.environmentId ||
    parentTrace.data.workspaceId !== input.workspaceId ||
    (input.captureMode !== undefined && input.captureMode !== parentTrace.data.captureMode)
  ) {
    throw new ConversationError("trace_mismatch", "Parent trace does not match the run scope.");
  }
  if (
    !parentRun ||
    parentLookup?.data.runId !== input.traceContext.parentRunId ||
    parentRun.data.id !== input.traceContext.parentRunId ||
    parentRun.data.agentDeploymentId !== input.traceContext.parentAgentDeploymentId ||
    parentRun.data.organizationId !== input.organizationId ||
    parentRun.data.projectId !== input.projectId ||
    parentRun.data.environmentId !== input.environmentId ||
    parentRun.data.workspaceId !== input.workspaceId ||
    parentRun.data.threadId !== parentThreadId ||
    parentRun.data.traceId !== input.traceContext.traceId ||
    parentRun.data.spanId !== input.traceContext.parentSpanId
  ) {
    throw new ConversationError("trace_mismatch", "Parent run does not match the trace context.");
  }
  const parentDelegation = await loadParentRunDelegation(database, input);
  return { ...(parentDelegation ? { parentDelegation } : {}), parentRun, parentTrace };
}

/** Opens a new trace rooted at a run that has no parent trace context. */
export function rootTraceRecord(run: Run, timestamp: string): Trace {
  return Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        captureMode: run.data.captureMode,
        createdAt: timestamp,
        environmentId: run.data.environmentId,
        id: run.data.traceId,
        organizationId: run.data.organizationId,
        projectId: run.data.projectId,
        redactionPolicyVersion: OBSERVABILITY_REDACTION_POLICY_VERSION,
        rootRunId: run.data.id,
        rootSpanId: run.data.spanId,
        runIds: [run.data.id],
        terminalRunIds: [],
        schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
        sessionId: run.data.threadId,
        status: "open" as const,
        traceId: run.data.traceId,
        updatedAt: timestamp,
        version: 0,
        ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
      },
      itemType: "trace" as const,
    }),
  );
}

export function observabilityRecordsForRun(args: {
  readonly input: SubmitConversationTurnInput;
  readonly parentDelegation?: ConversationRunDelegation;
  readonly parentTrace?: Trace;
  readonly run: Run;
  readonly runEdgeId: Ulid;
  readonly timestamp: string;
}) {
  const { input, parentDelegation, parentTrace, run, runEdgeId, timestamp } = args;
  if (
    parentTrace &&
    !parentTrace.data.runIds.includes(run.data.id) &&
    parentTrace.data.runIds.length >= MAX_TRACE_RUNS
  ) {
    throw new ConversationError(
      "trace_run_limit",
      `Trace graphs cannot exceed ${MAX_TRACE_RUNS} runs.`,
    );
  }
  const trace = parentTrace
    ? Schema.decodeUnknownSync(TraceRecord)(
        withCanonicalRecordKeys({
          data: {
            ...parentTrace.data,
            runIds: [...new Set([...parentTrace.data.runIds, run.data.id])],
            updatedAt: timestamp,
            version: parentTrace.data.version + 1,
          },
          itemType: "trace" as const,
        }),
      )
    : rootTraceRecord(run, timestamp);
  const runEdge = input.traceContext
    ? Schema.decodeUnknownSync(RunEdgeRecord)(
        withCanonicalRecordKeys({
          data: {
            childRunId: run.data.id,
            childThreadId: run.data.threadId,
            createdAt: timestamp,
            environmentId: run.data.environmentId,
            fromAgentDeploymentId: input.traceContext.parentAgentDeploymentId,
            id: runEdgeId,
            kind: input.traceContext.edgeKind ?? "delegation",
            ...(input.traceContext.metadata ? { metadata: input.traceContext.metadata } : {}),
            organizationId: run.data.organizationId,
            parentRunId: input.traceContext.parentRunId,
            parentSpanId: input.traceContext.parentSpanId,
            projectId: run.data.projectId,
            threadId: input.traceContext.parentThreadId,
            toAgentDeploymentId: input.agentDeploymentId,
            traceId: run.data.traceId,
          },
          itemType: "run-edge" as const,
        }),
      )
    : undefined;
  const runDelegation = runDelegationRecord({
    input,
    ...(parentDelegation ? { parentDelegation } : {}),
    run,
    timestamp,
  });
  return { runDelegation, runEdge, trace };
}
