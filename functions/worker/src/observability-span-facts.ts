import { stableSpanId } from "@deployments-ai/observability";
import {
  contextualTrace,
  durationMs,
  makeFact,
  sourceContext,
  traceFromRun,
  type ObservabilityStreamTransition,
  type ProjectableRecord,
} from "./observability-fact-context.ts";

export function runSpan(
  transition: ObservabilityStreamTransition,
  run: Extract<ProjectableRecord, { readonly itemType: "run" }>,
) {
  const startedAt = run.data.startedAt ?? run.data.createdAt;
  const endedAt = run.data.completedAt ?? run.data.updatedAt;
  return makeFact(transition, run, {
    factType: "span.finalized",
    occurredAt: endedAt,
    payload: {
      ...(run.data.agentDeploymentId !== undefined
        ? { agentDeploymentId: run.data.agentDeploymentId }
        : {}),
      ...(run.data.agentReleaseId !== undefined ? { agentReleaseId: run.data.agentReleaseId } : {}),
      ...(run.data.executionBindingId !== undefined
        ? {
            executionBindingId: run.data.executionBindingId,
            executionPurpose: run.data.executionPurpose,
          }
        : {}),
      durationMs: durationMs(startedAt, endedAt),
      endedAt,
      kind: "run",
      name: "agent.run",
      startedAt,
      status:
        run.data.status === "completed"
          ? "ok"
          : run.data.status === "canceled"
            ? "canceled"
            : "error",
      trigger: run.data.trigger,
    },
    trace: traceFromRun(run),
  });
}

export function modelFacts(
  transition: ObservabilityStreamTransition,
  invocation: Extract<ProjectableRecord, { readonly itemType: "model-invocation" }>,
) {
  const payload = {
    ...(invocation.data.actualModelId ? { actualModelId: invocation.data.actualModelId } : {}),
    ...(invocation.data.actualProvider ? { actualProvider: invocation.data.actualProvider } : {}),
    ...(invocation.data.agentDefinitionId
      ? { agentDefinitionId: invocation.data.agentDefinitionId }
      : {}),
    ...(invocation.data.agentDeploymentId
      ? { agentDeploymentId: invocation.data.agentDeploymentId }
      : {}),
    agentManifestHash: invocation.data.agentManifestHash,
    ...(invocation.data.agentReleaseId ? { agentReleaseId: invocation.data.agentReleaseId } : {}),
    ...(invocation.data.executionBindingId
      ? {
          executionBindingId: invocation.data.executionBindingId,
          executionPurpose: invocation.data.executionPurpose ?? "customer",
        }
      : {}),
    attemptId: invocation.data.attemptId,
    ...(invocation.data.costUsdMicros !== undefined
      ? { costUsdMicros: invocation.data.costUsdMicros }
      : {}),
    ...(invocation.data.cachedTokens !== undefined
      ? { cachedTokens: invocation.data.cachedTokens }
      : {}),
    durationMs: durationMs(invocation.data.startedAt, invocation.data.completedAt),
    endedAt: invocation.data.completedAt,
    ...(invocation.data.errorClass ? { errorClass: invocation.data.errorClass } : {}),
    fallbackAttempt: invocation.data.fallbackAttempt,
    ...(invocation.data.fallbackReason ? { fallbackReason: invocation.data.fallbackReason } : {}),
    internalEvaluator: invocation.data.internalEvaluator,
    invocationId: invocation.data.invocationId,
    ...(invocation.data.invocationKind ? { invocationKind: invocation.data.invocationKind } : {}),
    ...(invocation.data.inputTokens !== undefined
      ? { inputTokens: invocation.data.inputTokens }
      : {}),
    kind: "model",
    ...(invocation.data.modelCallIndex !== undefined
      ? { modelCallIndex: invocation.data.modelCallIndex }
      : {}),
    name: "model.invocation",
    requestedModelId: invocation.data.requestedModelId,
    ...(invocation.data.requestedProvider
      ? { requestedProvider: invocation.data.requestedProvider }
      : {}),
    startedAt: invocation.data.startedAt,
    status:
      invocation.data.status === "succeeded"
        ? "ok"
        : invocation.data.status === "canceled"
          ? "canceled"
          : "error",
    ...(invocation.data.stopReason ? { stopReason: invocation.data.stopReason } : {}),
    streaming: invocation.data.streaming,
    ...(invocation.data.outputTokens !== undefined
      ? { outputTokens: invocation.data.outputTokens }
      : {}),
    ...(invocation.data.providerRequestId
      ? { providerRequestId: invocation.data.providerRequestId }
      : {}),
    ...(invocation.data.totalTokens !== undefined
      ? { totalTokens: invocation.data.totalTokens }
      : {}),
    ...(invocation.data.usageIdempotencyKey
      ? { usageIdempotencyKey: invocation.data.usageIdempotencyKey }
      : {}),
  } as const;
  const trace = {
    parentSpanId: invocation.data.parentSpanId,
    runId: invocation.data.runId,
    sessionId: invocation.data.threadId,
    spanId: invocation.data.spanId,
    traceId: invocation.data.traceId,
  };
  return [
    makeFact(transition, invocation, {
      factType: "model-invocation.recorded",
      occurredAt: invocation.data.completedAt,
      payload,
      trace,
    }),
    makeFact(transition, invocation, {
      factType: "span.finalized",
      occurredAt: invocation.data.completedAt,
      payload,
      trace,
    }),
  ];
}

export function traceFact(
  transition: ObservabilityStreamTransition,
  trace: Extract<ProjectableRecord, { readonly itemType: "trace" }>,
) {
  const endedAt = trace.data.completedAt ?? trace.data.updatedAt;
  return makeFact(transition, trace, {
    factType: "trace.finalized",
    occurredAt: trace.data.finalizedAt ?? endedAt,
    payload: {
      ...(trace.data.agentDefinitionId ? { agentDefinitionId: trace.data.agentDefinitionId } : {}),
      ...(trace.data.agentDeploymentId ? { agentDeploymentId: trace.data.agentDeploymentId } : {}),
      ...(trace.data.agentReleaseId ? { agentReleaseId: trace.data.agentReleaseId } : {}),
      completedAt: endedAt,
      ...(trace.data.durationMs !== undefined ? { durationMs: trace.data.durationMs } : {}),
      ...(trace.data.errorClass ? { errorClass: trace.data.errorClass } : {}),
      ...(trace.data.executionPurpose ? { executionPurpose: trace.data.executionPurpose } : {}),
      finalizedAt: trace.data.finalizedAt ?? endedAt,
      graphWatermark: trace.data.graphWatermark ?? "missing",
      ...(trace.data.releaseSelection ? { releaseSelection: trace.data.releaseSelection } : {}),
      rootRunId: trace.data.rootRunId,
      runCount: trace.data.runIds.length,
      runIds: trace.data.runIds,
      ...(trace.data.outcome ? { outcome: trace.data.outcome } : {}),
      status: trace.data.status,
      totalCostUsdMicros: trace.data.totalCostUsdMicros ?? 0,
      totalTokens: trace.data.totalTokens ?? 0,
      ...(trace.data.trigger ? { trigger: trace.data.trigger } : {}),
    },
    trace: {
      runId: trace.data.rootRunId,
      sessionId: trace.data.sessionId,
      spanId: trace.data.rootSpanId,
      traceId: trace.data.traceId,
    },
  });
}

/**
 * A model-requested tool span is a child of the requesting model attempt's span, whose id the
 * runtime derives the same way when it records that attempt; other tool spans parent to the run.
 */
export function toolSpan(
  transition: ObservabilityStreamTransition,
  tool: Extract<ProjectableRecord, { readonly itemType: "tool-call" }>,
) {
  const context = sourceContext(tool);
  const startedAt = tool.data.startedAt ?? tool.data.createdAt;
  const endedAt = tool.data.completedAt ?? tool.data.updatedAt;
  const { modelAttemptId, modelCallIndex } = tool.data;
  const requested = modelAttemptId !== undefined && modelCallIndex !== undefined;
  return makeFact(transition, tool, {
    factType: "span.finalized",
    occurredAt: endedAt,
    payload: {
      ...(requested ? { attemptId: modelAttemptId } : {}),
      durationMs: durationMs(startedAt, endedAt),
      effect: tool.data.effect,
      endedAt,
      kind: "tool",
      ...(requested ? { modelCallIndex } : {}),
      name: tool.data.toolName,
      ...(tool.data.policyAction ? { policyAction: tool.data.policyAction } : {}),
      startedAt,
      status: tool.data.status === "succeeded" ? "ok" : "error",
    },
    trace: {
      parentSpanId: requested
        ? stableSpanId(context.traceId, `model:${modelAttemptId}`)
        : context.runSpanId,
      runId: tool.data.runId,
      sessionId: context.sessionId,
      spanId: stableSpanId(context.traceId, `tool:${tool.data.id}`),
      traceId: context.traceId,
    },
  });
}

export function approvalSpan(
  transition: ObservabilityStreamTransition,
  approval: Extract<ProjectableRecord, { readonly itemType: "approval" }>,
) {
  const context = sourceContext(approval);
  const startedAt = approval.data.createdAt;
  const endedAt = approval.data.resolvedAt ?? approval.data.expiresAt ?? approval.data.updatedAt;
  return makeFact(transition, approval, {
    factType: "span.finalized",
    occurredAt: endedAt,
    payload: {
      durationMs: durationMs(startedAt, endedAt),
      endedAt,
      escalationCount: approval.data.escalationCount,
      kind: "approval_wait",
      name: "approval.wait",
      startedAt,
      status: approval.data.status === "approved" ? "ok" : "error",
    },
    trace: {
      parentSpanId: context.runSpanId,
      runId: approval.data.runId,
      sessionId: context.sessionId,
      spanId: stableSpanId(context.traceId, `approval:${approval.data.id}`),
      traceId: context.traceId,
    },
  });
}

export function artifactSpan(
  transition: ObservabilityStreamTransition,
  artifact: Extract<ProjectableRecord, { readonly itemType: "artifact" }>,
) {
  const startedAt = artifact.data.createdAt;
  const endedAt = artifact.data.updatedAt;
  return makeFact(transition, artifact, {
    factType: "span.finalized",
    occurredAt: endedAt,
    payload: {
      durationMs: durationMs(startedAt, endedAt),
      endedAt,
      kind: "artifact",
      name: "artifact.lifecycle",
      startedAt,
      status: artifact.data.status === "available" ? "ok" : "error",
    },
    trace: contextualTrace(artifact),
  });
}

export function memoryRecallSpan(
  transition: ObservabilityStreamTransition,
  attempt: Extract<ProjectableRecord, { readonly itemType: "memory-recall-attempt" }>,
) {
  const startedAt = attempt.data.createdAt;
  const endedAt = new Date(Date.parse(startedAt) + (attempt.data.latencyMs ?? 0)).toISOString();
  return makeFact(transition, attempt, {
    factType: "span.finalized",
    occurredAt: endedAt,
    payload: {
      candidateCount: attempt.data.candidateCount,
      durationMs: durationMs(startedAt, endedAt),
      endedAt,
      injectedCount: attempt.data.injectedCount,
      kind: "memory",
      name: "memory.recall",
      retrievedCount: attempt.data.retrievedCount,
      startedAt,
      status: attempt.data.status === "failed" ? "error" : "ok",
      strategy: attempt.data.strategy,
    },
    trace: contextualTrace(attempt),
  });
}

export function memoryFlushSpan(
  transition: ObservabilityStreamTransition,
  flush: Extract<ProjectableRecord, { readonly itemType: "memory-flush" }>,
) {
  const startedAt = flush.data.startedAt ?? flush.data.createdAt;
  const endedAt = flush.data.completedAt ?? flush.data.updatedAt;
  return makeFact(transition, flush, {
    factType: "span.finalized",
    occurredAt: endedAt,
    payload: {
      candidateCount: flush.data.candidateCount ?? 0,
      durationMs: durationMs(startedAt, endedAt),
      endedAt,
      kind: "memory",
      name: "memory.flush",
      rejectedCount: flush.data.rejectedCount ?? 0,
      startedAt,
      status: flush.data.status === "succeeded" ? "ok" : "error",
    },
    trace: contextualTrace(flush),
  });
}

export function sandboxSpan(
  transition: ObservabilityStreamTransition,
  sandbox: Extract<ProjectableRecord, { readonly itemType: "sandbox-lease" }>,
) {
  const startedAt = sandbox.data.readyAt ?? sandbox.data.usageStartedAt;
  const endedAt = sandbox.data.destroyedAt ?? sandbox.data.updatedAt;
  return makeFact(transition, sandbox, {
    factType: "span.finalized",
    occurredAt: endedAt,
    payload: {
      durationMs: durationMs(startedAt, endedAt),
      endedAt,
      kind: "sandbox",
      name: `sandbox.${sandbox.data.provider}`,
      startedAt,
      status: sandbox.data.status === "destroyed" ? "ok" : "error",
    },
    trace: contextualTrace(sandbox),
  });
}

export function usageFact(
  transition: ObservabilityStreamTransition,
  usage: Extract<ProjectableRecord, { readonly itemType: "meter-event" }>,
) {
  const context = sourceContext(usage);
  const dimensions = usage.data.dimensions as Readonly<Record<string, unknown>>;
  return makeFact(transition, usage, {
    factType: "usage.recorded",
    occurredAt: usage.data.occurredAt,
    payload: {
      ...(typeof dimensions.costUsdMicros === "number"
        ? { costUsdMicros: dimensions.costUsdMicros }
        : {}),
      idempotencyKey: usage.data.idempotencyKey,
      metric: usage.data.metric,
      ...(typeof dimensions.modelId === "string" ? { modelId: dimensions.modelId } : {}),
      ...(typeof dimensions.provider === "string" ? { provider: dimensions.provider } : {}),
      quantity: usage.data.quantity,
      source: usage.data.source,
      ...(typeof dimensions.startedAt === "string" ? { startedAt: dimensions.startedAt } : {}),
      unit: usage.data.unit,
    },
    trace: {
      ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
      runId: usage.data.runId!,
      sessionId: context.sessionId,
      spanId: context.runSpanId,
      traceId: context.traceId,
    },
  });
}
