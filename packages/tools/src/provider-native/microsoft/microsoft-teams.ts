import {
  readTeamsDataVisualizationAdaptiveCards,
  SLACK_DATA_VISUALIZATION_SPEC_ARRAY_INPUT_SCHEMA,
  teamsGraphAdaptiveCardAttachment,
} from "@deployments-ai/channel-adapters";
import {
  isPlainRecord,
  jsonProviderNativeBody,
  optionalToolBoolean,
  optionalToolString,
  requirePositiveLimit,
  requireToolString,
  type ProviderNativeHttpToolDefinition,
  type ProviderNativeInputSchemaProperty,
} from "../core.ts";
import { ProviderNativeExecutionKnownFailureError } from "../executor.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TEAMS_PROVIDER = "microsoft_teams";
const TEAM_READ_SCOPES = Object.freeze(["Team.ReadBasic.All"]);
const CHANNEL_READ_SCOPES = Object.freeze(["Channel.ReadBasic.All"]);
const CHANNEL_MESSAGE_READ_SCOPES = Object.freeze(["ChannelMessage.Read.All"]);
const CHANNEL_MESSAGE_SEND_SCOPES = Object.freeze(["ChannelMessage.Send"]);
const USER_READ_SCOPES = Object.freeze(["User.ReadBasic.All"]);
const RESOURCE_CONDITIONAL_SCOPES: readonly string[] = [];
/** Graph pages channel messages and replies at most 50 items per request. */
const MAX_MESSAGE_PAGE_SIZE = 50;
const RETRY_POLICY = {
  baseDelayMs: 500,
  maxAttempts: 3,
  maxDelayMs: 5_000,
  respectRetryAfter: true,
  retryableStatusCodes: [408, 425, 429, 500, 502, 503, 504],
} as const;
const ID_PROPERTY = { minLength: 1, type: "string" } as const;
const MESSAGE_PAGE_PROPERTIES = {
  cursor: {
    description: "The @odata.nextLink URL or $skiptoken from a previous page.",
    minLength: 1,
    type: "string",
  },
  limit: { maximum: MAX_MESSAGE_PAGE_SIZE, minimum: 1, type: "integer" },
} as const;

function graphPath(...segments: readonly string[]): URL {
  return new URL(`${GRAPH_BASE}/${segments.map(encodeURIComponent).join("/")}`);
}

/** Accepts either a Graph `@odata.nextLink` or its bare `$skiptoken` value. */
function graphSkipToken(cursor: string): string {
  if (!/^https?:\/\//iu.test(cursor)) return cursor;
  const url = new URL(cursor);
  const token = url.searchParams.get("$skiptoken");
  if (url.protocol !== "https:" || url.hostname !== "graph.microsoft.com" || !token) {
    throw new Error("Tool input cursor must be a Microsoft Graph nextLink or $skiptoken.");
  }
  return token;
}

function channelMessagesUrl(input: Record<string, unknown>, replies: boolean): string {
  const segments = [
    "teams",
    requireToolString(input, "teamId"),
    "channels",
    requireToolString(input, "channelId"),
    "messages",
    ...(replies ? [requireToolString(input, "messageId"), "replies"] : []),
  ];
  const url = graphPath(...segments);
  url.searchParams.set(
    "$top",
    String(requirePositiveLimit(input, "limit", 20, MAX_MESSAGE_PAGE_SIZE)),
  );
  if (!replies && optionalToolBoolean(input, "includeReplies")) {
    url.searchParams.set("$expand", "replies");
  }
  const cursor = optionalToolString(input, "cursor");
  if (cursor) url.searchParams.set("$skiptoken", graphSkipToken(cursor));
  return url.toString();
}

function userLookupScopes(input: Record<string, unknown>): readonly string[] {
  const identifiers = [optionalToolString(input, "email"), optionalToolString(input, "userId")];
  if (identifiers.filter(Boolean).length !== 1) {
    throw new Error("Exactly one of email or userId is required.");
  }
  return USER_READ_SCOPES;
}

function knownFailure(toolName: string, message: string): never {
  throw new ProviderNativeExecutionKnownFailureError(toolName, new Error(message));
}

/**
 * Graph reports failures with non-2xx statuses (classified by the executor); this validator
 * rejects 2xx payloads that carry a Graph error envelope or lack the documented shape.
 */
function graphResponseValidator(toolName: string, shape: "collection" | "entity" | "match") {
  return (_response: Response, value: unknown) => {
    if (!isPlainRecord(value))
      knownFailure(toolName, "Microsoft Teams returned an invalid response.");
    if (isPlainRecord(value.error)) {
      const code = value.error.code;
      knownFailure(
        toolName,
        typeof code === "string" && code.trim()
          ? `Microsoft Teams rejected the request: ${code.trim()}.`
          : "Microsoft Teams rejected the request.",
      );
    }
    if (shape === "entity") {
      if (typeof value.id !== "string" || !value.id) {
        knownFailure(toolName, "Microsoft Teams returned an invalid response.");
      }
      return;
    }
    if (!Array.isArray(value.value)) {
      knownFailure(toolName, "Microsoft Teams returned an invalid response.");
    }
    if (shape === "match" && value.value.length === 0) {
      knownFailure(toolName, "Microsoft Teams user was not found.");
    }
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function postMessageBody(input: Record<string, unknown>) {
  const text = requireToolString(input, "text");
  const contentType = optionalToolString(input, "contentType") ?? "text";
  if (contentType !== "text" && contentType !== "html") {
    throw new Error("Tool input contentType must be text or html.");
  }
  const explicitCards = input.adaptiveCards ?? [];
  if (!Array.isArray(explicitCards) || !explicitCards.every(isPlainRecord)) {
    throw new Error("Tool input adaptiveCards must be an array of objects.");
  }
  const subject = optionalToolString(input, "subject");
  if (subject && optionalToolString(input, "replyToMessageId")) {
    throw new Error("Tool input subject is only supported on new channel messages.");
  }
  const attachments = [
    ...explicitCards,
    ...readTeamsDataVisualizationAdaptiveCards(input.dataVisualizations),
  ].map(teamsGraphAdaptiveCardAttachment);
  // Graph renders each attachment where its placeholder appears, which requires an HTML body.
  const html = contentType === "html" || attachments.length > 0;
  const content =
    contentType === "html" || attachments.length === 0
      ? text
      : escapeHtml(text).replaceAll(/\r?\n/gu, "<br>");
  return jsonProviderNativeBody({
    ...(attachments.length > 0 ? { attachments } : {}),
    body: {
      content: `${content}${attachments.map((attachment) => `<attachment id="${attachment.id}"></attachment>`).join("")}`,
      contentType: html ? "html" : "text",
    },
    ...(subject ? { subject } : {}),
  });
}

export const microsoftTeamsNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] =
  [
    {
      toolName: "microsoft_teams.teams.list",
      description: "List the Microsoft Teams teams the connected user has joined.",
      effect: "read",
      provider: TEAMS_PROVIDER,
      requiredScopes: TEAM_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "microsoft-teams-teams",
      retryPolicy: RETRY_POLICY,
      inputSchema: { additionalProperties: false, properties: {}, type: "object" },
      buildUrl: () => `${GRAPH_BASE}/me/joinedTeams`,
      validateResponse: graphResponseValidator("microsoft_teams.teams.list", "collection"),
    },
    {
      toolName: "microsoft_teams.channels.list",
      description: "List channels in a Microsoft Teams team visible to the connected user.",
      effect: "read",
      provider: TEAMS_PROVIDER,
      requiredScopes: CHANNEL_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "microsoft-teams-channels",
      retryPolicy: RETRY_POLICY,
      inputSchema: {
        additionalProperties: false,
        properties: {
          membershipType: { enum: ["private", "shared", "standard"], type: "string" },
          teamId: ID_PROPERTY,
        },
        required: ["teamId"],
        type: "object",
      },
      buildUrl(input) {
        const url = graphPath("teams", requireToolString(input, "teamId"), "channels");
        const membershipType = optionalToolString(input, "membershipType");
        if (membershipType) {
          if (!["private", "shared", "standard"].includes(membershipType)) {
            throw new Error("Tool input membershipType is invalid.");
          }
          url.searchParams.set("$filter", `membershipType eq '${membershipType}'`);
        }
        return url.toString();
      },
      validateResponse: graphResponseValidator("microsoft_teams.channels.list", "collection"),
    },
    {
      toolName: "microsoft_teams.messages.list",
      description: "Read recent messages from a Microsoft Teams channel.",
      effect: "read",
      provider: TEAMS_PROVIDER,
      requiredScopes: CHANNEL_MESSAGE_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "microsoft-teams-channel-messages",
      retryPolicy: RETRY_POLICY,
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...MESSAGE_PAGE_PROPERTIES,
          channelId: ID_PROPERTY,
          includeReplies: { type: "boolean" },
          teamId: ID_PROPERTY,
        },
        required: ["teamId", "channelId"],
        type: "object",
      },
      buildUrl: (input) => channelMessagesUrl(input, false),
      validateResponse: graphResponseValidator("microsoft_teams.messages.list", "collection"),
    },
    {
      toolName: "microsoft_teams.messages.replies",
      description: "Read replies to a Microsoft Teams channel message thread.",
      effect: "read",
      provider: TEAMS_PROVIDER,
      requiredScopes: CHANNEL_MESSAGE_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "microsoft-teams-message-replies",
      retryPolicy: RETRY_POLICY,
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...MESSAGE_PAGE_PROPERTIES,
          channelId: ID_PROPERTY,
          messageId: ID_PROPERTY,
          teamId: ID_PROPERTY,
        },
        required: ["teamId", "channelId", "messageId"],
        type: "object",
      },
      buildUrl: (input) => channelMessagesUrl(input, true),
      validateResponse: graphResponseValidator("microsoft_teams.messages.replies", "collection"),
    },
    {
      toolName: "microsoft_teams.users.lookup",
      description:
        "Look up a Microsoft Teams user by email address, user ID, or user principal name.",
      effect: "read",
      provider: TEAMS_PROVIDER,
      authorizationScopes: USER_READ_SCOPES,
      requiredScopes: RESOURCE_CONDITIONAL_SCOPES,
      requiredScopesForInput: userLookupScopes,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "microsoft-teams-user",
      retryPolicy: RETRY_POLICY,
      inputSchema: {
        additionalProperties: false,
        properties: {
          email: { type: "string" },
          userId: {
            description: "Microsoft Entra object ID or user principal name.",
            type: "string",
          },
        },
        type: "object",
      },
      buildUrl(input) {
        userLookupScopes(input);
        const email = optionalToolString(input, "email");
        if (!email) return graphPath("users", requireToolString(input, "userId")).toString();
        const url = graphPath("users");
        url.searchParams.set("$filter", `mail eq '${email.replaceAll("'", "''")}'`);
        url.searchParams.set("$top", "1");
        return url.toString();
      },
      validateResponse(response, value, input) {
        graphResponseValidator(
          "microsoft_teams.users.lookup",
          optionalToolString(input, "email") ? "match" : "entity",
        )(response, value);
      },
    },
    {
      toolName: "microsoft_teams.post_message",
      description: "Post a message or thread reply to a Microsoft Teams channel after approval.",
      effect: "write",
      effectMetadata: {
        allowedEffects: ["write"],
        outboundMutation: true,
        writeRequiresApproval: true,
      },
      provider: TEAMS_PROVIDER,
      requiredScopes: CHANNEL_MESSAGE_SEND_SCOPES,
      defaultPolicyAction: "require_approval",
      method: "POST",
      filePrefix: "microsoft-teams-message",
      handoffResultStatus: "published",
      inputSchema: {
        additionalProperties: false,
        properties: {
          adaptiveCards: { items: { type: "object" }, type: "array" },
          channelId: ID_PROPERTY,
          contentType: { enum: ["html", "text"], type: "string" },
          dataVisualizations:
            SLACK_DATA_VISUALIZATION_SPEC_ARRAY_INPUT_SCHEMA as unknown as ProviderNativeInputSchemaProperty,
          replyToMessageId: { type: "string" },
          subject: { type: "string" },
          teamId: ID_PROPERTY,
          text: { minLength: 1, type: "string" },
        },
        required: ["teamId", "channelId", "text"],
        type: "object",
      },
      buildUrl(input) {
        const replyTo = optionalToolString(input, "replyToMessageId");
        return graphPath(
          "teams",
          requireToolString(input, "teamId"),
          "channels",
          requireToolString(input, "channelId"),
          "messages",
          ...(replyTo ? [replyTo, "replies"] : []),
        ).toString();
      },
      buildBody: postMessageBody,
      successSummary: (_response, input) =>
        optionalToolString(input, "replyToMessageId")
          ? "Posted a Microsoft Teams thread reply."
          : "Posted a Microsoft Teams message.",
      validateResponse: graphResponseValidator("microsoft_teams.post_message", "entity"),
    },
  ];
