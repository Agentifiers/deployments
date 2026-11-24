import { expect, test } from "bun:test";
import type {
  RuntimeModelInvocationAttempt,
  RuntimeUsageEntry,
} from "@deployments-ai/agent-runtime";
import {
  customerRunPins,
  abandonedRunWithLease,
  fixtures,
  id,
  inMemoryDatabase,
} from "./agent-run.fixture.ts";
import { modelInvocationRecord, modelInvocationsForRunAttempt } from "./model-invocations.ts";
import { runtimeUsageRecord } from "./record-builders.ts";

function succeededAttempt(): RuntimeModelInvocationAttempt {
  const fixture = fixtures();
  const { run } = abandonedRunWithLease(fixture);
  return {
    agentDefinitionId: fixture.release.data.agentDefinitionId,
    ...customerRunPins(run.data),
    agentManifestHash: fixture.release.data.contentHash,
    attemptId: `${run.data.id}:cached-attempt`,
    cachedTokens: 900,
    captureMode: run.data.captureMode,
    completedAt: "2026-07-22T00:00:00.500Z",
    environmentId: run.data.environmentId,
    fallbackAttempt: 0,
    inputTokens: 1_000,
    internalEvaluator: false,
    invocationId: `${run.data.id}:execution:1:assistant:0`,
    invocationKind: "assistant",
    modelCallIndex: 0,
    organizationId: run.data.organizationId,
    outputTokens: 20,
    parentSpanId: run.data.spanId,
    projectId: run.data.projectId,
    requestedModelId: "openrouter/primary",
    runAttempt: run.data.attempt,
    runExecutionVersion: 1,
    runId: run.data.id,
    spanId: "0123456789abcdef",
    startedAt: "2026-07-22T00:00:00.250Z",
    status: "succeeded",
    streaming: false,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
  };
}

const cachedUsage: RuntimeUsageEntry = {
  cacheWriteInputTokens: 100,
  cachedInputTokens: 900,
  costUsdMicros: 7,
  idempotencyKey: "model:cached",
  inputTokens: 1_000,
  modelId: "openrouter/primary",
  occurredAt: "2026-07-22T00:00:01.000Z",
  outputTokens: 20,
  payer: { kind: "operator" },
  provider: "openrouter",
  quantity: 1_020,
  source: "model-gateway",
  type: "model_tokens",
  unit: "tokens",
};

test("persists provider cache hits on the model invocation record", () => {
  expect(modelInvocationRecord(succeededAttempt()).data).toMatchObject({
    cachedTokens: 900,
    inputTokens: 1_000,
  });
});

test("records prompt cache reads and writes as meter-event dimensions", () => {
  const fixture = fixtures();
  const record = runtimeUsageRecord({ entry: cachedUsage, id: id(90), run: fixture.run });

  expect(record.data.dimensions).toMatchObject({
    cacheWriteInputTokens: 100,
    cachedInputTokens: 900,
    inputTokens: 1_000,
  });
  const { cachedInputTokens: _read, cacheWriteInputTokens: _write, ...uncachedUsage } = cachedUsage;
  expect(
    runtimeUsageRecord({ entry: uncachedUsage, id: id(90), run: fixture.run }).data.dimensions,
  ).not.toContainAnyKeys(["cachedInputTokens", "cacheWriteInputTokens"]);
});

test.each(["cachedInputTokens", "cacheWriteInputTokens"] as const)(
  "rejects invalid %s usage before persistence",
  (field) => {
    expect(() =>
      runtimeUsageRecord({
        entry: { ...cachedUsage, [field]: -1 },
        id: id(90),
        run: fixtures().run,
      }),
    ).toThrow(`Runtime usage ${field} is invalid`);
  },
);

test("records who paid for runtime model usage, and refuses usage that does not say", () => {
  const fixture = fixtures();
  const dimensions = (entry: RuntimeUsageEntry) =>
    runtimeUsageRecord({ entry, id: id(90), run: fixture.run }).data.dimensions;

  expect(dimensions(cachedUsage)).toMatchObject({ funding: "operator" });
  expect(dimensions(cachedUsage)).not.toContainKey("modelCredentialId");
  expect(
    dimensions({
      ...cachedUsage,
      payer: { kind: "organization", modelCredentialId: "credential-openrouter" },
    }),
  ).toMatchObject({ funding: "organization", modelCredentialId: "credential-openrouter" });
  const { payer: _payer, ...unpaid } = cachedUsage;
  expect(() => dimensions(unpaid)).toThrow(
    "Runtime model usage must say who paid for 01ARZ3NDEKTSV4RRFFQ69G0010:model:cached.",
  );
});

test("does not recover invocation history from an earlier manual execution", async () => {
  const fixture = fixtures();
  const abandoned = abandonedRunWithLease(fixture);
  const priorExecutionInvocation = modelInvocationRecord({
    actualModelId: "openrouter/primary",
    agentDefinitionId: fixture.release.data.agentDefinitionId,
    ...customerRunPins(abandoned.run.data),
    agentManifestHash: fixture.release.data.contentHash,
    attemptId: `${abandoned.run.data.id}:prior-manual-execution`,
    captureMode: abandoned.run.data.captureMode,
    completedAt: "2026-07-21T23:00:00.500Z",
    environmentId: abandoned.run.data.environmentId,
    fallbackAttempt: 0,
    internalEvaluator: false,
    invocationId: `${abandoned.run.data.id}:execution:0:assistant:0`,
    invocationKind: "assistant",
    modelCallIndex: 0,
    organizationId: abandoned.run.data.organizationId,
    parentSpanId: abandoned.run.data.spanId,
    projectId: abandoned.run.data.projectId,
    requestedModelId: "openrouter/primary",
    runAttempt: abandoned.run.data.attempt,
    runExecutionVersion: 0,
    runId: abandoned.run.data.id,
    spanId: "0123456789abcdef",
    startedAt: "2026-07-21T23:00:00.250Z",
    status: "succeeded",
    streaming: false,
    threadId: abandoned.run.data.threadId,
    traceId: abandoned.run.data.traceId,
    ...(abandoned.run.data.workspaceId ? { workspaceId: abandoned.run.data.workspaceId } : {}),
  });
  const memory = inMemoryDatabase([abandoned.run, priorExecutionInvocation]);

  expect(
    modelInvocationsForRunAttempt(memory.database, abandoned.run, abandoned.run.data.attempt),
  ).resolves.toEqual([]);
});
