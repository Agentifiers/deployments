import { describe, expect, test } from "bun:test";

import { handleChannelDelivery } from "./delivery.ts";
import {
  TEAMS_APP_ID,
  TEAMS_CONVERSATION_ID,
  finalReceive,
  teamsDeliveryFixture,
  teamsPayload,
} from "./delivery-teams-test-support.ts";
import { persistedDelivery } from "./delivery-test-support.ts";

const activitiesUrl = `${teamsPayload.serviceUrl}v3/conversations/${encodeURIComponent(
  TEAMS_CONVERSATION_ID,
)}/activities`;

describe("Teams channel delivery", () => {
  test("posts the stored payload through Bot Connector with the binding's bot token", async () => {
    const { connector, dependencies, event, memory } = teamsDeliveryFixture();

    const response = await handleChannelDelivery(event, dependencies);

    expect(response.batchItemFailures).toEqual([]);
    const [tokenRequest, activityRequest] = connector.requests;
    expect(tokenRequest).toMatchObject({
      method: "POST",
      url: "https://login.microsoftonline.com/home-tenant/oauth2/v2.0/token",
    });
    expect(Object.fromEntries(new URLSearchParams(tokenRequest?.body))).toEqual({
      client_id: TEAMS_APP_ID,
      client_secret: "app-password",
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    });
    expect(activityRequest).toMatchObject({
      authorization: "Bearer bot-token",
      method: "POST",
      url: activitiesUrl,
    });
    expect(JSON.parse(activityRequest?.body ?? "")).toEqual({
      text: teamsPayload.text,
      textFormat: "markdown",
      type: "message",
    });
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      providerMessageId: "activity-1",
      status: "sent",
    });
  });

  test("requeues a throttled post and sends it once Teams accepts", async () => {
    const { connector, dependencies, event, memory } = teamsDeliveryFixture();
    connector.queued.activity.push(() =>
      Response.json({ error: { code: "Throttled" } }, { status: 429 }),
    );

    const throttled = await handleChannelDelivery(event, dependencies);

    expect(throttled.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("HTTP 429"),
      status: "queued",
    });

    expect(await handleChannelDelivery(event, dependencies)).toEqual({ batchItemFailures: [] });
    expect(connector.activityRequests()).toHaveLength(2);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 2,
      providerMessageId: "activity-1",
      status: "sent",
    });
  });

  test("requeues bot token outages because no activity was posted", async () => {
    const { connector, dependencies, event, memory } = teamsDeliveryFixture();
    connector.queued.token.push(() => new Response("unavailable", { status: 503 }));

    const response = await handleChannelDelivery(event, dependencies);

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(connector.activityRequests()).toEqual([]);
    expect(persistedDelivery(memory)?.data.status).toBe("queued");
  });

  test("requeues token transport failures before the activity post", async () => {
    const { connector, dependencies, event, memory } = teamsDeliveryFixture();
    connector.queued.token.push(() => {
      throw new TypeError("network unreachable");
    });

    const response = await handleChannelDelivery(event, dependencies);

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(connector.activityRequests()).toEqual([]);
    expect(persistedDelivery(memory)?.data.status).toBe("queued");
  });

  for (const [label, respond] of [
    ["HTTP 503", () => new Response("", { status: 503 })],
    [
      "a transport failure",
      () => {
        throw new TypeError("socket hang up");
      },
    ],
  ] as const) {
    test(`does not replay an ambiguous post that failed with ${label}`, async () => {
      const { connector, dependencies, event, memory } = teamsDeliveryFixture();
      connector.queued.activity.push(respond);

      expect(await handleChannelDelivery(event, dependencies)).toEqual({ batchItemFailures: [] });
      expect(await handleChannelDelivery(event, dependencies)).toEqual({ batchItemFailures: [] });

      expect(connector.activityRequests()).toHaveLength(1);
      expect(persistedDelivery(memory)?.data).toMatchObject({ attempts: 1, status: "failed" });
    });
  }

  test("fails a definitively rejected post without retrying", async () => {
    const { connector, dependencies, event, memory } = teamsDeliveryFixture();
    connector.queued.activity.push(() =>
      Response.json({ error: { code: "BotNotInConversationRoster" } }, { status: 403 }),
    );

    const response = await handleChannelDelivery(event, dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("BotNotInConversationRoster"),
      status: "failed",
    });
  });

  test("fails a delivery whose bot credentials are rejected by the token endpoint", async () => {
    const { connector, dependencies, event, memory } = teamsDeliveryFixture();
    connector.queued.token.push(() => Response.json({ error: "invalid_client" }, { status: 401 }));

    const response = await handleChannelDelivery(event, dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(connector.activityRequests()).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("invalid_client"),
      status: "failed",
    });
  });

  test("terminalizes throttling on the final receive", async () => {
    const { connector, dependencies, event, memory } = teamsDeliveryFixture();
    connector.queued.activity.push(() => new Response("", { status: 429 }));

    const response = await handleChannelDelivery(finalReceive(event), dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("HTTP 429"),
      status: "failed",
    });
  });

  test("rejects stored payloads aimed outside the Teams connector before posting", async () => {
    const { connector, dependencies, event, memory } = teamsDeliveryFixture({
      providerPayload: { ...teamsPayload, serviceUrl: "https://attacker.example/" },
    });

    const response = await handleChannelDelivery(finalReceive(event), dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(connector.requests).toEqual([]);
    expect(persistedDelivery(memory)?.data.status).toBe("failed");
  });
});
