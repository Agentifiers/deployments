import { describe, expect, test } from "bun:test";

import {
  awsRcsCommandInput,
  awsRcsDeliveryPayload,
  awsRcsIngressRequestFromNotification,
  signAwsRcsIngress,
  sendAwsRcsDelivery,
  verifyAwsRcsIngressSignature,
} from "./index.ts";

describe("AWS End User Messaging RCS adapter", () => {
  test("builds a binding-routed text delivery", () => {
    expect(
      awsRcsDeliveryPayload({
        content: "Your appointment is confirmed.",
        destination: "rcs:thread:+16025550123",
        originationIdentity: "arn:aws:sms-voice:us-east-2:123456789012:rcs-agent/rcs-123",
      }),
    ).toEqual({
      DestinationPhoneNumber: "+16025550123",
      OriginationIdentity: "arn:aws:sms-voice:us-east-2:123456789012:rcs-agent/rcs-123",
      RcsMessageContent: {
        Content: { TextMessage: { Body: "Your appointment is confirmed." } },
      },
    });
  });

  test("accepts rich options without allowing routing overrides", () => {
    const payload = awsRcsDeliveryPayload({
      content: "fallback text",
      destination: "+16025550123",
      message: {
        RcsMessageContent: {
          Content: {
            RichCard: {
              CardContent: { Description: "Choose a time", Title: "Appointment" },
              CardOrientation: "VERTICAL",
            },
          },
        },
        TimeToLive: 600,
      },
      originationIdentity: "rcs-agent-1",
    });
    expect(payload).toMatchObject({
      DestinationPhoneNumber: "+16025550123",
      RcsMessageContent: { Content: { RichCard: expect.any(Object) } },
      TimeToLive: 600,
    });
    expect(() =>
      awsRcsDeliveryPayload({
        content: "hello",
        destination: "+16025550123",
        message: { DestinationPhoneNumber: "+16025550999" },
        originationIdentity: "rcs-agent-1",
      }),
    ).toThrow("cannot override binding-owned routing identities");
    expect(() =>
      awsRcsDeliveryPayload({
        content: "hello",
        destination: "+16025550123",
        message: {
          FallbackConfiguration: {
            Channel: "SMS",
            MessageBody: "hello",
            OriginationIdentity: "+16025550999",
          },
        },
        originationIdentity: "pool-1",
      }),
    ).toThrow("fallback cannot override the binding-owned pool origination identity");
    expect(() =>
      awsRcsDeliveryPayload({
        content: "hello",
        destination: "+16025550123",
        message: { FallbackConfiguration: { Channel: "SMS" } },
        originationIdentity: "pool-1",
      }),
    ).toThrow("SMS fallback message body");
    expect(() =>
      awsRcsDeliveryPayload({
        content: "hello",
        destination: "+16025550123",
        message: {
          FallbackConfiguration: {
            Channel: "SMS",
            MediaUrls: ["s3://bucket/fallback.jpg"],
            MessageBody: "Fallback",
          },
        },
        originationIdentity: "pool-1",
      }),
    ).toThrow("SMS fallback cannot include media URLs");
    expect(() =>
      awsRcsDeliveryPayload({
        content: "hello",
        destination: "+16025550123",
        message: { FallbackConfiguration: { Channel: "MMS" } },
        originationIdentity: "pool-1",
      }),
    ).toThrow("MMS fallback requires a message body or at least one media URL");
    expect(() =>
      awsRcsDeliveryPayload({
        content: "hello",
        destination: "+16025550123",
        message: { RcsMessageContent: { Content: { RichCard: {} } } },
        originationIdentity: "rcs-agent-1",
      }),
    ).toThrow("do not match the AWS RCS contract");
    expect(() =>
      awsRcsDeliveryPayload({
        content: "x".repeat(3_073),
        destination: "+16025550123",
        originationIdentity: "rcs-agent-1",
      }),
    ).toThrow("must not exceed 3072 characters");
  });

  test("revives calendar timestamps only when dispatching", () => {
    const command = awsRcsCommandInput({
      Context: { EndTime: "leave-as-text", StartTime: "also-text" },
      DestinationPhoneNumber: "+16025550123",
      OriginationIdentity: "rcs-agent-1",
      RcsMessageContent: {
        Content: { TextMessage: { Body: "Add this event" } },
        Suggestions: [
          {
            CreateCalendarEvent: {
              EndTime: "2026-08-02T18:00:00.000Z",
              PostbackData: "calendar:1",
              StartTime: "2026-08-02T17:00:00.000Z",
              Text: "Add",
              Title: "Demo",
            },
          },
        ],
      },
    });
    const action = command.RcsMessageContent?.Suggestions?.[0]?.CreateCalendarEvent;
    expect(action?.StartTime).toBeInstanceOf(Date);
    expect(action?.EndTime).toBeInstanceOf(Date);
    expect(command.Context).toEqual({ EndTime: "leave-as-text", StartTime: "also-text" });
  });

  test("normalizes inbound text and suggestion events", () => {
    expect(
      awsRcsIngressRequestFromNotification({
        deploymentsAiOriginationIdentity:
          "arn:aws:sms-voice:us-east-2:123456789012:rcs-agent/agent-1",
        deploymentsAiEventType: "TEXT",
        destinationNumber: "rcs-agent-1",
        inboundMessageId: "message-1",
        messageBody: "Hello",
        originationNumber: "+16025550123",
        previousPublishedMessageId: "outbound-1",
      }),
    ).toMatchObject({
      channel: "rcs",
      content: "Hello",
      externalChannelId: "arn:aws:sms-voice:us-east-2:123456789012:rcs-agent/agent-1",
      externalThreadKey: "+16025550123",
      metadata: {
        awsRcsNotification: {
          destinationNumber: "rcs-agent-1",
          previousPublishedMessageId: "outbound-1",
        },
      },
      provider: "aws_end_user_messaging_rcs",
    });
    expect(
      awsRcsIngressRequestFromNotification({
        deploymentsAiEventType: "SUGGESTION",
        destinationNumber: "rcs-agent-1",
        inboundMessageId: "message-2",
        messageBody: JSON.stringify({
          postbackData: "action:confirm:1",
          text: "Confirm",
        }),
        originationNumber: "+16025550123",
      }),
    ).toMatchObject({
      content: "Confirm",
      metadata: { awsRcs: { eventType: "SUGGESTION" } },
    });
    expect(
      awsRcsIngressRequestFromNotification({
        deploymentsAiEventType: "TEXT",
        destinationNumber: "rcs-agent-1",
        inboundMessageId: "message-3",
        messageBody: '{"type":"RCS_TYPING"}',
        originationNumber: "+16025550123",
      }),
    ).toMatchObject({ content: '{"type":"RCS_TYPING"}' });
    expect(
      awsRcsIngressRequestFromNotification({
        deploymentsAiEventType: "MEDIA",
        destinationNumber: "rcs-agent-1",
        inboundMessageId: "message-4",
        messageBody: JSON.stringify({
          fileName: "photo.jpg",
          mediaStatus: "SUCCESS",
          mimeType: "image/jpeg",
          s3Bucket: "vertical-rcs-media",
          s3Key: "inbound/photo.jpg",
        }),
        originationNumber: "+16025550123",
      }),
    ).toMatchObject({
      attachments: [
        {
          contentType: "image/jpeg",
          fileName: "photo.jpg",
          kind: "image",
          url: "s3://vertical-rcs-media/inbound/photo.jpg",
        },
      ],
      metadata: {
        awsRcs: {
          bucket: "vertical-rcs-media",
          eventType: "MEDIA",
          objectKey: "inbound/photo.jpg",
        },
      },
    });
    expect(
      awsRcsIngressRequestFromNotification({
        deploymentsAiEventType: "RCS_TYPING",
      }),
    ).toBeUndefined();
  });

  test("signs forwarded SNS notifications with replay protection", () => {
    const body = JSON.stringify({ messageBody: "hello" });
    const signed = signAwsRcsIngress({ body, secret: "secret", timestamp: "100" });
    expect(
      verifyAwsRcsIngressSignature({
        body,
        nowSeconds: 100,
        secret: "secret",
        signature: signed,
        timestamp: "100",
      }),
    ).toBe(true);
    expect(
      verifyAwsRcsIngressSignature({
        body,
        nowSeconds: 401,
        secret: "secret",
        signature: signed,
        timestamp: "100",
      }),
    ).toBe(false);
  });

  test("disables SDK retries for non-idempotent sends", async () => {
    let maxAttempts: number | undefined;
    const result = await sendAwsRcsDelivery(
      {
        credentials: { accessKeyId: "key", secretAccessKey: "secret", sessionToken: "token" },
        region: "us-east-2",
      },
      {
        DestinationPhoneNumber: "+16025550123",
        OriginationIdentity: "rcs-agent-1",
        RcsMessageContent: { Content: { TextMessage: { Body: "Hello" } } },
      },
      {
        createClient: (options) => {
          maxAttempts = options.maxAttempts;
          return { send: async () => ({ MessageId: "message-1" }) };
        },
      },
    );
    expect(maxAttempts).toBe(1);
    expect(result).toEqual({ providerMessageId: "message-1" });
  });
});
