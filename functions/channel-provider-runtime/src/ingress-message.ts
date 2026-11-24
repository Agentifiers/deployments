import {
  type ChannelAttachment,
  type ChannelAttachmentKind,
  type ChannelProvider,
  type NormalizedChannelIngressRequest,
} from "@deployments-ai/channel-adapters";
import {
  type ChannelIngressBurstFlush,
  type ChannelIngressBurstMessageInput,
  type ChannelIngressBurstRoute,
  channelIngressBurstRouteId,
  channelIngressSourceRecordId,
  Metadata,
  Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { record, text, ulid } from "./ingress-payload-fields.ts";

export interface ChannelIngressQueueMessageV1 {
  readonly bindingId: Ulid;
  readonly environmentId: Ulid;
  readonly ingress: NormalizedChannelIngressRequest & { readonly provider: ChannelProvider };
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly receivedAt: string;
  readonly type: "channel.ingress";
  readonly version: 1;
}

export interface DecodedChannelIngressQueueMessageV1 extends ChannelIngressQueueMessageV1 {
  readonly ingress: Omit<ChannelIngressQueueMessageV1["ingress"], "attachments"> & {
    readonly attachments?: readonly ChannelAttachment[];
  };
}

export interface ChannelIngressFlushQueueMessageV1 extends ChannelIngressBurstFlush {
  readonly rescheduleCount: number;
  readonly type: "channel.ingress.flush";
  readonly version: 1;
}

export interface ChannelIngressFlushSchedule extends ChannelIngressBurstFlush {
  readonly rescheduleCount?: number;
}

export const CHANNEL_INGRESS_QUIET_WINDOW_MAX_RESCHEDULES = 60;

export function channelIngressFlushQueueMessage(
  flush: ChannelIngressFlushSchedule,
): ChannelIngressFlushQueueMessageV1 {
  return {
    ...flush,
    rescheduleCount: flush.rescheduleCount ?? 0,
    type: "channel.ingress.flush",
    version: 1,
  };
}

export function channelIngressQueueMessage(
  record: {
    readonly data: {
      readonly environmentId: Ulid;
      readonly id: Ulid;
      readonly organizationId: Ulid;
      readonly projectId: Ulid;
    };
  },
  ingress: NormalizedChannelIngressRequest,
  receivedAt = new Date().toISOString(),
): ChannelIngressQueueMessageV1 {
  if (!ingress.provider) {
    throw new Error("Channel ingress provider is required.");
  }
  return {
    bindingId: record.data.id,
    environmentId: record.data.environmentId,
    ingress: { ...ingress, provider: ingress.provider },
    organizationId: record.data.organizationId,
    projectId: record.data.projectId,
    receivedAt,
    type: "channel.ingress",
    version: 1,
  };
}

export function channelIngressQueueRoute(
  message: ChannelIngressQueueMessageV1,
): ChannelIngressBurstRoute {
  return {
    bindingId: message.bindingId,
    channel: message.ingress.channel,
    ...(message.ingress.executor ? { executor: message.ingress.executor } : {}),
    ...(message.ingress.externalAccountId
      ? { externalAccountId: message.ingress.externalAccountId }
      : {}),
    externalChannelId: message.ingress.externalChannelId,
    externalThreadKey: message.ingress.externalThreadKey,
    ...(message.ingress.externalWorkspaceId
      ? { externalWorkspaceId: message.ingress.externalWorkspaceId }
      : {}),
    provider: message.ingress.provider,
  };
}

export function channelIngressQueueTransport(message: ChannelIngressQueueMessageV1) {
  const routeId = channelIngressBurstRouteId(channelIngressQueueRoute(message));
  return {
    MessageDeduplicationId: channelIngressSourceRecordId(
      routeId,
      message.ingress.externalMessageId,
    ),
    MessageGroupId: routeId,
  } as const;
}

function channelProvider(
  value: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): ChannelProvider {
  const provider = text(value, field, label);
  if (
    provider !== "aws_end_user_messaging_rcs" &&
    provider !== "slack_cloudflare_edge" &&
    provider !== "slack_edge" &&
    provider !== "teams_bot_framework" &&
    provider !== "telegram"
  ) {
    throw new Error(`${label}.${field} is unsupported.`);
  }
  return provider;
}

function selectedStrings(value: unknown, fields: readonly string[]) {
  const source =
    value && typeof value === "object" && !Array.isArray(value) ? record(value, "") : {};
  return Object.fromEntries(
    fields
      .map((field) => [field, source[field]] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
  );
}

function selectedSlackUserGroupMentionIds(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const ids = [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === "string" && /^S[A-Z0-9]+$/u.test(entry) && entry.length <= 64,
      ),
    ),
  ].slice(0, 100);
  return ids.length > 0 ? ids : undefined;
}

function selectedTeamsMentionIds(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const ids = [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0 && entry.length <= 512,
      ),
    ),
  ].slice(0, 100);
  return ids.length > 0 ? ids : undefined;
}

const ATTACHMENT_KINDS: Readonly<Record<ChannelAttachmentKind, true>> = {
  audio: true,
  document: true,
  image: true,
  other: true,
  video: true,
};

function isAttachmentKind(kind: string): kind is ChannelAttachmentKind {
  return Object.hasOwn(ATTACHMENT_KINDS, kind);
}

function sanitizedAttachments(value: unknown): ChannelAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 20) throw new Error("Channel ingress supports at most 20 attachments.");
  return value.map((entry) => {
    const attachment = record(entry, "Channel ingress attachment");
    const kind = text(attachment, "kind", "Channel ingress attachment");
    if (!isAttachmentKind(kind)) throw new Error("Channel ingress attachment kind is unsupported.");
    return {
      ...selectedStrings(attachment, ["contentType", "fileName", "providerAttachmentId", "url"]),
      kind,
      ...(typeof attachment.byteSize === "number" &&
      Number.isSafeInteger(attachment.byteSize) &&
      attachment.byteSize >= 0
        ? { byteSize: attachment.byteSize }
        : {}),
    };
  });
}

function sanitizedProviderMetadata(provider: ChannelProvider, value: unknown) {
  if (!value) return undefined;
  const metadata = record(value, "Channel ingress metadata");
  if (provider === "slack_edge" || provider === "slack_cloudflare_edge") {
    const scalars = selectedStrings(metadata, [
      "apiAppId",
      "channelType",
      "messageTs",
      "slackEventId",
      "slackEventType",
      "subtype",
    ]);
    const slackUserGroupMentionIds = selectedSlackUserGroupMentionIds(
      metadata.slackUserGroupMentionIds,
    );
    return {
      ...scalars,
      ...(slackUserGroupMentionIds ? { slackUserGroupMentionIds } : {}),
    };
  }
  if (provider === "teams_bot_framework") {
    const teamsMentionIds = selectedTeamsMentionIds(metadata.teamsMentionIds);
    return {
      ...selectedStrings(metadata, [
        "teamsActivityId",
        "teamsChannelId",
        "teamsConversationType",
        "teamsFromId",
        "teamsReplyToId",
        "teamsServiceUrl",
        "teamsTeamAadGroupId",
        "teamsTeamId",
      ]),
      ...(teamsMentionIds ? { teamsMentionIds } : {}),
    };
  }
  if (provider !== "aws_end_user_messaging_rcs") return undefined;
  const event = selectedStrings(metadata.awsRcs, [
    "bucket",
    "contentType",
    "eventType",
    "fileName",
    "objectKey",
    "postbackData",
    "text",
  ]);
  const eventRecord =
    metadata.awsRcs && typeof metadata.awsRcs === "object" && !Array.isArray(metadata.awsRcs)
      ? record(metadata.awsRcs, "AWS RCS event metadata")
      : undefined;
  const notification = selectedStrings(metadata.awsRcsNotification, [
    "destinationNumber",
    "eventType",
    "messageKeyword",
    "previousPublishedMessageId",
  ]);
  const sanitizedEvent = {
    ...event,
    ...(typeof eventRecord?.byteSize === "number" &&
    Number.isSafeInteger(eventRecord.byteSize) &&
    eventRecord.byteSize >= 0
      ? { byteSize: eventRecord.byteSize }
      : {}),
  };
  return {
    ...(Object.keys(sanitizedEvent).length > 0 ? { awsRcs: sanitizedEvent } : {}),
    ...(Object.keys(notification).length > 0 ? { awsRcsNotification: notification } : {}),
  };
}

export function decodeChannelIngressQueueMessage(
  value: unknown,
): DecodedChannelIngressQueueMessageV1 {
  const message = record(value, "Channel ingress queue message");
  if (message.type !== "channel.ingress" || message.version !== 1) {
    throw new Error("Channel ingress queue message version is unsupported.");
  }
  const ingressValue = record(message.ingress, "Channel ingress request");
  const sender = record(ingressValue.sender, "Channel ingress sender");
  const provider = channelProvider(ingressValue, "provider", "Channel ingress request");
  const attachments = sanitizedAttachments(ingressValue.attachments);
  const providerMetadata = sanitizedProviderMetadata(provider, ingressValue.metadata);
  const ingress: DecodedChannelIngressQueueMessageV1["ingress"] = {
    ...(attachments ? { attachments } : {}),
    channel: text(
      ingressValue,
      "channel",
      "Channel ingress request",
    ) as NormalizedChannelIngressRequest["channel"],
    content: text(ingressValue, "content", "Channel ingress request"),
    ...(typeof ingressValue.executor === "string" ? { executor: ingressValue.executor } : {}),
    ...(typeof ingressValue.externalAccountId === "string"
      ? { externalAccountId: ingressValue.externalAccountId }
      : {}),
    externalChannelId: text(ingressValue, "externalChannelId", "Channel ingress request"),
    externalMessageId: text(ingressValue, "externalMessageId", "Channel ingress request"),
    externalThreadKey: text(ingressValue, "externalThreadKey", "Channel ingress request"),
    ...(typeof ingressValue.externalWorkspaceId === "string"
      ? { externalWorkspaceId: ingressValue.externalWorkspaceId }
      : {}),
    ...(providerMetadata && Object.keys(providerMetadata).length > 0
      ? { metadata: providerMetadata }
      : {}),
    ...(typeof ingressValue.occurredAt === "string" ? { occurredAt: ingressValue.occurredAt } : {}),
    provider,
    sender: {
      ...(typeof sender.displayName === "string" ? { displayName: sender.displayName } : {}),
      id: text(sender, "id", "Channel ingress sender"),
    },
  };
  const receivedAt = text(message, "receivedAt", "Channel ingress queue message");
  if (!Number.isFinite(Date.parse(receivedAt))) {
    throw new Error("Channel ingress receivedAt must be an ISO timestamp.");
  }
  return {
    bindingId: ulid(message.bindingId, "Channel ingress bindingId"),
    environmentId: ulid(message.environmentId, "Channel ingress environmentId"),
    ingress,
    organizationId: ulid(message.organizationId, "Channel ingress organizationId"),
    projectId: ulid(message.projectId, "Channel ingress projectId"),
    receivedAt,
    type: "channel.ingress",
    version: 1,
  };
}

export function channelIngressMessageMetadata(
  message: ChannelIngressQueueMessageV1,
  sourceMessageIds: readonly string[] = [message.ingress.externalMessageId],
  burst?: { readonly routeId: string; readonly throughSequence: number },
) {
  const metadata = {
    attachments: message.ingress.attachments,
    bindingId: message.bindingId,
    externalAccountId: message.ingress.externalAccountId,
    externalChannelId: message.ingress.externalChannelId,
    externalMessageId: message.ingress.externalMessageId,
    sourceMessageCount: sourceMessageIds.length,
    sourceMessageIds,
    externalThreadKey: message.ingress.externalThreadKey,
    externalWorkspaceId: message.ingress.externalWorkspaceId,
    occurredAt: message.ingress.occurredAt,
    provider: message.ingress.provider,
    ...(burst ? { routeId: burst.routeId, throughSequence: burst.throughSequence } : {}),
    ...(message.ingress.metadata ? { providerMetadata: message.ingress.metadata } : {}),
    sender: message.ingress.sender,
    source: "channel-ingress",
  };
  const serialized = JSON.stringify(metadata);
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1024) {
    throw new Error("Channel ingress metadata exceeds 64 KiB.");
  }
  return JSON.parse(serialized) as Readonly<Record<string, unknown>>;
}

function serializedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sourceFingerprint(message: ChannelIngressQueueMessageV1) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        message.bindingId,
        message.environmentId,
        message.organizationId,
        message.projectId,
        message.ingress,
      ]),
    )
    .digest("hex");
}

export function channelIngressBurstStageInput(
  message: ChannelIngressQueueMessageV1,
): ChannelIngressBurstMessageInput {
  const metadata = channelIngressMessageMetadata(message);
  return {
    attachmentCount: message.ingress.attachments?.length ?? 0,
    bindingId: message.bindingId,
    contentBytes: new TextEncoder().encode(message.ingress.content).byteLength,
    environmentId: message.environmentId,
    metadataBytes: serializedBytes(metadata),
    organizationId: message.organizationId,
    payload: Schema.decodeUnknownSync(Metadata)(message),
    payloadBytes: serializedBytes(message),
    projectId: message.projectId,
    receivedAt: message.receivedAt,
    route: channelIngressQueueRoute(message),
    senderId: message.ingress.sender.id,
    sourceFingerprint: sourceFingerprint(message),
    sourceMessageId: message.ingress.externalMessageId,
  };
}
