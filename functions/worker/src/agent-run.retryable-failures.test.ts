import { describe, expect, it } from "bun:test";
import {
  RuntimeArtifactPublicationError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import { type PlatformRecord } from "@deployments-ai/db";
import { processAgentRun } from "./index.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies } from "./types.ts";
import {
  customerRunPins,
  abandonedRunWithLease,
  fixtures,
  inMemoryDatabase,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { runToolContinuation, withRunToolContinuation } from "./continuation.ts";
import { queuedRunThreadExecutionLease, threadExecutionLease } from "./agent-run-lease.ts";
import { retryableRun } from "./records.ts";
import { modelInvocationRecord } from "./model-invocations.ts";

describe("retryable agent run failures", () => {
  it("derives queued lease duration from the latest renewal", () => {
    const fixture = fixtures();
    const retryTimestamp = new Date("2026-07-22T00:10:05.000Z");
    const run = retryableRun(fixture.run, retryTimestamp);
    const renewedLease = threadExecutionLease({
      acquiredAt: "2026-07-22T00:00:00.000Z",
      expiresAt: "2026-07-22T00:10:30.000Z",
      owner: "worker-1",
      renewedAt: "2026-07-22T00:10:00.000Z",
      runId: run.data.id,
      threadId: run.data.threadId,
      version: 4,
    });

    expect(queuedRunThreadExecutionLease(renewedLease, run, retryTimestamp).data).toMatchObject({
      acquiredAt: "2026-07-22T00:10:05.000Z",
      expiresAt: "2026-07-22T00:10:35.000Z",
      owner: `queued-run/${run.data.id}`,
      renewedAt: "2026-07-22T00:10:05.000Z",
      version: 5,
    });
  });

  for (const [label, failure] of [
    ["artifact publication", new RuntimeArtifactPublicationError("stream unavailable")],
    [
      "tool preparation",
      new RuntimeToolPreparationRetryableError(
        "provider.write",
        new Error("credential vault unavailable"),
      ),
    ],
  ] as const) {
    it(`returns ${label} failures to the original queue position`, async () => {
      const fixture = fixtures();
      const memory = inMemoryDatabase([
        fixture.release,
        fixture.deployment,
        fixture.thread,
        fixture.userMessage,
        fixture.run,
      ]);
      const base = workerDependencies(memory.database);
      const requeued: AgentRunQueueMessage[] = [];
      const dependencies: AgentRunWorkerDependencies = {
        ...base.dependencies,
        enqueueRun: async ({ message }) => void requeued.push(message),
        runtime: {
          generateAssistantMessage: async () => {
            throw failure;
          },
        },
      };

      const result = await processAgentRun(fixture.queue, dependencies);

      expect(result).toMatchObject({
        action: "requeued",
        retryAfterSeconds: 60,
      });
      expect(requeued).toEqual([]);
      const persistedRun = [...memory.records.values()].find(
        (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
      ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
      expect(persistedRun?.data.status).toBe("queued");
      expect(persistedRun?.data.claimedBy).toBeUndefined();
      expect(
        [...memory.records.values()].find(
          (record) =>
            record.itemType === "runtime-lease" && record.data.runId === fixture.run.data.id,
        ),
      ).toMatchObject({ data: { owner: `queued-run/${fixture.run.data.id}` } });
      expect(
        [...memory.records.values()].some(
          (record) =>
            record.itemType === "semantic-event" && record.data.eventType === "run.retry-scheduled",
        ),
      ).toBe(true);
    });
  }

  it("carries a read's failure count to the next attempt and clears it once the run moves on", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const seen: unknown[] = [];
    const generateAssistantMessage = Object.assign(
      async () => {
        if (seen.length === 1) {
          throw new RuntimeToolPreparationRetryableError(
            "web.scrape",
            new Error("Firecrawl request failed with HTTP 502."),
            { failures: 1, idempotencyKey: "read-page" },
          );
        }
        return { assistantMessage: "Done." };
      },
      {
        validateRunInput: (input: { readonly retriedToolCall?: unknown }) =>
          void seen.push(input.retriedToolCall),
      },
    );
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      enqueueRun: async () => undefined,
      runtime: { generateAssistantMessage },
    };
    const persistedRun = () =>
      [...memory.records.values()].find(
        (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
      ) as Extract<PlatformRecord, { readonly itemType: "run" }>;

    expect(await processAgentRun(fixture.queue, dependencies)).toMatchObject({
      action: "requeued",
    });
    expect(runToolContinuation(persistedRun()).retriedToolCall).toEqual({
      failures: 1,
      idempotencyKey: "read-page",
    });
    expect(await processAgentRun(fixture.queue, dependencies)).toMatchObject({
      action: "completed",
    });
    expect(seen).toEqual([undefined, { failures: 1, idempotencyKey: "read-page" }]);
    expect(runToolContinuation(persistedRun()).retriedToolCall).toBeUndefined();
  });

  it("preserves artifact continuation while requeueing", async () => {
    const fixture = fixtures();
    const run = withRunToolContinuation(fixture.run, [], undefined, {
      artifactBytes: 512,
      artifactIndexCursor: 1,
      artifacts: [
        {
          contentType: "text/plain",
          fileName: "prior-output.txt",
          label: "Prior output",
          type: "report",
        },
      ],
      sandboxCompleted: true,
    });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      enqueueRun: async () => undefined,
      runtime: {
        ...base.dependencies.runtime,
        generateAssistantMessage: async () => {
          throw new RuntimeArtifactPublicationError("stream unavailable");
        },
        loadArtifact: async () => ({
          content: "x".repeat(512),
          contentType: "text/plain",
          fileName: "prior-output.txt",
          label: "Prior output",
          type: "report",
        }),
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "requeued",
    });
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun && runToolContinuation(persistedRun).artifactContinuation).toEqual({
      artifactBytes: 512,
      artifactIndexCursor: 1,
      artifacts: [
        {
          contentType: "text/plain",
          fileName: "prior-output.txt",
          label: "Prior output",
          type: "report",
        },
      ],
      sandboxCompleted: true,
    });
  });

  it("persists a provider response before advancing its completed run", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { throwAfterModelInvocationCommitOnce: true },
    );
    const base = workerDependencies(memory.database);
    let generations = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        ...base.dependencies.runtime,
        generateAssistantMessage: async () => {
          generations += 1;
          return {
            assistantMessage: "Provider response that must not be lost.",
            totalTokens: 7,
          };
        },
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    const invocationTransactionIndex = memory.transactionInputs.findIndex((operations) =>
      operations.some(
        (operation) => operation.kind === "put" && operation.record.itemType === "model-invocation",
      ),
    );
    const completionTransactionIndex = memory.transactionInputs.findIndex((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "run" &&
          operation.record.data.status === "completed",
      ),
    );
    expect(invocationTransactionIndex).toBeGreaterThanOrEqual(0);
    expect(completionTransactionIndex).toBeGreaterThan(invocationTransactionIndex);
    expect(memory.transactionInputs[invocationTransactionIndex]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "condition-check",
          table: "execution",
        }),
      ]),
    );
    const invocation = [...memory.records.values()].find(
      (record) => record.itemType === "model-invocation",
    );
    expect(invocation?.data).toMatchObject({ status: "succeeded" });
    expect(invocation?.data).not.toHaveProperty("totalTokens");
    expect(generations).toBe(1);
  });

  it("terminalizes invocations whose provider token fields are not canonical", async () => {
    for (const scenario of [
      {
        generation: {
          assistantMessage: "Provider returned invalid token metadata.",
          inputTokens: -1,
        },
        invocationCount: 0,
      },
      {
        generation: {
          assistantMessage: "Provider returned invalid usage metadata.",
          usage: [
            {
              idempotencyKey: "invalid-provider-usage",
              modelId: "openrouter/test",
              occurredAt: 2,
              provider: "openrouter",
              quantity: -1,
              source: "model-gateway",
              payer: { kind: "operator" as const },
              type: "model_tokens" as const,
              unit: "tokens",
            },
          ],
        },
        invocationCount: 1,
      },
    ]) {
      const fixture = fixtures();
      const memory = inMemoryDatabase([
        fixture.release,
        fixture.deployment,
        fixture.thread,
        fixture.userMessage,
        fixture.run,
      ]);
      const base = workerDependencies(memory.database);
      let generations = 0;
      const dependencies: AgentRunWorkerDependencies = {
        ...base.dependencies,
        runtime: {
          ...base.dependencies.runtime,
          generateAssistantMessage: async () => {
            generations += 1;
            return scenario.generation;
          },
        },
      };

      expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
        action: "skipped",
        run: { data: { status: "failed" } },
      });
      expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
        action: "skipped",
        run: { data: { status: "failed" } },
      });

      expect(
        [...memory.records.values()].filter(
          (record) =>
            record.itemType === "runtime-lease" && record.data.runId === fixture.run.data.id,
        ),
      ).toHaveLength(0);
      expect(
        [...memory.records.values()].filter((record) => record.itemType === "model-invocation"),
      ).toHaveLength(scenario.invocationCount);
      expect(generations).toBe(1);
    }
  });

  it("serializes provider-boundary persistence with claim heartbeats", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { delayModelInvocationCommitMs: 25 },
    );
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      heartbeatIntervalMs: 5,
      runningClaimTimeoutMs: 100,
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    const invocationTransactionIndex = memory.transactionInputs.findIndex((operations) =>
      operations.some(
        (operation) => operation.kind === "put" && operation.record.itemType === "model-invocation",
      ),
    );
    const heartbeatTransactionIndex = memory.transactionInputs.findIndex((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "semantic-event" &&
          operation.record.data.eventType === "run.heartbeat",
      ),
    );
    expect(invocationTransactionIndex).toBeGreaterThanOrEqual(0);
    expect(heartbeatTransactionIndex).toBeGreaterThan(invocationTransactionIndex);
  });

  it("terminalizes an orphaned provider response without dispatching it again", async () => {
    const fixture = fixtures();
    const abandoned = abandonedRunWithLease(fixture);
    const invocation = modelInvocationRecord({
      actualModelId: "openrouter/primary",
      agentDefinitionId: fixture.release.data.agentDefinitionId,
      ...customerRunPins(abandoned.run.data),
      agentManifestHash: fixture.release.data.contentHash,
      attemptId: `${abandoned.run.data.id}:orphaned-attempt`,
      captureMode: abandoned.run.data.captureMode,
      completedAt: "2026-07-22T00:00:00.500Z",
      environmentId: abandoned.run.data.environmentId,
      fallbackAttempt: 0,
      internalEvaluator: false,
      invocationId: `${abandoned.run.data.id}:orphaned-invocation`,
      invocationKind: "assistant",
      modelCallIndex: 0,
      organizationId: abandoned.run.data.organizationId,
      parentSpanId: abandoned.run.data.spanId,
      projectId: abandoned.run.data.projectId,
      requestedModelId: "openrouter/primary",
      runAttempt: abandoned.run.data.attempt,
      runExecutionVersion: abandoned.run.data.version,
      runId: abandoned.run.data.id,
      spanId: "fedcba9876543210",
      startedAt: "2026-07-22T00:00:00.250Z",
      status: "succeeded",
      streaming: false,
      threadId: abandoned.run.data.threadId,
      traceId: abandoned.run.data.traceId,
      ...(abandoned.run.data.workspaceId ? { workspaceId: abandoned.run.data.workspaceId } : {}),
    });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      abandoned.run,
      abandoned.lease,
      invocation,
    ]);
    const base = workerDependencies(memory.database);
    let generations = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 100,
      runtime: {
        generateAssistantMessage: async () => {
          generations += 1;
          return { assistantMessage: "must not run" };
        },
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "skipped",
      run: { data: { status: "failed" } },
    });
    expect(generations).toBe(0);
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "model-invocation"),
    ).toHaveLength(1);
  });

  it("resumes the bounded single-route retry after an orphaned failed provider attempt", async () => {
    const fixture = fixtures();
    const abandoned = abandonedRunWithLease(fixture);
    const failedInvocation = modelInvocationRecord({
      agentDefinitionId: fixture.release.data.agentDefinitionId,
      ...customerRunPins(abandoned.run.data),
      agentManifestHash: fixture.release.data.contentHash,
      attemptId: `${abandoned.run.data.id}:failed-primary`,
      captureMode: abandoned.run.data.captureMode,
      completedAt: "2026-07-22T00:00:00.500Z",
      environmentId: abandoned.run.data.environmentId,
      errorClass: "Error",
      fallbackAttempt: 0,
      internalEvaluator: false,
      invocationId: `${abandoned.run.data.id}:execution:1:assistant:0`,
      invocationKind: "assistant",
      modelCallIndex: 0,
      organizationId: abandoned.run.data.organizationId,
      parentSpanId: abandoned.run.data.spanId,
      projectId: abandoned.run.data.projectId,
      requestedModelId: "openrouter/qwen/qwen3.7-plus",
      runAttempt: abandoned.run.data.attempt,
      runExecutionVersion: abandoned.run.data.version,
      runId: abandoned.run.data.id,
      spanId: "fedcba9876543210",
      startedAt: "2026-07-22T00:00:00.250Z",
      status: "failed",
      streaming: false,
      threadId: abandoned.run.data.threadId,
      traceId: abandoned.run.data.traceId,
      ...(abandoned.run.data.workspaceId ? { workspaceId: abandoned.run.data.workspaceId } : {}),
    });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      abandoned.run,
      abandoned.lease,
      failedInvocation,
    ]);
    const base = workerDependencies(memory.database);
    const generated: Array<{ readonly modelCallId: string; readonly modelId: string }> = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 100,
      runtime: {
        generateAssistantMessage: async (request) => {
          generated.push({ modelCallId: request.modelCallId, modelId: request.modelId });
          return { assistantMessage: "Recovered on the single-route retry." };
        },
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    expect(generated).toEqual([
      {
        modelCallId: `${abandoned.run.data.id}:execution:${abandoned.run.data.version + 1}:assistant:0:run-attempt:${abandoned.run.data.attempt + 1}:fallback:1`,
        modelId: "openrouter/qwen/qwen3.7-plus",
      },
    ]);
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "model-invocation"),
    ).toHaveLength(2);
  });

  it("resumes the latest execution epoch after an orphaned failed provider attempt", async () => {
    const fixture = fixtures();
    const abandoned = abandonedRunWithLease(fixture);
    const release = releaseWithManifest(fixture.release, {
      ...fixture.release.data.manifest,
      spec: {
        ...fixture.release.data.manifest.spec,
        model: {
          ...fixture.release.data.manifest.spec.model,
          fallbackIds: ["openrouter/z-ai/glm-5.2", "openrouter/xiaomi/mimo-v2.5"],
        },
      },
    });
    const failedInvocation = modelInvocationRecord({
      agentDefinitionId: fixture.release.data.agentDefinitionId,
      ...customerRunPins(abandoned.run.data),
      agentManifestHash: fixture.release.data.contentHash,
      attemptId: `${abandoned.run.data.id}:failed-first-fallback`,
      captureMode: abandoned.run.data.captureMode,
      completedAt: "2026-07-22T00:00:00.500Z",
      environmentId: abandoned.run.data.environmentId,
      errorClass: "Error",
      fallbackAttempt: 1,
      internalEvaluator: false,
      invocationId: `${abandoned.run.data.id}:execution:1:assistant:0`,
      invocationKind: "assistant",
      modelCallIndex: 0,
      organizationId: abandoned.run.data.organizationId,
      parentSpanId: abandoned.run.data.spanId,
      projectId: abandoned.run.data.projectId,
      requestedModelId: "openrouter/z-ai/glm-5.2",
      runAttempt: abandoned.run.data.attempt,
      runExecutionVersion: abandoned.run.data.version,
      runId: abandoned.run.data.id,
      spanId: "fedcba9876543210",
      startedAt: "2026-07-22T00:00:00.250Z",
      status: "failed",
      streaming: false,
      threadId: abandoned.run.data.threadId,
      traceId: abandoned.run.data.traceId,
      ...(abandoned.run.data.workspaceId ? { workspaceId: abandoned.run.data.workspaceId } : {}),
    });
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
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      abandoned.run,
      abandoned.lease,
      priorExecutionInvocation,
      failedInvocation,
    ]);
    const base = workerDependencies(memory.database);
    const generatedModels: string[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 100,
      runtime: {
        generateAssistantMessage: async (request) => {
          generatedModels.push(request.modelId);
          return { assistantMessage: "Recovered with fallback." };
        },
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    expect(generatedModels).toEqual(["openrouter/xiaomi/mimo-v2.5"]);
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "model-invocation"),
    ).toHaveLength(3);
  });
});
