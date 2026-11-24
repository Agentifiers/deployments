import type { CommandCatalog } from "./types.ts";
import {
  action,
  create,
  id,
  json,
  lifecycleAction,
  list,
  mutate,
  name,
  positional,
  requiredJson,
  requiredText,
  show,
  text,
} from "./catalog-helpers.ts";

const pagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;

export const emailCommandCatalog: CommandCatalog = {
  "email-tenant": {
    summary: "Platform sending tenants",
    actions: {
      create: create("/v1/email/tenants", "environment", { name }, "Create a sending tenant"),
      list: list("/v1/email/tenants", "environment", "List sending tenants", pagination),
      get: show("/v1/email/tenants", "environment", "Get a sending tenant"),
      update: mutate(
        "PATCH",
        "/v1/email/tenants",
        "environment",
        "Update or explicitly pause/reinstate a sending tenant",
        {
          id,
          name: text("Tenant name"),
          status: text("active or paused"),
        },
      ),
    },
  },
  "email-domain": {
    summary: "Send-only domain ownership and DNS verification",
    actions: {
      create: action({
        summary: "Register a sending domain ownership challenge",
        method: "POST",
        path: "/v1/email/tenants/:tenantId/domains",
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: {
          tenantId: positional("Sending tenant ID"),
          domain: requiredText("DNS domain name"),
        },
      }),
      list: action({
        summary: "List a tenant's sending domains",
        method: "GET",
        path: "/v1/email/tenants/:tenantId/domains",
        scope: "environment",
        output: "list",
        pagination,
        args: { tenantId: positional("Sending tenant ID") },
      }),
      get: show(
        "/v1/email/domains",
        "environment",
        "Get sending domain DNS and verification state",
      ),
      refresh: lifecycleAction(
        "/v1/email/domains",
        "refresh",
        "environment",
        "Refresh sending domain ownership and DNS verification",
        { id },
      ),
      revoke: mutate("DELETE", "/v1/email/domains", "environment", "Revoke a sending domain", {
        id,
      }),
    },
  },
  email: {
    summary: "Platform tenant-scoped email delivery",
    actions: {
      send: action({
        summary: "Send email and return the provider acceptance receipt",
        method: "POST",
        path: "/v1/email/tenants/:tenantId/messages",
        scope: "environment",
        output: "action",
        idempotent: true,
        args: {
          tenantId: positional("Sending tenant ID"),
          from: requiredText("Sender mailbox; display name allowed"),
          to: requiredJson("JSON array of recipient mailboxes"),
          cc: json("JSON array of CC mailboxes"),
          bcc: json("JSON array of BCC mailboxes"),
          "reply-to": json("JSON array of reply-to mailboxes"),
          subject: requiredText("Message subject"),
          text: text("Plain-text body; prefer --text-file or --text-env for secrets", "control"),
          html: text("HTML body; prefer --html-file or --html-env for secrets", "control"),
          "text-file": text("File containing the plain-text body", "control"),
          "html-file": text("File containing the HTML body", "control"),
          "text-env": text("Environment variable containing the plain-text body", "control"),
          "html-env": text("Environment variable containing the HTML body", "control"),
        },
        secretInputs: [
          {
            directArgument: "text",
            environmentArgument: "text-env",
            fileArgument: "text-file",
            bodyField: "text",
            format: "text",
            required: false,
          },
          {
            directArgument: "html",
            environmentArgument: "html-env",
            fileArgument: "html-file",
            bodyField: "html",
            format: "text",
            required: false,
          },
        ],
        sensitiveOutput: true,
        sensitiveOutputFields: ["text", "html", "subject", "from", "to", "cc", "bcc", "replyTo"],
      }),
    },
  },
};
