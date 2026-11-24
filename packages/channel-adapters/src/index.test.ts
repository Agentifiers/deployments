import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  channelProviderRequiresExternalWorkspacePin,
  channelProviderSupports,
  channelProviders,
  slackEventsApiActionFromRequest,
  telegramIngressRequestFromUpdate,
  telegramDeliveryParts,
} from "./index.ts";

describe("channel adapter registry", () => {
  test("registers AWS RCS, Slack, Teams, and Telegram without Fanvue", () => {
    expect(channelProviders("slack")).toEqual(["slack_edge", "slack_cloudflare_edge"]);
    expect(channelProviders("telegram")).toEqual(["telegram"]);
    expect(channelProviders("imessage")).toEqual([]);
    expect(channelProviders("sms")).toEqual([]);
    expect(channelProviders("rcs")).toEqual(["aws_end_user_messaging_rcs"]);
    expect(channelProviderSupports("rcs", "aws_end_user_messaging_rcs")).toBe(true);
    expect(channelProviders("teams")).toEqual(["teams_bot_framework"]);
    expect(channelProviderSupports("slack", "teams_bot_framework")).toBe(false);
    expect(channelProviderRequiresExternalWorkspacePin("teams_bot_framework")).toBe(true);
    expect(
      JSON.stringify({ slack: channelProviders("slack"), telegram: channelProviders("telegram") }),
    ).not.toContain("fanvue");
  });

  test("normalizes Telegram and Slack ingress", () => {
    const telegram = telegramIngressRequestFromUpdate(
      {
        update_id: 9,
        message: {
          chat: { id: 42 },
          from: { id: 7, username: "operator" },
          message_id: 11,
          text: "hello",
        },
      },
      { botId: "bot-1" },
    );
    expect(telegram).toMatchObject({
      channel: "telegram",
      externalThreadKey: "42",
      provider: "telegram",
    });

    expect(
      telegramIngressRequestFromUpdate(
        {
          edited_message: {
            chat: { id: 42 },
            from: { id: 7, username: "operator" },
            message_id: 11,
            text: "updated note",
          },
          update_id: 10,
        },
        { botId: "bot-1" },
      ),
    ).toMatchObject({ externalMessageId: "11:edit:10" });
    expect(
      telegramIngressRequestFromUpdate(
        {
          edited_message: {
            chat: { id: 42 },
            from: { id: 7 },
            message_id: 11,
            text: "updated note",
          },
        },
        { botId: "bot-1" },
      ),
    ).toBeUndefined();

    const body = JSON.stringify({
      api_app_id: "A1",
      event: {
        channel: "C1",
        event_ts: "1.2",
        files: [
          {
            id: "F1",
            mimetype: "image/jpeg",
            name: "photo.jpg",
            size: 1234,
            url_private: "https://files.slack.com/files-pri/photo.jpg",
          },
        ],
        text: "hello <!subteam^S123ABC|@rex> and <!subteam^S456DEF> then <!subteam^S123ABC>",
        ts: "1.2",
        type: "message",
        user: "U1",
      },
      event_id: "E1",
      team_id: "T1",
      type: "event_callback",
    });
    const signature = `v0=${createHmac("sha256", "secret").update(`v0:100:${body}`).digest("hex")}`;
    const slack = slackEventsApiActionFromRequest({
      nowSeconds: 100,
      rawBody: body,
      signature,
      signingSecret: "secret",
      timestamp: "100",
    });
    expect(slack.type).toBe("message");
    if (slack.type === "message") {
      expect(slack.request).toMatchObject({
        attachments: [
          {
            byteSize: 1234,
            contentType: "image/jpeg",
            fileName: "photo.jpg",
            kind: "image",
            providerAttachmentId: "F1",
            url: "https://files.slack.com/files-pri/photo.jpg",
          },
        ],
        channel: "slack",
        externalWorkspaceId: "T1",
        metadata: {
          messageTs: "1.2",
          slackUserGroupMentionIds: ["S123ABC", "S456DEF"],
        },
        provider: "slack_edge",
      });
    }
    const cloudflareBody = JSON.stringify({
      event: { channel: "C1", text: "hello", ts: "1.3", type: "message", user: "U1" },
      event_id: "E2",
      team_id: "T1",
      type: "event_callback",
    });
    const cloudflareSignature = `v0=${createHmac("sha256", "secret").update(`v0:100:${cloudflareBody}`).digest("hex")}`;
    const cloudflare = slackEventsApiActionFromRequest({
      nowSeconds: 100,
      provider: "slack_cloudflare_edge",
      rawBody: cloudflareBody,
      signature: cloudflareSignature,
      signingSecret: "secret",
      timestamp: "100",
    });
    expect(cloudflare.type).toBe("message");
    if (cloudflare.type === "message") {
      expect(cloudflare.request.provider).toBe("slack_cloudflare_edge");
    }
  });

  test("anchors Slack replies to the thread root, or to a root message itself", () => {
    const ingress = (event: Record<string, unknown>) => {
      const rawBody = JSON.stringify({
        event: { text: "hello", type: "message", user: "U1", ...event },
        event_id: "E1",
        team_id: "T1",
        type: "event_callback",
      });
      const signature = `v0=${createHmac("sha256", "secret").update(`v0:100:${rawBody}`).digest("hex")}`;
      const action = slackEventsApiActionFromRequest({
        nowSeconds: 100,
        rawBody,
        signature,
        signingSecret: "secret",
        timestamp: "100",
      });
      if (action.type !== "message") throw new Error("Expected a Slack message action.");
      return {
        externalThreadKey: action.request.externalThreadKey,
        messageTs: action.request.metadata?.messageTs,
      };
    };

    expect(ingress({ channel: "C1", channel_type: "channel", ts: "1.2" })).toEqual({
      externalThreadKey: "slack:T1:thread:C1:1.2",
      messageTs: "1.2",
    });
    expect(
      ingress({ channel: "C1", channel_type: "channel", thread_ts: "1.2", ts: "1.5" }),
    ).toEqual({ externalThreadKey: "slack:T1:thread:C1:1.2", messageTs: "1.2" });
    // A direct-message root continues the DM conversation, but Slack streams must still reply in a
    // thread under a real message, so the stream anchors to the root message's own ts.
    expect(ingress({ channel: "D1", channel_type: "im", ts: "1.7" })).toEqual({
      externalThreadKey: "slack:T1:thread:D1",
      messageTs: "1.7",
    });
    expect(ingress({ channel: "D1", channel_type: "im", thread_ts: "1.7", ts: "1.9" })).toEqual({
      externalThreadKey: "slack:T1:thread:D1:1.7",
      messageTs: "1.7",
    });
  });

  test("rejects an empty Telegram text delivery", () => {
    expect(() => telegramDeliveryParts({ content: "  ", hasImage: false })).toThrow(
      "text or an image",
    );
  });
});
