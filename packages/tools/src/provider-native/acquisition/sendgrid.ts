import {
  jsonObjectProperty,
  objectSchema,
  staticProviderUrl,
  stringProperty,
} from "../tool-definition-builders.ts";
import { acquisitionRead, acquisitionWrite, bodyFromFields, optional } from "./common.ts";

const HOSTS = ["api.sendgrid.com"] as const;

export const sendgridNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl(input) {
      const url = new URL(staticProviderUrl("api.sendgrid.com", ["v3", "stats"]));
      if (optional(input, "startDate"))
        url.searchParams.set("start_date", optional(input, "startDate")!);
      if (optional(input, "endDate")) url.searchParams.set("end_date", optional(input, "endDate")!);
      return url.toString();
    },
    description: "Read SendGrid account email statistics for a bounded date range.",
    hosts: HOSTS,
    inputSchema: objectSchema({ endDate: stringProperty(), startDate: stringProperty() }),
    provider: "sendgrid",
    resourceTypes: ["account"],
    sampleInput: { startDate: "2026-01-01", endDate: "2026-01-31" },
    toolName: "sendgrid.stats.read",
  }),
  acquisitionWrite({
    buildBody: (input) =>
      bodyFromFields(input, ["personalizations", "from", "subject", "content", "template_id"]),
    buildUrl: () => staticProviderUrl("api.sendgrid.com", ["v3", "mail", "send"]),
    description: "Send a SendGrid email after explicit approval.",
    egress: "public",
    hosts: HOSTS,
    inputSchema: objectSchema({ body: jsonObjectProperty() }, ["body"]),
    method: "POST",
    provider: "sendgrid",
    resourceTypes: ["account"],
    sampleInput: { body: { from: { email: "sender@example.com" }, subject: "Approved send" } },
    toolName: "sendgrid.email.send",
  }),
] as const;
