import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import { oauthScopesVerification, platformOAuthDefinition } from "./shared.ts";

/** platform OAuth definitions absent from the baseline provider registry. */
export const PLATFORM_OAUTH_CATALOG_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    // Advertising and automation
    platformOAuthDefinition({
      key: "google_ads",
      displayName: "Google Ads",
      category: "ads",
      oauthProviderKey: "google",
      apiHosts: Object.freeze(["googleads.googleapis.com"]),
      authorizationScopes: Object.freeze([
        "openid",
        "email",
        "https://www.googleapis.com/auth/adwords",
      ]),
      defaultScopes: Object.freeze(["https://www.googleapis.com/auth/adwords"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: oauthScopesVerification(
        "Confirm the Google Ads OAuth user, AWS-managed developer token, directly accessible customers, optional manager login customer, and selected customer account before activation.",
      ),
      tools: Object.freeze(["google_ads.customers.list_accessible", "google_ads.campaign_report"]),
    }),
    platformOAuthDefinition({
      key: "linkedin_ads",
      displayName: "LinkedIn Ads",
      category: "ads",
      oauthProviderKey: "linkedin",
      apiHosts: Object.freeze(["api.linkedin.com"]),
      authorizationScopes: Object.freeze(["r_ads", "r_ads_reporting", "rw_ads"]),
      defaultScopes: Object.freeze(["r_ads", "r_ads_reporting", "rw_ads"]),
      supportsMultipleAccounts: true,
      status: "unsupported",
      verification: oauthScopesVerification(
        "Unsupported until LinkedIn publishes an upstream revoke contract for Marketing API grants; current refresh tokens can remain valid for up to 365 days.",
      ),
      tools: Object.freeze(["linkedin_ads.accounts.list", "linkedin_ads.campaigns.create"]),
    }),
  ]);
