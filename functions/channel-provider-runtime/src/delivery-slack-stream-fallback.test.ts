import { describe, expect, test } from "bun:test";
import { handleChannelDelivery, sendSlackDelivery } from "./delivery.ts";
import {
  addStoppedSlackStream,
  fixture,
  persistedDelivery,
  timestamp,
} from "./delivery-test-support.ts";

describe("channel delivery worker", () => {
  test("rejects Slack API error envelopes even when HTTP succeeds", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ error: "invalid_auth", ok: false })) as unknown as typeof fetch;
    try {
      expect(sendSlackDelivery("bad-token", { channel: "C1", text: "Hello" })).rejects.toThrow(
        "invalid_auth",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("records a stopped Slack stream as sent without posting a duplicate message", async () => {
    const { dependencies, delivery, event, memory } = fixture(
      "queued",
      { channel: "C1", text: "Deployment complete.", thread_ts: "1721609600.123456" },
      "telegram",
    );
    const streamDelivery = {
      ...delivery,
      data: {
        ...delivery.data,
        channel: "slack",
        deliveryMode: "slack-stream-fallback" as const,
        provider: "slack_edge",
        slackStreamRunClaimedAt: timestamp,
      },
    };
    memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, streamDelivery);
    addStoppedSlackStream(memory, streamDelivery);
    let sends = 0;

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendSlack: async () => {
        sends += 1;
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(sends).toBe(0);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      providerMessageId: "1721609601.000001",
      status: "sent",
    });
  });

  test("does not credit a newer stopped stream for an obsolete fallback", async () => {
    const { dependencies, delivery, event, memory } = fixture(
      "queued",
      { channel: "C1", text: "Old fallback.", thread_ts: "1721609600.123456" },
      "telegram",
    );
    const streamDelivery = {
      ...delivery,
      data: {
        ...delivery.data,
        channel: "slack",
        deliveryMode: "slack-stream-fallback" as const,
        provider: "slack_edge",
        slackStreamRunClaimedAt: "2026-07-25T11:00:00.000Z",
      },
    };
    memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, streamDelivery);
    addStoppedSlackStream(memory, streamDelivery);
    let sends = 0;

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendSlack: async () => {
        sends += 1;
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(sends).toBe(0);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("obsolete"),
      status: "failed",
    });
  });

  test("suppresses fallback while the Slack stream outcome is ambiguous", async () => {
    const { dependencies, delivery, event, memory } = fixture(
      "queued",
      { channel: "C1", text: "Deployment complete.", thread_ts: "1721609600.123456" },
      "telegram",
    );
    const streamDelivery = {
      ...delivery,
      data: {
        ...delivery.data,
        channel: "slack",
        deliveryMode: "slack-stream-fallback" as const,
        provider: "slack_edge",
        slackStreamRunClaimedAt: timestamp,
      },
    };
    memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, streamDelivery);
    const stopped = addStoppedSlackStream(memory, streamDelivery);
    const ambiguous = {
      ...stopped,
      data: {
        ...stopped.data,
        fallbackAllowed: false,
        status: "failed" as const,
      },
    };
    memory.records.set(`execution\0${stopped.pk}\0${stopped.sk}`, ambiguous);
    let sends = 0;

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendSlack: async () => {
        sends += 1;
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(sends).toBe(0);
    expect(persistedDelivery(memory)?.data.status).toBe("queued");
  });

  test("fails closed when fallback stream evidence is missing", async () => {
    const { dependencies, delivery, event, memory } = fixture(
      "queued",
      { channel: "C1", text: "Fallback.", thread_ts: "1721609600.123456" },
      "telegram",
    );
    const streamDelivery = {
      ...delivery,
      data: {
        ...delivery.data,
        channel: "slack",
        deliveryMode: "slack-stream-fallback" as const,
        provider: "slack_edge",
        slackStreamRunClaimedAt: timestamp,
      },
    };
    memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, streamDelivery);
    let sends = 0;
    const finalReceiveEvent = {
      Records: event.Records.map((record) => ({
        ...record,
        attributes: { ApproximateReceiveCount: "4" },
      })),
    };

    const response = await handleChannelDelivery(finalReceiveEvent, {
      ...dependencies,
      sendSlack: async () => {
        sends += 1;
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(sends).toBe(0);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("evidence is unavailable"),
      status: "failed",
    });
  });

  test("fences fallback send against the exact failed stream generation", async () => {
    const { dependencies, delivery, event, memory } = fixture(
      "queued",
      { channel: "C1", text: "Deployment complete.", thread_ts: "1721609600.123456" },
      "telegram",
    );
    const streamDelivery = {
      ...delivery,
      data: {
        ...delivery.data,
        channel: "slack",
        deliveryMode: "slack-stream-fallback" as const,
        provider: "slack_edge",
        slackStreamRunClaimedAt: timestamp,
      },
    };
    memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, streamDelivery);
    const stopped = addStoppedSlackStream(memory, streamDelivery);
    const failed = {
      ...stopped,
      data: { ...stopped.data, fallbackAllowed: true, status: "failed" as const },
    };
    memory.records.set(`execution\0${stopped.pk}\0${stopped.sk}`, failed);

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendSlack: async () => ({ providerMessageId: "1721609602.000001" }),
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(
      memory.transactionInputs.some((operations) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "slack-agent-stream" &&
            operation.record.data.fallbackDeliveryId === streamDelivery.data.id &&
            operation.previousRecord?.itemType === "slack-agent-stream" &&
            operation.previousRecord.data.runClaimedAt ===
              streamDelivery.data.slackStreamRunClaimedAt,
        ),
      ),
    ).toBe(true);
    const persistedStream = [...memory.records.values()].find(
      (record) => record.itemType === "slack-agent-stream",
    );
    expect(persistedStream?.data).not.toHaveProperty("fallbackDeliveryId");
  });

  test("terminalizes an unresolved stream fallback at the normal receive limit", async () => {
    const { dependencies, delivery, event, memory } = fixture(
      "queued",
      { channel: "C1", text: "Deployment complete.", thread_ts: "1721609600.123456" },
      "telegram",
    );
    const streamDelivery = {
      ...delivery,
      data: {
        ...delivery.data,
        channel: "slack",
        deliveryMode: "slack-stream-fallback" as const,
        provider: "slack_edge",
        slackStreamRunClaimedAt: timestamp,
      },
    };
    memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, streamDelivery);
    const stopped = addStoppedSlackStream(memory, streamDelivery);
    const unresolved = {
      ...stopped,
      data: { ...stopped.data, fallbackAllowed: false, status: "failed" as const },
    };
    memory.records.set(`execution\0${stopped.pk}\0${stopped.sk}`, unresolved);
    let sends = 0;
    const finalReceiveEvent = {
      Records: event.Records.map((record) => ({
        ...record,
        attributes: { ApproximateReceiveCount: "4" },
      })),
    };

    const unresolvedResponse = await handleChannelDelivery(finalReceiveEvent, {
      ...dependencies,
      sendSlack: async () => {
        sends += 1;
        return {};
      },
    });

    expect(unresolvedResponse.batchItemFailures).toEqual([]);
    expect(sends).toBe(0);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("suppressed"),
      status: "failed",
    });
    expect(
      memory.transactionInputs.some((operations) =>
        operations.some(
          (operation) =>
            operation.kind === "condition-check" &&
            operation.key.sk === stopped.sk &&
            operation.expressionAttributeValues?.[":version"] === unresolved.data.version,
        ),
      ),
    ).toBe(true);
  });

  test("treats non-JSON Slack 5xx responses as ambiguous", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    try {
      const error = await sendSlackDelivery("token", { channel: "C1", text: "Hello" }).catch(
        (cause: unknown) => cause,
      );
      expect(error).toMatchObject({
        message: "Slack delivery failed with HTTP 503.",
        safeToRetry: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
