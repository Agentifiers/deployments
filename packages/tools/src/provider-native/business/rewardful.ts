import { integerProperty, objectSchema, stringProperty } from "../tool-definition-builders.ts";
import { businessRead, queryProviderUrl } from "./common.ts";

const HOSTS = ["api.getrewardful.com"] as const;

export const rewardfulNativeHttpToolDefinitions = [
  businessRead({
    buildUrl: (input) =>
      queryProviderUrl("api.getrewardful.com", ["v1", "referrals"], input, [
        "affiliate_id",
        "conversion_state",
        "email",
        "limit",
        "page",
        "stripe_customer_id",
        "updated_since",
        "updated_until",
      ]),
    description: "List Rewardful referrals accessible to the connected account.",
    expectedHost: "api.getrewardful.com",
    hosts: HOSTS,
    inputSchema: objectSchema({
      affiliate_id: stringProperty("Optional Rewardful affiliate ID filter."),
      conversion_state: stringProperty("Optional referral conversion-state filter."),
      email: stringProperty("Optional referred customer email filter."),
      limit: integerProperty(1, 100),
      page: integerProperty(),
      stripe_customer_id: stringProperty("Optional Stripe customer ID filter."),
      updated_since: stringProperty("Optional lower-bound timestamp filter."),
      updated_until: stringProperty("Optional upper-bound timestamp filter."),
    }),
    provider: "rewardful",
    requiredScopes: ["referrals:read"],
    resourceTypes: ["account"],
    sampleInput: { limit: 25 },
    toolName: "rewardful.referrals.list",
  }),
  businessRead({
    buildUrl: (input) =>
      queryProviderUrl("api.getrewardful.com", ["v1", "affiliates"], input, [
        "campaign_id",
        "email",
        "limit",
        "page",
        "stripe_customer_id",
      ]),
    description: "List Rewardful affiliates accessible to the connected account.",
    expectedHost: "api.getrewardful.com",
    hosts: HOSTS,
    inputSchema: objectSchema({
      campaign_id: stringProperty("Optional Rewardful campaign ID filter."),
      email: stringProperty("Optional affiliate email filter."),
      limit: integerProperty(1, 100),
      page: integerProperty(),
      stripe_customer_id: stringProperty("Optional Stripe customer ID filter."),
    }),
    provider: "rewardful",
    requiredScopes: ["affiliates:read"],
    resourceTypes: ["account"],
    sampleInput: { limit: 25 },
    toolName: "rewardful.affiliates.list",
    verificationPath: "/v1/affiliates?limit=1",
  }),
] as const;
