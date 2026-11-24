import { describe, expect, test } from "bun:test";

import { rcsMessageValue } from "./channel-validation.ts";
import { deliveryExternalChannelId, deliveryPayload } from "./channel-bindings.ts";
import type { Binding } from "./channel-validation.ts";

describe("RCS message validation", () => {
  test("accepts bounded JSON and rejects oversized or non-object messages", () => {
    expect(rcsMessageValue({ TimeToLive: 600 })).toEqual({ TimeToLive: 600 });
    expect(() => rcsMessageValue([])).toThrow("rcsMessage must be an object");
    const mediaUrl = `s3://bucket/${"x".repeat(1_980)}`;
    const card = {
      Description: "x".repeat(2_000),
      Media: { FileUrl: mediaUrl, ThumbnailUrl: mediaUrl },
      Suggestions: Array.from({ length: 4 }, () => ({
        Reply: { PostbackData: "x".repeat(2_048), Text: "Reply" },
      })),
      Title: "x".repeat(200),
    };
    expect(() =>
      rcsMessageValue({
        RcsMessageContent: {
          Content: {
            Carousel: {
              CardContents: Array.from({ length: 10 }, () => card),
              CardWidth: "MEDIUM",
            },
          },
        },
      }),
    ).toThrow("rcsMessage must not exceed");
  });

  test.each([
    { Context: { invalid: 1 } },
    { DryRun: "yes" },
    { FallbackConfiguration: { Channel: "EMAIL" } },
    {
      FallbackConfiguration: {
        Channel: "SMS",
        OriginationIdentity: "+16025550123",
      },
    },
    { FallbackConfiguration: { Channel: "SMS" } },
    {
      FallbackConfiguration: {
        Channel: "SMS",
        MediaUrls: ["s3://bucket/fallback.jpg"],
        MessageBody: "Fallback",
      },
    },
    { FallbackConfiguration: { Channel: "MMS" } },
    { FallbackConfiguration: { Channel: "MMS", MediaUrls: [] } },
    { RcsMessageContent: { Content: { FileMessage: {} } } },
    { RcsMessageContent: { Content: { RichCard: {} } } },
    { RcsMessageContent: { Content: { Carousel: {} } } },
    {
      RcsMessageContent: {
        Content: { TextMessage: { Body: "Hello" } },
        Suggestions: [{}],
      },
    },
    {
      RcsMessageContent: {
        Content: { TextMessage: { Body: "Hello" } },
        Suggestions: [
          {
            CreateCalendarEvent: {
              EndTime: "2027-02-30T11:00:00Z",
              PostbackData: "calendar:1",
              StartTime: "01/02/2027",
              Text: "Add",
              Title: "Invalid date",
            },
          },
        ],
      },
    },
  ])("rejects malformed provider options %#", (message) => {
    expect(() => rcsMessageValue(message)).toThrow("rcsMessage must contain valid JSON values");
  });
});

describe("AWS RCS delivery identity", () => {
  const binding = {
    data: {
      externalChannelId: "arn:aws:sms-voice:us-east-2:123456789012:rcs-agent/rcs-1",
      provider: "aws_end_user_messaging_rcs",
    },
  } as Binding;

  test("allows only the verified binding identity", () => {
    expect(deliveryExternalChannelId(binding, undefined)).toBe(binding.data.externalChannelId);
    expect(deliveryExternalChannelId(binding, binding.data.externalChannelId)).toBe(
      binding.data.externalChannelId,
    );
    expect(() => deliveryExternalChannelId(binding, "rcs-agent-2")).toThrow(
      "cannot override the binding-owned origination identity",
    );
  });

  test("maps invalid RCS payloads to client errors", () => {
    expect(() =>
      deliveryPayload(binding, "x".repeat(3_073), binding.data.externalChannelId, "+16025550123"),
    ).toThrow("RCS text body must not exceed 3072 characters");
    try {
      deliveryPayload(binding, "x".repeat(3_073), binding.data.externalChannelId, "+16025550123");
    } catch (cause) {
      expect(cause).toMatchObject({ code: "invalid_channel_payload", status: 400 });
    }
  });

  test("rejects RCS-only message options for Telegram", () => {
    const telegramBinding = {
      data: { provider: "telegram" },
    } as Binding;
    expect(() =>
      deliveryPayload(telegramBinding, "Hello", undefined, "telegram:chat:123", {
        TimeToLive: 600,
      }),
    ).toThrow("rcsMessage is available only for AWS End User Messaging RCS bindings");
  });
});

describe("Slack delivery identity", () => {
  const threadKey = "slack:T1:thread:C1:1721609600.123456";
  const slackBinding = (provider: string, metadata?: Readonly<Record<string, unknown>>) =>
    ({ data: { provider, ...(metadata ? { metadata } : {}) } }) as Binding;

  test("applies the binding's Slack agent identity to explicit deliveries", () => {
    expect(
      deliveryPayload(
        slackBinding("slack_edge", {
          slackAgentIdentity: { iconEmoji: ":mag:", username: " Rex " },
        }),
        "Hello",
        "C1",
        threadKey,
      ),
    ).toEqual({
      channel: "C1",
      icon_emoji: ":mag:",
      markdown_text: "Hello",
      thread_ts: "1721609600.123456",
      username: "Rex",
    });
    expect(
      deliveryPayload(
        slackBinding("slack_cloudflare_edge", {
          slackAgentIdentity: {
            iconUrl: "https://cdn.example.test/agents/rex.png",
            username: "Rex",
          },
        }),
        "Hello",
        "C1",
        threadKey,
      ),
    ).toEqual({
      channel: "C1",
      icon_url: "https://cdn.example.test/agents/rex.png",
      markdown_text: "Hello",
      thread_ts: "1721609600.123456",
      username: "Rex",
    });
    expect(deliveryPayload(slackBinding("slack_edge"), "Hello", "C1", threadKey)).toEqual({
      channel: "C1",
      markdown_text: "Hello",
      thread_ts: "1721609600.123456",
    });
  });

  test("bounds explicit Slack Markdown to Slack's 12,000-character limit", () => {
    const notice =
      "\n\n_Response truncated in Slack. Open Deployments.ai to view the complete result._";
    const binding = slackBinding("slack_edge");
    expect(deliveryPayload(binding, "é".repeat(12_000), "C1", threadKey)).toEqual({
      channel: "C1",
      markdown_text: "é".repeat(12_000),
      thread_ts: "1721609600.123456",
    });
    expect(deliveryPayload(binding, "é".repeat(12_001), "C1", threadKey)).toEqual({
      channel: "C1",
      markdown_text: `${"é".repeat(12_000 - notice.length)}${notice}`,
      thread_ts: "1721609600.123456",
    });
  });

  test("rejects explicit deliveries for bindings with invalid Slack identity metadata", () => {
    const binding = slackBinding("slack_edge", {
      slackAgentIdentity: { iconEmoji: "mag", username: "Rex" },
    });
    expect(() => deliveryPayload(binding, "Hello", "C1", threadKey)).toThrow(
      expect.objectContaining({ code: "binding_identity_invalid", status: 409 }),
    );
  });
});
