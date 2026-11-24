import { describe, expect, it } from "bun:test";
import { type DynamoDatabaseService, type PlatformRecord, type Ulid } from "@deployments-ai/db";
import { processAgentRun, resolveRunApproval } from "./index.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies } from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

describe("DynamoDB agent run worker", () => {
  it("keeps renewing ownership until terminal persistence commits", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    let completionAttempts = 0;
    const delayedDatabase: DynamoDatabaseService = {
      ...memory.database,
      transactWrite: async (operations, clientRequestToken) => {
        const completesRun = operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "completed",
        );
        if (!completesRun)
          return await memory.database.transactWrite(operations, clientRequestToken);
        completionAttempts += 1;
        if (completionAttempts === 1) await Bun.sleep(60);
        return await memory.database.transactWrite(operations, clientRequestToken);
      },
    };
    const base = workerDependencies(delayedDatabase);
    const assistantBody = "x".repeat(300_000);
    const externalizedMessageIds = new Set<Ulid>();
    let bodyWrites = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      heartbeatIntervalMs: 5,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: assistantBody }),
      },
      deleteMessageBody: async () => undefined,
      writeMessageBody: async (input) => {
        bodyWrites += 1;
        externalizedMessageIds.add(input.messageId);
        return {
          bucket: "message-bodies",
          byteSize: new TextEncoder().encode(input.body).byteLength,
          contentType: "text/plain; charset=utf-8",
          key: `messages/${input.messageId}`,
          sha256: input.contentHash,
          versionId: "stable-completion-version",
        };
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    expect(completionAttempts).toBeGreaterThan(1);
    expect(bodyWrites).toBe(1);
    expect(externalizedMessageIds.size).toBe(1);
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.heartbeat",
      ).length,
    ).toBeGreaterThan(0);
    const semanticEvents = [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "semantic-event" }> =>
        record.itemType === "semantic-event",
    );
    const heartbeatTimes = semanticEvents
      .filter((record) => record.data.eventType === "run.heartbeat")
      .map((record) => Date.parse(record.data.occurredAt));
    const completionEvent = semanticEvents.find(
      (record) => record.data.eventType === "run.completed",
    );
    expect(completionEvent).toBeDefined();
    expect(Date.parse(completionEvent!.data.occurredAt)).toBeGreaterThanOrEqual(
      Math.max(...heartbeatTimes),
    );
  });

  it("extends queue visibility before a short execution can complete", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let visibilityExtensions = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      extendQueueVisibility: Object.assign(
        async () => {
          visibilityExtensions += 1;
        },
        { renewalIntervalMs: 500 },
      ),
      heartbeatIntervalMs: 1_000,
    };

    const result = await processAgentRun(fixture.queue, dependencies, {
      messageId: "immediate-visibility-delivery",
      receiptHandle: "immediate-visibility-receipt",
    });

    expect(result.action).toBe("completed");
    expect(visibilityExtensions).toBe(1);
  });

  it("renews queue visibility independently from a slower claim heartbeat", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let visibilityExtensions = 0;
    // The first extension starts with the claim. The next two come from the renewal interval.
    const renewedByInterval = Promise.withResolvers<void>();
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      extendQueueVisibility: Object.assign(
        async () => {
          visibilityExtensions += 1;
          if (visibilityExtensions === 3) renewedByInterval.resolve();
        },
        { renewalIntervalMs: 5 },
      ),
      heartbeatIntervalMs: 60_000,
      runningClaimTimeoutMs: 120_000,
      runtime: {
        generateAssistantMessage: async () => {
          await renewedByInterval.promise;
          return { assistantMessage: "Independent visibility result." };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies, {
      messageId: "independent-visibility-delivery",
      receiptHandle: "independent-visibility-receipt",
    });

    expect(result.action).toBe("completed");
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.heartbeat",
      ),
    ).toHaveLength(1);
  });

  it("validates queue visibility configuration before claiming the run", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      queueVisibilityExtensionTimeoutMs: 0,
    };

    expect(processAgentRun(fixture.queue, dependencies)).rejects.toThrow(
      "visibility extension timeout",
    );

    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("queued");
    expect(memory.transactionInputs).toHaveLength(0);
  });

  it("reconciles a heartbeat that committed before its response was lost", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { throwAfterHeartbeatCommitOnce: true },
    );
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      heartbeatIntervalMs: 5,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async () => {
          await Bun.sleep(20);
          return { assistantMessage: "Reconciled heartbeat result." };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.heartbeat",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("retains an externalized body when claim release fails before completion persistence", async () => {
    const fixture = fixtures();
    let heartbeatFailed!: () => void;
    const heartbeatFailure = new Promise<void>((resolve) => {
      heartbeatFailed = resolve;
    });
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      {
        failHeartbeatBeforeCommitOnce: true,
        onHeartbeatFailureBeforeCommit: heartbeatFailed,
      },
    );
    const base = workerDependencies(memory.database);
    const assistantBody = "x".repeat(300_000);
    let deletes = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      deleteMessageBody: async () => {
        deletes += 1;
      },
      heartbeatIntervalMs: 5,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: assistantBody }),
      },
      writeMessageBody: async (input) => {
        await heartbeatFailure;
        return {
          bucket: "message-bodies",
          byteSize: new TextEncoder().encode(input.body).byteLength,
          contentType: "text/plain; charset=utf-8",
          key: `messages/${input.messageId}`,
          sha256: input.contentHash,
          versionId: "pre-persistence-release-failure",
        };
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).rejects.toThrow(
      "heartbeat failure before commit",
    );

    expect(deletes).toBe(0);
    expect(
      [...memory.records.values()].some(
        (record) => record.itemType === "message" && record.data.role === "assistant",
      ),
    ).toBe(false);
  });

  it("does not rewrite canceled outcomes when terminal persistence is unavailable", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { failCanceledBeforeCommitOnce: true },
    );
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
        shouldCancel: async () => true,
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).rejects.toThrow(
      "canceled-run persistence failure",
    );

    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("running");
    expect(
      [...memory.records.values()].some(
        (record) => record.itemType === "semantic-event" && record.data.eventType === "run.failed",
      ),
    ).toBe(false);
  });

  it("terminalizes an approved tool when cancellation wins before execution", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithToolRequests(fixture.release.data.manifest, [
        {
          effect: "write",
          idempotencyKey: "tool/approved-before-cancel",
          input: { target: "production" },
          inputSummary: "Deploy to production.",
          requiredScopes: ["deployment:write"],
          toolName: "deployment.start",
        },
      ]),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let canceled = false;
    let executions = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        authorizeToolCall: async () => ({
          action: "require-approval",
          approvalId: id(92),
          reason: "Production deployment requires approval.",
          toolCallId: id(91),
        }),
        executeToolCall: async () => {
          executions += 1;
          return { status: "completed" };
        },
        generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
        recordArtifact: async () => undefined,
        resolveToolDefinition: async (toolName) => ({
          effect: "write",
          requiredScopes: ["deployment:write"],
          toolName,
        }),
        shouldCancel: async () => canceled,
      },
    };

    const paused = await processAgentRun(fixture.queue, dependencies);
    expect(paused).toMatchObject({ action: "paused", status: "waiting-for-approval" });
    const enqueued: AgentRunQueueMessage[] = [];
    const resolution = await resolveRunApproval(
      {
        approvalId: id(92),
        decision: "approved",
        environmentId: fixture.queue.environmentId,
        organizationId: fixture.queue.organizationId,
        projectId: fixture.queue.projectId,
        resolvedByPrincipalId: id(93),
        runId: fixture.queue.runId,
        threadId: fixture.queue.threadId,
      },
      {
        appendThreadEvent: base.dependencies.appendThreadEvent!,
        database: memory.database,
        enqueueRun: async ({ message }) => void enqueued.push(message),
        generateId: base.dependencies.generateId,
        now: base.dependencies.now!,
      },
    );
    expect(resolution.queueMessage).toBeDefined();
    if (!resolution.queueMessage) throw new Error("Approval did not return a queue message.");
    expect(enqueued).toEqual([resolution.queueMessage]);
    canceled = true;

    const result = await processAgentRun(resolution.queueMessage, dependencies);

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "canceled" } } });
    expect(executions).toBe(0);
    const toolCall = [...memory.records.values()].find(
      (record) => record.itemType === "tool-call" && record.data.id === id(91),
    );
    expect(toolCall).toMatchObject({
      data: {
        completedAt: expect.any(String),
        outputSummary: "Agent run was canceled before approved tool execution.",
        status: "failed",
      },
      itemType: "tool-call",
    });
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.aggregateId === id(91) &&
          record.data.eventType === "tool-call.failed",
      ),
    ).toBe(true);
  });

  it("persists a running async tool when cancellation wins after execution starts", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithToolRequests(fixture.release.data.manifest, [
        {
          effect: "write",
          idempotencyKey: "tool/async-cancel-race",
          input: { target: "production" },
          inputSummary: "Start an asynchronous production write.",
          requiredScopes: ["provider:write"],
          toolName: "provider.async-write",
        },
      ]),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let canceled = false;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        authorizeToolCall: async () => ({
          action: "allow",
          reason: "Allowed by pinned test policy.",
          toolCallId: id(70),
        }),
        executeToolCall: async () => {
          canceled = true;
          return {
            externalOperationId: "provider-operation-after-cancel",
            status: "running",
          };
        },
        generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
        recordArtifact: async () => undefined,
        resolveToolDefinition: async (toolName) => ({
          effect: "write",
          requiredScopes: ["provider:write"],
          toolName,
        }),
        shouldCancel: async () => canceled,
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "canceled" } } });
    const toolCall = [...memory.records.values()].find(
      (record) => record.itemType === "tool-call" && record.data.id === id(70),
    );
    expect(toolCall).toMatchObject({
      data: {
        externalOperationId: "provider-operation-after-cancel",
        status: "running",
      },
      itemType: "tool-call",
    });
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "tool-call.running",
      ),
    ).toBe(true);
  });

  it("continues database heartbeats when queue visibility extension fails", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let visibilityFailures = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      extendQueueVisibility: Object.assign(
        async () => {
          throw new Error("SQS unavailable");
        },
        { renewalIntervalMs: 5 },
      ),
      heartbeatIntervalMs: 5,
      reportQueueVisibilityFailure: async () => {
        visibilityFailures += 1;
      },
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async () => {
          await Bun.sleep(20);
          return { assistantMessage: "Visibility-independent result." };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies, {
      messageId: "visibility-delivery",
      receiptHandle: "visibility-receipt",
    });

    expect(result.action).toBe("completed");
    expect(visibilityFailures).toBeGreaterThan(0);
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.heartbeat",
      ).length,
    ).toBeGreaterThan(0);
  });
});
