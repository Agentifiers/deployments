import { expect, test } from "bun:test";
import {
  ArtifactRecord,
  MemoryFlushRecord,
  MemoryRecallAttemptRecord,
  MeterEventRecord,
  ModelInvocationRecord,
  RunRecord,
  SandboxLeaseRecord,
  TraceRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { customerRunPins, fixtures, id } from "./agent-run.fixture.ts";
import { modelInvocationRecord } from "./model-invocations.ts";
import { runtimeUsageRecord } from "./records.ts";
import { observabilityFactsForTransition } from "./observability-normalizer.ts";

const stream = {
  normalizedAt: "2026-07-28T12:00:02.000Z",
  streamArn: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
  streamSequenceNumber: "100",
} as const;

test("normalizes terminal runs and immutable model attempts without content", async () => {
  const fixture = fixtures();
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...fixture.run,
      data: {
        ...fixture.run.data,
        completedAt: "2026-07-28T12:00:01.000Z",
        startedAt: "2026-07-28T12:00:00.000Z",
        status: "completed" as const,
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
      },
    }),
  );
  const invocation = modelInvocationRecord({
    actualModelId: "openrouter/primary",
    actualProvider: "openrouter",
    agentDefinitionId: fixture.release.data.agentDefinitionId,
    ...customerRunPins(run.data),
    agentManifestHash: fixture.release.data.contentHash,
    attemptId: `${run.data.id}:attempt`,
    captureMode: run.data.captureMode,
    completedAt: "2026-07-28T12:00:00.900Z",
    environmentId: run.data.environmentId,
    fallbackAttempt: 0,
    internalEvaluator: false,
    invocationId: `${run.data.id}:invocation`,
    invocationKind: "response-depth",
    modelCallIndex: 3,
    inputTokens: 4,
    organizationId: run.data.organizationId,
    parentSpanId: run.data.spanId,
    outputTokens: 1,
    projectId: run.data.projectId,
    providerRequestId: "provider-request-digest",
    requestedModelId: "openrouter/primary",
    requestedProvider: "openrouter",
    runAttempt: 1,
    runExecutionVersion: 1,
    runId: run.data.id,
    spanId: "fedcba9876543210",
    startedAt: "2026-07-28T12:00:00.100Z",
    status: "succeeded",
    stopReason: "stop",
    streaming: false,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
    totalTokens: 5,
    usageIdempotencyKey: `${run.data.id}:usage`,
    ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
  });
  const invocationWithCachedTokens = Schema.decodeUnknownSync(ModelInvocationRecord)(
    withCanonicalRecordKeys({
      ...invocation,
      data: { ...invocation.data, cachedTokens: 2 },
    }),
  );
  const runFacts = await observabilityFactsForTransition({
    ...stream,
    current: run,
    eventName: "MODIFY",
    table: "execution",
  });
  const modelFacts = await observabilityFactsForTransition({
    ...stream,
    current: invocationWithCachedTokens,
    eventName: "INSERT",
    table: "execution",
  });

  expect(runFacts.map((fact) => fact.factType)).toEqual(["span.finalized"]);
  expect(modelFacts.map((fact) => fact.factType)).toEqual([
    "model-invocation.recorded",
    "span.finalized",
  ]);
  expect(JSON.stringify(modelFacts)).not.toContain("requestSummary");
  expect(modelFacts[0]?.source.streamSequenceNumber).toBe("100");
  expect(modelFacts[0]?.payload).toMatchObject({
    cachedTokens: 2,
    inputTokens: 4,
    invocationKind: "response-depth",
    modelCallIndex: 3,
    outputTokens: 1,
    providerRequestId: "provider-request-digest",
    stopReason: "stop",
    totalTokens: 5,
  });
  expect(modelFacts[1]?.payload).toMatchObject({
    invocationKind: "response-depth",
    modelCallIndex: 3,
  });
});

test("resolves usage trace context and emits deletion tombstones", async () => {
  const fixture = fixtures();
  const usage = runtimeUsageRecord({
    entry: {
      costUsdMicros: 7,
      idempotencyKey: "usage-1",
      modelId: "openrouter/primary",
      occurredAt: "2026-07-28T12:00:01.000Z",
      provider: "openrouter",
      quantity: 5,
      source: "model-gateway",
      payer: { kind: "operator" as const },
      type: "model_tokens",
      unit: "tokens",
    },
    id: id(90),
    run: fixture.run,
  });
  const facts = await observabilityFactsForTransition({
    ...stream,
    current: usage,
    eventName: "INSERT",
    table: "usage",
  });
  const deleted = await observabilityFactsForTransition({
    ...stream,
    eventName: "REMOVE",
    previous: usage,
    table: "usage",
  });

  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({
    factType: "usage.recorded",
    payload: { costUsdMicros: 7, quantity: 5 },
    trace: { runId: fixture.run.data.id, traceId: fixture.run.data.traceId },
  });
  expect(usage.data.observability).toMatchObject({
    captureMode: fixture.run.data.captureMode,
    runSpanId: fixture.run.data.spanId,
    sessionId: fixture.run.data.threadId,
    traceId: fixture.run.data.traceId,
  });
  expect(deleted).toHaveLength(1);
  expect(deleted[0]?.factType).toBe("record.deleted");
  expect(deleted[0]?.trace).toMatchObject({
    runId: fixture.run.data.id,
    traceId: fixture.run.data.traceId,
  });
  expect(deleted[0]?.payload).toMatchObject({
    deleteThroughRecordVersion: 0,
    deletedFactTypes: ["usage.recorded"],
  });
});

test("re-emits a finalized trace fact when outcome or late usage changes", async () => {
  const run = fixtures().run;
  const previous = Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        captureMode: run.data.captureMode,
        completedAt: "2026-07-28T12:00:01.000Z",
        createdAt: run.data.createdAt,
        environmentId: run.data.environmentId,
        finalizedAt: "2026-07-28T12:00:02.000Z",
        graphWatermark: `sha256:${"a".repeat(64)}`,
        id: run.data.traceId,
        organizationId: run.data.organizationId,
        projectId: run.data.projectId,
        redactionPolicyVersion: 1,
        rootRunId: run.data.id,
        rootSpanId: run.data.spanId,
        runIds: [run.data.id],
        schemaVersion: 1,
        sessionId: run.data.threadId,
        status: "finalized" as const,
        terminalRunIds: [run.data.id],
        totalCostUsdMicros: 0,
        totalTokens: 0,
        traceId: run.data.traceId,
        updatedAt: "2026-07-28T12:00:02.000Z",
        version: 2,
        workspaceId: run.data.workspaceId,
      },
      itemType: "trace",
    }),
  );
  const outcomeOnly = Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        outcome: "ok",
        updatedAt: "2026-07-28T12:00:03.000Z",
        version: 3,
      },
    }),
  );
  const current = Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      ...outcomeOnly,
      data: {
        ...outcomeOnly.data,
        totalCostUsdMicros: 13,
        totalTokens: 21,
        updatedAt: "2026-07-28T12:00:04.000Z",
        version: 4,
      },
    }),
  );

  const outcomeFacts = await observabilityFactsForTransition({
    ...stream,
    current: outcomeOnly,
    eventName: "MODIFY",
    previous,
    table: "execution",
  });

  const facts = await observabilityFactsForTransition({
    ...stream,
    current,
    eventName: "MODIFY",
    previous: outcomeOnly,
    table: "execution",
  });

  expect(outcomeFacts[0]).toMatchObject({
    factType: "trace.finalized",
    payload: {
      outcome: "ok",
      runIds: [run.data.id],
      status: "finalized",
      totalCostUsdMicros: 0,
      totalTokens: 0,
    },
    source: { recordVersion: 3 },
  });
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({
    factType: "trace.finalized",
    payload: {
      outcome: "ok",
      status: "finalized",
      totalCostUsdMicros: 13,
      totalTokens: 21,
    },
    source: { recordVersion: 4 },
  });

  const { outcome: _outcome, ...reopenedData } = current.data;
  const reopened = Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      ...current,
      data: {
        ...reopenedData,
        status: "open",
        updatedAt: "2026-07-28T12:00:05.000Z",
        version: 5,
      },
    }),
  );
  const retraction = await observabilityFactsForTransition({
    ...stream,
    current: reopened,
    eventName: "MODIFY",
    previous: current,
    table: "execution",
  });
  expect(retraction[0]).toMatchObject({
    factType: "record.deleted",
    payload: {
      deletedFactTypes: ["trace.finalized"],
      deleteThroughRecordVersion: 5,
    },
    source: { recordVersion: 5 },
  });
});

test("ignores shared usage records that have no agent run", async () => {
  const fixture = fixtures();
  const usage = Schema.decodeUnknownSync(MeterEventRecord)(
    withCanonicalRecordKeys({
      data: {
        dimensions: {},
        environmentId: fixture.run.data.environmentId,
        id: id(91),
        idempotencyKey: "agent-email:message-1",
        metric: "agent_email.outbound_messages",
        occurredAt: "2026-07-28T12:00:01.000Z",
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
        quantity: 1,
        source: "agent-email",
        unit: "count",
      },
      itemType: "meter-event",
    }),
  );
  expect(
    await observabilityFactsForTransition({
      ...stream,
      current: usage,
      eventName: "INSERT",
      table: "usage",
    }),
  ).toEqual([]);
  expect(
    await observabilityFactsForTransition({
      ...stream,
      eventName: "REMOVE",
      previous: usage,
      table: "usage",
    }),
  ).toEqual([]);
});

test("removes run-owned usage written before trace context without a tombstone", async () => {
  const fixture = fixtures();
  const legacy = Schema.decodeUnknownSync(MeterEventRecord)(
    withCanonicalRecordKeys({
      data: {
        dimensions: { startedAt: "2026-07-28T12:00:00.000Z" },
        environmentId: fixture.run.data.environmentId,
        id: id(92),
        idempotencyKey: `${fixture.run.data.id}:attempt:1:worker-ms:completed`,
        metric: "worker_ms",
        occurredAt: "2026-07-28T12:00:01.000Z",
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
        quantity: 18_580,
        runId: fixture.run.data.id,
        source: "agent-runtime",
        unit: "ms",
      },
      itemType: "meter-event",
    }),
  );
  expect(
    await observabilityFactsForTransition({
      ...stream,
      eventName: "REMOVE",
      previous: legacy,
      table: "usage",
    }),
  ).toEqual([]);
  expect(
    observabilityFactsForTransition({
      ...stream,
      current: legacy,
      eventName: "INSERT",
      table: "usage",
    }),
  ).rejects.toThrow("has no immutable trace context");
});

test("normalizes run-owned memory and sandbox primitives from immutable context", async () => {
  const run = fixtures().run;
  const observability = {
    captureMode: run.data.captureMode,
    ...(run.data.parentSpanId ? { parentSpanId: run.data.parentSpanId } : {}),
    runSpanId: run.data.spanId,
    sessionId: run.data.threadId,
    traceId: run.data.traceId,
    ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
  };
  const common = {
    environmentId: run.data.environmentId,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
  };
  const artifact = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        createdAt: "2026-07-28T12:00:00.000Z",
        id: id(94),
        name: "report.txt",
        observability,
        runId: run.data.id,
        status: "available",
        storage: {
          bucket: "artifact-bucket",
          byteSize: 12,
          contentType: "text/plain",
          fileName: "report.txt",
          key: "artifacts/report.txt",
          sha256: "a".repeat(64),
        },
        type: "patient-diagnosis-secret",
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
        visibility: "organization",
      },
      itemType: "artifact",
    }),
  );
  const recall = Schema.decodeUnknownSync(MemoryRecallAttemptRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        candidateCount: 2,
        createdAt: "2026-07-28T12:00:00.000Z",
        id: id(92),
        injectedCount: 1,
        latencyMs: 10,
        observability,
        purpose: "active-recall",
        retrievedCount: 1,
        runId: run.data.id,
        status: "completed",
        threadId: run.data.threadId,
        strategy: "dense-v1",
        version: 0,
      },
      itemType: "memory-recall-attempt",
    }),
  );
  const flush = Schema.decodeUnknownSync(MemoryFlushRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        attempt: 1,
        completedAt: "2026-07-28T12:00:01.000Z",
        createdAt: "2026-07-28T12:00:00.000Z",
        id: id(93),
        idempotencyKey: "flush-1",
        memoryIds: [],
        observability,
        runId: run.data.id,
        status: "succeeded",
        threadId: run.data.threadId,
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
      },
      itemType: "memory-flush",
    }),
  );
  const sandbox = Schema.decodeUnknownSync(SandboxLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        executionTargetId: run.data.agentDeploymentId,
        executionTargetKind: "agent-deployment",
        computeUsageActive: false,
        createdAt: "2026-07-28T12:00:00.000Z",
        destroyedAt: "2026-07-28T12:00:01.000Z",
        id: run.data.id,
        isolationMode: "run-ephemeral",
        observability,
        provider: "aws_lambda_microvm",
        runId: run.data.id,
        status: "destroyed",
        updatedAt: "2026-07-28T12:00:01.000Z",
        usageStartedAt: "2026-07-28T12:00:00.000Z",
        version: 1,
      },
      itemType: "sandbox-lease",
    }),
  );

  const facts = await Promise.all(
    [artifact, recall, flush, sandbox].map((current) =>
      observabilityFactsForTransition({
        ...stream,
        current,
        eventName: "MODIFY",
        table: "execution",
      }),
    ),
  );

  expect(facts.flat().map((fact) => fact.payload.kind)).toEqual([
    "artifact",
    "memory",
    "memory",
    "sandbox",
  ]);
  expect(facts.flat().every((fact) => fact.trace?.traceId === run.data.traceId)).toBe(true);
  expect(facts[0]?.[0]?.payload.name).toBe("artifact.lifecycle");
  expect(JSON.stringify(facts[0])).not.toContain("patient-diagnosis-secret");
});
