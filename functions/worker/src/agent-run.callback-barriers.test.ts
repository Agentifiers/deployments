import { describe, expect, it } from "bun:test";
import {
  RunRecord,
  RuntimeLeaseRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  pausedToolCallRecord,
  pendingApprovalRecord,
  processAgentRun,
  resolveRunApproval,
  resolveRunToolResult,
} from "./index.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  additionalRunOnThread,
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

describe("DynamoDB agent run worker", () => {
  it("replays an expired completed-run barrier before starting a later run", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
      second.userMessage,
      second.run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async (request) => ({
          assistantMessage: `Completed ${request.runId}.`,
        }),
      },
    };
    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    const completed = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }>;
    const expiredLease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:00:00.050Z",
          id: fixture.thread.data.id,
          leaseKey: `agent-run-thread/${fixture.thread.data.id}`,
          owner: completed.data.claimedBy!,
          renewedAt: "2026-07-22T00:00:00.000Z",
          runId: completed.data.id,
          threadId: fixture.thread.data.id,
          version: 4,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    await memory.database.putRecord(expiredLease);
    base.events.length = 0;

    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    const priorFinalized = base.events.findIndex(
      (event) =>
        event.eventType === "assistant-message.finalized" && event.runId === completed.data.id,
    );
    const priorCompleted = base.events.findIndex(
      (event) => event.eventType === "run.completed" && event.runId === completed.data.id,
    );
    const laterStarted = base.events.findIndex(
      (event) => event.eventType === "run.started" && event.runId === second.run.data.id,
    );
    expect(priorFinalized).toBeGreaterThanOrEqual(0);
    expect(priorCompleted).toBeGreaterThan(priorFinalized);
    expect(laterStarted).toBeGreaterThan(priorCompleted);
  });

  it("replays an expired approval-rejection callback before starting a later run", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
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
      approvalId: id(93),
      effect: "write" as const,
      idempotencyKey: "approval-rejection-recovery",
      inputSummary: "Deploy to production.",
      kind: "approval" as const,
      policyReason: "Production deployment requires approval.",
      requiredScopes: ["deployment:write"],
      toolCallId: id(94),
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
    ]);
    const base = workerDependencies(memory.database);

    expect(
      resolveRunApproval(
        {
          approvalId: approval.data.id,
          decision: "rejected",
          environmentId: paused.data.environmentId,
          organizationId: paused.data.organizationId,
          projectId: paused.data.projectId,
          resolvedByPrincipalId: id(95),
          runId: paused.data.id,
          threadId: paused.data.threadId,
        },
        {
          appendThreadEvent: async () => {
            throw new Error("simulated approval publication failure");
          },
          database: memory.database,
          generateId: base.dependencies.generateId,
          now: () => new Date("2026-07-22T00:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("approval publication failure");

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

    const approvalResolved = base.events.findIndex(
      (event) => event.eventType === "approval.resolved" && event.runId === paused.data.id,
    );
    const priorFailed = base.events.findIndex(
      (event) => event.eventType === "run.failed" && event.runId === paused.data.id,
    );
    const laterStarted = base.events.findIndex(
      (event) => event.eventType === "run.started" && event.runId === second.run.data.id,
    );
    expect(approvalResolved).toBeGreaterThanOrEqual(0);
    expect(priorFailed).toBeGreaterThan(approvalResolved);
    expect(laterStarted).toBeGreaterThan(priorFailed);
  });

  it("replays an active terminal callback barrier on a duplicate delivery", async () => {
    const fixture = fixtures();
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
      approvalId: id(72),
      effect: "write" as const,
      idempotencyKey: "same-run-rejection-recovery",
      inputSummary: "Deploy to production.",
      kind: "approval" as const,
      policyReason: "Production deployment requires approval.",
      requiredScopes: ["deployment:write"],
      toolCallId: id(73),
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
    ]);
    const base = workerDependencies(memory.database);

    expect(
      resolveRunApproval(
        {
          approvalId: approval.data.id,
          decision: "rejected",
          environmentId: paused.data.environmentId,
          organizationId: paused.data.organizationId,
          projectId: paused.data.projectId,
          resolvedByPrincipalId: id(74),
          runId: paused.data.id,
          threadId: paused.data.threadId,
        },
        {
          appendThreadEvent: async () => {
            throw new Error("simulated active callback publication failure");
          },
          database: memory.database,
          generateId: base.dependencies.generateId,
          now: () => new Date("2026-07-22T00:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("active callback publication failure");

    base.events.length = 0;
    expect(
      processAgentRun(fixture.queue, {
        ...base.dependencies,
        now: () => new Date("2026-07-22T00:01:01.000Z"),
        runtime: {
          generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
        },
      }),
    ).resolves.toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });

    expect(base.events.map((event) => event.eventType)).toEqual([
      "approval.resolved",
      "run.failed",
    ]);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("replays a same-run queued callback barrier without replacing the current delivery", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithToolRequests(fixture.release.data.manifest, [
        {
          effect: "write",
          idempotencyKey: "same-run-approved-recovery",
          inputSummary: "Deploy to production.",
          requiredScopes: ["deployment:write"],
          toolName: "deployment.start",
        },
      ]),
    );
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
      approvalId: id(75),
      effect: "write" as const,
      idempotencyKey: "same-run-approved-recovery",
      inputSummary: "Deploy to production.",
      kind: "approval" as const,
      policyReason: "Production deployment requires approval.",
      requiredScopes: ["deployment:write"],
      toolCallId: id(76),
      toolName: "deployment.start",
    };
    const timestamp = new Date("2026-07-22T00:00:00.000Z");
    const toolCall = pausedToolCallRecord({ action, now: timestamp, run: paused });
    const approval = pendingApprovalRecord({ action, now: timestamp, run: paused });
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      paused,
      toolCall,
      approval,
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
          resolvedByPrincipalId: id(77),
          runId: paused.data.id,
          threadId: paused.data.threadId,
        },
        {
          appendThreadEvent: base.dependencies.appendThreadEvent!,
          database: memory.database,
          enqueueRun: async () => {
            throw new Error("simulated same-run enqueue failure");
          },
          generateId: base.dependencies.generateId,
          now: () => new Date("2026-07-22T00:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("same-run enqueue failure");

    base.events.length = 0;
    let executions = 0;
    let modelCalls = 0;
    let requeues = 0;
    const result = await processAgentRun(fixture.queue, {
      ...base.dependencies,
      enqueueRun: async () => {
        requeues += 1;
      },
      now: () => new Date("2026-07-22T00:01:01.000Z"),
      runtime: {
        authorizeToolCall: async () => {
          throw new Error("approved continuation must not be reauthorized");
        },
        executeToolCall: async () => {
          executions += 1;
          return { status: "completed" };
        },
        generateAssistantMessage: async () => {
          modelCalls += 1;
          return { assistantMessage: "Completed after callback recovery." };
        },
        recordArtifact: async () => undefined,
        resolveToolDefinition: async (toolName) => ({
          effect: "write",
          requiredScopes: ["deployment:write"],
          toolName,
        }),
      },
    });

    expect(result).toMatchObject({ action: "completed" });
    expect(executions).toBe(1);
    expect(modelCalls).toBe(1);
    expect(requeues).toBe(0);
    const approvalResolved = base.events.findIndex(
      (event) => event.eventType === "approval.resolved",
    );
    const runStarted = base.events.findIndex((event) => event.eventType === "run.started");
    expect(approvalResolved).toBeGreaterThanOrEqual(0);
    expect(runStarted).toBeGreaterThan(approvalResolved);
  });

  it("replays an expired failed-tool callback before starting a later run", async () => {
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
      externalOperationId: "provider-operation-recovery",
      idempotencyKey: "failed-tool-recovery",
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
          outcome: "failed",
          outputSummary: "Provider deployment failed.",
          projectId: paused.data.projectId,
          runId: paused.data.id,
          threadId: paused.data.threadId,
          toolCallId: action.toolCallId,
        },
        {
          appendThreadEvent: async () => {
            throw new Error("simulated tool publication failure");
          },
          database: memory.database,
          generateId: base.dependencies.generateId,
          now: () => new Date("2026-07-22T00:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("tool publication failure");

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
      (event) => event.eventType === "tool.failed" && event.runId === paused.data.id,
    );
    const priorFailed = base.events.findIndex(
      (event) => event.eventType === "run.failed" && event.runId === paused.data.id,
    );
    const laterStarted = base.events.findIndex(
      (event) => event.eventType === "run.started" && event.runId === second.run.data.id,
    );
    expect(toolFailed).toBeGreaterThanOrEqual(0);
    expect(priorFailed).toBeGreaterThan(toolFailed);
    expect(laterStarted).toBeGreaterThan(priorFailed);
  });
});
