import { describe, expect, test } from "bun:test";
import {
  RunRecord,
  RuntimeLeaseRecord,
  SlackAgentStreamRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { additionalRunOnThread, id } from "./agent-run.fixture.ts";
import { slackFixture, streamRecord } from "./slack-agent-stream.fixture.ts";
import {
  SlackAgentStreamApiError,
  ensureSlackAgentStream,
  finalizeSlackAgentStream,
} from "./slack-agent-stream.ts";

describe("Slack agent stream initialization and recovery", () => {
  test("permits fallback after a definitive start rejection", async () => {
    const test = slackFixture();
    const dependencies = {
      ...test.dependencies,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        start: async () => {
          throw new SlackAgentStreamApiError("chat.startStream", 200, "channel_type_not_supported");
        },
      },
    };
    const result = await ensureSlackAgentStream(dependencies, test.run, test.userMessage);
    expect(result?.data).toMatchObject({
      fallbackAllowed: true,
      lastError: expect.stringContaining("channel_type_not_supported"),
      status: "failed",
    });
  });

  test("fails closed after an ambiguous start failure", async () => {
    const test = slackFixture();
    const result = ensureSlackAgentStream(
      {
        ...test.dependencies,
        slackAgentStream: {
          ...test.dependencies.slackAgentStream,
          start: async () => {
            throw new TypeError("fetch failed");
          },
        },
      },
      test.run,
      test.userMessage,
    );
    expect(result).rejects.toThrow("initialization could not be durably reconciled");
    expect(streamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      lastError: "fetch failed",
      status: "failed",
    });
  });

  test("releases a persisted terminal run lease before surfacing a Slack retry", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const failed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          claimedAt: "2026-07-22T00:00:00.000Z",
          claimedBy: "worker-terminal-replay",
          completedAt: "2026-07-22T00:00:10.000Z",
          heartbeatAt: "2026-07-22T00:00:10.000Z",
          status: "failed" as const,
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    const lease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:15:00.000Z",
          id: failed.data.threadId,
          leaseKey: `agent-run-thread/${failed.data.threadId}`,
          owner: failed.data.claimedBy!,
          renewedAt: "2026-07-22T00:00:10.000Z",
          runId: failed.data.id,
          threadId: failed.data.threadId,
          version: 1,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    await test.memory.database.putRecord(failed);
    await test.memory.database.putRecord(lease);
    const dependencies = {
      ...test.dependencies,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        stop: async () => {
          throw new SlackAgentStreamApiError("chat.stopStream", 429, "ratelimited");
        },
      },
    };

    expect(processAgentRun(test.queue, dependencies)).rejects.toThrow("ratelimited");

    expect(
      [...test.memory.records.values()].some((record) => record.itemType === "runtime-lease"),
    ).toBe(false);
  });

  test("releases a completed run lease before surfacing an external body read retry", async () => {
    const test = slackFixture();
    const assistantBody = "x".repeat(300_000);
    const completionDependencies = {
      ...test.dependencies,
      deleteMessageBody: async () => undefined,
      readMessageBody: async () => assistantBody,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: assistantBody }),
      },
      writeMessageBody: async (input: {
        readonly body: string;
        readonly contentHash: string;
        readonly messageId: string;
      }) => ({
        bucket: "message-bodies",
        byteSize: new TextEncoder().encode(input.body).byteLength,
        contentType: "text/plain; charset=utf-8",
        key: `messages/${input.messageId}`,
        sha256: input.contentHash,
      }),
    };
    expect(processAgentRun(test.queue, completionDependencies)).resolves.toMatchObject({
      action: "completed",
    });
    const completed = [...test.memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
        record.itemType === "run" && record.data.id === test.run.data.id,
    );
    const assistant = [...test.memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "message" }> =>
        record.itemType === "message" && record.data.role === "assistant",
    );
    expect(assistant?.data.bodyRef).toBeDefined();
    if (!completed?.data.claimedBy) throw new Error("Expected completed run owner.");
    const lease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:15:00.000Z",
          id: completed.data.threadId,
          leaseKey: `agent-run-thread/${completed.data.threadId}`,
          owner: completed.data.claimedBy,
          renewedAt: "2026-07-22T00:00:10.000Z",
          runId: completed.data.id,
          threadId: completed.data.threadId,
          version: 1,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    await test.memory.database.putRecord(lease);

    expect(
      processAgentRun(test.queue, {
        ...completionDependencies,
        readMessageBody: async () => {
          throw new Error("simulated external body read failure");
        },
      }),
    ).rejects.toThrow("simulated external body read failure");

    expect(
      [...test.memory.records.values()].some((record) => record.itemType === "runtime-lease"),
    ).toBe(false);
    expect(
      [...test.memory.records.values()].some(
        (record) =>
          record.itemType === "timeline-event" && record.data.eventType === "run.completed",
      ),
    ).toBe(true);
  });

  test("fails closed when Slack accepts a stream start without returning its timestamp", async () => {
    const test = slackFixture();
    const result = ensureSlackAgentStream(
      {
        ...test.dependencies,
        slackAgentStream: {
          ...test.dependencies.slackAgentStream,
          start: async () => {
            throw new SlackAgentStreamApiError("chat.startStream", 200, "missing_ts");
          },
        },
      },
      test.run,
      test.userMessage,
    );
    expect(result).rejects.toThrow("initialization could not be durably reconciled");
    expect(streamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      lastError: expect.stringContaining("missing_ts"),
      status: "failed",
    });
  });

  test("retries when fallback eligibility cannot be persisted", async () => {
    const test = slackFixture();
    const database = {
      ...test.dependencies.database,
      transactWrite: (operations: Parameters<typeof test.dependencies.database.transactWrite>[0]) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "slack-agent-stream" &&
            operation.record.data.status === "failed",
        )
          ? Promise.reject(new Error("simulated stream transition failure"))
          : test.dependencies.database.transactWrite(operations),
    };
    expect(
      ensureSlackAgentStream(
        {
          ...test.dependencies,
          database,
          slackAgentStream: {
            ...test.dependencies.slackAgentStream,
            start: async () => {
              throw new SlackAgentStreamApiError("chat.startStream", 200, "restricted_action");
            },
          },
        },
        test.run,
        test.userMessage,
      ),
    ).rejects.toThrow("simulated stream transition failure");
    expect(streamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      status: "starting",
    });
  });

  test("retries when the initial stream record cannot be persisted", async () => {
    const test = slackFixture();
    const database = {
      ...test.dependencies.database,
      putRecord: (record: Parameters<typeof test.dependencies.database.putRecord>[0]) =>
        record.itemType === "slack-agent-stream" && record.data.status === "starting"
          ? Promise.reject(new Error("simulated initial stream write failure"))
          : test.dependencies.database.putRecord(record),
    };

    expect(
      ensureSlackAgentStream({ ...test.dependencies, database }, test.run, test.userMessage),
    ).rejects.toThrow("simulated initial stream write failure");
    expect(streamRecord(test.memory)).toBeUndefined();
    expect(test.calls).toEqual([]);
  });

  test("continues initialization after a lost successful initial stream record response", async () => {
    const test = slackFixture();
    let loseResponse = true;
    const database = {
      ...test.dependencies.database,
      putRecord: (record: Parameters<typeof test.dependencies.database.putRecord>[0]) =>
        (async () => {
          await test.dependencies.database.putRecord(record);
          if (
            loseResponse &&
            record.itemType === "slack-agent-stream" &&
            record.data.status === "starting"
          ) {
            loseResponse = false;
            throw new Error("simulated lost initial stream write response");
          }
        })(),
    };

    expect(
      ensureSlackAgentStream({ ...test.dependencies, database }, test.run, test.userMessage),
    ).resolves.toMatchObject({ data: { status: "streaming" } });
    expect(streamRecord(test.memory)?.data.status).toBe("streaming");
    expect(test.calls.map((call) => call.method)).toEqual(["start"]);
  });

  test("does not execute the runtime until stream initialization is durably reconciled", async () => {
    const test = slackFixture();
    let executions = 0;
    const database = {
      ...test.dependencies.database,
      transactWrite: (operations: Parameters<typeof test.dependencies.database.transactWrite>[0]) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "slack-agent-stream" &&
            operation.record.data.status === "failed",
        )
          ? Promise.reject(new Error("simulated stream transition failure"))
          : test.dependencies.database.transactWrite(operations),
    };
    const result = await processAgentRun(test.queue, {
      ...test.dependencies,
      database,
      runtime: {
        ...test.dependencies.runtime,
        generateAssistantMessage: async () => {
          executions += 1;
          return { assistantMessage: "unexpected" };
        },
      },
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        start: async () => {
          throw new SlackAgentStreamApiError("chat.startStream", 200, "restricted_action");
        },
      },
    });
    expect(result).toMatchObject({ action: "requeued" });
    expect(executions).toBe(0);
  });

  test("fails closed for coded Slack server errors", () => {
    const error = new SlackAgentStreamApiError("chat.startStream", 503, "unknown_server_error");
    expect(error.safeToFallback).toBe(false);
  });

  test("allows fallback for a definitive start rate-limit rejection only", () => {
    const start = new SlackAgentStreamApiError("chat.startStream", 429, "ratelimited");
    const stop = new SlackAgentStreamApiError("chat.stopStream", 429, "ratelimited");
    expect(start.safeToFallback).toBe(true);
    expect(stop.safeToFallback).toBe(false);
  });

  test("fails closed for malformed post-start mutations", () => {
    const stop = new SlackAgentStreamApiError("chat.stopStream", 200, "invalid_arguments");
    const update = new SlackAgentStreamApiError("chat.update", 200, "invalid_arguments");
    const missing = new SlackAgentStreamApiError("chat.update", 200, "message_not_found");
    expect(stop.safeToFallback).toBe(false);
    expect(update.safeToFallback).toBe(false);
    expect(missing.safeToFallback).toBe(true);
  });

  test("only the claimed run owner initializes a stream under concurrent deliveries", async () => {
    const test = slackFixture();
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startCalls = 0;
    const dependencies = {
      ...test.dependencies,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        start: async (_token: string, payload: unknown) => {
          startCalls += 1;
          test.calls.push({ method: "start", payload });
          await startGate;
          return { ts: "1721609601.000001" };
        },
      },
    };
    const first = processAgentRun(test.queue, dependencies);
    while (startCalls === 0) await Promise.resolve();
    const second = processAgentRun(test.queue, dependencies);
    expect(second).rejects.toThrow("active claim");
    releaseStart?.();
    expect(first).resolves.toMatchObject({ action: "completed" });
    expect(startCalls).toBe(1);
    expect(streamRecord(test.memory)?.data.status).toBe("stopped");
  });

  test("finalizes an existing stream when missing pins fail a recovered run before claim", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const running = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          attempt: 1,
          claimedAt: "2026-07-21T23:00:00.000Z",
          claimedBy: "expired-worker",
          heartbeatAt: "2026-07-21T23:00:00.000Z",
          status: "running" as const,
          updatedAt: "2026-07-21T23:00:00.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    const release = [...test.memory.records.values()].find(
      (record) => record.itemType === "agent-release",
    );
    if (!release) throw new Error("Expected release fixture.");
    await test.memory.database.putRecord(running);
    await test.memory.database.deleteRecord(release);
    const result = await processAgentRun(test.queue, {
      ...test.dependencies,
      runningClaimTimeoutMs: 1_000,
    });
    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop"]);
    expect(streamRecord(test.memory)?.data.status).toBe("stopped");
  });

  test("requeues prior Slack finalization before releasing its expired lease", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const running = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:00.000Z",
          claimedBy: "expired-worker",
          heartbeatAt: "2026-07-22T00:00:00.000Z",
          status: "running" as const,
          updatedAt: "2026-07-22T00:00:00.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    const lease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:00:00.050Z",
          id: test.fixture.thread.data.id,
          leaseKey: `agent-run-thread/${test.fixture.thread.data.id}`,
          owner: "expired-worker",
          renewedAt: "2026-07-22T00:00:00.000Z",
          runId: running.data.id,
          threadId: test.fixture.thread.data.id,
          version: 0,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    const secondBase = additionalRunOnThread({
      ...test.fixture,
      run: test.run,
      userMessage: test.userMessage,
    });
    const second = {
      ...secondBase,
      run: Schema.decodeUnknownSync(RunRecord)(
        withCanonicalRecordKeys({
          data: {
            ...secondBase.run.data,
            userMessageId: secondBase.userMessage.data.id,
            userMessageSequence: secondBase.userMessage.data.sequence,
          },
          itemType: "run" as const,
        }),
      ),
    };
    await test.memory.database.putRecord(running);
    await test.memory.database.putRecord(lease);
    await test.memory.database.putRecord(second.userMessage);
    await test.memory.database.putRecord(second.run);
    let failFirstStop = true;
    const requeued: Parameters<NonNullable<typeof test.dependencies.enqueueRun>>[0][] = [];
    const dependencies = {
      ...test.dependencies,
      enqueueRun: async (input: Parameters<NonNullable<typeof test.dependencies.enqueueRun>>[0]) =>
        void requeued.push(input),
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: "Second answer." }),
      },
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        stop: async (token: string, payload: unknown) => {
          if (failFirstStop) {
            failFirstStop = false;
            throw new SlackAgentStreamApiError("chat.stopStream", 429, "ratelimited");
          }
          await test.dependencies.slackAgentStream.stop(token, payload as never);
        },
      },
    };
    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    expect(
      [...test.memory.records.values()].some(
        (record) => record.itemType === "runtime-lease" && record.data.runId === running.data.id,
      ),
    ).toBe(false);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toMatchObject({
      deduplicationId: expect.stringContaining("slack-terminal-recovery:"),
      message: { runId: running.data.id },
      messageGroupId: expect.stringContaining(":recovery"),
    });

    const recovered = await processAgentRun(requeued[0]!.message, test.dependencies);
    expect(recovered).toMatchObject({ action: "skipped" });
    const priorStream = [...test.memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "slack-agent-stream" }> =>
        record.itemType === "slack-agent-stream" && record.data.runId === running.data.id,
    );
    expect(priorStream?.data.status).toBe("stopped");
    expect(test.calls.map((call) => call.method)).toEqual([
      "start",
      "start",
      "append",
      "append",
      "append",
      "stop",
      "update",
      "stop",
    ]);
  });

  test("suppresses unsafe restart after an unresolved starting record", async () => {
    const test = slackFixture();
    const starting = Schema.decodeUnknownSync(SlackAgentStreamRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: test.run.data.agentDeploymentId,
          bindingId: id(70),
          bindingVersion: 0,
          channelId: "C1",
          createdAt: "2026-07-22T00:00:01.000Z",
          credentialRef: {
            credentialId: id(71),
            generation: 1,
            store: "dynamodb-kms",
          },
          environmentId: test.run.data.environmentId,
          fallbackAllowed: false,
          id: test.run.data.id,
          organizationId: test.run.data.organizationId,
          projectId: test.run.data.projectId,
          recipientTeamId: "T1",
          recipientUserId: "U1",
          runAttempt: test.run.data.attempt,
          runClaimedAt: test.run.data.claimedAt ?? test.run.data.updatedAt,
          runExecutionVersion: test.run.data.version,
          runId: test.run.data.id,
          status: "starting",
          threadId: test.run.data.threadId,
          threadTs: "1721609600.123456",
          updatedAt: "2026-07-22T00:00:01.000Z",
          version: 0,
          workspaceId: test.run.data.workspaceId,
        },
        itemType: "slack-agent-stream" as const,
      }),
    );
    await test.memory.database.putRecord(starting);
    const result = ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    expect(test.calls).toEqual([]);
    expect(result).rejects.toThrow("initialization could not be durably reconciled");
    expect(streamRecord(test.memory)?.data).toMatchObject({ status: "starting", version: 0 });
  });

  test("starts a fresh segment for a later in-place retry generation", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const failed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          status: "failed" as const,
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    await finalizeSlackAgentStream({ dependencies: test.dependencies, run: failed });
    const { completedAt: _completedAt, error: _error, ...retryData } = failed.data;
    const retried = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...retryData,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:11.000Z",
          status: "running" as const,
          updatedAt: "2026-07-22T00:00:11.000Z",
          version: failed.data.version + 2,
        },
        itemType: "run" as const,
      }),
    );

    const result = await ensureSlackAgentStream(test.dependencies, retried, test.userMessage);

    expect(result?.data).toMatchObject({
      runAttempt: retried.data.attempt,
      runClaimedAt: retried.data.claimedAt,
      runExecutionVersion: retried.data.version,
      status: "streaming",
    });
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop", "start"]);
  });

  test("keeps an unconfirmed post-start compensation retryable without restarting", async () => {
    const test = slackFixture();
    let failStreamingWrite = true;
    const database = {
      ...test.dependencies.database,
      transactWrite: (
        operations: Parameters<typeof test.dependencies.database.transactWrite>[0],
      ) => {
        if (
          failStreamingWrite &&
          operations.some(
            (operation) =>
              operation.kind === "put" &&
              operation.record.itemType === "slack-agent-stream" &&
              operation.record.data.status === "streaming",
          )
        ) {
          failStreamingWrite = false;
          return Promise.reject(new Error("simulated streaming-state write failure"));
        }
        return test.dependencies.database.transactWrite(operations);
      },
    };
    const dependencies = {
      ...test.dependencies,
      database,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        stop: async () => {
          throw new TypeError("stop outcome unknown");
        },
      },
    };

    expect(ensureSlackAgentStream(dependencies, test.run, test.userMessage)).rejects.toThrow(
      "initialization could not be durably reconciled",
    );
    expect(streamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      status: "failed",
    });
    const laterGeneration = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: { ...test.run.data, version: test.run.data.version + 2 },
        itemType: "run" as const,
      }),
    );
    expect(ensureSlackAgentStream(dependencies, laterGeneration, test.userMessage)).rejects.toThrow(
      "initialization could not be durably reconciled",
    );
    expect(test.calls.map((call) => call.method)).toEqual(["start"]);
  });
});
