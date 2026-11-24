import { OPERATIONAL_RECORD_PAGE_LIMIT } from "@deployments-ai/api-contract";
import type { CommandCatalog } from "./types.ts";
import {
  action,
  csv,
  id,
  json,
  list,
  name,
  nullFlag,
  number,
  positional,
  requiredCsv,
  requiredText,
  show,
  text,
} from "./catalog-helpers.ts";

/** Usage, cost, and spend lists page up to the API's ledger page limit. */
const ledgerPagination = {
  limitField: "limit",
  maxLimit: OPERATIONAL_RECORD_PAGE_LIMIT,
  target: "query",
} as const;

const summaryArgs = {
  since: requiredText("Start timestamp on an interval boundary (UTC)", "query"),
  until: requiredText("End timestamp on an interval boundary (UTC), exclusive", "query"),
  interval: text("Bucket width: hour (default) or day", "query"),
  definition: {
    ...text("Only usage of runs that executed this agent definition", "query"),
    field: "agentDefinitionId",
  },
  "workspace-id": {
    ...text("Only usage that names this workspace; not combinable with --definition", "query"),
    field: "workspaceId",
  },
};

export const operationsCommandCatalog: CommandCatalog = {
  webhook: {
    summary: "Signed semantic webhooks",
    actions: {
      create: action({
        summary: "Create a webhook subscription",
        method: "POST",
        path: "/v1/webhooks",
        scope: "environment",
        output: "detail",
        args: {
          name,
          url: requiredText("HTTPS endpoint URL"),
          "event-types": requiredCsv("Semantic event types"),
          "resource-filters": json("Resource filter JSON"),
        },
        sensitiveOutput: true,
        sensitiveOutputFields: ["signingSecret"],
      }),
      list: {
        ...list("/v1/webhooks", "environment", "List webhook subscriptions", {
          limitField: "limit",
          maxLimit: 100,
          target: "query",
        }),
        listField: "webhooks",
      },
      show: action({
        summary: "Show a webhook subscription",
        method: "GET",
        path: "/v1/webhooks/:webhookId",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "webhookId" },
        },
      }),
      archive: action({
        summary: "Archive a webhook subscription",
        method: "POST",
        path: "/v1/webhooks/:webhookId/archive",
        scope: "environment",
        output: "action",
        args: {
          id: { ...id, field: "webhookId" },
        },
        destructive: true,
      }),
      update: action({
        summary: "Update a webhook subscription",
        method: "PATCH",
        path: "/v1/webhooks/:webhookId",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "webhookId" },
          name: text("Webhook subscription name"),
          url: text("HTTPS endpoint URL"),
          "event-types": csv("Semantic event types"),
          "resource-filters": json("Resource filter JSON"),
          "clear-resource-filters": nullFlag("Remove all resource filters", "resourceFilters"),
        },
      }),
      disable: action({
        summary: "Pause deliveries to a webhook subscription",
        method: "POST",
        path: "/v1/webhooks/:webhookId/disable",
        scope: "environment",
        output: "action",
        args: {
          id: { ...id, field: "webhookId" },
        },
      }),
      enable: action({
        summary: "Resume deliveries to a webhook subscription",
        method: "POST",
        path: "/v1/webhooks/:webhookId/enable",
        scope: "environment",
        output: "action",
        args: {
          id: { ...id, field: "webhookId" },
        },
      }),
      "rotate-secret": action({
        summary: "Rotate a webhook signing secret",
        method: "POST",
        path: "/v1/webhooks/:webhookId/rotate-secret",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "webhookId" },
          "previous-secret-expires-in-seconds": number(
            "Seconds the previous secret keeps signing (0 to 604800, default 86400)",
          ),
        },
        sensitiveOutput: true,
        sensitiveOutputFields: ["signingSecret"],
      }),
      test: action({
        summary: "Send a signed test event to a webhook subscription",
        method: "POST",
        path: "/v1/webhooks/:webhookId/test",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "webhookId" },
        },
      }),
    },
  },
  "webhook-delivery": {
    summary: "Webhook delivery attempts",
    actions: {
      list: action({
        summary: "List webhook deliveries",
        method: "GET",
        path: "/v1/webhook-deliveries",
        scope: "environment",
        output: "list",
        listField: "deliveries",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          webhook: {
            ...text("Webhook subscription ID", "query"),
            field: "webhookId",
          },
          status: text(
            "Delivery status: delivered, failed, pending, retrying, or sending",
            "query",
          ),
        },
      }),
      show: action({
        summary: "Show a webhook delivery",
        method: "GET",
        path: "/v1/webhook-deliveries/:deliveryId",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "deliveryId" },
        },
      }),
      attempts: action({
        summary: "List the attempts of a webhook delivery",
        method: "GET",
        path: "/v1/webhook-deliveries/:deliveryId/attempts",
        scope: "environment",
        output: "list",
        listField: "attempts",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          id: { ...id, field: "deliveryId" },
        },
      }),
      retry: action({
        summary: "Retry a delivered or failed webhook delivery",
        method: "POST",
        path: "/v1/webhook-deliveries/:deliveryId/retry",
        scope: "environment",
        output: "action",
        args: {
          id: { ...id, field: "deliveryId" },
        },
      }),
    },
  },
  usage: {
    summary: "Metered usage",
    actions: {
      show: action({
        summary: "Show usage aggregates",
        method: "GET",
        path: "/v1/usage",
        scope: "environment",
        output: "list",
        pagination: ledgerPagination,
        args: {
          since: text("Start timestamp", "query"),
          until: text("End timestamp", "query"),
          metric: text("Usage metric", "query"),
        },
      }),
      summary: action({
        summary: "Summarize usage per metric and hour or day",
        method: "GET",
        path: "/v1/usage/summary",
        scope: "environment",
        output: "detail",
        args: summaryArgs,
      }),
      export: action({
        summary: "Export usage events",
        method: "POST",
        path: "/v1/usage/exports",
        scope: "environment",
        output: "detail",
        args: {
          since: text("Start timestamp"),
          until: text("End timestamp"),
          format: text("Export format"),
        },
        idempotent: true,
        sensitiveOutput: true,
        sensitiveOutputFields: ["value", "export-url"],
      }),
    },
  },
  cost: {
    summary: "Estimated and provider-reported costs",
    actions: {
      show: action({
        summary: "Show cost records",
        method: "GET",
        path: "/v1/costs",
        scope: "environment",
        output: "list",
        pagination: ledgerPagination,
        args: {
          since: text("Start timestamp", "query"),
          until: text("End timestamp", "query"),
        },
      }),
      summary: action({
        summary: "Summarize cost per metric and hour or day",
        method: "GET",
        path: "/v1/costs/summary",
        scope: "environment",
        output: "detail",
        args: summaryArgs,
      }),
    },
  },
  spend: {
    summary: "Spend and cost summaries",
    actions: {
      show: action({
        summary: "Show spend aggregates",
        method: "GET",
        path: "/v1/spend",
        scope: "environment",
        output: "list",
        pagination: ledgerPagination,
        args: {
          since: text("Start timestamp", "query"),
          until: text("End timestamp", "query"),
        },
      }),
      export: action({
        summary: "Export spend records",
        method: "POST",
        path: "/v1/spend/exports",
        scope: "environment",
        output: "detail",
        args: {
          since: text("Start timestamp"),
          until: text("End timestamp"),
          format: text("Export format"),
        },
        idempotent: true,
        sensitiveOutput: true,
        sensitiveOutputFields: ["value", "export-url"],
      }),
    },
  },
  billing: {
    summary: "Billing account summaries",
    actions: {
      show: action({
        summary: "Show the organization billing summary",
        method: "GET",
        path: "/v1/billing",
        scope: "organization",
        output: "detail",
      }),
    },
  },
  audit: {
    summary: "Tenant audit history",
    actions: {
      list: action({
        summary: "List audit events",
        method: "GET",
        path: "/v1/audit-events",
        scope: "environment",
        output: "list",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          since: text("Start timestamp", "query"),
          until: text("End timestamp", "query"),
          actor: text("Actor ID", "query"),
          resource: text("Resource ID", "query"),
          event: text("Event type", "query"),
        },
      }),
      show: show("/v1/audit-events", "environment", "Show an audit event"),
      "organization-list": action({
        summary: "List organization-level audit events",
        method: "GET",
        path: "/v1/organizations/:id/audit-events",
        scope: "organization",
        output: "list",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          "organization-id": { ...positional("Organization ID"), field: "id" },
          since: text("Start timestamp", "query"),
          until: text("End timestamp", "query"),
          actor: text("Actor ID", "query"),
          resource: text("Resource ID", "query"),
          event: text("Event type", "query"),
        },
      }),
    },
  },
};
