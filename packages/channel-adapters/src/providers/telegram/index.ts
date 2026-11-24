import {
  asRecord,
  externalThreadTarget,
  parseJsonResponseBody,
  readNumber,
  extractProviderMessageId,
  readString,
  type ChannelAttachment,
  type ChannelDeliveryResult,
  type ChannelMessageIngressRequest,
} from "../../shared/core.ts";

export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

export interface TelegramInboundMessage {
  readonly attachments?: readonly ChannelAttachment[];
  readonly chatId: string;
  readonly content: string;
  readonly externalMessageId: string;
  readonly senderDisplayName?: string;
  readonly senderId: string;
}

export interface TelegramTextDeliveryPayload {
  readonly chat_id: string;
  readonly text: string;
}

export interface TelegramPhotoDeliveryPayload {
  readonly caption?: string;
  readonly chat_id: string;
  readonly photo: string;
}

export type TelegramDeliveryPayload = TelegramTextDeliveryPayload | TelegramPhotoDeliveryPayload;

export interface TelegramDeliveryPart {
  readonly content: string;
  readonly includeAttachments: boolean;
}

export interface TelegramClientConfig {
  readonly apiBaseUrl?: string;
  readonly botToken: string;
  readonly fetch?: typeof fetch;
}

export class TelegramApiError extends Error {
  readonly body: unknown;
  readonly retryAfter: string | undefined;
  readonly status: number;

  constructor(status: number, body: unknown, headers?: Headers) {
    super(`Telegram API request failed with status ${status}.`);
    this.name = "TelegramApiError";
    this.body = body;
    this.retryAfter = headers?.get("retry-after")?.trim() || undefined;
    this.status = status;
  }

  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

function telegramPayloadRecord(input: unknown) {
  const update = asRecord(input);
  const ordinaryMessage = asRecord(update?.message) ?? asRecord(update?.channel_post);
  if (ordinaryMessage) return { message: ordinaryMessage };

  const editedMessage = asRecord(update?.edited_message) ?? asRecord(update?.edited_channel_post);
  const updateId = readString(update, "update_id", "updateId");
  const messageId = readString(editedMessage, "message_id", "messageId");
  return editedMessage && updateId && messageId
    ? { externalMessageId: `${messageId}:edit:${updateId}`, message: editedMessage }
    : undefined;
}

function telegramDisplayName(user: Record<string, unknown> | undefined) {
  const username = readString(user, "username");
  if (username) return username.startsWith("@") ? username : `@${username}`;

  return (
    [readString(user, "first_name", "firstName"), readString(user, "last_name", "lastName")]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

function telegramAttachment(input: unknown, kind?: ChannelAttachment["kind"]) {
  const record = asRecord(input);
  const providerAttachmentId = readString(record, "file_id", "fileId");
  if (!providerAttachmentId) return undefined;

  const contentType = readString(record, "mime_type", "mimeType");
  const fileName = readString(record, "file_name", "fileName");
  const byteSize = readNumber(record, "file_size", "fileSize");
  const inferredKind = kind ?? (contentType?.startsWith("image/") ? "image" : "document");

  return {
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(contentType ? { contentType } : {}),
    ...(fileName ? { fileName } : {}),
    kind: inferredKind,
    providerAttachmentId,
  } satisfies ChannelAttachment;
}

function telegramPhotoAttachment(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const largest = value
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .toSorted(
      (left, right) =>
        (readNumber(right, "file_size", "fileSize") ?? 0) -
        (readNumber(left, "file_size", "fileSize") ?? 0),
    )[0];

  return telegramAttachment(largest, "image");
}

export function readTelegramInboundMessage(input: unknown): TelegramInboundMessage | undefined {
  const update = asRecord(input);
  const payload = telegramPayloadRecord(input);
  if (!payload) return undefined;
  const { message } = payload;

  const chat = asRecord(message.chat);
  const sender = asRecord(message.from);
  const chatId = readString(message, "chat_id", "chatId") ?? readString(chat, "id");
  const senderId = readString(sender, "id");
  const externalMessageId =
    payload.externalMessageId ??
    readString(message, "message_id", "messageId") ??
    readString(update, "update_id", "updateId");
  const attachments = [
    telegramPhotoAttachment(message.photo),
    telegramAttachment(message.document),
    telegramAttachment(message.animation, "image"),
    telegramAttachment(message.video, "video"),
    telegramAttachment(message.voice, "audio"),
  ].flatMap((attachment) => (attachment ? [attachment] : []));
  const content =
    readString(message, "text", "caption") ??
    (attachments.some((attachment) => attachment.kind === "image") ? "[image]" : undefined) ??
    (attachments.length > 0 ? "[attachment]" : undefined);

  if (!chatId || !senderId || !externalMessageId || !content) return undefined;

  const senderDisplayName = telegramDisplayName(sender);
  return {
    ...(attachments.length > 0 ? { attachments } : {}),
    chatId,
    content,
    externalMessageId,
    ...(senderDisplayName ? { senderDisplayName } : {}),
    senderId,
  };
}

export function telegramIngressRequestFromUpdate(
  input: unknown,
  args: { readonly botId: string; readonly externalAccountId?: string },
): ChannelMessageIngressRequest | undefined {
  const message = readTelegramInboundMessage(input);
  if (!message) return undefined;

  return {
    ...(message.attachments ? { attachments: message.attachments } : {}),
    channel: "telegram",
    content: message.content,
    ...(args.externalAccountId ? { externalAccountId: args.externalAccountId } : {}),
    externalChannelId: args.botId,
    externalMessageId: message.externalMessageId,
    externalThreadKey: message.chatId,
    externalWorkspaceId: args.botId,
    idempotencyKey: `telegram:${args.botId}:${message.chatId}:${message.externalMessageId}`,
    metadata: {
      chatId: message.chatId,
      telegramUpdate: input,
    },
    provider: "telegram",
    sender: {
      ...(message.senderDisplayName ? { displayName: message.senderDisplayName } : {}),
      id: message.senderId,
    },
  };
}

export function telegramDeliveryPayload(args: {
  readonly attachments?: readonly ChannelAttachment[];
  readonly content: string;
  readonly externalThreadKey: string;
}): TelegramDeliveryPayload {
  const image = args.attachments?.find(
    (attachment) => attachment.kind === "image" && attachment.url,
  );
  const chatId = externalThreadTarget(args.externalThreadKey).trim();
  if (!chatId) throw new Error("Telegram delivery requires a chat target.");
  const content = Array.from(args.content.trim());

  if (!image?.url && content.length === 0) {
    throw new Error("Telegram delivery requires text or an image.");
  }

  const limit = image?.url ? TELEGRAM_MAX_CAPTION_LENGTH : TELEGRAM_MAX_TEXT_LENGTH;
  if (content.length > limit) {
    throw new Error(`Telegram delivery content exceeds the ${limit} character limit.`);
  }

  return image?.url
    ? {
        ...(content.length > 0 ? { caption: content.join("") } : {}),
        chat_id: chatId,
        photo: image.url,
      }
    : { chat_id: chatId, text: content.join("") };
}

function telegramTextParts(content: readonly string[], limit: number) {
  return Array.from({ length: Math.ceil(content.length / limit) }, (_, index) =>
    content.slice(index * limit, (index + 1) * limit).join(""),
  );
}

export function telegramDeliveryParts(args: {
  readonly content: string;
  readonly hasImage: boolean;
}): readonly TelegramDeliveryPart[] {
  const content = Array.from(args.content.trim());
  if (!args.hasImage) {
    if (content.length === 0) {
      throw new Error("Telegram delivery requires text or an image.");
    }
    return telegramTextParts(content, TELEGRAM_MAX_TEXT_LENGTH).map((part, index) => ({
      content: part,
      includeAttachments: index === 0,
    }));
  }

  const caption = content.slice(0, TELEGRAM_MAX_CAPTION_LENGTH);
  const overflow = content.slice(TELEGRAM_MAX_CAPTION_LENGTH);
  return [
    { content: caption.join(""), includeAttachments: true },
    ...telegramTextParts(overflow, TELEGRAM_MAX_TEXT_LENGTH).map((part) => ({
      content: part,
      includeAttachments: false,
    })),
  ];
}

export function verifyTelegramWebhookSecret(args: {
  readonly expectedSecret: string;
  readonly providedSecret: string | null;
}) {
  const expected = args.expectedSecret.trim();
  const provided = args.providedSecret?.trim();
  if (!expected || !provided || expected.length !== provided.length) return false;

  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
}

export async function sendTelegramDelivery(
  config: TelegramClientConfig,
  payload: TelegramDeliveryPayload,
): Promise<ChannelDeliveryResult> {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const apiBaseUrl = (config.apiBaseUrl?.trim() || TELEGRAM_API_BASE_URL).replace(/\/+$/u, "");
  const token = config.botToken.trim();
  if (!token) throw new Error("Telegram bot token is required.");

  const response = await fetchImpl(
    `${apiBaseUrl}/bot${token}/${"photo" in payload ? "sendPhoto" : "sendMessage"}`,
    {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const body = parseJsonResponseBody(await response.text());
  if (!response.ok) {
    throw new TelegramApiError(response.status, body, response.headers);
  }
  const providerMessageId = extractProviderMessageId(body);

  return {
    ...(providerMessageId ? { providerMessageId } : {}),
    responseBody: body,
  };
}
