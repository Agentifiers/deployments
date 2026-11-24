import { describe, expect, test } from "bun:test";
import {
  RunRecord,
  TimelineEventRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { pausedToolCallRecord, pendingApprovalRecord, processAgentRun } from "./index.ts";
import { id } from "./agent-run.fixture.ts";
import { slackFixture, streamRecord } from "./slack-agent-stream.fixture.ts";
import {
  SlackAgentStreamApiError,
  ensureSlackAgentStream,
  finalizeSlackAgentStream,
  pauseSlackAgentStream,
} from "./slack-agent-stream.ts";

describe("Slack agent stream lifecycle", () => {
  test("stops on pause and starts a fresh stream segment on resume", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);

    const paused = await pauseSlackAgentStream(test.dependencies, test.run);
    const resumed = await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);

    expect(paused?.data).toMatchObject({ status: "paused" });
    expect(resumed?.data).toMatchObject({ status: "streaming", version: 4 });
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop", "start"]);
  });

  test("updates a paused stream segment when the run later fails", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    await pauseSlackAgentStream(test.dependencies, test.run);
    const failed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          error: { message: "Approval was rejected." },
          status: "failed" as const,
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );

    const result = await finalizeSlackAgentStream({ dependencies: test.dependencies, run: failed });

    expect(result?.data.status).toBe("stopped");
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop", "update"]);
    expect(test.calls.at(-1)).toMatchObject({
      method: "update",
      payload: {
        channel: "C1",
        text: expect.stringContaining("failed"),
        ts: "1721609601.000001",
      },
    });
  });

  test("recovers a confirmed pause after paused-state persistence fails", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    let failPausedWrite = true;
    const database = {
      ...test.dependencies.database,
      transactWrite: (
        operations: Parameters<typeof test.dependencies.database.transactWrite>[0],
      ) => {
        if (
          failPausedWrite &&
          operations.some(
            (operation) =>
              operation.kind === "put" &&
              operation.record.itemType === "slack-agent-stream" &&
              operation.record.data.status === "paused",
          )
        ) {
          failPausedWrite = false;
          return Promise.reject(new Error("simulated paused-state write failure"));
        }
        return test.dependencies.database.transactWrite(operations);
      },
    };
    expect(pauseSlackAgentStream({ ...test.dependencies, database }, test.run)).rejects.toThrow(
      "simulated paused-state write failure",
    );
    const recovered = await pauseSlackAgentStream(
      {
        ...test.dependencies,
        database,
        slackAgentStream: {
          ...test.dependencies.slackAgentStream,
          stop: async () => {
            throw new SlackAgentStreamApiError(
              "chat.stopStream",
              200,
              "message_not_in_streaming_state",
            );
          },
        },
      },
      test.run,
    );
    expect(recovered?.data).toMatchObject({ fallbackAllowed: false, status: "paused" });
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop", "update"]);
  });

  test("allows fallback after a definitive paused-message update rejection", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const result = await pauseSlackAgentStream(
      {
        ...test.dependencies,
        slackAgentStream: {
          ...test.dependencies.slackAgentStream,
          stop: async () => {
            throw new SlackAgentStreamApiError(
              "chat.stopStream",
              200,
              "message_not_in_streaming_state",
            );
          },
          update: async () => {
            throw new SlackAgentStreamApiError("chat.update", 200, "message_not_found");
          },
        },
      },
      test.run,
    );
    expect(result?.data).toMatchObject({ fallbackAllowed: true, status: "failed" });
  });

  test("persists a fallback delivery when canceled stream finalization loses its message", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const canceled = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          status: "canceled" as const,
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );

    const result = await finalizeSlackAgentStream({
      dependencies: {
        ...test.dependencies,
        slackAgentStream: {
          ...test.dependencies.slackAgentStream,
          stop: async () => {
            throw new SlackAgentStreamApiError("chat.stopStream", 200, "message_not_found");
          },
        },
      },
      run: canceled,
    });

    expect(result?.data).toMatchObject({ fallbackAllowed: true, status: "failed" });
    const delivery = [...test.memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "channel-delivery" }> =>
        record.itemType === "channel-delivery",
    );
    expect(delivery?.data).toMatchObject({
      contentPreview: "Agent run canceled.",
      deliveryMode: "slack-stream-fallback",
      idempotencyKey: expect.stringContaining(`:terminal-${test.run.data.version}`),
      providerPayload: { channel: "C1", markdown_text: "Agent run canceled." },
      status: "queued",
    });
  });

  test("pauses a streaming segment when recovering an already-persisted waiting run", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const paused = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          heartbeatAt: "2026-07-22T00:00:01.000Z",
          status: "waiting-for-approval" as const,
          updatedAt: "2026-07-22T00:00:01.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    const action = {
      approvalId: id(72),
      effect: "write" as const,
      idempotencyKey: "slack-stream-recovery-approval",
      inputSummary: "Deploy to production.",
      kind: "approval" as const,
      policyReason: "Production deployment requires approval.",
      requiredScopes: ["deployment:write"],
      toolCallId: id(73),
      toolName: "deployment.start",
    };
    const timestamp = new Date("2026-07-22T00:00:01.000Z");
    const timeline = Schema.decodeUnknownSync(TimelineEventRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp.toISOString(),
          data: {
            approvalId: action.approvalId,
            status: paused.data.status,
            toolCallId: action.toolCallId,
            toolName: action.toolName,
          },
          environmentId: paused.data.environmentId,
          eventType: "run.waiting-for-approval",
          id: id(74),
          organizationId: paused.data.organizationId,
          projectId: paused.data.projectId,
          runId: paused.data.id,
          sequence: paused.data.version,
          threadId: paused.data.threadId,
        },
        itemType: "timeline-event" as const,
      }),
    );
    await test.memory.database.putRecord(paused);
    await test.memory.database.putRecord(timeline);
    await test.memory.database.putRecord(
      pausedToolCallRecord({ action, now: timestamp, run: paused }),
    );
    await test.memory.database.putRecord(
      pendingApprovalRecord({ action, now: timestamp, run: paused }),
    );

    const result = await processAgentRun(test.queue, test.dependencies);

    expect(result).toMatchObject({ action: "paused", status: "waiting-for-approval" });
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop"]);
    const recoveredStream = streamRecord(test.memory);
    expect(recoveredStream?.data.status).toBe("paused");
    expect(recoveredStream?.data.streamTs).toBe("1721609601.000001");
  });
});
