import { describe, expect, it } from "bun:test";
import {
  MessageRecord,
  RunRecord,
  RuntimeLeaseRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  pausedToolCallRecord,
  pendingApprovalRecord,
  processAgentRun,
  resolveRunApproval,
  resolveRunToolResult,
} from "./index.ts";
import type {
  AgentRunQueueDelivery,
  AgentRunQueueMessage,
  AgentRunWorkerDependencies,
} from "./types.ts";
import {
  additionalRunOnThread,
  fifoQueueRecord,
  fixtures,
  id,
  inMemoryDatabase,
  processQueueRecords,
  workerDependencies,
} from "./agent-run.fixture.ts";

describe("DynamoDB agent run worker", () => {
  it("replays an expired failed-tool callback for a canceled run", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const canceled = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:00.000Z",
          claimedBy: "worker-canceled-tool",
          completedAt: "2026-07-22T00:00:30.000Z",
          heartbeatAt: "2026-07-22T00:00:30.000Z",
          status: "canceled" as const,
          updatedAt: "2026-07-22T00:00:30.000Z",
          userMessageId: fixture.userMessage.data.id,
          userMessageSequence: fixture.userMessage.data.sequence,
          version: 2,
        },
        itemType: "run" as const,
      }),
    );
    const action = {
      effect: "write" as const,
      externalOperationId: "provider-canceled-failure",
      idempotencyKey: "canceled-tool-failure-recovery",
      inputSummary: "Deploy to staging.",
      kind: "tool" as const,
      policyReason: "Pinned policy allows this call.",
      requiredScopes: ["deployment:write"],
      toolCallId: id(84),
      toolName: "deployment.start",
    };
    const toolCall = pausedToolCallRecord({
      action,
      now: new Date("2026-07-22T00:00:00.000Z"),
      run: canceled,
    });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      canceled,
      toolCall,
      second.userMessage,
      second.run,
    ]);
    const base = workerDependencies(memory.database);

    expect(
      resolveRunToolResult(
        {
          environmentId: canceled.data.environmentId,
          externalOperationId: action.externalOperationId,
          organizationId: canceled.data.organizationId,
          outcome: "failed",
          outputSummary: "Provider deployment failed after cancellation.",
          projectId: canceled.data.projectId,
          runId: canceled.data.id,
          threadId: canceled.data.threadId,
          toolCallId: action.toolCallId,
        },
        {
          appendThreadEvent: async () => {
            throw new Error("simulated canceled-tool publication failure");
          },
          database: memory.database,
          generateId: base.dependencies.generateId,
          now: () => new Date("2026-07-22T00:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("canceled-tool publication failure");

    expect(
      processAgentRun(second.queue, {
        ...base.dependencies,
        now: () => new Date("2026-07-22T01:00:00.000Z"),
        runningClaimTimeoutMs: 50,
        runtime: {
          generateAssistantMessage: async (request) => ({
            assistantMessage: `Completed ${request.runId}.`,
          }),
        },
      }),
    ).resolves.toMatchObject({ action: "completed" });

    const toolFailed = base.events.findIndex(
      (event) => event.eventType === "tool.failed" && event.runId === canceled.data.id,
    );
    const laterStarted = base.events.findIndex(
      (event) => event.eventType === "run.started" && event.runId === second.run.data.id,
    );
    expect(toolFailed).toBeGreaterThanOrEqual(0);
    expect(laterStarted).toBeGreaterThan(toolFailed);
  });

  it("requeues an approved prior run before the blocked current run", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const thirdRunId = id(70);
    const thirdUserMessage = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...second.userMessage.data,
          body: "Produce the third answer.",
          contentHash: "third-user-hash",
          id: id(71),
          runId: thirdRunId,
          sequence: 4,
        },
        itemType: "message" as const,
      }),
    );
    const thirdRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...second.run.data,
          id: thirdRunId,
          idempotencyKey: "run/request-3",
          userMessageId: thirdUserMessage.data.id,
          userMessageSequence: thirdUserMessage.data.sequence,
        },
        itemType: "run" as const,
      }),
    );
    const thirdQueue: AgentRunQueueMessage = {
      ...second.queue,
      idempotencyKey: thirdRun.data.idempotencyKey,
      runId: thirdRunId,
      userMessageId: thirdUserMessage.data.id,
      userMessageSequence: thirdUserMessage.data.sequence,
    };
    const paused = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:00.000Z",
          claimedBy: "worker-paused-approval",
          heartbeatAt: "2026-07-22T00:00:00.000Z",
          status: "waiting-for-approval" as const,
          updatedAt: "2026-07-22T00:00:00.000Z",
          userMessageId: fixture.userMessage.data.id,
          userMessageSequence: fixture.userMessage.data.sequence,
          version: 2,
        },
        itemType: "run" as const,
      }),
    );
    const action = {
      approvalId: id(97),
      effect: "write" as const,
      idempotencyKey: "approval-queued-recovery",
      inputSummary: "Deploy to production.",
      kind: "approval" as const,
      policyReason: "Production deployment requires approval.",
      requiredScopes: ["deployment:write"],
      toolCallId: id(98),
      toolName: "deployment.start",
    };
    const timestamp = new Date("2026-07-22T00:00:00.000Z");
    const toolCall = pausedToolCallRecord({ action, now: timestamp, run: paused });
    const approval = pendingApprovalRecord({ action, now: timestamp, run: paused });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      paused,
      toolCall,
      approval,
      second.userMessage,
      second.run,
      thirdUserMessage,
      thirdRun,
    ]);
    const base = workerDependencies(memory.database);

    expect(
      resolveRunApproval(
        {
          approvalId: approval.data.id,
          decision: "approved",
          environmentId: paused.data.environmentId,
          organizationId: paused.data.organizationId,
          projectId: paused.data.projectId,
          resolvedByPrincipalId: id(99),
          runId: paused.data.id,
          threadId: paused.data.threadId,
        },
        {
          appendThreadEvent: base.dependencies.appendThreadEvent!,
          database: memory.database,
          enqueueRun: async () => {
            throw new Error("simulated approval enqueue failure");
          },
          generateId: base.dependencies.generateId,
          now: () => new Date("2026-07-22T00:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("approval enqueue failure");

    const requeued: AgentRunQueueMessage[] = [];
    const modelRunIds: Ulid[] = [];
    const recoveryDependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      enqueueRun: async ({ message }) => void requeued.push(message),
      now: () => new Date("2026-07-22T01:00:00.000Z"),
      runningClaimTimeoutMs: 50,
      runtime: {
        authorizeToolCall: async () => {
          throw new Error("approved continuation must not be reauthorized");
        },
        executeToolCall: async () => ({ status: "completed" }),
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          return { assistantMessage: `Completed ${request.runId}.` };
        },
        resolveToolDefinition: async (toolName) => ({
          effect: "write",
          requiredScopes: ["deployment:write"],
          toolName,
        }),
      },
    };

    expect(
      processQueueRecords(
        [
          fifoQueueRecord(second.queue, "blocked-current", "blocked-current-receipt"),
          fifoQueueRecord(thirdQueue, "blocked-later", "blocked-later-receipt"),
        ],
        recoveryDependencies,
      ),
    ).resolves.toEqual(["blocked-current", "blocked-later"]);
    expect(requeued).toEqual([expect.objectContaining({ runId: paused.data.id })]);
    expect(modelRunIds).toEqual([]);

    await processAgentRun(requeued[0]!, recoveryDependencies);
    await processQueueRecords(
      [
        fifoQueueRecord(second.queue, "blocked-current-retry", "blocked-current-retry-receipt"),
        fifoQueueRecord(thirdQueue, "blocked-later-retry", "blocked-later-retry-receipt"),
      ],
      recoveryDependencies,
    );
    expect(modelRunIds).toEqual([paused.data.id, second.run.data.id, thirdRun.data.id]);
  });

  it("requeues an asynchronously completed prior run before the blocked current run", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const paused = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:00.000Z",
          claimedBy: "worker-paused-tool",
          heartbeatAt: "2026-07-22T00:00:00.000Z",
          status: "waiting-for-tool" as const,
          updatedAt: "2026-07-22T00:00:00.000Z",
          userMessageId: fixture.userMessage.data.id,
          userMessageSequence: fixture.userMessage.data.sequence,
          version: 2,
        },
        itemType: "run" as const,
      }),
    );
    const action = {
      effect: "write" as const,
      externalOperationId: "provider-operation-queued-recovery",
      idempotencyKey: "tool-queued-recovery",
      inputSummary: "Deploy to staging.",
      kind: "tool" as const,
      policyReason: "Pinned policy allows this call.",
      requiredScopes: ["deployment:write"],
      toolCallId: id(96),
      toolName: "deployment.start",
    };
    const toolCall = pausedToolCallRecord({
      action,
      now: new Date("2026-07-22T00:00:00.000Z"),
      run: paused,
    });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      paused,
      toolCall,
      second.userMessage,
      second.run,
    ]);
    const base = workerDependencies(memory.database);

    expect(
      resolveRunToolResult(
        {
          environmentId: paused.data.environmentId,
          externalOperationId: action.externalOperationId,
          organizationId: paused.data.organizationId,
          outcome: "completed",
          outputSummary: "Staging deployment completed.",
          projectId: paused.data.projectId,
          runId: paused.data.id,
          threadId: paused.data.threadId,
          toolCallId: action.toolCallId,
        },
        {
          appendThreadEvent: base.dependencies.appendThreadEvent!,
          database: memory.database,
          enqueueRun: async () => {
            throw new Error("simulated tool enqueue failure");
          },
          generateId: base.dependencies.generateId,
          now: () => new Date("2026-07-22T00:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("tool enqueue failure");

    const requeued: AgentRunQueueMessage[] = [];
    const modelRunIds: Ulid[] = [];
    const recoveryDependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      enqueueRun: async ({ message }) => void requeued.push(message),
      now: () => new Date("2026-07-22T01:00:00.000Z"),
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    expect(processAgentRun(second.queue, recoveryDependencies)).resolves.toEqual({
      action: "requeued",
      reason: "Run was requeued behind recovered callback work.",
      retryAfterSeconds: 60,
    });
    expect(requeued).toEqual([expect.objectContaining({ runId: paused.data.id })]);
    expect(modelRunIds).toEqual([]);

    await processAgentRun(requeued[0]!, recoveryDependencies);
    await processAgentRun(second.queue, recoveryDependencies);
    expect(modelRunIds).toEqual([paused.data.id, second.run.data.id]);
  });

  it("recovers a foreign lease whose renewal exceeds the future-skew bound", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const futureRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T01:00:00.000Z",
          claimedBy: "worker-future",
          heartbeatAt: "2026-07-22T01:00:00.000Z",
          status: "running" as const,
          version: 1,
        },
        itemType: "run" as const,
      }),
    );
    const futureLease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T01:00:00.000Z",
          expiresAt: "2026-07-22T01:00:00.050Z",
          id: fixture.thread.data.id,
          leaseKey: `agent-run-thread/${fixture.thread.data.id}`,
          owner: futureRun.data.claimedBy!,
          renewedAt: "2026-07-22T01:00:00.000Z",
          runId: futureRun.data.id,
          threadId: fixture.thread.data.id,
          version: 0,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      futureRun,
      second.userMessage,
      second.run,
      futureLease,
    ]);
    const base = workerDependencies(memory.database);
    const modelRunIds: Ulid[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    expect(modelRunIds).toEqual([second.run.data.id]);
    const runs = [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
        record.itemType === "run",
    );
    expect(runs.find((run) => run.data.id === futureRun.data.id)?.data.status).toBe("failed");
    expect(runs.find((run) => run.data.id === second.run.data.id)?.data.status).toBe("completed");
  });

  it("reclaims a running claim whose heartbeat exceeds the future-skew bound", async () => {
    const fixture = fixtures();
    const futureRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          claimedAt: "2026-07-22T01:00:00.000Z",
          claimedBy: "worker-skewed",
          heartbeatAt: "2026-07-22T01:00:00.000Z",
          executionSlot: 0,
          status: "running" as const,
          version: 1,
        },
        itemType: "run" as const,
      }),
    );
    const futureLease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T01:00:00.000Z",
          expiresAt: "2026-07-22T01:00:00.050Z",
          id: fixture.thread.data.id,
          leaseKey: `agent-run-thread/${fixture.thread.data.id}`,
          owner: "worker-skewed",
          renewedAt: "2026-07-22T01:00:00.000Z",
          runId: futureRun.data.id,
          threadId: fixture.thread.data.id,
          version: 0,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      futureRun,
      futureLease,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 50,
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
  });

  it("reconciles a claim that committed before its response was lost", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { throwAfterClaimCommitOnce: true },
    );
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    expect(
      [...memory.records.values()].filter(
        (record) => record.itemType === "semantic-event" && record.data.eventType === "run.started",
      ),
    ).toHaveLength(1);
  });

  it("uses a different request token when a reconstructed claim transaction changes", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { failClaimBeforeCommitOnce: true },
    );
    const { dependencies } = workerDependencies(memory.database);

    expect(processAgentRun(fixture.queue, dependencies)).rejects.toThrow("simulated claim failure");
    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    expect(memory.transactionTokens[0]).not.toBe(memory.transactionTokens[1]);
  });

  it("renews the run claim and queue visibility during long execution", async () => {
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
    let observedReceiptHandle: string | undefined;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      extendQueueVisibility: Object.assign(
        async (delivery: AgentRunQueueDelivery) => {
          visibilityExtensions += 1;
          observedReceiptHandle = delivery.receiptHandle;
        },
        { renewalIntervalMs: 5 },
      ),
      heartbeatIntervalMs: 5,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async () => {
          await Bun.sleep(20);
          return { assistantMessage: "Heartbeat result." };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies, {
      messageId: "heartbeat-delivery",
      receiptHandle: "heartbeat-receipt",
    });

    expect(result.action).toBe("completed");
    expect(visibilityExtensions).toBeGreaterThan(0);
    expect(observedReceiptHandle).toBe("heartbeat-receipt");
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.version).toBeGreaterThan(2);
  });

  it("renews the run claim immediately before terminal persistence", async () => {
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
      heartbeatIntervalMs: 49,
      runningClaimTimeoutMs: 50,
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    const heartbeatIndex = memory.transactionInputs.findIndex((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "semantic-event" &&
          operation.record.data.eventType === "run.heartbeat",
      ),
    );
    const completionIndex = memory.transactionInputs.findIndex((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "run" &&
          operation.record.data.status === "completed",
      ),
    );
    expect(heartbeatIndex).toBeGreaterThanOrEqual(0);
    expect(completionIndex).toBeGreaterThan(heartbeatIndex);
  });
});
