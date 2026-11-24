import type { SendRcsMessageCommandInput } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { decodeAwsRcsMessage } from "@deployments-ai/api-contract/runtime";

import {
  asRecord,
  externalThreadTarget,
  readString,
  type ChannelMessageIngressRequest,
} from "../../shared/core.ts";

export const AWS_RCS_PROVIDER = "aws_end_user_messaging_rcs" as const;

export type AwsRcsDeliveryPayload = SendRcsMessageCommandInput;

export interface AwsRcsClientOptions {
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken: string;
  };
  readonly region: string;
}

const TOP_LEVEL_FIELDS = new Set([
  "ConfigurationSetName",
  "Context",
  "DestinationPhoneNumber",
  "DryRun",
  "FallbackConfiguration",
  "MaxPrice",
  "MessageFeedbackEnabled",
  "MessageTrafficType",
  "OriginationIdentity",
  "ProtectConfigurationId",
  "RcsMessageContent",
  "TimeToLive",
]);

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required.`);
  return value.trim();
}

function jsonObject(value: unknown, label: string) {
  const record = asRecord(value);
  if (!record) throw new TypeError(`${label} must be an object.`);
  return record;
}

function reviveCalendarTimestamps(value: unknown, calendarEvent = false): unknown {
  if (Array.isArray(value))
    return value.map((entry) => reviveCalendarTimestamps(entry, calendarEvent));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (calendarEvent && (key === "StartTime" || key === "EndTime")) {
        if (entry instanceof Date && Number.isFinite(entry.getTime())) return [key, entry];
        const timestamp = typeof entry === "string" ? Date.parse(entry) : Number.NaN;
        if (!Number.isFinite(timestamp)) throw new TypeError(`${key} must be an ISO timestamp.`);
        return [key, new Date(timestamp)];
      }
      return [key, reviveCalendarTimestamps(entry, key === "CreateCalendarEvent")];
    }),
  );
}

function validateMessageContent(value: unknown) {
  const message = jsonObject(value, "RcsMessageContent");
  const content = jsonObject(message.Content, "RcsMessageContent.Content");
  const selected = ["TextMessage", "FileMessage", "RichCard", "Carousel"].filter(
    (key) => content[key] !== undefined,
  );
  if (selected.length !== 1) {
    throw new TypeError("RcsMessageContent.Content must contain exactly one content type.");
  }
  if (selected[0] === "TextMessage") {
    const body = requiredText(
      jsonObject(content.TextMessage, "RcsMessageContent.Content.TextMessage").Body,
      "RCS text body",
    );
    if (Array.from(body).length > 3_072) {
      throw new TypeError("RCS text body must not exceed 3072 characters.");
    }
  }
  if (message.Suggestions !== undefined) {
    if (!Array.isArray(message.Suggestions) || message.Suggestions.length > 11) {
      throw new TypeError("RCS message suggestions must be an array of at most 11 actions.");
    }
  }
}

function validateTimeToLive(value: unknown) {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 172_800)
  ) {
    throw new TypeError("TimeToLive must be an integer between 1 and 172800 seconds.");
  }
}

function validateFallbackConfiguration(value: unknown) {
  if (value === undefined) return;
  const fallback = jsonObject(value, "FallbackConfiguration");
  if ("OriginationIdentity" in fallback) {
    throw new TypeError(
      "RCS fallback cannot override the binding-owned pool origination identity.",
    );
  }
  const channel = requiredText(fallback.Channel, "RCS fallback channel");
  const messageBody = fallback.MessageBody;
  const mediaUrls = fallback.MediaUrls;
  if (channel === "SMS") {
    requiredText(messageBody, "RCS SMS fallback message body");
    if (mediaUrls !== undefined) {
      throw new TypeError("RCS SMS fallback cannot include media URLs.");
    }
    return;
  }
  if (channel !== "MMS") {
    throw new TypeError("RCS fallback channel must be SMS or MMS.");
  }
  const hasMessageBody = typeof messageBody === "string" && Boolean(messageBody.trim());
  const hasMedia = Array.isArray(mediaUrls) && mediaUrls.length > 0;
  if (!hasMessageBody && !hasMedia) {
    throw new TypeError("RCS MMS fallback requires a message body or at least one media URL.");
  }
}

export function awsRcsDeliveryPayload(args: {
  readonly content: string;
  readonly destination: string;
  readonly message?: Readonly<Record<string, unknown>> | undefined;
  readonly originationIdentity: string;
}): AwsRcsDeliveryPayload {
  const destination = externalThreadTarget(requiredText(args.destination, "RCS destination"));
  if (!/^\+[1-9]\d{7,14}$/u.test(destination)) {
    throw new TypeError("RCS destination must be an E.164 phone number.");
  }
  const originationIdentity = requiredText(args.originationIdentity, "RCS origination identity");
  const rawMessage = args.message ?? {};
  if ("DestinationPhoneNumber" in rawMessage || "OriginationIdentity" in rawMessage) {
    throw new TypeError("RCS message options cannot override binding-owned routing identities.");
  }
  validateFallbackConfiguration(rawMessage.FallbackConfiguration);
  const unknownFields = Object.keys(rawMessage).filter((key) => !TOP_LEVEL_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new TypeError(
      `RCS message options contain unsupported fields: ${unknownFields.join(", ")}.`,
    );
  }
  const message = decodeAwsRcsMessage(rawMessage);
  const fallbackContent = {
    Content: { TextMessage: { Body: requiredText(args.content, "RCS message content") } },
  };
  const payload = {
    ...message,
    DestinationPhoneNumber: destination,
    OriginationIdentity: originationIdentity,
    RcsMessageContent: message.RcsMessageContent ?? fallbackContent,
  };
  validateMessageContent(payload.RcsMessageContent);
  validateFallbackConfiguration(message.FallbackConfiguration);
  validateTimeToLive(message.TimeToLive);
  return payload as AwsRcsDeliveryPayload;
}

export function awsRcsCommandInput(payload: unknown): AwsRcsDeliveryPayload {
  const record = jsonObject(payload, "AWS RCS delivery payload");
  const destination = requiredText(record.DestinationPhoneNumber, "DestinationPhoneNumber");
  if (!/^\+[1-9]\d{7,14}$/u.test(destination)) {
    throw new TypeError("DestinationPhoneNumber must be an E.164 phone number.");
  }
  requiredText(record.OriginationIdentity, "OriginationIdentity");
  validateFallbackConfiguration(record.FallbackConfiguration);
  const message = decodeAwsRcsMessage(
    Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => key !== "DestinationPhoneNumber" && key !== "OriginationIdentity",
      ),
    ),
  );
  validateMessageContent(message.RcsMessageContent);
  validateTimeToLive(message.TimeToLive);
  return reviveCalendarTimestamps({
    ...message,
    DestinationPhoneNumber: record.DestinationPhoneNumber,
    OriginationIdentity: record.OriginationIdentity,
  }) as AwsRcsDeliveryPayload;
}

function eventRecord(body: string, eventType: string) {
  try {
    return jsonObject(JSON.parse(body), `AWS RCS ${eventType} event`);
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    throw new TypeError(`AWS RCS ${eventType} event must contain valid JSON.`, { cause });
  }
}

function messageContent(body: string, eventType: string) {
  if (eventType === "TEXT") {
    return { content: body, metadata: { awsRcs: { eventType } } };
  }
  if (eventType === "RCS_TYPING" || eventType === "CONVERSATION_STARTED") return undefined;
  const record = eventRecord(body, eventType);
  if (eventType === "SUGGESTION") {
    const postbackData = readString(record, "postbackData");
    const text = readString(record, "text");
    return {
      content: text ?? postbackData ?? "RCS suggestion selected",
      metadata: { awsRcs: { eventType, postbackData, text } },
    };
  }
  if (eventType !== "MEDIA") {
    throw new TypeError("AWS RCS forwarded event type is unsupported.");
  }
  const bucket = readString(record, "s3Bucket");
  const objectKey = readString(record, "s3Key");
  if (record.mediaStatus !== "SUCCESS" || !bucket || !objectKey) return undefined;
  const fileName = readString(record, "fileName") ?? "RCS attachment";
  const contentType = readString(record, "mimeType");
  const kind = contentType?.startsWith("image/")
    ? ("image" as const)
    : contentType?.startsWith("video/")
      ? ("video" as const)
      : contentType?.startsWith("audio/")
        ? ("audio" as const)
        : contentType === "application/pdf"
          ? ("document" as const)
          : ("other" as const);
  const byteSize =
    typeof record.fileSizeBytes === "number" && Number.isSafeInteger(record.fileSizeBytes)
      ? record.fileSizeBytes
      : undefined;
  return {
    attachments: [
      {
        ...(byteSize !== undefined ? { byteSize } : {}),
        ...(contentType ? { contentType } : {}),
        fileName,
        kind,
        url: `s3://${bucket}/${objectKey}`,
      },
    ],
    content: fileName,
    metadata: {
      awsRcs: {
        ...(byteSize !== undefined ? { byteSize } : {}),
        bucket,
        ...(contentType ? { contentType } : {}),
        eventType,
        fileName,
        objectKey,
      },
    },
  };
}

export function awsRcsIngressRequestFromNotification(
  input: unknown,
): ChannelMessageIngressRequest | undefined {
  const notification = jsonObject(input, "AWS RCS inbound notification");
  const eventType = requiredText(
    notification.deploymentsAiEventType,
    "AWS RCS forwarded event type",
  );
  if (eventType === "RCS_TYPING" || eventType === "CONVERSATION_STARTED") return undefined;
  const body = requiredText(notification.messageBody, "AWS RCS inbound messageBody");
  const content = messageContent(body, eventType);
  if (!content) return undefined;
  const sender = requiredText(notification.originationNumber, "AWS RCS originationNumber");
  const destination = requiredText(notification.destinationNumber, "AWS RCS destinationNumber");
  const identity = readString(notification, "deploymentsAiOriginationIdentity") ?? destination;
  const notificationMetadata = Object.fromEntries(
    ["destinationNumber", "messageKeyword", "previousPublishedMessageId"]
      .map((key) => [key, readString(notification, key)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  return {
    ...content,
    channel: "rcs",
    externalChannelId: identity,
    externalMessageId: requiredText(notification.inboundMessageId, "AWS RCS inboundMessageId"),
    externalThreadKey: sender,
    metadata: {
      ...("metadata" in content ? content.metadata : {}),
      awsRcsNotification: { ...notificationMetadata, eventType },
    },
    provider: AWS_RCS_PROVIDER,
    sender: { id: sender },
  };
}
