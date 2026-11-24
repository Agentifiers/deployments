import { teamsConnectorClient } from "../providers/teams/connector.ts";
import { teamsBotCredentials, type TeamsBotCredentials } from "../providers/teams/credentials.ts";
import { TEAMS_CONNECTOR_ORIGIN } from "../providers/teams/service-url.ts";
import { TELEGRAM_API_BASE_URL } from "../providers/telegram/index.ts";
import {
  ChannelAttachmentDownloadError,
  downloadFromOrigin,
  isUrlOnOrigin,
  type ChannelAttachmentTransport,
} from "./attachment-download.ts";
import { asRecord, readString, type ChannelAttachment, type ChannelProvider } from "./core.ts";

const SLACK_FILES_ORIGIN = "https://files.slack.com";
const TELEGRAM_GET_FILE_MAX_BYTES = 16 * 1_024;

export type ChannelAttachmentReference =
  | { readonly type: "slack-file"; readonly url: string }
  | { readonly type: "teams-inline-image"; readonly contentUrl: string }
  | { readonly type: "telegram-file"; readonly fileId: string };

export type ChannelAttachmentSource = (
  attachment: ChannelAttachment,
) => ChannelAttachmentReference | undefined;

export type ChannelAttachmentSources = {
  readonly [Provider in ChannelProvider]: ChannelAttachmentSource | undefined;
};

const slackFile: ChannelAttachmentSource = (attachment) =>
  attachment.url !== undefined && isUrlOnOrigin(attachment.url, SLACK_FILES_ORIGIN)
    ? { type: "slack-file", url: attachment.url }
    : undefined;

export const CHANNEL_ATTACHMENT_SOURCES: ChannelAttachmentSources = {
  aws_end_user_messaging_rcs: undefined,
  slack_cloudflare_edge: slackFile,
  slack_edge: slackFile,
  teams_bot_framework: (attachment) =>
    attachment.kind === "image" &&
    attachment.url !== undefined &&
    isUrlOnOrigin(attachment.url, TEAMS_CONNECTOR_ORIGIN)
      ? { contentUrl: attachment.url, type: "teams-inline-image" }
      : undefined,
  telegram: (attachment) =>
    attachment.providerAttachmentId === undefined
      ? undefined
      : { fileId: attachment.providerAttachmentId, type: "telegram-file" },
};

export interface ChannelAttachmentDownloadOptions extends ChannelAttachmentTransport {
  readonly botTokenFetch?: typeof fetch;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

function credentialValue(credentials: Readonly<Record<string, string>>, ...keys: string[]) {
  const value = readString(credentials, ...keys);
  if (!value) throw new ChannelAttachmentDownloadError("credential_invalid");
  return value;
}

function telegramFilePath(getFileBody: Uint8Array) {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(getFileBody));
  } catch {
    throw new ChannelAttachmentDownloadError("malformed_response");
  }
  const filePath = readString(asRecord(asRecord(body)?.result), "file_path");
  if (!filePath) throw new ChannelAttachmentDownloadError("malformed_response");
  return filePath.split("/").map(encodeURIComponent).join("/");
}

async function downloadTelegramFile(
  fileId: string,
  credentials: Readonly<Record<string, string>>,
  options: ChannelAttachmentDownloadOptions,
) {
  const token = credentialValue(credentials, "botToken");
  const getFileBody = await downloadFromOrigin({
    maxBytes: TELEGRAM_GET_FILE_MAX_BYTES,
    origin: TELEGRAM_API_BASE_URL,
    signal: options.signal,
    transport: options,
    url: `${TELEGRAM_API_BASE_URL}/bot${token}/getFile?${new URLSearchParams({ file_id: fileId }).toString()}`,
  });
  return downloadFromOrigin({
    maxBytes: options.maxBytes,
    origin: TELEGRAM_API_BASE_URL,
    signal: options.signal,
    transport: options,
    url: `${TELEGRAM_API_BASE_URL}/file/bot${token}/${telegramFilePath(getFileBody)}`,
  });
}

export async function downloadChannelAttachment(
  reference: ChannelAttachmentReference,
  credentials: Readonly<Record<string, string>>,
  options: ChannelAttachmentDownloadOptions,
): Promise<Uint8Array> {
  switch (reference.type) {
    case "slack-file":
      return downloadFromOrigin({
        headers: {
          authorization: `Bearer ${credentialValue(credentials, "accessToken", "botToken")}`,
        },
        maxBytes: options.maxBytes,
        origin: SLACK_FILES_ORIGIN,
        signal: options.signal,
        transport: options,
        url: reference.url,
      });
    case "teams-inline-image": {
      let botCredentials: TeamsBotCredentials;
      try {
        botCredentials = teamsBotCredentials(credentials);
      } catch {
        throw new ChannelAttachmentDownloadError("credential_invalid");
      }
      return teamsConnectorClient({
        ...options,
        ...(options.botTokenFetch ? { fetch: options.botTokenFetch } : {}),
      }).downloadAttachment({
        contentUrl: reference.contentUrl,
        credentials: botCredentials,
        maxBytes: options.maxBytes,
        signal: options.signal,
      });
    }
    case "telegram-file":
      return downloadTelegramFile(reference.fileId, credentials, options);
    default: {
      const unhandled: never = reference;
      return unhandled;
    }
  }
}
