import { asRecord, type ChannelDeliveryResult } from "../../shared/core.ts";
import type { TeamsConnectorClient } from "./connector.ts";
import type { TeamsBotCredentials } from "./credentials.ts";
import { normalizeTeamsServiceUrl, TEAMS_DEFAULT_SERVICE_URL } from "./service-url.ts";

export interface TeamsAgentIdentity {
  readonly displayName: string;
}

export interface TeamsDeliveryPayload {
  readonly conversationId: string;
  readonly serviceUrl: string;
  readonly text: string;
}

/** Teams rejects activities around 28 KB; text is kept well under that with room for the envelope. */
export const TEAMS_MAX_MESSAGE_TEXT_BYTES = 24_000;
const TEAMS_TRUNCATION_NOTICE =
  "\n\n_Response truncated in Teams. Open Deployments.ai to view the complete result._";
const MAX_TEAMS_IDENTITY_DISPLAY_NAME_CHARACTERS = 80;
const MAX_TEAMS_CONVERSATION_ID_CHARACTERS = 1_024;

const utf8 = new TextEncoder();

function utf8ByteLength(codePoint: number) {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

/**
 * Validates a binding's Teams agent identity. Throws a TypeError when invalid so callers never
 * silently drop the label and post as the bare bot.
 */
export function normalizeTeamsAgentIdentity(value: unknown): TeamsAgentIdentity | undefined {
  if (value === undefined || value === null) return undefined;
  const identity = asRecord(value);
  if (!identity) throw new TypeError("Teams agent identity must be an object.");
  if (typeof identity.displayName !== "string") {
    throw new TypeError("Teams agent identity displayName is required.");
  }
  const displayName = identity.displayName.trim();
  const characters = Array.from(displayName);
  if (!characters.length)
    throw new TypeError("Teams agent identity displayName must not be empty.");
  if (characters.length > MAX_TEAMS_IDENTITY_DISPLAY_NAME_CHARACTERS) {
    throw new TypeError(
      `Teams agent identity displayName must not exceed ${String(
        MAX_TEAMS_IDENTITY_DISPLAY_NAME_CHARACTERS,
      )} characters.`,
    );
  }
  if (
    characters.some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    throw new TypeError("Teams agent identity displayName must not contain control characters.");
  }
  return { displayName };
}

/**
 * Renders an optional bold identity label above the body and bounds the result to 24,000 UTF-8
 * bytes, cutting on a code point boundary and appending the Teams truncation notice.
 */
export function teamsMarkdownMessageText(body: string, identity?: TeamsAgentIdentity) {
  const normalizedIdentity = normalizeTeamsAgentIdentity(identity);
  const label = normalizedIdentity
    ? `**${normalizedIdentity.displayName.replace(/[\\`*_~[\]<>#|]/gu, "\\$&")}**\n\n`
    : "";
  const text = `${label}${body}`;
  if (utf8.encode(text).byteLength <= TEAMS_MAX_MESSAGE_TEXT_BYTES) return text;
  const budget = TEAMS_MAX_MESSAGE_TEXT_BYTES - utf8.encode(TEAMS_TRUNCATION_NOTICE).byteLength;
  let used = 0;
  let end = 0;
  for (const character of text) {
    const bytes = utf8ByteLength(character.codePointAt(0)!);
    if (used + bytes > budget) break;
    used += bytes;
    end += character.length;
  }
  return `${text.slice(0, end)}${TEAMS_TRUNCATION_NOTICE}`;
}

function conversationIdText(value: unknown) {
  const conversationId = typeof value === "string" ? value.trim() : "";
  if (!conversationId || conversationId.length > MAX_TEAMS_CONVERSATION_ID_CHARACTERS) {
    throw new TypeError("Teams delivery conversationId is invalid.");
  }
  return conversationId;
}

export function teamsDeliveryPayload(input: {
  readonly body: string;
  readonly conversationId: string;
  readonly identity?: TeamsAgentIdentity;
  readonly serviceUrl?: string;
}): TeamsDeliveryPayload {
  if (!input.body.trim()) throw new TypeError("Teams delivery body must not be empty.");
  return {
    conversationId: conversationIdText(input.conversationId),
    serviceUrl: normalizeTeamsServiceUrl(input.serviceUrl ?? TEAMS_DEFAULT_SERVICE_URL),
    text: teamsMarkdownMessageText(input.body, input.identity),
  };
}

/** Validates a stored `channel-delivery` provider payload before it is sent. */
export function readTeamsDeliveryPayload(value: unknown): TeamsDeliveryPayload {
  const payload = asRecord(value);
  if (!payload) throw new TypeError("Teams delivery payload must be an object.");
  if (typeof payload.serviceUrl !== "string") {
    throw new TypeError("Teams delivery serviceUrl is required.");
  }
  const text = payload.text;
  if (
    typeof text !== "string" ||
    !text.trim() ||
    utf8.encode(text).byteLength > TEAMS_MAX_MESSAGE_TEXT_BYTES
  ) {
    throw new TypeError("Teams delivery text is invalid.");
  }
  return {
    conversationId: conversationIdText(payload.conversationId),
    serviceUrl: normalizeTeamsServiceUrl(payload.serviceUrl),
    text,
  };
}

export async function sendTeamsDelivery(input: {
  readonly client: Pick<TeamsConnectorClient, "sendActivity">;
  readonly credentials: TeamsBotCredentials;
  readonly payload: TeamsDeliveryPayload;
}): Promise<ChannelDeliveryResult> {
  const payload = readTeamsDeliveryPayload(input.payload);
  const { id } = await input.client.sendActivity({
    activity: { text: payload.text, textFormat: "markdown", type: "message" },
    conversationId: payload.conversationId,
    credentials: input.credentials,
    serviceUrl: payload.serviceUrl,
  });
  return id ? { providerMessageId: id } : {};
}
