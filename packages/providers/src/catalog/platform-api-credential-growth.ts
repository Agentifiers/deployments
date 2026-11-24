import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import {
  basicApiKeyAuth,
  bearerTokenAuth,
  headerApiKeyAuth,
  platformApiCredentialDefinition,
} from "./shared.ts";

export const PLATFORM_API_CREDENTIAL_GROWTH_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    // Payments, referral, and affiliate
    platformApiCredentialDefinition({
      key: "rewardful",
      displayName: "Rewardful",
      category: "referral",
      auth: basicApiKeyAuth("apiKey", "API key", "username"),
      apiHosts: Object.freeze(["api.getrewardful.com"]),
      defaultScopes: Object.freeze(["affiliates:read", "referrals:read"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "List one Rewardful affiliate using the API key as the HTTP Basic username before enabling referral performance reads.",
        probe: Object.freeze({
          host: "api.getrewardful.com",
          path: "/v1/affiliates?limit=1",
        }),
      }),
      tools: Object.freeze(["rewardful.referrals.list", "rewardful.affiliates.list"]),
    }),
    platformApiCredentialDefinition({
      key: "dub_co",
      displayName: "Dub.co",
      category: "links",
      auth: bearerTokenAuth("apiToken", "API token"),
      apiHosts: Object.freeze(["api.dub.co"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "List one link with the workspace-scoped bearer token before enabling Dub link and analytics reads.",
        probe: Object.freeze({ host: "api.dub.co", path: "/links?pageSize=1" }),
      }),
      tools: Object.freeze(["dub_co.links.list", "dub_co.analytics.read"]),
    }),

    // Email and newsletter
    platformApiCredentialDefinition({
      key: "mailchimp",
      displayName: "Mailchimp",
      category: "email",
      auth: Object.freeze({
        kind: "basic",
        requestFieldKeys: Object.freeze(["baseUrl"]),
        transport: Object.freeze({
          passwordFieldKey: "apiKey",
          type: "basic",
          usernameFieldKey: "username",
        }),
        fields: Object.freeze([
          Object.freeze({
            key: "baseUrl",
            displayName: "Marketing API base URL",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "username",
            displayName: "Basic Auth username",
            sensitive: false,
            required: false,
            displayFormat: "none",
            defaultValue: "deployments-ai",
          }),
          Object.freeze({
            key: "apiKey",
            displayName: "Marketing API key",
            sensitive: true,
            required: true,
            displayFormat: "masked",
          }),
        ]),
      }),
      apiHosts: Object.freeze(["api.mailchimp.com"]),
      defaultScopes: Object.freeze(["audiences:read", "campaigns:send", "campaigns:write"]),
      originPolicy: Object.freeze({ fieldKey: "baseUrl", hostMatch: "suffix" }),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Call Mailchimp Marketing API ping with the regional origin and API-key Basic authentication before enabling audience or campaign tools.",
        probe: Object.freeze({ path: "/3.0/ping" }),
      }),
      tools: Object.freeze([
        "mailchimp.audiences.list",
        "mailchimp.campaigns.create",
        "mailchimp.campaigns.send",
      ]),
    }),
    platformApiCredentialDefinition({
      key: "sendgrid",
      displayName: "SendGrid",
      category: "email",
      auth: bearerTokenAuth("apiKey", "API key"),
      apiHosts: Object.freeze(["api.sendgrid.com"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Probe the SendGrid user profile with Bearer authentication before enabling statistics reads and approved email sends.",
        probe: Object.freeze({
          host: "api.sendgrid.com",
          path: "/v3/user/profile",
        }),
      }),
      tools: Object.freeze(["sendgrid.stats.read", "sendgrid.email.send"]),
    }),
    platformApiCredentialDefinition({
      key: "postmark",
      displayName: "Postmark",
      category: "email",
      auth: headerApiKeyAuth("X-Postmark-Server-Token", "serverToken", "Server token"),
      apiHosts: Object.freeze(["api.postmarkapp.com"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Probe the Postmark server endpoint with the X-Postmark-Server-Token header before enabling server reads and approved sends.",
        probe: Object.freeze({ host: "api.postmarkapp.com", path: "/server" }),
      }),
      tools: Object.freeze(["postmark.server.read", "postmark.email.send"]),
    }),
  ]);
