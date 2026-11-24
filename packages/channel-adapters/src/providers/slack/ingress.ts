import { createHmac, timingSafeEqual } from "node:crypto";

import {
  asRecord,
  type ChannelAttachment,
  type SlackChannelMessageIngressRequest,
} from "../../shared/core.ts";

export type SlackEventsApiAction =
  | {
      readonly challenge: string;
      readonly type: "url_verification";
    }
  | {
      readonly reason: string;
      readonly type: "ignored";
    }
  | {
      readonly request: SlackChannelMessageIngressRequest;
      readonly type: "message";
    };

export type SlackChannelProvider = "slack_edge" | "slack_cloudflare_edge";

export function verifySlackRequestSignature(args: {
  readonly nowSeconds?: number;
  readonly rawBody: string;
  readonly signature: string | null;
  readonly signingSecret: string;
  readonly timestamp: string | null;
}) {
  const timestamp = Number(args.timestamp);
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;
  const expected = `v0=${createHmac("sha256", args.signingSecret).update(`v0:${timestamp}:${args.rawBody}`).digest("hex")}`;
  const provided = args.signature?.trim();
  if (!provided || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export class SlackEventsApiError extends Error {
  readonly status: 400 | 401 | 403;

  constructor(status: SlackEventsApiError["status"], message: string) {
    super(message);
    this.name = "SlackEventsApiError";
    this.status = status;
  }
}

const FORWARDABLE_MESSAGE_SUBTYPES = new Set(["file_share", "me_message", "thread_broadcast"]);
const ARTIFACT_INTERACTION_PREFIX = "deployments_ai_artifact_";
const ARTIFACT_INTERACTION_ACTIONS = new Set(["archive", "inspect", "share", "source_run"]);
const MAX_SLACK_USER_GROUP_MENTIONS = 100;

function readString(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];

  return typeof value === "boolean" ? value : undefined;
}

function readArray(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];

  return Array.isArray(value) ? value : undefined;
}

export function slackUserGroupMentionIds(text: string) {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/<!subteam\^(S[A-Z0-9]+)(?:\|[^>]*)?>/gu)) {
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === MAX_SLACK_USER_GROUP_MENTIONS) break;
  }
  return ids;
}

function slackFileAttachments(event: Record<string, unknown>) {
  return readArray(event, "files")
    ?.map((value): ChannelAttachment | undefined => {
      const file = asRecord(value);
      if (!file) return undefined;
      const contentType = readString(file, "mimetype");
      const fileName = readString(file, "name");
      const providerAttachmentId = readString(file, "id");
      const url =
        readString(file, "url_private_download") ??
        readString(file, "url_private") ??
        readString(file, "permalink");
      if (!providerAttachmentId && !url) return undefined;
      const kind = contentType?.startsWith("image/")
        ? ("image" as const)
        : contentType?.startsWith("video/")
          ? ("video" as const)
          : contentType?.startsWith("audio/")
            ? ("audio" as const)
            : contentType === "application/pdf"
              ? ("document" as const)
              : ("other" as const);
      const size = file.size;
      return {
        ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0
          ? { byteSize: size }
          : {}),
        ...(contentType ? { contentType } : {}),
        ...(fileName ? { fileName } : {}),
        kind,
        ...(providerAttachmentId ? { providerAttachmentId } : {}),
        ...(url ? { url } : {}),
      };
    })
    .filter((value): value is ChannelAttachment => value !== undefined);
}

export function parseSlackEventsApiBody(rawBody: string) {
  try {
    return asRecord(JSON.parse(rawBody) as unknown);
  } catch {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload")?.trim();
    if (payload) {
      try {
        return asRecord(JSON.parse(payload) as unknown);
      } catch {
        return undefined;
      }
    }

    const command = params.get("command")?.trim();
    if (!command) {
      return params.get("ssl_check")?.trim() === "1" ? { type: "ssl_check" } : undefined;
    }

    return {
      ...Object.fromEntries(params.entries()),
      type: "slash_command",
    };
  }
}

export function slackExternalThreadKey(args: {
  channel: string;
  requiresApproval?: boolean;
  teamId?: string;
  threadTs?: string;
}) {
  const team = args.teamId?.trim() || "unknown-team";
  const channel = args.channel.trim();
  if (!channel) throw new SlackEventsApiError(400, "Slack channel is required.");

  const routeKind = args.requiresApproval ? "shared:thread" : "thread";
  const thread = args.threadTs?.trim();

  return thread
    ? `slack:${team}:${routeKind}:${channel}:${thread}`
    : `slack:${team}:${routeKind}:${channel}`;
}

function slackEventRequiresExternalReplyApproval(event: Record<string, unknown>) {
  const team = readString(event, "team");
  const contextTeam = readString(event, "context_team_id");

  return (
    readBoolean(event, "is_ext_shared_channel") === true ||
    readBoolean(event, "is_shared") === true ||
    readString(event, "channel_type") === "shared_channel" ||
    (team !== undefined && contextTeam !== undefined && team !== contextTeam)
  );
}

function slackThreadTsForEvent(event: Record<string, unknown>) {
  const threadTs = readString(event, "thread_ts");
  if (threadTs) return threadTs;
  if (readString(event, "channel_type") === "im") return undefined;

  return readString(event, "ts") ?? readString(event, "event_ts");
}

function slackFileSummary(value: unknown) {
  const file = asRecord(value);
  if (!file) return undefined;

  const title =
    readString(file, "title") ??
    readString(file, "name") ??
    readString(file, "id") ??
    "untitled file";
  const mimetype = readString(file, "mimetype");

  return mimetype ? `File shared: ${title} (${mimetype})` : `File shared: ${title}`;
}

function slackEventContent(event: Record<string, unknown>) {
  const text = readString(event, "text");
  const fileSummaries = (readArray(event, "files") ?? [])
    .map(slackFileSummary)
    .filter((summary): summary is string => Boolean(summary));
  const content = [text, ...fileSummaries].filter(Boolean).join("\n").trim();

  return content || undefined;
}

function slackEventMessageId(args: {
  channel: string;
  event: Record<string, unknown>;
  teamId?: string;
}) {
  const messageId = readString(args.event, "client_msg_id") ?? readString(args.event, "ts");
  if (!messageId) return undefined;

  return `slack:${args.teamId ?? "unknown-team"}:${args.channel}:${messageId}`;
}

function isForwardableSlackMessage(event: Record<string, unknown>) {
  if (!readString(event, "channel") || !readString(event, "user")) return false;
  if (readString(event, "bot_id") || readString(event, "app_id")) return false;
  if (!slackEventContent(event)) return false;

  const subtype = readString(event, "subtype");

  return !subtype || FORWARDABLE_MESSAGE_SUBTYPES.has(subtype);
}

function metadata(args: {
  apiAppId?: string;
  body: Record<string, unknown>;
  event: Record<string, unknown>;
  eventType: string;
}) {
  const messageTs =
    readString(args.event, "thread_ts") ??
    readString(args.event, "ts") ??
    readString(args.event, "event_ts");
  const userGroupMentionIds = slackUserGroupMentionIds(readString(args.event, "text") ?? "");
  return {
    ...(args.apiAppId ? { apiAppId: args.apiAppId } : {}),
    ...(readString(args.event, "channel_type")
      ? { channelType: readString(args.event, "channel_type") }
      : {}),
    ...(readString(args.event, "subtype") ? { subtype: readString(args.event, "subtype") } : {}),
    ...(readString(args.body, "event_id")
      ? { slackEventId: readString(args.body, "event_id") }
      : {}),
    ...(messageTs ? { messageTs } : {}),
    ...(userGroupMentionIds.length > 0 ? { slackUserGroupMentionIds: userGroupMentionIds } : {}),
    slackEventType: args.eventType,
  };
}

function slackSlashCommandIngressRequest(
  body: Record<string, unknown>,
  provider: SlackChannelProvider,
) {
  const apiAppId = readString(body, "api_app_id");
  const channel = readString(body, "channel_id");
  const channelName = readString(body, "channel_name");
  const command = readString(body, "command");
  const teamId = readString(body, "team_id");
  const text = readString(body, "text");
  const triggerId = readString(body, "trigger_id");
  const user = readString(body, "user_id");
  const userName = readString(body, "user_name");

  if (!channel || !command || !teamId || !triggerId || !user) {
    throw new SlackEventsApiError(400, "Slack slash command payload is missing required fields.");
  }

  const externalMessageId = `slack-command:${teamId}:${triggerId}`;
  const request: SlackChannelMessageIngressRequest = {
    channel: "slack",
    content: text?.trim() || command,
    ...(apiAppId ? { externalAccountId: apiAppId } : {}),
    externalChannelId: channel,
    externalMessageId,
    externalThreadKey: slackExternalThreadKey({ channel, teamId }),
    externalWorkspaceId: teamId,
    idempotencyKey: externalMessageId,
    metadata: {
      ...(apiAppId ? { apiAppId } : {}),
      ...(channelName ? { channelName } : {}),
      command,
      slackEventType: "slash_command",
    },
    provider,
    sender: {
      ...(userName ? { displayName: userName } : {}),
      id: user,
    },
  };

  return request;
}

function readJsonRecord(value: string | undefined) {
  if (!value) return undefined;

  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function slackInteractionTeamId(body: Record<string, unknown>) {
  const team = asRecord(body.team);
  const user = asRecord(body.user);
  const view = asRecord(body.view);

  return (
    readString(team, "id") ??
    readString(user, "team_id") ??
    readString(view, "team_id") ??
    readString(view, "app_installed_team_id")
  );
}

function artifactActionFromId(actionId: string | undefined) {
  if (!actionId?.startsWith(ARTIFACT_INTERACTION_PREFIX)) return undefined;

  return actionId.slice(ARTIFACT_INTERACTION_PREFIX.length);
}

function slackArtifactInteractionRequest(
  body: Record<string, unknown>,
  provider: SlackChannelProvider,
) {
  const actions = readArray(body, "actions");
  const action = actions?.map(asRecord).find((candidate) => {
    const actionId = readString(candidate, "action_id");
    const actionName = artifactActionFromId(actionId);

    return Boolean(actionName && ARTIFACT_INTERACTION_ACTIONS.has(actionName));
  });
  const actionId = readString(action, "action_id");
  const actionNameFromId = artifactActionFromId(actionId);
  const value = readJsonRecord(readString(action, "value"));
  const actionName = readString(value, "action") ?? actionNameFromId;
  const actionTs = readString(action, "action_ts");
  const apiAppId = readString(body, "api_app_id");
  const channel = asRecord(body.channel);
  const container = asRecord(body.container);
  const message = asRecord(body.message);
  const triggerId = readString(body, "trigger_id");
  const user = asRecord(body.user);
  const artifactId = readString(value, "artifactId");
  const approvalId = readString(value, "approvalId");
  const runId = readString(value, "runId");
  const channelId = readString(channel, "id") ?? readString(container, "channel_id");
  const teamId = slackInteractionTeamId(body);
  const userId = readString(user, "id");

  if (
    !actionName ||
    !ARTIFACT_INTERACTION_ACTIONS.has(actionName) ||
    !artifactId ||
    !channelId ||
    !runId ||
    !teamId ||
    !userId
  ) {
    return undefined;
  }

  const uniqueInteractionId = actionTs ?? triggerId;
  if (!uniqueInteractionId) {
    throw new SlackEventsApiError(400, "Slack interaction payload is missing action identity.");
  }

  const externalMessageId = `slack-interaction:${teamId}:${uniqueInteractionId}`;
  const threadTs = readString(message, "thread_ts") ?? readString(message, "ts");
  const displayAction = actionName === "source_run" ? "source run" : actionName.replace(/_/gu, " ");
  const request: SlackChannelMessageIngressRequest = {
    channel: "slack",
    content: `Artifact ${displayAction} requested for ${artifactId}.`,
    ...(apiAppId ? { externalAccountId: apiAppId } : {}),
    externalChannelId: channelId,
    externalMessageId,
    externalThreadKey: slackExternalThreadKey({
      channel: channelId,
      teamId,
      ...(threadTs ? { threadTs } : {}),
    }),
    externalWorkspaceId: teamId,
    idempotencyKey: externalMessageId,
    metadata: {
      action: actionName,
      ...(actionId ? { actionId } : {}),
      ...(apiAppId ? { apiAppId } : {}),
      artifactId,
      ...(approvalId ? { approvalId } : {}),
      runId,
      slackEventType: "block_actions",
    },
    provider,
    sender: {
      ...(readString(user, "name") ? { displayName: readString(user, "name") } : {}),
      id: userId,
    },
  };

  return request;
}

function slackMessageIngressRequest(
  body: Record<string, unknown>,
  event: Record<string, unknown>,
  eventType: string,
  provider: SlackChannelProvider,
) {
  if (!isForwardableSlackMessage(event)) return undefined;

  const channel = readString(event, "channel");
  const user = readString(event, "user");
  const teamId =
    readString(body, "team_id") ??
    readString(event, "team") ??
    readString(event, "context_team_id");
  if (!channel || !user) return undefined;

  const externalMessageId = slackEventMessageId({
    channel,
    event,
    ...(teamId ? { teamId } : {}),
  });
  const externalWorkspaceId = teamId;
  if (!externalMessageId || !externalWorkspaceId) return undefined;

  const apiAppId = readString(body, "api_app_id");
  const threadTs = slackThreadTsForEvent(event);
  const attachments = slackFileAttachments(event);
  const request: SlackChannelMessageIngressRequest = {
    ...(attachments?.length ? { attachments } : {}),
    channel: "slack",
    content: slackEventContent(event)!,
    ...(apiAppId ? { externalAccountId: apiAppId } : {}),
    externalChannelId: channel,
    externalMessageId,
    externalThreadKey: slackExternalThreadKey({
      channel,
      requiresApproval: slackEventRequiresExternalReplyApproval(event),
      teamId: externalWorkspaceId,
      ...(threadTs ? { threadTs } : {}),
    }),
    externalWorkspaceId,
    idempotencyKey: externalMessageId,
    metadata: metadata({ ...(apiAppId ? { apiAppId } : {}), body, event, eventType }),
    provider,
    sender: { id: user },
  };

  return request;
}

function slackEventsApiActionFromBody(
  body: Record<string, unknown>,
  options: { readonly provider?: SlackChannelProvider } = {},
): SlackEventsApiAction {
  const type = readString(body, "type");
  const provider = options.provider ?? "slack_edge";

  if (type === "url_verification") {
    const challenge = readString(body, "challenge");
    if (!challenge) {
      throw new SlackEventsApiError(400, "Slack URL verification challenge is required.");
    }

    return { challenge, type: "url_verification" };
  }

  if (type === "app_rate_limited") {
    return { reason: "app_rate_limited", type: "ignored" };
  }

  if (type === "ssl_check") {
    return { reason: "ssl_check", type: "ignored" };
  }

  if (type === "slash_command") {
    return { request: slackSlashCommandIngressRequest(body, provider), type: "message" };
  }

  if (type === "block_actions") {
    const request = slackArtifactInteractionRequest(body, provider);
    if (!request) return { reason: "unsupported_slack_interaction", type: "ignored" };

    return { request, type: "message" };
  }

  if (type !== "event_callback") {
    return { reason: "unsupported_slack_callback", type: "ignored" };
  }

  const event = asRecord(body.event);
  if (!event) {
    throw new SlackEventsApiError(400, "Slack Events API payload is missing event.");
  }

  const eventType = readString(event, "type");
  if (eventType !== "message" && eventType !== "app_mention") {
    return { reason: "unsupported_slack_event", type: "ignored" };
  }

  const request = slackMessageIngressRequest(body, event, eventType, provider);
  if (!request) {
    return { reason: "unsupported_slack_message", type: "ignored" };
  }

  return { request, type: "message" };
}

export function slackEventsApiActionFromRequest(args: {
  readonly nowSeconds?: number;
  readonly provider?: SlackChannelProvider;
  readonly rawBody: string;
  readonly signature: string | null;
  readonly signingSecret: string;
  readonly timestamp: string | null;
}): SlackEventsApiAction {
  if (!verifySlackRequestSignature(args)) {
    throw new SlackEventsApiError(401, "Slack request signature is invalid or expired.");
  }
  const body = parseSlackEventsApiBody(args.rawBody);
  if (!body) throw new SlackEventsApiError(400, "Slack request body is invalid.");
  return slackEventsApiActionFromBody(body, args.provider ? { provider: args.provider } : {});
}
