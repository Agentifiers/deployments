import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { expectedAlarmSlackMessage, recordedAlarmEvent } from "./cloudwatch-alarm-event.fixture.ts";
import { createOpsAlertsHandler } from "./index.ts";

interface ReceivedRequest {
  readonly authorization: string | null;
  readonly body: unknown;
  readonly contentType: string | null;
  readonly method: string;
  readonly path: string;
}

const servers: { stop(): unknown }[] = [];
afterAll(() => {
  for (const server of servers.splice(0)) server.stop();
});

function slackStub(reply: { readonly status: number; readonly body: unknown }) {
  const requests: ReceivedRequest[] = [];
  const server = Bun.serve({
    async fetch(request) {
      requests.push({
        authorization: request.headers.get("authorization"),
        body: await request.json(),
        contentType: request.headers.get("content-type"),
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return Response.json(reply.body, { status: reply.status });
    },
    port: 0,
  });
  servers.push(server);
  return { requests, slackApiBaseUrl: `http://127.0.0.1:${server.port}/api` };
}

function handlerFor(
  slackApiBaseUrl: string,
  overrides: Partial<{ channelId: string | undefined; loadBotToken: () => Promise<string> }> = {},
) {
  return createOpsAlertsHandler({
    channelId: "C0OPSALERTS",
    environment: "dev",
    loadBotToken: async () => "xoxb-test-token\n",
    slackApiBaseUrl,
    ...overrides,
  });
}

async function warningsDuring(run: () => Promise<void>) {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await run();
    return warn.mock.calls.map(([line]) => JSON.parse(String(line)));
  } finally {
    warn.mockRestore();
  }
}

describe("ops alerts handler", () => {
  test("posts the rendered alarm to chat.postMessage with the bot token", async () => {
    const slack = slackStub({ body: { channel: "C0OPSALERTS", ok: true }, status: 200 });

    await handlerFor(slack.slackApiBaseUrl)(recordedAlarmEvent);

    expect(slack.requests).toEqual([
      {
        authorization: "Bearer xoxb-test-token",
        body: expectedAlarmSlackMessage,
        contentType: "application/json; charset=utf-8",
        method: "POST",
        path: "/api/chat.postMessage",
      },
    ]);
  });

  test("warns and sends nothing when the Slack channel is unset", async () => {
    const slack = slackStub({ body: { ok: true }, status: 200 });
    const handler = handlerFor(slack.slackApiBaseUrl, {
      channelId: undefined,
      loadBotToken: () => Promise.reject(new Error("the bot token must not be read")),
    });

    expect(await warningsDuring(() => handler(recordedAlarmEvent))).toEqual([
      {
        environment: "dev",
        level: "warn",
        message: "Ops alert was not sent to Slack because the notifier is unconfigured.",
        reason: "slack-channel-unset",
      },
    ]);
    expect(slack.requests).toEqual([]);
  });

  test("warns and sends nothing while the bot token is the pending placeholder", async () => {
    const slack = slackStub({ body: { ok: true }, status: 200 });
    const handler = handlerFor(slack.slackApiBaseUrl, { loadBotToken: async () => "pending\n" });

    expect(await warningsDuring(() => handler(recordedAlarmEvent))).toEqual([
      {
        environment: "dev",
        level: "warn",
        message: "Ops alert was not sent to Slack because the notifier is unconfigured.",
        reason: "slack-bot-token-pending",
      },
    ]);
    expect(slack.requests).toEqual([]);
  });

  test("rejects with Slack's error code when Slack answers ok false", () => {
    const slack = slackStub({ body: { error: "channel_not_found", ok: false }, status: 200 });

    expect(handlerFor(slack.slackApiBaseUrl)(recordedAlarmEvent)).rejects.toThrow(
      "Slack chat.postMessage failed with channel_not_found.",
    );
  });

  test("rejects when Slack answers with a non-2xx status", () => {
    const slack = slackStub({ body: { error: "internal_error", ok: false }, status: 503 });

    expect(handlerFor(slack.slackApiBaseUrl)(recordedAlarmEvent)).rejects.toThrow(
      "Slack chat.postMessage returned HTTP 503.",
    );
  });

  test("rejects an event that SNS did not deliver", () => {
    expect(
      handlerFor("http://127.0.0.1:9/api")({ Records: [{ body: "{}", eventSource: "aws:sqs" }] }),
    ).rejects.toThrow("EventSource");
  });
});
