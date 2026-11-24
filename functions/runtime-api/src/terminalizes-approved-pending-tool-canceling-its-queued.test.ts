import {
  ApprovalRecord,
  MessageRecord,
  RunRecord,
  RuntimeLeaseRecord,
  ThreadRecord,
  ToolCallRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { assertPromptBinding } from "@deployments-ai/worker/agent-run";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { cancelRunThreadEvents, runMutationThreadEvents } from "./runtime-handler.ts";
import { cancelRun, replayRun, retryRun } from "./runtime-operations.ts";
import type { RuntimeApiDependencies } from "./runtime-support.ts";
import {
  deployment,
  deploymentId,
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  principal,
  projectId,
  release,
  runLocator,
  runRecord,
  serviceAccountId,
} from "./runtime-lifecycle.fixture.ts";

function threadRecord(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: {
          id: serviceAccountId,
          type: "service-account" as const,
        },
        environmentId,
        id: run.data.threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[18]!,
        title: "Replay source",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
}

function promptMessage(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        body: "Replay this prompt",
        contentHash: "source-content-hash",
        createdAt: now.toISOString(),
        environmentId,
        id: run.data.userMessageId!,
        organizationId,
        projectId,
        role: "user" as const,
        runId: run.data.id,
        sequence: run.data.userMessageSequence!,
        threadId: run.data.threadId,
      },
      itemType: "message" as const,
    }),
  );
}

function threadExecutionLease(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
        id: run.data.threadId,
        leaseKey: `agent-run-thread/${run.data.threadId}`,
        owner: `worker:${ids[19]}`,
        runId: run.data.id,
        threadId: run.data.threadId,
        version: 2,
      },
      itemType: "runtime-lease" as const,
    }),
  );
}

function messagePublicationBarrier(run: ReturnType<typeof runRecord>) {
  const lease = threadExecutionLease(run);
  return Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      ...lease,
      data: {
        ...lease.data,
        expiresAt: "9999-12-31T23:59:59.999Z",
        owner: `message-publication/${ids[19]}`,
        version: 0,
      },
    }),
  );
}

function approvalRecord(
  status: "approved" | "expired" | "pending" | "rejected",
  approvalId: Ulid,
  toolCallId?: Ulid,
) {
  return Schema.decodeUnknownSync(ApprovalRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId,
        escalationCount: 0,
        id: approvalId,
        organizationId,
        projectId,
        request: { toolName: "deploy" },
        requestedByAgentDeploymentId: deploymentId,
        runId: ids[7]!,
        status,
        threadId: ids[8]!,
        ...(toolCallId ? { toolCallId } : {}),
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "approval" as const,
    }),
  );
}

function waitingToolCall(toolCallId: Ulid, approvalId: Ulid) {
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        approvalId,
        createdAt: now.toISOString(),
        effect: "write" as const,
        environmentId,
        id: toolCallId,
        inputSummary: "Deploy release",
        organizationId,
        policyAction: "require-approval" as const,
        projectId,
        requiredScopes: ["deployments:write"],
        runId: ids[7]!,
        status: "waiting" as const,
        threadId: ids[8]!,
        toolName: "deploy",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "tool-call" as const,
    }),
  );
}

function runningToolCall(toolCallId: Ulid) {
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        effect: "write" as const,
        environmentId,
        externalOperationId: "provider-operation-1",
        id: toolCallId,
        idempotencyKey: "async-tool",
        inputSummary: "Start deployment",
        organizationId,
        policyAction: "allow" as const,
        projectId,
        requiredScopes: ["deployments:write"],
        runId: ids[7]!,
        status: "running" as const,
        threadId: ids[8]!,
        toolName: "deploy",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "tool-call" as const,
    }),
  );
}

describe("runtime discovery and lifecycle operations", () => {
  test("keeps trace reconciliation off the cancellation response path", async () => {
    const run = runRecord("queued");
    const memory = memoryDatabase([run, runLocator(run)]);
    let traceReads = 0;
    const database = {
      ...memory.database,
      getRecord: (
        table: Parameters<typeof memory.database.getRecord>[0],
        key: Parameters<typeof memory.database.getRecord>[1],
        consistentRead?: boolean,
      ) => {
        if (key.sk.startsWith("TRACE#")) {
          traceReads += 1;
          return Promise.reject(new Error("unexpected trace read") as never);
        }
        return memory.database.getRecord(table, key, consistentRead);
      },
    };
    const generated = [ids[11]!, ids[12]!, ids[13]!, ids[14]!];

    expect(
      cancelRun(
        {
          database,
          generateId: async () => generated.shift()!,
          now: () => now,
        } as unknown as RuntimeApiDependencies,
        principal(),
        run.data.id,
      ),
    ).resolves.toMatchObject({ run: { status: "canceled" } });
    expect(traceReads).toBe(0);
  });

  test("keeps an asynchronous tool open for canceled-run reconciliation", async () => {
    const waiting = runRecord("waiting-for-tool");
    const toolCallId = ids[10]!;
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...waiting,
        data: {
          ...waiting.data,
          toolContinuation: {
            completedToolCallIds: [],
            pendingAction: { kind: "tool", toolCallId },
            version: 2,
          },
        },
      }),
    );
    const toolCall = runningToolCall(toolCallId);
    const memory = memoryDatabase([run, runLocator(run), toolCall]);
    const generated = [ids[11]!, ids[12]!];

    expect(
      cancelRun(
        {
          database: memory.database,
          generateId: async () => generated.shift()!,
          now: () => now,
        } as unknown as RuntimeApiDependencies,
        principal(),
        run.data.id,
      ),
    ).resolves.toMatchObject({ run: { status: "canceled" } });

    expect(memory.records.get(`${toolCall.pk}\n${toolCall.sk}`)).toMatchObject({
      data: {
        externalOperationId: "provider-operation-1",
        status: "running",
      },
    });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "trace" && record.data.traceId === run.data.traceId,
      ),
    ).toMatchObject({ data: { status: "open" } });
  });

  test("terminalizes an approved pending tool when canceling its queued run", async () => {
    const queued = runRecord("queued");
    const approvalId = ids[9]!;
    const toolCallId = ids[10]!;
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...queued,
        data: {
          ...queued.data,
          toolContinuation: {
            completedToolCallIds: [],
            pendingAction: { kind: "approval", toolCallId },
            version: 2,
          },
        },
      }),
    );
    const approval = approvalRecord("approved", approvalId, toolCallId);
    const waiting = waitingToolCall(toolCallId, approvalId);
    const toolCall = Schema.decodeUnknownSync(ToolCallRecord)(
      withCanonicalRecordKeys({
        ...waiting,
        data: {
          ...waiting.data,
          idempotencyKey: "approved-tool",
          status: "pending" as const,
          version: waiting.data.version + 1,
        },
      }),
    );
    const memory = memoryDatabase([run, runLocator(run), approval, toolCall]);
    const generated = [ids[11]!, ids[12]!, ids[13]!, ids[14]!];

    const result = await cancelRun(
      {
        database: memory.database,
        generateId: async () => generated.shift()!,
        now: () => now,
      } as unknown as RuntimeApiDependencies,
      principal(),
      run.data.id,
    );
    const recovered = await cancelRun(
      {
        database: memory.database,
        enqueueRun: async () => undefined,
      } as unknown as RuntimeApiDependencies,
      principal(),
      run.data.id,
    );

    expect(memory.records.get(`${approval.pk}\n${approval.sk}`)).toMatchObject({
      data: { status: "approved" },
    });
    expect(memory.records.get(`${toolCall.pk}\n${toolCall.sk}`)).toMatchObject({
      data: {
        outputSummary: "Run canceled before approved tool execution.",
        status: "failed",
      },
    });
    expect(cancelRunThreadEvents(principal(), result).map((event) => event.eventType)).toEqual([
      "tool.failed",
      "run.canceled",
    ]);
    expect(cancelRunThreadEvents(principal(), recovered)).toEqual(
      cancelRunThreadEvents(principal(), result),
    );
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.requested",
      ),
    ).toBe(true);
  });

  test("retries failed runs in place and replays terminal runs as new work", async () => {
    const failed = runRecord("failed");
    const completed = runRecord("completed", ids[10]!, "run-completed");
    const thread = threadRecord(completed);
    const sourceMessage = promptMessage(completed);
    const failedLease = threadExecutionLease(failed);
    const memory = memoryDatabase([
      failed,
      runLocator(failed),
      failedLease,
      completed,
      runLocator(completed),
      thread,
      sourceMessage,
      deployment(),
      release(),
    ]);
    const enqueued: string[] = [];
    const generated = [
      ids[9]!,
      ids[11]!,
      ids[20]!,
      ids[12]!,
      ids[13]!,
      ids[15]!,
      ids[16]!,
      ids[17]!,
    ];
    const dependencies = {
      database: memory.database,
      enqueueRun: async (request: Parameters<RuntimeApiDependencies["enqueueRun"]>[0]) =>
        void enqueued.push(request.message.runId),
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const retried = await retryRun(dependencies, principal(), failed.data.id);
    const retriedAgain = await retryRun(dependencies, principal(), failed.data.id);
    const replayed = await replayRun(
      dependencies,
      principal(),
      completed.data.id,
      "public-replay-key",
    );
    const replayedAgain = await replayRun(
      dependencies,
      principal(),
      completed.data.id,
      "public-replay-key",
    );

    expect(retried.run).toMatchObject({
      attempt: 0,
      id: failed.data.id,
      status: "queued",
    });
    expect(retriedAgain.run).toEqual(retried.run);
    expect(retriedAgain.publication).toEqual(retried.publication);
    const reopenedTrace = [...memory.records.values()].find(
      (record) => record.itemType === "trace" && record.data.traceId === failed.data.traceId,
    );
    expect(reopenedTrace).toMatchObject({
      data: { status: "open", version: 2 },
      itemType: "trace",
    });
    expect(reopenedTrace?.data).not.toHaveProperty("finalizedAt");
    expect(memory.records.has(`${failedLease.pk}\n${failedLease.sk}`)).toBe(false);
    expect(replayed.run).toMatchObject({
      id: ids[12],
      replayedFromRunId: completed.data.id,
      replayedFromTraceId: completed.data.traceId,
      status: "queued",
      trigger: completed.data.trigger,
    });
    expect(replayed.run.traceId).not.toBe(completed.data.traceId);
    expect(replayedAgain).toEqual(replayed);
    expect(enqueued).toEqual([]);
    expect(
      memory.transactions[0]?.filter((operation) => operation.kind === "condition-check"),
    ).toEqual([
      expect.objectContaining({ table: "control" }),
      expect.objectContaining({ table: "control" }),
    ]);
    expect(memory.transactions[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "put",
          previousRecord: expect.objectContaining({ itemType: "thread" }),
          record: expect.objectContaining({
            data: expect.objectContaining({ version: thread.data.version + 1 }),
            itemType: "thread",
          }),
        }),
      ]),
    );
    expect(
      memory.transactions[1]?.filter((operation) => operation.kind === "condition-check"),
    ).toEqual([
      expect.objectContaining({ table: "control" }),
      expect.objectContaining({ table: "control" }),
    ]);
    const dispatchEvents = [...memory.records.values()].filter(
      (record) => record.itemType === "semantic-event" && record.data.eventType === "run.requested",
    );
    expect(dispatchEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            aggregateId: ids[11],
            aggregateType: "run-dispatch",
            aggregateVersion: 1,
            payload: expect.objectContaining({
              dispatchId: ids[11],
              idempotencyKey: failed.data.idempotencyKey,
              runId: failed.data.id,
              threadId: failed.data.threadId,
              userMessageId: failed.data.userMessageId,
              userMessageSequence: failed.data.userMessageSequence,
            }),
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            aggregateId: ids[16],
            aggregateType: "run-dispatch",
            aggregateVersion: 1,
            payload: expect.objectContaining({
              dispatchId: ids[16],
              idempotencyKey: "public-replay-key",
              runId: replayed.run.id,
              userMessageId: ids[13],
              userMessageSequence: 2,
            }),
          }),
        }),
      ]),
    );
    expect(dispatchEvents).toHaveLength(2);
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.aggregateId === failed.data.id &&
          record.data.eventType === "run.retry-requested",
      ),
    ).toBeDefined();
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.aggregateId === replayed.run.id &&
          record.data.eventType === "run.replayed",
      ),
    ).toMatchObject({
      data: {
        aggregateId: replayed.run.id,
      },
    });
    const storedReplay = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === replayed.run.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }>;
    expect(storedReplay.data).toMatchObject({
      trigger: completed.data.trigger,
      userMessageId: ids[13],
      userMessageSequence: 2,
    });
    const replayMessage = [...memory.records.values()].find(
      (record) =>
        record.itemType === "message" && record.data.id === storedReplay.data.userMessageId,
    );
    expect(replayMessage).toMatchObject({
      data: {
        body: sourceMessage.data.body,
        runId: replayed.run.id,
        sequence: 2,
      },
    });
    assertPromptBinding(
      replayMessage as Extract<PlatformRecord, { readonly itemType: "message" }>,
      storedReplay.data.userMessageId!,
      storedReplay,
    );
    expect(memory.records.get(`${thread.pk}\n${thread.sk}`)).toMatchObject({
      data: { version: 2 },
    });
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.aggregateId === thread.data.id &&
          record.data.eventType === "thread.run-retried",
      ),
    ).toMatchObject({
      data: {
        aggregateType: "thread",
        aggregateVersion: thread.data.version + 2,
        payload: { runId: failed.data.id, threadId: thread.data.id },
      },
    });
    const storedRetry = memory.records.get(`${failed.pk}\n${failed.sk}`) as Extract<
      PlatformRecord,
      { readonly itemType: "run" }
    >;
    expect(runMutationThreadEvents("retry", principal(), storedRetry)).toMatchObject([
      {
        eventType: "run.retry-requested",
        runId: failed.data.id,
        threadId: failed.data.threadId,
      },
    ]);
    expect(runMutationThreadEvents("replay", principal(), storedReplay)).toMatchObject([
      {
        eventType: "user-message.accepted",
        messageId: storedReplay.data.userMessageId,
        runId: storedReplay.data.id,
      },
      {
        eventType: "run.replayed",
        runId: storedReplay.data.id,
      },
    ]);
  });

  test("blocks replay-created turns behind a message publication barrier", async () => {
    const completed = runRecord("completed", ids[10]!, "run-completed-for-barrier");
    const thread = threadRecord(completed);
    const sourceMessage = promptMessage(completed);
    const memory = memoryDatabase([
      completed,
      runLocator(completed),
      thread,
      sourceMessage,
      messagePublicationBarrier(completed),
      deployment(),
      release(),
    ]);
    const dependencies = {
      database: memory.database,
      enqueueRun: async () => undefined,
      generateId: async () => ids[20]!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    expect(
      replayRun(dependencies, principal(), completed.data.id, "blocked-replay"),
    ).rejects.toMatchObject({ code: "publication_busy", status: 409 });
    expect(memory.transactions).toEqual([]);
  });
});
