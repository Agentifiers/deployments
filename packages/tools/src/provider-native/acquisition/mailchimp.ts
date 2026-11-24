import { jsonObjectProperty, objectSchema, stringProperty } from "../tool-definition-builders.ts";
import {
  acquisitionRead,
  acquisitionWrite,
  allowlistedProviderBaseUrl,
  bodyFromFields,
  id,
  providerUrl,
} from "./common.ts";

const HOSTS = ["api.mailchimp.com"] as const;

function mailchimpBase(input: Record<string, unknown>): URL {
  const url = allowlistedProviderBaseUrl(input, "baseUrl", "mailchimp", HOSTS);
  url.pathname = "/3.0";
  return url;
}

export const mailchimpNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: (input) => providerUrl(mailchimpBase(input), ["lists"]),
    description: "List Mailchimp audiences accessible to the connected account.",
    hosts: HOSTS,
    inputSchema: objectSchema({}),
    provider: "mailchimp",
    requiredScopes: ["audiences:read"],
    resourceTypes: ["account"],
    sampleInput: { baseUrl: "https://us1.api.mailchimp.com" },
    toolName: "mailchimp.audiences.list",
  }),
  acquisitionWrite({
    buildBody: (input) => bodyFromFields(input, ["type", "recipients", "settings"]),
    buildUrl: (input) => providerUrl(mailchimpBase(input), ["campaigns"]),
    description: "Create a Mailchimp campaign after explicit approval.",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        body: jsonObjectProperty(),
      },
      ["body"],
    ),
    method: "POST",
    provider: "mailchimp",
    requiredScopes: ["campaigns:write"],
    resourceTypes: ["account"],
    sampleInput: {
      body: { type: "regular", recipients: { list_id: "list_1" } },
      baseUrl: "https://us1.api.mailchimp.com",
    },
    toolName: "mailchimp.campaigns.create",
  }),
  acquisitionWrite({
    buildUrl: (input) =>
      providerUrl(mailchimpBase(input), ["campaigns", id(input, "campaignId"), "actions", "send"]),
    description: "Send a Mailchimp campaign after explicit approval.",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        campaignId: stringProperty(),
      },
      ["campaignId"],
    ),
    method: "POST",
    provider: "mailchimp",
    requiredScopes: ["campaigns:send"],
    resourceTypes: ["campaign"],
    sampleInput: { baseUrl: "https://us1.api.mailchimp.com", campaignId: "campaign_1" },
    toolName: "mailchimp.campaigns.send",
  }),
] as const;
