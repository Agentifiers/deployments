import { describe, expect, test } from "bun:test";
import { RunDelegationRecord, RunRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { resolveAwaitedDelegation, resolvePausedDelegation } from "./agent-delegation-results.ts";
import { asyncFixture, dependencies, id, inMemoryDatabase } from "./approvals.fixture.ts";
import { withRunToolContinuation } from "./continuation.ts";
import { assistantMessageRecord, pausedToolCallRecord, timelineRecord } from "./records.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

const now = new Date("2026-07-22T00:00:30.000Z");
const childRunId = id(21);

function scenario(childStatus: "completed" | "failed", parentStatus = "waiting-for-tool") {
  const base = asyncFixture();
  const action = {
    effect: "execute" as const,
    externalOperationId: childRunId,
    idempotencyKey: "delegate/researcher",
    input: { prompt: "Research it.", targetAgentId: "researcher" },
    inputSummary: "Delegate research.",
    kind: "tool" as const,
    policyReason: "Allowed.",
    requiredScopes: [],
    toolCallId: id(14),
    toolName: "agent.delegate",
  };
  const paused = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: { ...base.run.data, status: parentStatus },
      itemType: "run" as const,
    }),
  );
  const parent = withRunToolContinuation(paused, [], action);
  const toolCall = pausedToolCallRecord({ action, now, run: parent });
  const { claimedAt: _a, claimedBy: _b, heartbeatAt: _c, ...childData } = base.run.data;
  const child = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...childData,
        agentDeploymentId: id(30),
        agentReleaseId: id(31),
        completedAt: now.toISOString(),
        ...(childStatus === "failed" ? { error: { message: "Model unavailable." } } : {}),
        id: childRunId,
        idempotencyKey: "child/researcher",
        parentSpanId: base.run.data.spanId,
        spanId: "fedcba9876543210",
        status: childStatus,
        threadId: id(20),
        userMessageId: id(22),
        userMessageSequence: 0,
        version: 3,
      },
      itemType: "run" as const,
    }),
  );
  const message = assistantMessageRecord({
    body: "The answer is 42.",
    id: id(23),
    now,
    run: child,
    sequence: 1,
    streamEventId: id(24),
  });
  const timeline = timelineRecord({
    data: { messageId: message.data.id, messageSequence: 1 },
    eventType: "run.completed",
    id: id(25),
    now,
    run: child,
    sequence: child.data.version,
  });
  const link = Schema.decodeUnknownSync(RunDelegationRecord)(
    withCanonicalRecordKeys({
      data: {
        ancestorAgentDeploymentIds: [parent.data.agentDeploymentId],
        awaitResult: true,
        childAgentDeploymentId: id(30),
        childRunId,
        childThreadId: child.data.threadId,
        createdAt: now.toISOString(),
        depth: 1,
        edgeKind: "delegation",
        environmentId: parent.data.environmentId,
        organizationId: parent.data.organizationId,
        parentAgentDeploymentId: parent.data.agentDeploymentId,
        parentRunId: parent.data.id,
        parentThreadId: parent.data.threadId,
        projectId: parent.data.projectId,
      },
      itemType: "run-delegation" as const,
    }),
  );
  const memory = inMemoryDatabase([parent, toolCall, child, message, timeline, link]);
  const test = dependencies(memory.database);
  const worker = test.dependencies as unknown as AgentRunWorkerDependencies;
  const stored = (itemType: "run" | "tool-call", recordId: string) =>
    [...memory.records.values()].find(
      (record) => record.itemType === itemType && record.data.id === recordId,
    );
  return { action, child, parent, stored, test, toolCall, worker };
}

describe("awaited sub-agent results", () => {
  test("resumes the waiting parent with the child's answer exactly once", async () => {
    const { child, parent, stored, test, toolCall, worker } = scenario("completed");
    await resolveAwaitedDelegation(worker, child);
    expect(stored("tool-call", toolCall.data.id)).toMatchObject({
      data: {
        output: {
          childRunId,
          childThreadId: child.data.threadId,
          finalMessage: "The answer is 42.",
          status: "completed",
        },
        status: "succeeded",
      },
    });
    expect(stored("run", parent.data.id)).toMatchObject({ data: { status: "queued" } });
    expect(test.enqueued).toHaveLength(1);

    const resolved = stored("tool-call", toolCall.data.id);
    await resolveAwaitedDelegation(worker, child);
    expect(stored("tool-call", toolCall.data.id)).toEqual(resolved);
    expect(test.enqueued).toHaveLength(1);
  });

  test("fails the tool call and resumes the parent when the child fails", async () => {
    const { child, parent, stored, test, toolCall, worker } = scenario("failed");
    await resolveAwaitedDelegation(worker, child);
    expect(stored("tool-call", toolCall.data.id)).toMatchObject({
      data: { outputSummary: expect.stringContaining("Model unavailable."), status: "failed" },
    });
    expect(stored("run", parent.data.id)).toMatchObject({ data: { status: "queued" } });
    expect(test.enqueued.map((entry) => entry.message.runId)).toEqual([parent.data.id]);

    const resolved = stored("tool-call", toolCall.data.id);
    await resolveAwaitedDelegation(worker, child);
    expect(stored("tool-call", toolCall.data.id)).toEqual(resolved);
    expect(test.enqueued).toHaveLength(1);
  });

  test("reconciles a canceled parent without resuming it", async () => {
    const { child, parent, stored, test, toolCall, worker } = scenario("completed", "canceled");
    await resolveAwaitedDelegation(worker, child);
    expect(stored("run", parent.data.id)).toMatchObject({ data: { status: "canceled" } });
    expect(stored("tool-call", toolCall.data.id)).toMatchObject({ data: { status: "succeeded" } });
    expect(
      test.enqueued.filter((entry) => entry.deduplicationId.startsWith("tool-resume")),
    ).toEqual([]);
  });

  test("leaves a parent that has not paused for the pause-side resolution", async () => {
    const { action, child, parent, stored, test, worker } = scenario("completed", "running");
    await resolveAwaitedDelegation(worker, child);
    expect(stored("run", parent.data.id)).toMatchObject({ data: { status: "running" } });
    expect(test.enqueued).toEqual([]);
    const paused = stored("run", parent.data.id) as RunRecordValue;
    await resolvePausedDelegation(worker, paused, action);
    expect(test.enqueued).toEqual([]);
  });

  test("resolves on pause when the child already finished", async () => {
    const { action, parent, stored, test, toolCall, worker } = scenario("completed");
    await resolvePausedDelegation(worker, parent, action);
    expect(stored("tool-call", toolCall.data.id)).toMatchObject({ data: { status: "succeeded" } });
    expect(test.enqueued).toHaveLength(1);
  });
});
