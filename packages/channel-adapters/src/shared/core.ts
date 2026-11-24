export type ChannelProvider =
  | "aws_end_user_messaging_rcs"
  | "slack_edge"
  | "slack_cloudflare_edge"
  | "teams_bot_framework"
  | "telegram";
export type ExternalAgentChannel = "slack" | "imessage" | "sms" | "rcs" | "teams" | "telegram";

export interface ChannelMessageSender {
  readonly displayName?: string | undefined;
  readonly id: string;
}

export interface ChannelMessageIngressRequest {
  readonly attachments?: readonly unknown[] | undefined;
  readonly channel: ExternalAgentChannel;
  readonly content: string;
  readonly executor?: string | undefined;
  readonly externalAccountId?: string | undefined;
  readonly externalChannelId: string;
  readonly externalMessageId: string;
  readonly externalThreadKey: string;
  readonly externalWorkspaceId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly modelId?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly provider?: ChannelProvider | undefined;
  readonly sandboxPoolKey?: string | undefined;
  readonly sender: ChannelMessageSender;
}

export type SlackChannelMessageIngressRequest = Omit<
  ChannelMessageIngressRequest,
  "channel" | "externalWorkspaceId"
> & {
  readonly channel: "slack";
  readonly externalWorkspaceId: string;
};

export type TeamsChannelMessageIngressRequest = Omit<
  ChannelMessageIngressRequest,
  "channel" | "externalWorkspaceId"
> & {
  readonly channel: "teams";
  readonly externalWorkspaceId: string;
};

export type ChannelAttachmentKind = "image" | "document" | "audio" | "video" | "other";

export interface ChannelAttachment {
  readonly byteSize?: number;
  readonly contentType?: string;
  readonly fileName?: string;
  readonly kind: ChannelAttachmentKind;
  readonly providerAttachmentId?: string;
  readonly url?: string;
}

export interface ChannelAdapterDefinition<
  Channel extends ExternalAgentChannel = ExternalAgentChannel,
  Provider extends ChannelProvider = ChannelProvider,
> {
  readonly channel: Channel;
  readonly provider: Provider;
}

export interface ChannelDeliveryResult {
  readonly providerMessageId?: string;
  readonly responseBody?: unknown;
}

export type NormalizedChannelIngressRequest = ChannelMessageIngressRequest;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readString(
  record: Record<string, unknown> | undefined,
  ...keys: readonly string[]
) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }

  return undefined;
}

export function readNumber(
  record: Record<string, unknown> | undefined,
  ...keys: readonly string[]
) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }

  return undefined;
}

export function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function externalThreadTarget(externalThreadKey: string) {
  const marker = ":thread:";
  const index = externalThreadKey.indexOf(marker);
  return index === -1 ? externalThreadKey : externalThreadKey.slice(index + marker.length);
}

export function extractProviderMessageId(value: unknown) {
  const record = asRecord(value);
  const result = asRecord(record?.result);
  const message = asRecord(record?.message);

  return (
    readString(record, "providerMessageId", "messageUuid", "message_uuid", "messageId", "id") ??
    readString(result, "message_id", "messageId", "id") ??
    readString(message, "id", "uuid")
  );
}

export function parseJsonResponseBody(body: string): unknown {
  if (!body.trim()) return undefined;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}
