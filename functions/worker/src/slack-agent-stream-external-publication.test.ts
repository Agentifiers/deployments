import { describe, expect, test } from "bun:test";
import { RunRecord, withCanonicalRecordKeys, type PlatformRecord } from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { slackFixture, streamRecord } from "./slack-agent-stream.fixture.ts";
import {
  SlackAgentStreamApiError,
  ensureSlackAgentStream,
  finalizeSlackAgentStream,
} from "./slack-agent-stream.ts";

type Delivery = Extract<PlatformRecord, { readonly itemType: "channel-delivery" }>;

const identity = {
  slackAgentIdentity: { iconUrl: "https://cdn.example.test/agents/rex.png", username: "Rex" },
};

function records<ItemType extends PlatformRecord["itemType"]>(
  memory: { readonly records: ReadonlyMap<string, PlatformRecord> },
  itemType: ItemType,
) {
  return [...memory.records.values()].filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: ItemType }> =>
      record.itemType === itemType,
  );
}

describe("Slack streaming for externally published channel responses", () => {
  test("streams the run and hands the stopped stream to confirmed publication", async () => {
    const test = slackFixture({ bindingMetadata: identity, externalPublication: true });

    const result = await processAgentRun(test.queue, test.dependencies);

    expect(result.action).toBe("completed");
    expect(test.calls[0]).toMatchObject({
      method: "start",
      payload: {
        channel: "C1",
        icon_url: "https://cdn.example.test/agents/rex.png",
        recipient_team_id: "T1",
        recipient_user_id: "U1",
        thread_ts: "1721609600.123456",
        username: "Rex",
      },
    });
    expect(test.calls.at(-2)).toMatchObject({
      method: "stop",
      payload: {
        chunks: [{ text: "Persisted assistant result.", type: "markdown_text" }],
        ts: "1721609601.000001",
      },
    });
    expect(streamRecord(test.memory)?.data).toMatchObject({
      status: "stopped",
      streamTs: "1721609601.000001",
    });
    const [assistant] = records(test.memory, "message").filter(
      (message) => message.data.role === "assistant",
    );
    const deliveries: Delivery[] = records(test.memory, "channel-delivery");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      deliveryMode: "slack-stream-fallback",
      publicationContent: "Persisted assistant result.",
      responsePublication: "external",
      routeId: "a".repeat(64),
      slackStreamRunClaimedAt: streamRecord(test.memory)?.data.runClaimedAt,
      sourceMessageId: assistant?.data.id,
      sourceMessageSequence: assistant?.data.sequence,
      status: "queued",
      throughSequence: 0,
    });
    // History publication waits for the delivery worker to observe the stopped stream.
    expect(records(test.memory, "message-publication")).toEqual([]);
  });

  test("queues one identity-aware fallback when the stream cannot start", async () => {
    const test = slackFixture({ bindingMetadata: identity, externalPublication: true });
    const dependencies = {
      ...test.dependencies,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        start: async (_token: string, payload: unknown) => {
          test.calls.push({ method: "start", payload });
          throw new SlackAgentStreamApiError("chat.startStream", 200, "channel_type_not_supported");
        },
      },
    };

    const result = await processAgentRun(test.queue, dependencies);

    expect(result.action).toBe("completed");
    expect(test.calls.map((call) => call.method)).toEqual(["start"]);
    expect(streamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: true,
      status: "failed",
    });
    const deliveries: Delivery[] = records(test.memory, "channel-delivery");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      deliveryMode: "slack-stream-fallback",
      providerPayload: {
        channel: "C1",
        icon_url: "https://cdn.example.test/agents/rex.png",
        markdown_text: "Persisted assistant result.",
        thread_ts: "1721609600.123456",
        username: "Rex",
      },
      publicationContent: "Persisted assistant result.",
      responsePublication: "external",
      status: "queued",
    });
  });

  test("bounds a long fallback post to Slack's limit while publishing the complete result", async () => {
    const notice =
      "\n\n_Response truncated in Slack. Open Deployments.ai to view the complete result._";
    const assistantBody = "é".repeat(12_001);
    const test = slackFixture({ externalPublication: true });
    const dependencies = {
      ...test.dependencies,
      runtime: { generateAssistantMessage: async () => ({ assistantMessage: assistantBody }) },
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        start: async () => {
          throw new SlackAgentStreamApiError("chat.startStream", 200, "channel_type_not_supported");
        },
      },
    };

    expect(processAgentRun(test.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    const deliveries: Delivery[] = records(test.memory, "channel-delivery");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      deliveryMode: "slack-stream-fallback",
      providerPayload: {
        channel: "C1",
        markdown_text: `${"é".repeat(12_000 - notice.length)}${notice}`,
        thread_ts: "1721609600.123456",
      },
      publicationContent: assistantBody,
      status: "queued",
    });
  });

  test("delivers a failed run's fallback notice without publishing it to history", async () => {
    const test = slackFixture({ externalPublication: true });
    const dependencies = {
      ...test.dependencies,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        start: async () => {
          throw new SlackAgentStreamApiError("chat.startStream", 200, "channel_type_not_supported");
        },
      },
    };
    await ensureSlackAgentStream(dependencies, test.run, test.userMessage);
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

    await finalizeSlackAgentStream({ dependencies, run: failed });

    const deliveries: Delivery[] = records(test.memory, "channel-delivery");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      deliveryMode: "slack-stream-fallback",
      providerPayload: { markdown_text: "Agent run failed." },
      status: "queued",
    });
    expect(deliveries[0]?.data).not.toHaveProperty("responsePublication");
    expect(deliveries[0]?.data).not.toHaveProperty("publicationContent");
  });
});
