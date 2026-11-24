import { describe, expect, it } from "bun:test";
import {
  ApprovalRecord,
  RunRecord,
  RuntimeLeaseRecord,
  ToolCallRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  ApprovalResolutionError,
  pausedToolCallRecord,
  resolveRunApproval,
  resolveRunToolResult,
  timelineRecord,
} from "./index.ts";
import {
  asyncFixture,
  claimResumedRun,
  dependencies,
  fixture,
  id,
  inMemoryDatabase,
} from "./approvals.fixture.ts";
import { runToolContinuation, withRunToolContinuationReferences } from "./continuation.ts";

const artifactContinuation = {
  artifactBytes: 8,
  artifactIndexCursor: 1,
  artifacts: [
    {
      contentType: "application/octet-stream",
      fileName: "evidence.txt",
      label: "Evidence",
      type: "report",
    },
  ],
  sandboxCompleted: true as const,
};

/** The `run.failed` semantic event the resolution committed, as monitors receive it. */
function runFailedPayload(
  records: ReadonlyMap<string, { readonly data: unknown; readonly itemType: string }>,
) {
  return [...records.values()]
    .filter((record) => record.itemType === "semantic-event")
    .map((record) => record.data as { readonly eventType: string; readonly payload: unknown })
    .find((event) => event.eventType === "run.failed")?.payload;
}

describe("DynamoDB run approvals", () => {
  it("approves and requeues the exact paused run idempotently", async () => {
    const paused = fixture();
    const memory = inMemoryDatabase([paused.run, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database, {
      onAppend: () => {
        expect(
          [...memory.records.values()].some((record) => record.itemType === "runtime-lease"),
        ).toBe(true);
      },
      onEnqueue: () => {
        expect(
          [...memory.records.values()].some((record) => record.itemType === "runtime-lease"),
        ).toBe(true);
      },
    });

    const first = await resolveRunApproval(paused.input, test.dependencies);
    const replay = await resolveRunApproval(paused.input, test.dependencies);

    expect(first.run.data.status).toBe("queued");
    expect(first.run.data.trigger).toBe("api");
    expect(first.run.data.claimedBy).toBeUndefined();
    expect(first.run.data.startedAt).toBe(paused.run.data.startedAt);
    expect(first.toolCall.data.status).toBe("pending");
    expect(first.approval.data.status).toBe("approved");
    expect(first.queueMessage).toEqual({
      environmentId: paused.run.data.environmentId,
      idempotencyKey: paused.run.data.idempotencyKey,
      organizationId: paused.run.data.organizationId,
      projectId: paused.run.data.projectId,
      runId: paused.run.data.id,
      spanId: paused.run.data.spanId,
      threadId: paused.run.data.threadId,
      traceId: paused.run.data.traceId,
      userMessageId: paused.run.data.userMessageId!,
      userMessageSequence: paused.run.data.userMessageSequence!,
    });
    expect(replay.run.data.version).toBe(first.run.data.version);
    expect(test.enqueued).toHaveLength(1);
    expect(test.enqueued[0]?.messageGroupId).toBe(
      [
        paused.run.data.organizationId,
        paused.run.data.projectId,
        paused.run.data.environmentId,
        paused.run.data.threadId,
      ].join(":"),
    );
    expect(test.events.map((event) => event.eventType)).toEqual(["approval.resolved"]);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
    expect(memory.queryInputs).toHaveLength(0);
  });

  it("replays an identical approval after the worker claimed the resumed run", async () => {
    const paused = fixture();
    const memory = inMemoryDatabase([paused.run, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database);
    const first = await resolveRunApproval(paused.input, test.dependencies);
    claimResumedRun(memory.records, first.run);

    const replay = await resolveRunApproval(paused.input, test.dependencies);

    expect(replay.approval).toEqual(first.approval);
    expect(replay.decision).toBe("approved");
    expect(replay.run.data.status).toBe("running");
    expect(replay.queueMessage).toBeUndefined();
    expect(test.enqueued).toHaveLength(1);
    expect(test.events.map((event) => event.eventType)).toEqual(["approval.resolved"]);
    expect(
      resolveRunApproval({ ...paused.input, decision: "rejected" }, test.dependencies),
    ).rejects.toMatchObject({ code: "approval_already_resolved" });
  });

  it("reconciles an approval transaction whose response is lost", async () => {
    const paused = fixture();
    const memory = inMemoryDatabase([paused.run, paused.toolCall, paused.approval], {
      throwAfterCommitOnce: true,
    });
    const test = dependencies(memory.database);

    const result = await resolveRunApproval(paused.input, test.dependencies);

    expect(result.run.data.status).toBe("queued");
    expect(result.approval.data.status).toBe("approved");
    expect(test.enqueued).toHaveLength(1);
  });

  it("refuses to approve a resumable run without an enqueue adapter", async () => {
    const paused = fixture();
    const memory = inMemoryDatabase([paused.run, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database);
    const { enqueueRun: _enqueueRun, ...withoutEnqueue } = test.dependencies;

    expect(resolveRunApproval(paused.input, withoutEnqueue)).rejects.toMatchObject({
      code: "run_enqueue_unavailable",
    });

    const approval = [...memory.records.values()].find(
      (record) => record.itemType === "approval" && record.data.id === paused.approval.data.id,
    );
    expect(approval).toMatchObject({ data: { status: "pending" } });
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("does not mutate approval state when the run trigger binding is missing", async () => {
    const paused = fixture();
    const {
      userMessageId: _userMessageId,
      userMessageSequence: _userMessageSequence,
      ...data
    } = paused.run.data;
    const unboundRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({ data, itemType: "run" as const }),
    );
    const memory = inMemoryDatabase([unboundRun, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database);

    expect(resolveRunApproval(paused.input, test.dependencies)).rejects.toMatchObject({
      code: "run_trigger_missing",
    });

    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "approval" && record.data.id === paused.approval.data.id,
      ),
    ).toEqual(paused.approval);
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "run" && record.data.id === paused.run.data.id,
      ),
    ).toEqual(unboundRun);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("rejects an approval and terminalizes its tool call and run", async () => {
    const paused = fixture();
    const run = withRunToolContinuationReferences(paused.run, {
      artifactContinuation,
      completedToolCallIds: [],
      pendingAction: { kind: "approval", toolCallId: paused.toolCall.data.id },
    });
    const memory = inMemoryDatabase([run, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database);

    const result = await resolveRunApproval(
      { ...paused.input, decision: "rejected" },
      { ...test.dependencies, enqueueTerminalRun: test.dependencies.enqueueRun },
    );

    expect(result.approval.data.status).toBe("rejected");
    expect(result.toolCall.data.status).toBe("failed");
    expect(result.run.data.status).toBe("failed");
    expect(runToolContinuation(result.run)).toEqual({
      artifactContinuation,
      completedToolCallIds: [],
    });
    expect(result.queueMessage).toBeUndefined();
    expect(test.enqueued).toHaveLength(1);
    expect(test.enqueued[0]?.deduplicationId).toContain("approval-terminal:");
    expect(test.events.map((event) => event.eventType)).toEqual([
      "approval.resolved",
      "run.failed",
    ]);
    expect(runFailedPayload(memory.records)).toMatchObject({
      agentDeploymentId: paused.run.data.agentDeploymentId,
      agentReleaseId: paused.run.data.agentReleaseId,
    });
  });

  it("rejects an approval without dispatching a terminal callback for an unbound run", async () => {
    const paused = fixture();
    const boundRun = withRunToolContinuationReferences(paused.run, {
      artifactContinuation,
      completedToolCallIds: [],
      pendingAction: { kind: "approval", toolCallId: paused.toolCall.data.id },
    });
    const {
      userMessageId: _userMessageId,
      userMessageSequence: _userMessageSequence,
      ...data
    } = boundRun.data;
    const unboundRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({ data, itemType: "run" as const }),
    );
    const memory = inMemoryDatabase([unboundRun, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database);

    const result = await resolveRunApproval(
      { ...paused.input, decision: "rejected" },
      { ...test.dependencies, enqueueTerminalRun: test.dependencies.enqueueRun },
    );

    expect(result.run.data.status).toBe("failed");
    expect(test.enqueued).toHaveLength(0);
    expect(test.events.map((event) => event.eventType)).toEqual([
      "approval.resolved",
      "run.failed",
    ]);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("rejects a conflicting decision after an approval is resolved", async () => {
    const paused = fixture();
    const memory = inMemoryDatabase([paused.run, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database);
    await resolveRunApproval(paused.input, test.dependencies);

    expect(
      resolveRunApproval({ ...paused.input, decision: "rejected" }, test.dependencies),
    ).rejects.toBeInstanceOf(ApprovalResolutionError);
  });

  it("expires an overdue approval instead of authorizing it", async () => {
    const paused = fixture();
    const expiredApproval = Schema.decodeUnknownSync(ApprovalRecord)(
      withCanonicalRecordKeys({
        data: {
          ...paused.approval.data,
          expiresAt: "2026-07-22T00:00:30.000Z",
        },
        itemType: "approval" as const,
      }),
    );
    const memory = inMemoryDatabase([paused.run, paused.toolCall, expiredApproval]);
    const test = dependencies(memory.database);

    const result = await resolveRunApproval(paused.input, test.dependencies);

    expect(result.decision).toBe("expired");
    expect(result.approval.data.status).toBe("expired");
    expect(result.approval.data.resolvedByPrincipalId).toBeUndefined();
    expect(result.toolCall.data.status).toBe("failed");
    expect(result.run.data.status).toBe("failed");
    expect(test.enqueued).toHaveLength(0);
    expect(test.events[0]?.actor).toEqual({ type: "service" });
  });

  it("uses the persisted resolver identity when replaying publication", async () => {
    const paused = fixture();
    const memory = inMemoryDatabase([paused.run, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database, { failAppendOnce: true });
    expect(resolveRunApproval(paused.input, test.dependencies)).rejects.toThrow(
      "stream publication failure",
    );
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      true,
    );

    await resolveRunApproval({ ...paused.input, resolvedByPrincipalId: id(99) }, test.dependencies);

    expect(test.events[0]?.actor).toEqual({ id: id(13), type: "user" });
    expect(test.enqueued).toHaveLength(1);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("retains the publication barrier until a failed enqueue is retried", async () => {
    const paused = fixture();
    const memory = inMemoryDatabase([paused.run, paused.toolCall, paused.approval]);
    const test = dependencies(memory.database, { failEnqueueOnce: true });

    expect(resolveRunApproval(paused.input, test.dependencies)).rejects.toThrow(
      "queue publication failure",
    );
    expect(test.events.map((event) => event.eventType)).toEqual(["approval.resolved"]);
    expect(test.enqueued).toHaveLength(0);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      true,
    );

    await resolveRunApproval(paused.input, test.dependencies);

    expect(test.enqueued).toHaveLength(1);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("completes an asynchronous tool and requeues the exact run idempotently", async () => {
    const waiting = asyncFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);

    const first = await resolveRunToolResult(waiting.input, test.dependencies);
    const replay = await resolveRunToolResult(waiting.input, test.dependencies);

    expect(first.toolCall.data.status).toBe("succeeded");
    expect(first.toolCall.data.outputSummary).toBe("Deployment completed.");
    expect(first.run.data.status).toBe("queued");
    expect(first.run.data.trigger).toBe("api");
    expect(first.queueMessage?.userMessageId).toBe(waiting.run.data.userMessageId);
    expect(replay.run.data.version).toBe(first.run.data.version);
    expect(test.enqueued).toHaveLength(1);
    expect(test.events.map((event) => event.eventType)).toEqual(["tool.completed"]);
  });

  it("refuses to complete a resumable async tool without an enqueue adapter", async () => {
    const waiting = asyncFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    const { enqueueRun: _enqueueRun, ...withoutEnqueue } = test.dependencies;

    expect(resolveRunToolResult(waiting.input, withoutEnqueue)).rejects.toMatchObject({
      code: "run_enqueue_unavailable",
    });

    const toolCall = [...memory.records.values()].find(
      (record) => record.itemType === "tool-call" && record.data.id === waiting.toolCall.data.id,
    );
    expect(toolCall).toMatchObject({ data: { status: "running" } });
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("does not mutate async tool state when the run trigger binding is missing", async () => {
    const waiting = asyncFixture();
    const {
      userMessageId: _userMessageId,
      userMessageSequence: _userMessageSequence,
      ...data
    } = waiting.run.data;
    const unboundRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({ data, itemType: "run" as const }),
    );
    const memory = inMemoryDatabase([unboundRun, waiting.toolCall]);
    const test = dependencies(memory.database);

    expect(resolveRunToolResult(waiting.input, test.dependencies)).rejects.toMatchObject({
      code: "run_trigger_missing",
    });

    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "tool-call" && record.data.id === waiting.toolCall.data.id,
      ),
    ).toEqual(waiting.toolCall);
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "run" && record.data.id === waiting.run.data.id,
      ),
    ).toEqual(unboundRun);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("fails an asynchronous tool and terminalizes the run", async () => {
    const waiting = asyncFixture();
    const run = withRunToolContinuationReferences(waiting.run, {
      artifactContinuation,
      completedToolCallIds: [],
      pendingAction: { kind: "tool", toolCallId: waiting.toolCall.data.id },
    });
    const memory = inMemoryDatabase([run, waiting.toolCall]);
    const test = dependencies(memory.database);

    const result = await resolveRunToolResult(
      {
        ...waiting.input,
        outcome: "failed",
        outputSummary: "Provider operation failed.",
      },
      { ...test.dependencies, enqueueTerminalRun: test.dependencies.enqueueRun },
    );

    expect(result.toolCall.data.status).toBe("failed");
    expect(result.run.data.status).toBe("failed");
    expect(runToolContinuation(result.run)).toEqual({
      artifactContinuation,
      completedToolCallIds: [],
    });
    expect(result.queueMessage).toBeUndefined();
    expect(test.enqueued).toHaveLength(1);
    expect(test.enqueued[0]?.deduplicationId).toContain("tool-terminal:");
    expect(test.events.map((event) => event.eventType)).toEqual(["tool.failed", "run.failed"]);
    expect(runFailedPayload(memory.records)).toMatchObject({
      agentDeploymentId: waiting.run.data.agentDeploymentId,
    });
  });

  it("fails an async tool without dispatching a terminal callback for an unbound run", async () => {
    const waiting = asyncFixture();
    const boundRun = withRunToolContinuationReferences(waiting.run, {
      artifactContinuation,
      completedToolCallIds: [],
      pendingAction: { kind: "tool", toolCallId: waiting.toolCall.data.id },
    });
    const {
      userMessageId: _userMessageId,
      userMessageSequence: _userMessageSequence,
      ...data
    } = boundRun.data;
    const unboundRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({ data, itemType: "run" as const }),
    );
    const memory = inMemoryDatabase([unboundRun, waiting.toolCall]);
    const test = dependencies(memory.database);

    const result = await resolveRunToolResult(
      {
        ...waiting.input,
        outcome: "failed",
        outputSummary: "Provider operation failed.",
      },
      { ...test.dependencies, enqueueTerminalRun: test.dependencies.enqueueRun },
    );

    expect(result.run.data.status).toBe("failed");
    expect(test.enqueued).toHaveLength(0);
    expect(test.events.map((event) => event.eventType)).toEqual(["tool.failed", "run.failed"]);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("rejects a mismatched external operation callback", async () => {
    const waiting = asyncFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);

    expect(
      resolveRunToolResult(
        { ...waiting.input, externalOperationId: "another-operation" },
        test.dependencies,
      ),
    ).rejects.toMatchObject({ code: "external_operation_mismatch" });
  });

  it("requires concrete external operation correlation on callbacks", async () => {
    const waiting = asyncFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    const { externalOperationId: _externalOperationId, ...uncorrelatedInput } = waiting.input;

    expect(resolveRunToolResult(uncorrelatedInput, test.dependencies)).rejects.toMatchObject({
      code: "external_operation_mismatch",
    });
  });

  it("rejects callbacks when canonical running state has no operation correlation", async () => {
    const waiting = asyncFixture();
    const { externalOperationId: _externalOperationId, ...uncorrelatedData } =
      waiting.toolCall.data;
    const uncorrelatedToolCall = Schema.decodeUnknownSync(ToolCallRecord)(
      withCanonicalRecordKeys({
        data: uncorrelatedData,
        itemType: "tool-call" as const,
      }),
    );
    const memory = inMemoryDatabase([waiting.run, uncorrelatedToolCall]);
    const test = dependencies(memory.database);

    expect(resolveRunToolResult(waiting.input, test.dependencies)).rejects.toMatchObject({
      code: "external_operation_mismatch",
    });
  });

  it("rejects callback operation IDs in the reserved reconciliation namespace", async () => {
    const waiting = asyncFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);

    expect(
      resolveRunToolResult(
        { ...waiting.input, externalOperationId: "unknown:provider-supplied" },
        test.dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_external_operation_id" });
  });

  it("rejects mismatched external operation correlation on callback replays", async () => {
    const waiting = asyncFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    await resolveRunToolResult(waiting.input, test.dependencies);

    expect(
      resolveRunToolResult(
        { ...waiting.input, externalOperationId: "another-operation" },
        test.dependencies,
      ),
    ).rejects.toMatchObject({ code: "external_operation_mismatch" });
    expect(test.enqueued).toHaveLength(1);
    expect(test.events.map((event) => event.eventType)).toEqual(["tool.completed"]);
  });

  it("records asynchronous outcomes without resuming an already canceled run", async () => {
    const waiting = asyncFixture();
    const canceled = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...waiting.run.data,
          completedAt: "2026-07-22T00:00:30.000Z",
          status: "canceled" as const,
        },
        itemType: "run" as const,
      }),
    );
    const canceledTimeline = timelineRecord({
      data: { status: "canceled" },
      eventType: "run.canceled",
      id: id(80),
      now: new Date("2026-07-22T00:00:30.000Z"),
      run: canceled,
      sequence: canceled.data.version,
    });
    const memory = inMemoryDatabase([canceled, waiting.toolCall, canceledTimeline]);
    const test = dependencies(memory.database);

    const result = await resolveRunToolResult(waiting.input, test.dependencies);

    expect(result.run.data.status).toBe("canceled");
    expect(result.run.data.version).toBe(canceled.data.version + 1);
    expect(result.toolCall.data.status).toBe("succeeded");
    expect(result.queueMessage).toBeUndefined();
    expect(test.enqueued).toHaveLength(0);
    expect(test.events.map((event) => event.eventType)).toEqual(["tool.completed"]);
    expect(
      [...memory.records.values()]
        .filter((record) => record.itemType === "timeline-event")
        .map((record) => record.data.sequence)
        .toSorted((left, right) => left - right),
    ).toEqual([canceled.data.version, result.run.data.version]);
  });

  it("allows explicit reconciliation when the persisted operation is unknown", async () => {
    const waiting = asyncFixture();
    const unknownToolCall = pausedToolCallRecord({
      action: {
        effect: waiting.toolCall.data.effect,
        externalOperationId: `unknown:${waiting.toolCall.data.id}`,
        idempotencyKey: waiting.toolCall.data.idempotencyKey!,
        inputSummary: waiting.toolCall.data.inputSummary,
        kind: "tool",
        policyReason: waiting.toolCall.data.policyReason!,
        requiredScopes: waiting.toolCall.data.requiredScopes,
        toolCallId: waiting.toolCall.data.id,
        toolName: waiting.toolCall.data.toolName,
      },
      now: new Date(waiting.toolCall.data.createdAt),
      run: waiting.run,
    });
    const memory = inMemoryDatabase([waiting.run, unknownToolCall]);
    const test = dependencies(memory.database);
    expect(
      resolveRunToolResult(
        { ...waiting.input, externalOperationId: "provider-operation-reconciled" },
        test.dependencies,
      ),
    ).resolves.toMatchObject({
      run: { data: { status: "queued" } },
      toolCall: { data: { externalOperationId: "provider-operation-reconciled" } },
    });
  });

  it("rejects a racing reconciliation callback with a different operation ID", async () => {
    const waiting = asyncFixture();
    const unknownToolCall = pausedToolCallRecord({
      action: {
        effect: waiting.toolCall.data.effect,
        externalOperationId: `unknown:${waiting.toolCall.data.id}`,
        idempotencyKey: waiting.toolCall.data.idempotencyKey!,
        inputSummary: waiting.toolCall.data.inputSummary,
        kind: "tool",
        policyReason: waiting.toolCall.data.policyReason!,
        requiredScopes: waiting.toolCall.data.requiredScopes,
        toolCallId: waiting.toolCall.data.id,
        toolName: waiting.toolCall.data.toolName,
      },
      now: new Date(waiting.toolCall.data.createdAt),
      run: waiting.run,
    });
    const memory = inMemoryDatabase([waiting.run, unknownToolCall], {
      competingToolOperationIdOnce: "provider-operation-first",
    });
    const test = dependencies(memory.database);

    expect(
      resolveRunToolResult(
        { ...waiting.input, externalOperationId: "provider-operation-second" },
        test.dependencies,
      ),
    ).rejects.toMatchObject({ code: "external_operation_mismatch" });
    expect(test.enqueued).toHaveLength(0);
    expect(test.events).toHaveLength(0);
  });

  it("defers resolutions until the paused event publication barrier is released", async () => {
    const paused = fixture();
    const lease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:15:00.000Z",
          id: paused.run.data.threadId,
          leaseKey: `agent-run-thread/${paused.run.data.threadId}`,
          owner: "worker-paused",
          runId: paused.run.data.id,
          threadId: paused.run.data.threadId,
          version: 0,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    const memory = inMemoryDatabase([paused.run, paused.toolCall, paused.approval, lease]);
    const test = dependencies(memory.database);

    expect(resolveRunApproval(paused.input, test.dependencies)).rejects.toMatchObject({
      code: "thread_publication_pending",
    });
    expect(test.enqueued).toHaveLength(0);
    expect(test.events).toHaveLength(0);
  });
});
