import { describe, expect, test } from "bun:test";
import {
  ChannelDeliveryRecord,
  RunRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { id } from "./agent-run.fixture.ts";
import { slackFixture, streamRecord } from "./slack-agent-stream.fixture.ts";
import {
  SlackAgentStreamApiError,
  ensureSlackAgentStream,
  finalizeSlackAgentStream,
} from "./slack-agent-stream.ts";

describe("Slack agent stream lifecycle", () => {
  test("reopens a terminalized fallback exactly when its stream outcome resolves", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const timestamp = "2026-07-22T00:00:01.000Z";
    const delivery = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
      withCanonicalRecordKeys({
        data: {
          attempts: 0,
          bindingId: id(70),
          channel: "slack",
          contentPreview: "Final answer.",
          createdAt: timestamp,
          credentialRef: {
            credentialId: id(71),
            generation: 1,
            store: "dynamodb-kms" as const,
          },
          deliveryMode: "slack-stream-fallback" as const,
          environmentId: test.run.data.environmentId,
          externalThreadKey: "slack:T1:thread:C1:1721609600.123456",
          failedAt: timestamp,
          id: id(75),
          idempotencyKey: `channel-response:v1:${test.run.data.id}:${id(70)}`,
          lastError: "Slack agent stream outcome is unknown; fallback delivery was suppressed.",
          organizationId: test.run.data.organizationId,
          projectId: test.run.data.projectId,
          provider: "slack_edge",
          providerPayload: { channel: "C1", markdown_text: "Final answer." },
          runId: test.run.data.id,
          status: "failed" as const,
          threadId: test.run.data.threadId,
          updatedAt: timestamp,
          version: 1,
          workspaceId: test.run.data.workspaceId,
        },
        itemType: "channel-delivery" as const,
      }),
    );
    await test.memory.database.putRecord(delivery);
    const completed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          status: "completed" as const,
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );

    await finalizeSlackAgentStream({
      body: "Final answer.",
      dependencies: test.dependencies,
      run: completed,
    });

    const reopened = [...test.memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "channel-delivery" }> =>
        record.itemType === "channel-delivery",
    );
    expect(reopened?.data).toMatchObject({
      lastError: expect.stringContaining("resolved"),
      status: "queued",
      version: 2,
    });
    expect(reopened?.data).not.toHaveProperty("failedAt");
  });

  test("retries suppressed-fallback reconciliation for an already-stopped stream", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const completed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          status: "completed" as const,
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    await finalizeSlackAgentStream({
      body: "Final answer.",
      dependencies: test.dependencies,
      run: completed,
    });
    const timestamp = "2026-07-22T00:00:11.000Z";
    const delivery = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
      withCanonicalRecordKeys({
        data: {
          attempts: 0,
          bindingId: id(70),
          channel: "slack",
          contentPreview: "Final answer.",
          createdAt: timestamp,
          credentialRef: { credentialId: id(71), generation: 1, store: "dynamodb-kms" as const },
          deliveryMode: "slack-stream-fallback" as const,
          environmentId: test.run.data.environmentId,
          externalThreadKey: "slack:T1:thread:C1:1721609600.123456",
          failedAt: timestamp,
          id: id(76),
          idempotencyKey: `channel-response:v1:${test.run.data.id}:${id(70)}`,
          lastError: "Slack agent stream outcome is unknown; fallback delivery was suppressed.",
          organizationId: test.run.data.organizationId,
          projectId: test.run.data.projectId,
          provider: "slack_edge",
          providerPayload: { channel: "C1", markdown_text: "Final answer." },
          runId: test.run.data.id,
          status: "failed" as const,
          threadId: test.run.data.threadId,
          updatedAt: timestamp,
          version: 1,
          workspaceId: test.run.data.workspaceId,
        },
        itemType: "channel-delivery" as const,
      }),
    );
    await test.memory.database.putRecord(delivery);

    await finalizeSlackAgentStream({
      body: "Final answer.",
      dependencies: test.dependencies,
      run: completed,
    });

    const reconciled = [...test.memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "channel-delivery" }> =>
        record.itemType === "channel-delivery",
    );
    expect(reconciled?.data.status).toBe("queued");
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop", "update"]);
  });

  test("leaves a retryable finalization failure streaming", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const dependencies = {
      ...test.dependencies,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        stop: async () => {
          throw new SlackAgentStreamApiError("chat.stopStream", 429, "ratelimited");
        },
      },
    };
    const completed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          status: "completed",
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );

    expect(
      finalizeSlackAgentStream({ body: "Final answer", dependencies, run: completed }),
    ).rejects.toThrow("ratelimited");
    expect(streamRecord(test.memory)?.data.status).toBe("streaming");
  });

  test("releases the thread barrier before surfacing terminal Slack retry", async () => {
    const test = slackFixture();
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
    expect(
      [...test.memory.records.values()].some(
        (record) =>
          record.itemType === "timeline-event" && record.data.eventType === "run.completed",
      ),
    ).toBe(true);
  });

  test("reconciles an already-ended stream with an idempotent message update", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const dependencies = {
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
      },
    };
    const completed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          status: "completed",
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );

    await finalizeSlackAgentStream({
      body: "Recovered final answer.",
      dependencies,
      run: completed,
    });

    expect(test.calls.at(-1)).toEqual({
      method: "update",
      payload: {
        channel: "C1",
        text: "Recovered final answer.",
        ts: "1721609601.000001",
      },
    });
    expect(streamRecord(test.memory)?.data.status).toBe("stopped");
  });

  test("fails closed after a stop request is rejected without removing the stream", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const dependencies = {
      ...test.dependencies,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        stop: async () => {
          throw new SlackAgentStreamApiError("chat.stopStream", 200, "restricted_action");
        },
      },
    };
    const completed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          status: "completed",
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );

    expect(
      finalizeSlackAgentStream({ body: "Final answer.", dependencies, run: completed }),
    ).rejects.toThrow("restricted_action");
    expect(streamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      status: "streaming",
    });
  });
});
