import { describe, expect, it } from "bun:test";
import {
  MessageRecord,
  RunRecord,
  ThreadRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { threadExecutionLease } from "./agent-run-lease.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies } from "./types.ts";
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
  it("processes independent message groups concurrently", async () => {
    const fixture = fixtures();
    const secondThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.thread.data, id: id(60), streamId: id(61), title: "Second run" },
        itemType: "thread" as const,
      }),
    );
    const secondRunId = id(62);
    const secondMessage = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          contentHash: "second-user-hash",
          id: id(63),
          runId: secondRunId,
          threadId: secondThread.data.id,
        },
        itemType: "message" as const,
      }),
    );
    const secondRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          id: secondRunId,
          idempotencyKey: "run/request-2",
          threadId: secondThread.data.id,
        },
        itemType: "run" as const,
      }),
    );
    const secondQueue: AgentRunQueueMessage = {
      ...fixture.queue,
      idempotencyKey: secondRun.data.idempotencyKey,
      runId: secondRun.data.id,
      threadId: secondThread.data.id,
      userMessageId: secondMessage.data.id,
      userMessageSequence: secondMessage.data.sequence,
    };
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
      secondThread,
      secondMessage,
      secondRun,
    ]);
    const base = workerDependencies(memory.database);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const observedFirst = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const observedSecond = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          if (request.runId === fixture.run.data.id) {
            firstStarted();
            await firstBlocked;
          } else if (request.runId === secondRun.data.id) {
            secondStarted();
          }
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    const responsePromise = processQueueRecords(
      [
        fifoQueueRecord(fixture.queue, "first", "receipt-first"),
        fifoQueueRecord(secondQueue, "second", "receipt-second"),
      ],
      dependencies,
    );
    await observedFirst;
    await Promise.race([
      observedSecond,
      Bun.sleep(100).then(() => {
        throw new Error("Second queue record did not start concurrently.");
      }),
    ]);
    releaseFirst();

    expect(responsePromise).resolves.toEqual([]);
  });

  it("hands back a thread's blocked record and holds its later records behind it", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const activeRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          claimedAt: "2026-07-22T00:00:00.900Z",
          claimedBy: "worker-old",
          heartbeatAt: "2026-07-22T00:00:00.900Z",
          status: "running" as const,
          version: 1,
        },
        itemType: "run" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      activeRun,
      second.userMessage,
      second.run,
    ]);
    const base = workerDependencies(memory.database);
    let generated = false;
    const retries: Array<{ readonly messageId: string; readonly retryAfterSeconds: number }> = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      retryQueueMessage: async (delivery, _message, retryAfterSeconds) => {
        retries.push({ messageId: delivery.messageId, retryAfterSeconds });
      },
      runtime: {
        generateAssistantMessage: async () => {
          generated = true;
          return { assistantMessage: "unexpected" };
        },
      },
    };

    const response = await processQueueRecords(
      [
        fifoQueueRecord(fixture.queue, "lane-first", "lane-first-receipt"),
        fifoQueueRecord(second.queue, "lane-second", "lane-second-receipt"),
      ],
      dependencies,
    );

    expect(response).toEqual(["lane-first", "lane-second"]);
    expect(generated).toBe(false);
    expect(retries).toEqual([{ messageId: "lane-first", retryAfterSeconds: 60 }]);
  });

  it("continues a FIFO thread lane after a failed run is fully published", async () => {
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
    const modelRunIds: Ulid[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          if (request.runId === fixture.run.data.id) throw new Error("first run failed");
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    const response = await processQueueRecords(
      [
        fifoQueueRecord(fixture.queue, "failed-first", "failed-first-receipt"),
        fifoQueueRecord(second.queue, "completed-second", "completed-second-receipt"),
      ],
      dependencies,
    );

    expect(response).toEqual([]);
    expect(modelRunIds).toEqual([fixture.run.data.id, fixture.run.data.id, second.run.data.id]);
    const runs = [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
        record.itemType === "run",
    );
    expect(runs.find((run) => run.data.id === fixture.run.data.id)?.data.status).toBe("failed");
    expect(runs.find((run) => run.data.id === second.run.data.id)?.data.status).toBe("completed");
  });

  it("holds later thread records until terminal stream publication replays", async () => {
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
    const modelRunIds: Ulid[] = [];
    const published: Array<{ readonly eventType: string; readonly runId?: string }> = [];
    let failFirstFinalized = true;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      appendThreadEvent: async (event) => {
        if (
          failFirstFinalized &&
          event.eventType === "assistant-message.finalized" &&
          event.runId === fixture.run.data.id
        ) {
          failFirstFinalized = false;
          throw new Error("stream temporarily unavailable");
        }
        published.push({
          eventType: event.eventType,
          ...(event.runId ? { runId: event.runId } : {}),
        });
      },
      runtime: {
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };
    const records = [
      fifoQueueRecord(fixture.queue, "publish-first", "publish-first-receipt"),
      fifoQueueRecord(second.queue, "publish-second", "publish-second-receipt"),
    ];

    expect(processQueueRecords(records, dependencies)).resolves.toEqual([
      "publish-first",
      "publish-second",
    ]);
    expect(modelRunIds).toEqual([fixture.run.data.id]);

    expect(processQueueRecords(records, dependencies)).resolves.toEqual([]);
    expect(modelRunIds).toEqual([fixture.run.data.id, second.run.data.id]);
    const firstFinalized = published.findIndex(
      (item) =>
        item.runId === fixture.run.data.id && item.eventType === "assistant-message.finalized",
    );
    const secondStarted = published.findIndex(
      (item) => item.runId === second.run.data.id && item.eventType === "run.started",
    );
    expect(firstFinalized).toBeGreaterThanOrEqual(0);
    expect(secondStarted).toBeGreaterThan(firstFinalized);
  });

  it("holds the thread lease across terminal publication in separate invocations", async () => {
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
    let continuePublication!: () => void;
    const publicationBlocked = new Promise<void>((resolve) => {
      continuePublication = resolve;
    });
    let publicationStarted!: () => void;
    const observedPublication = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      appendThreadEvent: async (event) => {
        if (
          event.eventType === "assistant-message.finalized" &&
          event.runId === fixture.run.data.id
        ) {
          publicationStarted();
          await publicationBlocked;
        }
      },
      runtime: {
        generateAssistantMessage: async (request) => ({
          assistantMessage: `Completed ${request.runId}.`,
        }),
      },
    };

    const first = processAgentRun(fixture.queue, dependencies);
    await observedPublication;

    expect(processAgentRun(second.queue, dependencies)).rejects.toThrow("active claim");
    const barrier = [...memory.records.values()].find(
      (record) => record.itemType === "runtime-lease",
    ) as Extract<PlatformRecord, { readonly itemType: "runtime-lease" }> | undefined;
    expect(barrier?.data.runId).toBe(fixture.run.data.id);

    continuePublication();
    expect(first).resolves.toMatchObject({ action: "completed" });
    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
  });

  it("never stale-recovers a publication barrier before explicit resolution", async () => {
    const fixture = fixtures();
    const publicationLease = threadExecutionLease({
      acquiredAt: "2026-07-22T00:00:00.900Z",
      environmentId: fixture.run.data.environmentId,
      expiresAt: "2026-07-22T00:00:00.950Z",
      organizationId: fixture.run.data.organizationId,
      owner: `message-publication/${id(60)}`,
      projectId: fixture.run.data.projectId,
      runId: id(61),
      threadId: fixture.thread.data.id,
      version: 0,
    });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
      publicationLease,
    ]);
    const base = workerDependencies(memory.database);
    let generated = false;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          generated = true;
          return { assistantMessage: "unexpected" };
        },
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).rejects.toThrow("active claim");
    expect(generated).toBe(false);
    expect(
      [...memory.records.values()].find((record) => record.itemType === "runtime-lease")?.data
        .owner,
    ).toBe(publicationLease.data.owner);

    await memory.database.deleteRecord(publicationLease);
    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    expect(generated).toBe(true);
  });

  it("stops a FIFO thread lane after a permanent scope mismatch", async () => {
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
    const modelRunIds: Ulid[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    const response = await processQueueRecords(
      [
        fifoQueueRecord(
          { ...fixture.queue, runId: id(99) },
          "scope-mismatch",
          "scope-mismatch-receipt",
        ),
        fifoQueueRecord(
          second.queue,
          "valid-after-scope-mismatch",
          "valid-after-scope-mismatch-receipt",
        ),
      ],
      dependencies,
    );

    expect(response).toEqual(["scope-mismatch", "valid-after-scope-mismatch"]);
    expect(modelRunIds).toEqual([]);
  });

  it("continues a FIFO thread lane after terminalizing an invalid trigger", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const unboundMessage = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.userMessage.data, runId: id(99) },
        itemType: "message" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      unboundMessage,
      fixture.run,
      second.userMessage,
      second.run,
    ]);
    const base = workerDependencies(memory.database);
    const modelRunIds: Ulid[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    const response = await processQueueRecords(
      [
        fifoQueueRecord(fixture.queue, "permanent-invalid", "permanent-invalid-receipt"),
        fifoQueueRecord(second.queue, "valid-later", "valid-later-receipt"),
      ],
      dependencies,
    );

    expect(response).toEqual([]);
    expect(modelRunIds).toEqual([second.run.data.id]);
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
      ),
    ).toMatchObject({ data: { status: "failed" } });
  });

  it("serializes SQS records that target the same thread", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let active = 0;
    let maximumActive = 0;
    let modelCalls = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          modelCalls += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(10);
          active -= 1;
          return { assistantMessage: "Serialized result." };
        },
      },
    };

    const response = await processQueueRecords(
      [
        fifoQueueRecord(fixture.queue, "same-thread-1", "same-thread-receipt-1"),
        fifoQueueRecord(fixture.queue, "same-thread-2", "same-thread-receipt-2"),
      ],
      dependencies,
    );

    expect(response).toEqual([]);
    expect(modelCalls).toBe(1);
    expect(maximumActive).toBe(1);
  });

  it("preserves same-thread FIFO delivery order", async () => {
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
    const modelRunIds: Ulid[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    const response = await processQueueRecords(
      [
        fifoQueueRecord(fixture.queue, "earlier-message-first", "earlier-message-first-receipt"),
        fifoQueueRecord(second.queue, "later-message-second", "later-message-second-receipt"),
      ],
      dependencies,
    );

    expect(response).toEqual([]);
    expect(modelRunIds).toEqual([fixture.run.data.id, second.run.data.id]);
  });
});
