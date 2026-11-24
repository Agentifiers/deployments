import {
  appendNativeQueryFields,
  jsonProviderNativeBody,
  optionalToolObject,
  optionalToolString,
  requirePositiveLimit,
  requireToolString,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";
import { requiredObject } from "../tool-input-guards.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const OUTLOOK_MAIL_READ_SCOPES = ["Mail.Read"] as const;
const OUTLOOK_DRAFT_WRITE_SCOPES = ["Mail.ReadWrite"] as const;
const OUTLOOK_SEND_SCOPES = ["Mail.Send"] as const;
const OUTLOOK_CALENDAR_READ_SCOPES = ["Calendars.Read"] as const;
const OUTLOOK_CALENDAR_WRITE_SCOPES = ["Calendars.ReadWrite"] as const;

function graphHeaders(): Record<string, string> {
  return { accept: "application/json" };
}

export const microsoftOutlookNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] =
  [
    {
      toolName: "microsoft_outlook.messages.search",
      description: "Search Microsoft Outlook messages for customer and operational context.",
      effect: "read",
      provider: "microsoft-outlook",
      requiredScopes: OUTLOOK_MAIL_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "outlook-messages-search",
      buildUrl(input) {
        const url = new URL(`${GRAPH_BASE}/me/messages`);
        url.searchParams.set("$top", String(requirePositiveLimit(input, "limit", 25, 100)));
        const query = optionalToolString(input, "query");
        if (query) url.searchParams.set("$search", `"${query.replaceAll('"', "")}"`);
        appendNativeQueryFields(url, input, ["$filter", "$orderby", "$select", "$skiptoken"]);
        return url.toString();
      },
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_outlook.messages.get",
      description: "Read one Microsoft Outlook message by id.",
      effect: "read",
      provider: "microsoft-outlook",
      requiredScopes: OUTLOOK_MAIL_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "outlook-message",
      buildUrl(input) {
        const url = new URL(
          `${GRAPH_BASE}/me/messages/${encodeURIComponent(requireToolString(input, "messageId"))}`,
        );
        appendNativeQueryFields(url, input, ["$select", "$expand"]);
        return url.toString();
      },
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_outlook.drafts.create",
      description: "Create a Microsoft Outlook draft after approval.",
      effect: "write",
      provider: "microsoft-outlook",
      requiredScopes: OUTLOOK_DRAFT_WRITE_SCOPES,
      defaultPolicyAction: "require_approval",
      method: "POST",
      filePrefix: "outlook-draft-create",
      buildUrl: () => `${GRAPH_BASE}/me/messages`,
      buildBody: (input) => jsonProviderNativeBody(requiredObject(input, "message")),
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_outlook.messages.send",
      description: "Send a Microsoft Outlook message after approval.",
      effect: "write",
      provider: "microsoft-outlook",
      requiredScopes: OUTLOOK_SEND_SCOPES,
      defaultPolicyAction: "require_approval",
      method: "POST",
      filePrefix: "outlook-message-send",
      buildUrl: () => `${GRAPH_BASE}/me/sendMail`,
      buildBody: (input) =>
        jsonProviderNativeBody({
          message: requiredObject(input, "message"),
          saveToSentItems: input.saveToSentItems !== false,
        }),
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_outlook.messages.reply",
      description: "Reply to a Microsoft Outlook message after approval.",
      effect: "write",
      provider: "microsoft-outlook",
      requiredScopes: OUTLOOK_SEND_SCOPES,
      defaultPolicyAction: "require_approval",
      method: "POST",
      filePrefix: "outlook-message-reply",
      buildUrl: (input) =>
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(requireToolString(input, "messageId"))}/reply`,
      buildBody: (input) =>
        jsonProviderNativeBody({
          comment: requireToolString(input, "comment"),
          ...(optionalToolObject(input, "message")
            ? { message: optionalToolObject(input, "message") }
            : {}),
        }),
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_outlook.events.list",
      description: "List Microsoft Outlook calendar events in a time window.",
      effect: "read",
      provider: "microsoft-outlook",
      requiredScopes: OUTLOOK_CALENDAR_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "outlook-events-list",
      buildUrl(input) {
        const startDateTime = requireToolString(input, "startDateTime");
        const endDateTime = requireToolString(input, "endDateTime");
        const url = new URL(`${GRAPH_BASE}/me/calendarView`);
        url.searchParams.set("startDateTime", startDateTime);
        url.searchParams.set("endDateTime", endDateTime);
        url.searchParams.set("$top", String(requirePositiveLimit(input, "limit", 50, 100)));
        appendNativeQueryFields(url, input, ["$orderby", "$select", "$skiptoken"]);
        return url.toString();
      },
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_outlook.events.create",
      description: "Create a Microsoft Outlook calendar event after approval.",
      effect: "write",
      provider: "microsoft-outlook",
      requiredScopes: OUTLOOK_CALENDAR_WRITE_SCOPES,
      defaultPolicyAction: "require_approval",
      method: "POST",
      filePrefix: "outlook-event-create",
      buildUrl: () => `${GRAPH_BASE}/me/events`,
      buildBody: (input) => jsonProviderNativeBody(requiredObject(input, "event")),
      buildHeaders: graphHeaders,
    },
  ];
