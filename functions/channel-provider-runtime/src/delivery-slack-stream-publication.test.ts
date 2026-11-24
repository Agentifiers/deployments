import { describe, expect, test } from "bun:test";
import {
  ChannelDeliveryRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { handleChannelDelivery } from "./delivery.ts";
import {
  addStoppedSlackStream,
  fixture,
  persistedDelivery,
  timestamp,
} from "./delivery-test-support.ts";

type SlackStream = Extract<PlatformRecord, { readonly itemType: "slack-agent-stream" }>;

const fallbackPayload = {
  channel: "C1",
  icon_url: "https://cdn.example.test/agents/rex.png",
  text: "A concise current reply.",
  thread_ts: "1721609600.123456",
  username: "Rex",
};

function externalStreamFixture(
  stream: Partial<Pick<SlackStream["data"], "fallbackAllowed" | "status">> = {},
  dispatch: "current" | "superseded" = "current",
) {
  const test = fixture("queued", fallbackPayload, "telegram");
  const delivery = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
    withCanonicalRecordKeys({
      ...test.delivery,
      data: {
        ...test.delivery.data,
        channel: "slack",
        deliveryMode: "slack-stream-fallback",
        provider: "slack_edge",
        publicationContent: "A concise current reply.",
        responsePublication: "external",
        routeId: "a".repeat(64),
        slackStreamRunClaimedAt: timestamp,
        sourceMessageId: test.delivery.data.runId,
        sourceMessageSequence: 4,
        throughSequence: 2,
      },
    }),
  );
  test.memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, delivery);
  const stopped = addStoppedSlackStream(test.memory, delivery);
  test.memory.records.set(`execution\0${stopped.pk}\0${stopped.sk}`, {
    ...stopped,
    data: { ...stopped.data, ...stream },
  });
  const calls: string[] = [];
  const sent: unknown[] = [];
  const dependencies = {
    ...test.dependencies,
    externalPublication: {
      publish: async () =>
        void calls.push(`publish:${persistedDelivery(test.memory)?.data.status}`),
      release: async () => void calls.push("release"),
      reserve: async () => {
        calls.push("reserve");
        return "reserved" as const;
      },
    },
    ingressDispatch: {
      assess: async () => {
        calls.push("fence");
        return dispatch === "superseded"
          ? { kind: "superseded" as const }
          : {
              condition: {
                conditionExpression: "attribute_exists(pk)",
                key: { pk: delivery.pk, sk: delivery.sk },
                kind: "condition-check" as const,
                table: "execution" as const,
              },
              kind: "current" as const,
            };
      },
    },
    readCredential: async () => ({ accessToken: "xoxb-token" }),
    sendSlack: async (_token: string, payload: unknown) => {
      calls.push("send");
      sent.push(payload);
      return { providerMessageId: "1721609602.000001" };
    },
  };
  return { ...test, calls, delivery, dependencies, sent };
}

describe("externally published Slack stream deliveries", () => {
  test("publishes a stopped stream's response as confirmed without posting again", async () => {
    const { calls, dependencies, event, memory, sent } = externalStreamFixture();

    const response = await handleChannelDelivery(event, dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(calls).toEqual(["reserve", "fence", "publish:sent"]);
    expect(sent).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      providerMessageId: "1721609601.000001",
      status: "sent",
    });
  });

  test("keeps a superseded streamed response out of history", async () => {
    const { calls, dependencies, event, memory } = externalStreamFixture({}, "superseded");

    const response = await handleChannelDelivery(event, dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(calls).toEqual(["reserve", "fence", "release"]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("superseded"),
      status: "failed",
    });
  });

  test("posts exactly one identity-aware fallback and publishes it on confirmation", async () => {
    const { calls, dependencies, event, memory, sent } = externalStreamFixture({
      fallbackAllowed: true,
      status: "failed",
    });

    expect(await handleChannelDelivery(event, dependencies)).toEqual({ batchItemFailures: [] });
    expect(await handleChannelDelivery(event, dependencies)).toEqual({ batchItemFailures: [] });

    expect(calls).toEqual(["reserve", "fence", "send", "publish:sent", "publish:sent"]);
    expect(sent).toEqual([fallbackPayload]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      providerMessageId: "1721609602.000001",
      status: "sent",
    });
  });

  test("does not hold the publication barrier while the stream outcome is unresolved", async () => {
    const { calls, dependencies, event, memory, sent } = externalStreamFixture({
      status: "streaming",
    });

    expect(await handleChannelDelivery(event, dependencies)).toEqual({
      batchItemFailures: [{ itemIdentifier: "queue-message-1" }],
    });
    expect(calls).toEqual([]);

    const finalReceive = {
      Records: event.Records.map((record) => ({
        ...record,
        attributes: { ApproximateReceiveCount: "4" },
      })),
    };
    expect(await handleChannelDelivery(finalReceive, dependencies)).toEqual({
      batchItemFailures: [],
    });
    expect(calls).toEqual(["release"]);
    expect(sent).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: "Slack agent stream outcome is unknown; fallback delivery was suppressed.",
      status: "failed",
    });
  });
});
