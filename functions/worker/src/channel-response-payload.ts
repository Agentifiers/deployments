import {
  externalThreadTarget,
  telegramDeliveryParts,
  telegramDeliveryPayload,
} from "@deployments-ai/channel-adapters";
import {
  slackMarkdownMessageText,
  slackMessageIdentityPayload,
  slackStreamMarkdownText,
  slackTerminalChunks,
} from "@deployments-ai/channel-adapters/slack";
import {
  allowedTeamsServiceUrl,
  normalizeTeamsAgentIdentity,
  TEAMS_DEFAULT_SERVICE_URL,
  teamsDeliveryPayload,
} from "@deployments-ai/channel-adapters/teams";
import type { PlatformRecord } from "@deployments-ai/db";

type Binding = Extract<PlatformRecord, { readonly itemType: "channel-binding" }>;

export const MAX_AUTOMATIC_CHANNEL_RESPONSE_CHARACTERS = 40_000;
const INVALID_SLACK_IDENTITY_ERROR = "Slack channel binding has an invalid agent identity.";
const INVALID_TEAMS_IDENTITY_ERROR = "Teams channel binding has an invalid agent identity.";
const INVALID_TEAMS_ROUTE_ERROR = "Teams delivery route is not an allowed Bot Connector endpoint.";
const SLACK_FALLBACK_TRUNCATION_NOTICE =
  "\n\n_Response truncated in Slack. Open Deployments.ai to view the complete result._";
const TEAMS_FALLBACK_TRUNCATION_NOTICE =
  "\n\n_Response truncated in Teams. Open Deployments.ai to view the complete result._";

export function slackThreadTs(externalThreadKey: string) {
  const parts = externalThreadKey.split(":");
  if (parts[0] !== "slack") return undefined;
  if (parts[2] === "thread" && parts.length === 5) return parts[4];
  if (parts[2] === "shared" && parts[3] === "thread" && parts.length === 6) return parts[5];
  return undefined;
}

/**
 * The delivery body of a run that streamed (or tried to stream) to its channel: the streamed
 * terminal text, bounded to the automatic-response limit so a long streamed result still falls
 * back instead of failing the delivery.
 */
export function streamFallbackBody(channel: "slack" | "teams", content: string) {
  const [body, notice] =
    channel === "slack"
      ? [
          slackStreamMarkdownText(slackTerminalChunks({ body: content, status: "completed" })),
          SLACK_FALLBACK_TRUNCATION_NOTICE,
        ]
      : [content, TEAMS_FALLBACK_TRUNCATION_NOTICE];
  const characters = Array.from(body);
  if (characters.length <= MAX_AUTOMATIC_CHANNEL_RESPONSE_CHARACTERS) return body;
  return (
    characters
      .slice(0, MAX_AUTOMATIC_CHANNEL_RESPONSE_CHARACTERS - Array.from(notice).length)
      .join("") + notice
  );
}

function teamsProviderPayload(binding: Binding, body: string, input: ProviderPayloadInput) {
  let identity;
  try {
    identity = normalizeTeamsAgentIdentity(binding.data.metadata?.teamsAgentIdentity);
  } catch {
    return { error: INVALID_TEAMS_IDENTITY_ERROR } as const;
  }
  const serviceUrl = input.teamsServiceUrl
    ? allowedTeamsServiceUrl(input.teamsServiceUrl)
    : TEAMS_DEFAULT_SERVICE_URL;
  if (!serviceUrl) return { error: INVALID_TEAMS_ROUTE_ERROR } as const;
  try {
    return {
      payload: teamsDeliveryPayload({
        body,
        conversationId: externalThreadTarget(input.externalThreadKey),
        ...(identity ? { identity } : {}),
        serviceUrl,
      }),
    } as const;
  } catch {
    return { error: INVALID_TEAMS_ROUTE_ERROR } as const;
  }
}

interface ProviderPayloadInput {
  readonly externalChannelId: string | undefined;
  readonly externalThreadKey: string;
  /** Bot Connector service URL from Teams ingress metadata. */
  readonly teamsServiceUrl: string | undefined;
}

/**
 * The provider payload stored on an automatic `channel-delivery`, or the terminal delivery error
 * when the binding cannot deliver it (for example an invalid agent identity).
 */
export function channelResponseProviderPayload(
  binding: Binding,
  body: string,
  input: ProviderPayloadInput,
): { readonly error: string } | { readonly payload: unknown } {
  if (binding.data.provider === "telegram") {
    const payloads = telegramDeliveryParts({ content: body, hasImage: false }).map((part) =>
      telegramDeliveryPayload({
        content: part.content,
        externalThreadKey: input.externalThreadKey,
      }),
    );
    return { payload: payloads.length === 1 ? payloads[0]! : payloads };
  }
  if (binding.data.provider === "teams_bot_framework") {
    return teamsProviderPayload(binding, body, input);
  }
  let slackIdentity = {};
  if (binding.data.provider === "slack_edge" || binding.data.provider === "slack_cloudflare_edge") {
    try {
      slackIdentity = slackMessageIdentityPayload(binding.data.metadata?.slackAgentIdentity);
    } catch {
      return { error: INVALID_SLACK_IDENTITY_ERROR };
    }
  }
  if (!input.externalChannelId) {
    throw new Error(`${binding.data.provider} delivery requires an external channel ID.`);
  }
  const threadTs = slackThreadTs(input.externalThreadKey);
  return {
    payload: {
      channel: input.externalChannelId,
      // Slack posts standard Markdown, bounded to its `markdown_text` limit. The full delivery body
      // stays the preview and external publication content, so history keeps the complete result.
      ...(binding.data.channel === "slack"
        ? { markdown_text: slackMarkdownMessageText(body) }
        : { text: body }),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...slackIdentity,
    },
  };
}
