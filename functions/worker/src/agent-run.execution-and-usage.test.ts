import { describe, expect, it } from "bun:test";
import {
  prepareDynamoTransactionOperations,
  RunRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS } from "@deployments-ai/agent-runtime";
import { conversationMessageIsTransient } from "@deployments-ai/conversations";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { boundedRecentMessages } from "./agent-run-input.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  manifestWithTriggers,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

describe("DynamoDB agent run worker", () => {
  it("keeps the maximum completed-tool run within expanded transaction capacity", async () => {
    const fixture = fixtures();
    const requests = Array.from({ length: MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS }, (_, index) => ({
      effect: "read" as const,
      idempotencyKey: `capacity-tool-${index}`,
      inputSummary: `Read capacity resource ${index}`,
      requiredScopes: [],
      toolName: "provider.read",
    }));
    const release = releaseWithManifest(
      fixture.release,
      manifestWithToolRequests(fixture.release.data.manifest, requests),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const database: DynamoDatabaseService = {
      ...memory.database,
      transactWrite: async (operations, token, signal) => {
        await prepareDynamoTransactionOperations(operations);
        return await memory.database.transactWrite(operations, token, signal);
      },
    };
    const base = workerDependencies(database);
    let nextToolId = 200;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        authorizeToolCall: async () => ({
          action: "allow",
          reason: "Capacity test.",
          toolCallId: id(nextToolId++),
        }),
        executeToolCall: async () => ({ status: "completed" }),
        generateAssistantMessage: async (request) => ({
          assistantMessage: "All capacity reads completed.",
          usage: [
            {
              idempotencyKey: `${request.runId}:capacity-model`,
              occurredAt: "2026-07-22T00:00:01.000Z",
              quantity: 1,
              source: "model-gateway",
              payer: { kind: "operator" as const },
              type: "model_tokens",
              unit: "tokens",
            },
          ],
        }),
        recordArtifact: async () => undefined,
        resolveToolDefinition: async (toolName) => ({
          description: "Read a capacity resource.",
          effect: "read",
          inputSchema: { additionalProperties: false, type: "object" },
          requiredScopes: [],
          toolName,
        }),
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
  });

  it("claims a queued run and persists a pinned model-only execution", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    for (const [key, record] of memory.records) {
      if (record.itemType === "run-lookup" && record.data.runId === fixture.run.data.id) {
        memory.records.delete(key);
      }
    }
    const { dependencies, events } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    const all = [...memory.records.values()];
    const persistedRun = all.find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("completed");
    expect(persistedRun?.data.agentReleaseId).toBe(fixture.release.data.id);
    const assistant = all.find(
      (record) => record.itemType === "message" && record.data.role === "assistant",
    ) as Extract<PlatformRecord, { readonly itemType: "message" }> | undefined;
    expect(assistant?.data.body).toBe("Persisted assistant result.");
    expect(assistant?.data.runId).toBe(fixture.run.data.id);
    expect(all.filter((record) => record.itemType === "timeline-event")).toHaveLength(1);
    expect(
      all
        .filter((record) => record.itemType === "semantic-event")
        .map((record) => record.data.eventType),
    ).toEqual([
      "run.started",
      "agent.plan.updated",
      "agent.task.updated",
      "agent.task.updated",
      "run.heartbeat",
      "run.completed",
      "assistant-message.finalized",
    ]);
    expect(events.some((event) => event.eventType === "assistant-message.finalized")).toBe(true);
    expect(events.some((event) => event.eventType === "run.completed")).toBe(true);
    expect(
      all.some(
        (record) => record.itemType === "run-lookup" && record.data.runId === fixture.run.data.id,
      ),
    ).toBe(true);
    expect(memory.queryInputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ ConsistentRead: true })]),
    );
    expect(memory.transactionInputs[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "condition-check",
          table: "execution",
        }),
        expect.objectContaining({ kind: "condition-check", table: "control" }),
        expect.objectContaining({ kind: "condition-check", table: "control" }),
      ]),
    );
    expect(memory.transactionTokens[0]).toHaveLength(36);
    expect(all.some((record) => record.itemType === "runtime-lease")).toBe(false);
    expect(all.find((record) => record.itemType === "model-invocation")?.data).toMatchObject({
      captureMode: "metadata-only",
      parentSpanId: fixture.run.data.spanId,
      runId: fixture.run.data.id,
      status: "succeeded",
      traceId: fixture.run.data.traceId,
    });
  });

  it("marks suppressed heartbeat decisions transient", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithTriggers(fixture.release.data.manifest, ["heartbeat"]),
    );
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.run.data, trigger: "heartbeat" },
        itemType: "run" as const,
      }),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
    ]);
    const { dependencies, events } = workerDependencies(memory.database);
    const suppressedDependencies: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => ({
          assistantMessage: " [no_initiation] ",
        }),
      },
    };

    const result = await processAgentRun(fixture.queue, suppressedDependencies);

    expect(result.action).toBe("completed");
    const assistant = [...memory.records.values()].find(
      (record) => record.itemType === "message" && record.data.role === "assistant",
    );
    expect(assistant?.itemType).toBe("message");
    expect(
      conversationMessageIsTransient(
        assistant?.itemType === "message" ? assistant.data.metadata : undefined,
      ),
    ).toBe(true);
    expect(events.filter((event) => event.eventType === "assistant-message.finalized")).toEqual([]);
    expect(events.filter((event) => event.eventType === "run.completed")).toHaveLength(1);
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "assistant-message.finalized",
      ),
    ).toMatchObject({ data: { payload: { deploymentsAiInternal: true } } });

    const replay = workerDependencies(memory.database);
    expect(processAgentRun(fixture.queue, replay.dependencies)).resolves.toMatchObject({
      action: "skipped",
    });
    expect(
      replay.events.filter((event) => event.eventType === "assistant-message.finalized"),
    ).toEqual([]);
    expect(replay.events.filter((event) => event.eventType === "run.completed")).toHaveLength(1);
  });

  it.each(["heartbeat", "schedule"] as const)(
    "keeps %s outputs transient so external delivery policy cannot pollute model history",
    async (trigger) => {
      const fixture = fixtures();
      const release = releaseWithManifest(
        fixture.release,
        manifestWithTriggers(fixture.release.data.manifest, [trigger]),
      );
      const run = Schema.decodeUnknownSync(RunRecord)(
        withCanonicalRecordKeys({
          data: { ...fixture.run.data, trigger },
          itemType: "run" as const,
        }),
      );
      const memory = inMemoryDatabase([
        release,
        fixture.deployment,
        fixture.thread,
        fixture.userMessage,
        run,
      ]);
      const { dependencies, events } = workerDependencies(memory.database);

      const result = await processAgentRun(fixture.queue, dependencies);

      expect(result.action).toBe("completed");
      const assistant = [...memory.records.values()].find(
        (record) => record.itemType === "message" && record.data.role === "assistant",
      );
      expect(assistant?.itemType).toBe("message");
      expect(
        conversationMessageIsTransient(
          assistant?.itemType === "message" ? assistant.data.metadata : undefined,
        ),
      ).toBe(true);
      expect(events.filter((event) => event.eventType === "assistant-message.finalized")).toEqual(
        [],
      );
      expect(
        boundedRecentMessages(
          assistant?.itemType === "message" ? [assistant] : [],
          1_000,
          dependencies,
        ),
      ).resolves.toEqual([]);
    },
  );

  it("keeps externally published chat output transient until delivery is confirmed", async () => {
    const fixture = fixtures();
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          responsePublication: "external",
          trigger: "chat",
        },
        itemType: "run" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
    ]);
    const { dependencies, events } = workerDependencies(memory.database);

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    const assistant = [...memory.records.values()].find(
      (record) => record.itemType === "message" && record.data.role === "assistant",
    );
    expect(assistant?.itemType).toBe("message");
    expect(
      conversationMessageIsTransient(
        assistant?.itemType === "message" ? assistant.data.metadata : undefined,
      ),
    ).toBe(true);
    expect(events.filter((event) => event.eventType === "assistant-message.finalized")).toEqual([]);
  });

  it("executes due schedule prompts without exposing recursive schedule creation to the model", async () => {
    const fixture = fixtures();
    const manifest = manifestWithTriggers(
      {
        ...fixture.release.data.manifest,
        spec: {
          ...fixture.release.data.manifest.spec,
          capabilities: {
            tools: [
              {
                authorization: "none" as const,
                name: "agent.brain.search",
                required: false,
                requiredScopes: [],
              },
              {
                authorization: "none" as const,
                name: "agent.schedule.remind",
                required: false,
                requiredScopes: [],
              },
            ],
          },
          runtime: {
            ...fixture.release.data.manifest.spec.runtime,
            modelTools: ["agent.brain.search", "agent.schedule.remind"],
          },
        },
      },
      ["schedule"],
    );
    const release = releaseWithManifest(fixture.release, manifest);
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.run.data, trigger: "schedule" },
        itemType: "run" as const,
      }),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
    ]);
    const base = workerDependencies(memory.database);
    let observed:
      | Parameters<AgentRunWorkerDependencies["runtime"]["generateAssistantMessage"]>[0]
      | undefined;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          observed = request;
          return { assistantMessage: "missed u. what are u up to?" };
        },
        recordArtifact: async () => undefined,
        resolveToolDefinition: async (toolName) => ({
          description: toolName,
          effect: toolName === "agent.brain.search" ? "read" : "write",
          inputSchema: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          requiredScopes: [],
          toolName,
        }),
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    expect(observed?.tools.map((tool) => tool.toolName)).toEqual(["agent.brain.search"]);
    expect(observed?.instructions).toContain(
      "This run started because a previously created schedule is due now.",
    );
    expect(observed?.instructions).toContain("Fulfill the current prompt now");
    expect(observed?.instructions).toContain("Do not create another schedule or reminder");
  });

  it("commits model usage at the provider boundary and worker usage at terminal persistence", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    const metered: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => ({
          assistantMessage: "Metered result.",
          resolvedModelId: "openrouter/test-served",
          totalTokens: 999,
          usage: [
            {
              costUsdMicros: 25,
              idempotencyKey: "model:test",
              inputTokens: 30,
              modelId: "openrouter/test-served",
              occurredAt: "2026-07-22T00:00:01.000Z",
              outputTokens: 12,
              provider: "openrouter",
              quantity: 42,
              runId: fixture.run.data.id,
              source: "model-gateway",
              startedAt: "2026-07-22T00:00:00.500Z",
              payer: { kind: "operator" as const },
              type: "model_tokens",
              unit: "tokens",
            },
          ],
        }),
      },
    };

    const result = await processAgentRun(fixture.queue, metered);

    expect(result.action).toBe("completed");
    const usage = [...memory.records.values()].filter(
      (record) => record.itemType === "meter-event",
    ) as Extract<PlatformRecord, { readonly itemType: "meter-event" }>[];
    expect(usage.map((record) => record.data.metric).sort()).toEqual(["model_tokens", "worker_ms"]);
    expect(usage.map((record) => record.data.workspaceId)).toEqual([
      fixture.run.data.workspaceId,
      fixture.run.data.workspaceId,
    ]);
    expect(usage.find((record) => record.data.metric === "model_tokens")?.data).toMatchObject({
      dimensions: {
        costUsdMicros: 25,
        inputTokens: 30,
        modelId: "openrouter/qwen/qwen3.7-plus",
        outputTokens: 12,
        provider: "openrouter",
      },
      quantity: 42,
      runId: fixture.run.data.id,
      idempotencyKey: `${fixture.run.data.id}:model:test`,
    });
    const invocation = [...memory.records.values()].find(
      (record) => record.itemType === "model-invocation",
    );
    expect(invocation?.data).toMatchObject({
      actualModelId: "openrouter/qwen/qwen3.7-plus",
      agentDefinitionId: fixture.release.data.agentDefinitionId,
      agentDeploymentId: fixture.run.data.agentDeploymentId,
      agentManifestHash: fixture.release.data.contentHash,
      agentReleaseId: fixture.run.data.agentReleaseId,
      costUsdMicros: 25,
      threadId: fixture.run.data.threadId,
      totalTokens: 42,
      usageIdempotencyKey: `${fixture.run.data.id}:model:test`,
    });
    const completionTransaction = memory.transactionInputs.find((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "run" &&
          operation.record.data.status === "completed",
      ),
    );
    expect(
      completionTransaction?.filter(
        (operation) => operation.kind === "put" && operation.record.itemType === "meter-event",
      ),
    ).toHaveLength(1);
    const invocationTransaction = memory.transactionInputs.find((operations) =>
      operations.some(
        (operation) => operation.kind === "put" && operation.record.itemType === "model-invocation",
      ),
    );
    expect(
      invocationTransaction?.filter(
        (operation) => operation.kind === "put" && operation.record.itemType === "meter-event",
      ),
    ).toHaveLength(1);

    await processAgentRun(fixture.queue, metered);
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "meter-event"),
    ).toHaveLength(2);
  });

  it("fails closed on reused runtime usage idempotency keys", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    const duplicateUsage: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => ({
          assistantMessage: "Invalid metering result.",
          usage: [
            {
              idempotencyKey: "duplicate-usage",
              modelId: "openrouter/test",
              occurredAt: "2026-07-22T00:00:01.000Z",
              provider: "openrouter",
              quantity: 1,
              runId: fixture.run.data.id,
              source: "test",
              payer: { kind: "operator" as const },
              type: "model_tokens",
              unit: "tokens",
            },
            {
              idempotencyKey: "duplicate-usage",
              modelId: "openrouter/test",
              occurredAt: "2026-07-22T00:00:01.000Z",
              provider: "openrouter",
              quantity: 2,
              runId: fixture.run.data.id,
              source: "test",
              payer: { kind: "operator" as const },
              type: "model_tokens",
              unit: "tokens",
            },
          ],
        }),
      },
    };

    const result = await processAgentRun(fixture.queue, duplicateUsage);
    expect(result).toMatchObject({
      action: "skipped",
      run: { data: { status: "failed" } },
    });
    expect(result.run?.data.error?.message).toContain("reused usage idempotencyKey");
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "meter-event"),
    ).toHaveLength(1);
  });

  it("fails closed on runtime usage timestamps outside the Date range", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    const invalidUsage: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => ({
          assistantMessage: "Invalid timestamp result.",
          usage: [
            {
              idempotencyKey: "out-of-range-usage",
              modelId: "openrouter/test",
              occurredAt: Number.MAX_SAFE_INTEGER,
              provider: "openrouter",
              quantity: 1,
              runId: fixture.run.data.id,
              source: "test",
              payer: { kind: "operator" as const },
              type: "model_tokens",
              unit: "tokens",
            },
          ],
        }),
      },
    };

    const result = await processAgentRun(fixture.queue, invalidUsage);

    expect(result).toMatchObject({
      action: "skipped",
      run: { data: { status: "failed" } },
    });
    expect(result.run?.data.error?.message).toContain("supported timestamp range");
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "meter-event"),
    ).toHaveLength(0);
  });
});
