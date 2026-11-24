import {
  jsonObjectProperty,
  objectSchema,
  staticProviderUrl,
} from "../tool-definition-builders.ts";
import { acquisitionRead, acquisitionWrite, bodyFromFields } from "./common.ts";

const HOSTS = ["api.linkedin.com"] as const;

export const linkedinAdsNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: () => `${staticProviderUrl("api.linkedin.com", ["v2", "adAccountsV2"])}?q=search`,
    description: "List LinkedIn Ads accounts accessible to the connected OAuth grant.",
    hosts: HOSTS,
    inputSchema: objectSchema({}),
    provider: "linkedin_ads",
    requiredScopes: ["r_ads"],
    resourceTypes: ["ad_account"],
    sampleInput: {},
    toolName: "linkedin_ads.accounts.list",
  }),
  acquisitionWrite({
    buildBody: (input) =>
      bodyFromFields(input, ["account", "name", "type", "status", "objectiveType", "costType"]),
    buildUrl: () => staticProviderUrl("api.linkedin.com", ["v2", "adCampaignsV2"]),
    description: "Create a LinkedIn Ads campaign after explicit approval.",
    hosts: HOSTS,
    inputSchema: objectSchema({ body: jsonObjectProperty() }, ["body"]),
    method: "POST",
    provider: "linkedin_ads",
    requiredScopes: ["rw_ads"],
    resourceTypes: ["ad_account"],
    sampleInput: { body: { account: "urn:li:sponsoredAccount:1", name: "Approved campaign" } },
    toolName: "linkedin_ads.campaigns.create",
  }),
] as const;
