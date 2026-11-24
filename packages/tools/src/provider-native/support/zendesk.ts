import {
  appendNativeQueryFields,
  jsonProviderNativeBody,
  optionalToolBoolean,
  optionalToolObject,
  optionalToolString,
  optionalToolStringArray,
  requireToolString,
  type ProviderNativeBody,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";

const GENERIC_READ_SCOPES = ["read"] as const;
const GENERIC_WRITE_SCOPES = ["write"] as const;

function zendeskBaseUrl(input: Record<string, unknown>): URL {
  const subdomain = requireToolString(input, "subdomain");
  if (!/^[a-z0-9][a-z0-9-]*$/iu.test(subdomain)) {
    throw new Error("Tool input subdomain must be a Zendesk subdomain");
  }
  return new URL(`https://${subdomain}.zendesk.com`);
}

function optionalToolScalar(
  input: Record<string, unknown>,
  key: string,
): boolean | number | string | undefined {
  const value = input[key];
  if (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  ) {
    return value;
  }
  return undefined;
}

function addZendeskTicketFields(
  ticket: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  for (const [inputKey, ticketKey] of [
    ["assigneeId", "assignee_id"],
    ["brandId", "brand_id"],
    ["dueAt", "due_at"],
    ["externalId", "external_id"],
    ["groupId", "group_id"],
    ["organizationId", "organization_id"],
    ["priority", "priority"],
    ["requesterId", "requester_id"],
    ["status", "status"],
    ["subject", "subject"],
    ["submitterId", "submitter_id"],
    ["type", "type"],
  ] as const) {
    const value = optionalToolScalar(input, inputKey);
    if (value !== undefined && value !== "") ticket[ticketKey] = value;
  }
  const tags = optionalToolStringArray(input, "tags");
  if (tags && tags.length > 0) ticket.tags = tags;
  const customFields = input.customFields ?? input.custom_fields;
  if (Array.isArray(customFields)) ticket.custom_fields = customFields;
  const requester = optionalToolObject(input, "requester");
  if (requester) ticket.requester = requester;
}

function zendeskTicketCreateBody(input: Record<string, unknown>): ProviderNativeBody {
  const ticket = optionalToolObject(input, "ticket");
  if (ticket) return jsonProviderNativeBody({ ticket });
  const body = requireToolString(input, "body");
  const builtTicket: Record<string, unknown> = {
    comment: {
      body,
      public: optionalToolBoolean(input, "public") ?? false,
    },
    subject: requireToolString(input, "subject"),
  };
  addZendeskTicketFields(builtTicket, input);
  return jsonProviderNativeBody({ ticket: builtTicket });
}

function zendeskTicketUpdateBody(input: Record<string, unknown>): ProviderNativeBody {
  const ticket = optionalToolObject(input, "ticket");
  if (ticket) return jsonProviderNativeBody({ ticket });
  const builtTicket: Record<string, unknown> = {};
  addZendeskTicketFields(builtTicket, input);
  const body = optionalToolString(input, "body");
  if (body) {
    builtTicket.comment = {
      body,
      public: optionalToolBoolean(input, "public") ?? false,
    };
  }
  if (Object.keys(builtTicket).length === 0) {
    throw new Error("Tool input ticket or at least one Zendesk ticket update field is required");
  }
  return jsonProviderNativeBody({ ticket: builtTicket });
}

export const zendeskNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "zendesk.tickets.search",
    description: "Search Zendesk tickets for support triage.",
    effect: "read",
    provider: "zendesk",
    requiredScopes: GENERIC_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "zendesk-tickets-search",
    buildUrl(input) {
      const url = zendeskBaseUrl(input);
      url.pathname = "/api/v2/search.json";
      url.searchParams.set("query", requireToolString(input, "query"));
      appendNativeQueryFields(url, input, ["page", "per_page", "sort_by", "sort_order"]);
      return url.toString();
    },
  },
  {
    toolName: "zendesk.tickets.get",
    description: "Read a Zendesk ticket by id before planning a reply or update.",
    effect: "read",
    provider: "zendesk",
    requiredScopes: GENERIC_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "zendesk-ticket",
    buildUrl(input) {
      const url = zendeskBaseUrl(input);
      url.pathname = `/api/v2/tickets/${encodeURIComponent(requireToolString(input, "ticketId"))}.json`;
      appendNativeQueryFields(url, input, ["include"]);
      return url.toString();
    },
  },
  {
    toolName: "zendesk.tickets.create",
    description: "Create a Zendesk ticket after approval.",
    effect: "write",
    provider: "zendesk",
    requiredScopes: GENERIC_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "zendesk-ticket-create",
    buildUrl(input) {
      const url = zendeskBaseUrl(input);
      url.pathname = "/api/v2/tickets.json";
      return url.toString();
    },
    buildBody: zendeskTicketCreateBody,
  },
  {
    toolName: "zendesk.tickets.update",
    description: "Update a Zendesk ticket after approval.",
    effect: "write",
    provider: "zendesk",
    requiredScopes: GENERIC_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "PUT",
    filePrefix: "zendesk-ticket-update",
    buildUrl(input) {
      const url = zendeskBaseUrl(input);
      url.pathname = `/api/v2/tickets/${encodeURIComponent(requireToolString(input, "ticketId"))}.json`;
      return url.toString();
    },
    buildBody: zendeskTicketUpdateBody,
  },
  {
    toolName: "zendesk.ticket_reply.create",
    description: "Add a Zendesk ticket comment or reply after approval.",
    effect: "write",
    provider: "zendesk",
    requiredScopes: GENERIC_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "PUT",
    filePrefix: "zendesk-ticket-reply",
    buildUrl(input) {
      const url = zendeskBaseUrl(input);
      url.pathname = `/api/v2/tickets/${encodeURIComponent(requireToolString(input, "ticketId"))}.json`;
      return url.toString();
    },
    buildBody: (input) =>
      jsonProviderNativeBody({
        ticket: {
          comment: {
            body: requireToolString(input, "body"),
            public: optionalToolBoolean(input, "public") ?? false,
          },
          ...(optionalToolString(input, "status")
            ? { status: optionalToolString(input, "status") }
            : {}),
        },
      }),
  },
];
