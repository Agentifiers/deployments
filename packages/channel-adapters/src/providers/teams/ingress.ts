import {
  asRecord,
  type ChannelAttachment,
  readString,
  type TeamsChannelMessageIngressRequest,
} from "../../shared/core.ts";
import { TeamsIngressError, type TeamsBotFrameworkTokenVerifier } from "./bot-framework-auth.ts";
import { allowedTeamsServiceUrl } from "./service-url.ts";

export type { TeamsChannelMessageIngressRequest } from "../../shared/core.ts";

export type TeamsChannelProvider = "teams_bot_framework";

export type TeamsActivityAction =
  | { readonly reason: string; readonly type: "ignored" }
  | { readonly request: TeamsChannelMessageIngressRequest; readonly type: "message" };

export type TeamsConversationType = "channel" | "groupChat" | "personal";

const TEAMS_CHANNEL_ID = "msteams";
const BOT_ID_PREFIX = "28:";
const THREAD_MESSAGE_ID_MARKER = ";messageid=";
const FILE_DOWNLOAD_INFO_CONTENT_TYPE = "application/vnd.microsoft.teams.file.download.info";
const MAX_TEAMS_MENTION_IDS = 100;
const MAX_TEAMS_MENTION_ID_CHARACTERS = 512;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function teamsExternalThreadKey(input: {
  readonly conversationId: string;
  readonly tenantId: string;
}) {
  return `teams:${input.tenantId}:thread:${input.conversationId}`;
}

function teamsBotIds(botAppId: string) {
  const appId = botAppId.trim().toLowerCase();
  return new Set([appId, `${BOT_ID_PREFIX}${appId}`]);
}

function mentionEntities(activity: Record<string, unknown> | undefined) {
  const entities = activity?.entities;
  if (!Array.isArray(entities)) return [];
  return entities
    .map(asRecord)
    .filter((entity): entity is Record<string, unknown> => entity?.type === "mention");
}

/** Ordered, deduplicated ids of everyone mentioned in the activity except this bot. */
export function teamsMentionIds(activity: unknown, botAppId: string): string[] {
  const botIds = teamsBotIds(botAppId);
  const ids: string[] = [];
  for (const entity of mentionEntities(asRecord(activity))) {
    const id = readString(asRecord(entity.mentioned), "id");
    if (!id || id.length > MAX_TEAMS_MENTION_ID_CHARACTERS) continue;
    if (botIds.has(id.toLowerCase()) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length === MAX_TEAMS_MENTION_IDS) break;
  }
  return ids;
}

function decodeHtmlEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (entity, name: string) => {
    if (name.startsWith("#")) {
      const codePoint =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : +name.slice(1);
      return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/**
 * Converts Teams message HTML into plain text: removes the bot's own `<at>` mention, renders other
 * mentions as `@Name`, strips remaining markup, decodes entities, and collapses whitespace.
 */
function teamsMessageText(activity: unknown, botAppId: string) {
  const record = asRecord(activity);
  const raw = typeof record?.text === "string" ? record.text : "";
  if (!raw) return "";
  const botIds = teamsBotIds(botAppId);
  let text = raw;
  for (const entity of mentionEntities(record)) {
    const id = readString(asRecord(entity.mentioned), "id");
    const mentionText = typeof entity.text === "string" ? entity.text : undefined;
    if (id && mentionText && botIds.has(id.toLowerCase())) text = text.split(mentionText).join(" ");
  }
  text = text
    .replace(/<at(?:\s[^>]*)?>([\s\S]*?)<\/at>/giu, (_match, name: string) => `@${name.trim()}`)
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)>/giu, "\n")
    .replace(/<[^>]*>/gu, "");
  return decodeHtmlEntities(text)
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function attachmentKind(contentType: string | undefined, fileType: string | undefined) {
  const extension = fileType?.toLowerCase();
  if (contentType?.startsWith("image/")) return "image" as const;
  if (contentType?.startsWith("video/")) return "video" as const;
  if (contentType?.startsWith("audio/")) return "audio" as const;
  if (extension && ["gif", "heic", "jpeg", "jpg", "png", "webp"].includes(extension)) {
    return "image" as const;
  }
  if (
    extension &&
    ["doc", "docx", "md", "pdf", "ppt", "pptx", "txt", "xls", "xlsx"].includes(extension)
  ) {
    return "document" as const;
  }
  return "other" as const;
}

interface TeamsActivityFile {
  readonly attachment: ChannelAttachment;
  readonly summary: string;
}

/**
 * Teams file attachments. `downloadUrl` on file download info is a pre-authenticated secret and is
 * never kept; inline images keep their bot-token protected `contentUrl`.
 */
function teamsActivityFiles(activity: Record<string, unknown>): TeamsActivityFile[] {
  const attachments = Array.isArray(activity.attachments) ? activity.attachments : [];
  const files: TeamsActivityFile[] = [];
  for (const value of attachments) {
    const attachment = asRecord(value);
    const contentType = readString(attachment, "contentType");
    const name = readString(attachment, "name");
    if (contentType === FILE_DOWNLOAD_INFO_CONTENT_TYPE) {
      const content = asRecord(attachment?.content);
      const fileType = readString(content, "fileType");
      const uniqueId = readString(content, "uniqueId");
      if (!uniqueId && !name) continue;
      files.push({
        attachment: {
          ...(fileType ? { contentType: fileType } : {}),
          ...(name ? { fileName: name } : {}),
          kind: attachmentKind(undefined, fileType),
          ...(uniqueId ? { providerAttachmentId: uniqueId } : {}),
        },
        summary: `File shared: ${name ?? uniqueId ?? "untitled file"}${fileType ? ` (${fileType})` : ""}`,
      });
      continue;
    }
    if (!contentType?.startsWith("image/")) continue;
    const contentUrl = readString(attachment, "contentUrl");
    if (!contentUrl || !URL.canParse(contentUrl) || new URL(contentUrl).protocol !== "https:") {
      continue;
    }
    files.push({
      attachment: {
        contentType,
        ...(name ? { fileName: name } : {}),
        kind: "image",
        url: contentUrl,
      },
      summary: `File shared: ${name ?? "image"} (${contentType})`,
    });
  }
  return files;
}

function conversationTypeFor(
  conversation: Record<string, unknown>,
  channelData: Record<string, unknown> | undefined,
): TeamsConversationType {
  const declared = readString(conversation, "conversationType");
  if (declared === "personal" || declared === "groupChat" || declared === "channel") {
    return declared;
  }
  if (readString(asRecord(channelData?.channel), "id")) return "channel";
  return conversation.isGroup === true ? "groupChat" : "personal";
}

function teamsMessageIngressRequest(input: {
  readonly activity: Record<string, unknown>;
  readonly appId: string;
  readonly provider: TeamsChannelProvider;
  readonly serviceUrl: string;
}): TeamsActivityAction {
  const { activity } = input;
  const from = asRecord(activity.from);
  const fromId = readString(from, "id");
  if (!fromId) return { reason: "missing_sender", type: "ignored" };
  if (fromId.startsWith(BOT_ID_PREFIX) || readString(from, "role") === "bot") {
    return { reason: "bot_message", type: "ignored" };
  }
  const activityId = readString(activity, "id");
  if (!activityId) return { reason: "missing_activity_id", type: "ignored" };
  const conversation = asRecord(activity.conversation);
  const conversationId = readString(conversation, "id");
  if (!conversation || !conversationId) return { reason: "missing_conversation", type: "ignored" };
  const channelData = asRecord(activity.channelData);
  const tenantId =
    readString(asRecord(channelData?.tenant), "id") ?? readString(conversation, "tenantId");
  if (!tenantId) return { reason: "missing_tenant", type: "ignored" };

  const files = teamsActivityFiles(activity);
  const content = [teamsMessageText(activity, input.appId), ...files.map((file) => file.summary)]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!content) return { reason: "empty_message", type: "ignored" };

  const conversationType = conversationTypeFor(conversation, channelData);
  const markerIndex = conversationId.indexOf(THREAD_MESSAGE_ID_MARKER);
  const baseConversationId =
    markerIndex === -1 ? conversationId : conversationId.slice(0, markerIndex);
  const replyConversationId =
    conversationType === "channel" && markerIndex === -1
      ? `${conversationId}${THREAD_MESSAGE_ID_MARKER}${activityId}`
      : conversationId;
  const recipientId = readString(asRecord(activity.recipient), "id");
  const externalAccountId = recipientId?.startsWith(BOT_ID_PREFIX)
    ? recipientId.slice(BOT_ID_PREFIX.length)
    : input.appId;
  const externalMessageId = `teams:${tenantId}:${baseConversationId}:${activityId}`;
  const team = asRecord(channelData?.team);
  const mentionIds = teamsMentionIds(activity, input.appId);
  const providerMetadata = Object.fromEntries(
    Object.entries({
      teamsActivityId: activityId,
      teamsChannelId: readString(asRecord(channelData?.channel), "id"),
      teamsConversationType: conversationType,
      teamsFromId: fromId,
      teamsReplyToId: readString(activity, "replyToId"),
      teamsServiceUrl: input.serviceUrl,
      teamsTeamAadGroupId: readString(team, "aadGroupId"),
      teamsTeamId: readString(team, "id"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const senderDisplayName = readString(from, "name");
  const occurredAt = readString(activity, "timestamp");

  return {
    request: {
      ...(files.length ? { attachments: files.map((file) => file.attachment) } : {}),
      channel: "teams",
      content,
      externalAccountId,
      externalChannelId: baseConversationId,
      externalMessageId,
      externalThreadKey: teamsExternalThreadKey({ conversationId: replyConversationId, tenantId }),
      externalWorkspaceId: tenantId,
      idempotencyKey: externalMessageId,
      metadata: {
        ...providerMetadata,
        ...(mentionIds.length ? { teamsMentionIds: mentionIds } : {}),
      },
      ...(occurredAt ? { occurredAt } : {}),
      provider: input.provider,
      sender: {
        ...(senderDisplayName ? { displayName: senderDisplayName } : {}),
        id: readString(from, "aadObjectId") ?? fromId,
      },
    },
    type: "message",
  };
}

/**
 * Authenticates and normalizes a Bot Framework activity POST. The bearer token is verified before
 * any field beyond `channelId`/`serviceUrl` (needed for verification) is trusted.
 */
export async function teamsActivityActionFromRequest(input: {
  readonly appId: string;
  readonly authorization: string | null | undefined;
  readonly provider?: TeamsChannelProvider;
  readonly rawBody: string;
  readonly verifier: TeamsBotFrameworkTokenVerifier;
}): Promise<TeamsActivityAction> {
  let activity: Record<string, unknown> | undefined;
  try {
    activity = asRecord(JSON.parse(input.rawBody));
  } catch {
    activity = undefined;
  }
  if (!activity) throw new TeamsIngressError(400, "Teams activity body is invalid.");
  const channelId = typeof activity.channelId === "string" ? activity.channelId : undefined;
  const serviceUrl = typeof activity.serviceUrl === "string" ? activity.serviceUrl : undefined;
  if (!channelId || !serviceUrl) {
    throw new TeamsIngressError(400, "Teams activity is missing channelId or serviceUrl.");
  }
  await input.verifier.verify({
    appId: input.appId,
    authorization: input.authorization,
    channelId,
    serviceUrl,
  });

  if (channelId !== TEAMS_CHANNEL_ID) return { reason: "unsupported_channel", type: "ignored" };
  const normalizedServiceUrl = allowedTeamsServiceUrl(serviceUrl);
  if (!normalizedServiceUrl) return { reason: "disallowed_service_url", type: "ignored" };
  if (activity.type !== "message") return { reason: "unsupported_activity_type", type: "ignored" };
  return teamsMessageIngressRequest({
    activity,
    appId: input.appId,
    provider: input.provider ?? "teams_bot_framework",
    serviceUrl: normalizedServiceUrl,
  });
}
