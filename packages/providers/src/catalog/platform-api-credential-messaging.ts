import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import {
  apiProbeVerification,
  bearerTokenAuth,
  bearerTokenWithPublicFieldAuth,
  headerApiKeyAuth,
  manualVerification,
  platformApiCredentialDefinition,
} from "./shared.ts";

export const PLATFORM_API_CREDENTIAL_MESSAGING_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    // SMS and messaging
    platformApiCredentialDefinition({
      key: "aws_end_user_messaging_rcs",
      displayName: "AWS End User Messaging RCS",
      category: "rcs",
      auth: Object.freeze({
        kind: "service_account",
        requestFieldKeys: Object.freeze(["roleArn", "region"]),
        fields: Object.freeze([
          Object.freeze({
            key: "roleArn",
            displayName: "Vertical RCS delivery role ARN",
            description:
              "Cross-account role owned by the vertical and trusted only by the platform channel-delivery role.",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "externalId",
            displayName: "Role external ID",
            description: "Secret external ID required by the vertical-owned role trust policy.",
            sensitive: true,
            required: true,
            displayFormat: "masked",
          }),
          Object.freeze({
            key: "region",
            displayName: "AWS Region",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "ingressSigningSecret",
            displayName: "Inbound forwarder signing secret",
            description:
              "Optional shared secret used by a vertical-owned SNS forwarder to authenticate inbound RCS notifications.",
            sensitive: true,
            required: false,
            displayFormat: "masked",
          }),
        ]),
      }),
      apiHosts: Object.freeze([]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: manualVerification(
        "Confirm that the vertical-owned RCS Agent is Active and that its send-only cross-account role is restricted to the platform channel-delivery principal and an external ID.",
      ),
      tools: Object.freeze([]),
    }),
    platformApiCredentialDefinition({
      key: "twilio",
      displayName: "Twilio",
      category: "sms_voice",
      auth: Object.freeze({
        kind: "basic",
        requestFieldKeys: Object.freeze(["accountSid"]),
        transport: Object.freeze({
          passwordFieldKey: "apiKeySecret",
          type: "basic",
          usernameFieldKey: "apiKeySid",
        }),
        fields: Object.freeze([
          Object.freeze({
            key: "accountSid",
            displayName: "Account SID",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "apiKeySid",
            displayName: "API Key SID",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "apiKeySecret",
            displayName: "API Key Secret",
            sensitive: true,
            required: true,
            displayFormat: "masked",
          }),
        ]),
      }),
      apiHosts: Object.freeze(["api.twilio.com"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Probe the selected Twilio account using API Key SID/Secret Basic authentication before enabling reads and approved sends.",
        probe: Object.freeze({
          host: "api.twilio.com",
          path: "/2010-04-01/Accounts/{accountSid}.json",
          pathFieldKeys: Object.freeze(["accountSid"]),
        }),
      }),
      tools: Object.freeze([
        "twilio.account.read",
        "twilio.messages.list",
        "twilio.phone_numbers.list",
        "twilio.messages.send",
      ]),
    }),
    platformApiCredentialDefinition({
      key: "plivo",
      displayName: "Plivo",
      category: "sms_voice",
      auth: Object.freeze({
        kind: "basic",
        requestFieldKeys: Object.freeze(["authId"]),
        transport: Object.freeze({
          passwordFieldKey: "authToken",
          type: "basic",
          usernameFieldKey: "authId",
        }),
        fields: Object.freeze([
          Object.freeze({
            key: "authId",
            displayName: "Auth ID",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "authToken",
            displayName: "Auth token",
            sensitive: true,
            required: true,
            displayFormat: "masked",
          }),
        ]),
      }),
      apiHosts: Object.freeze(["api.plivo.com"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Probe the Plivo account resource with Auth ID/Auth Token Basic authentication before enabling reads and approved sends.",
        probe: Object.freeze({
          host: "api.plivo.com",
          path: "/v1/Account/{authId}/",
          pathFieldKeys: Object.freeze(["authId"]),
        }),
      }),
      tools: Object.freeze([
        "plivo.account.read",
        "plivo.messages.list",
        "plivo.numbers.list",
        "plivo.messages.send",
      ]),
    }),
    platformApiCredentialDefinition({
      key: "postscript",
      displayName: "Postscript",
      category: "sms",
      auth: bearerTokenAuth("privateApiKey", "Shop private API key"),
      apiHosts: Object.freeze(["api.postscript.io"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "List one Postscript subscriber with the shop private API key in the Bearer header. Direct custom API access requires an eligible shop plan or approved partner access.",
        probe: Object.freeze({ host: "api.postscript.io", path: "/api/v2/subscribers?page=1" }),
      }),
      tools: Object.freeze(["postscript.subscribers.list", "postscript.subscriber.read"]),
    }),
    platformApiCredentialDefinition({
      key: "audiencetap",
      displayName: "AudienceTap",
      category: "sms_email",
      auth: bearerTokenAuth(),
      apiHosts: Object.freeze(["api.audiencetap.com"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "unsupported",
      verification: apiProbeVerification(
        "Unsupported until AudienceTap publishes an official customer API endpoint inventory, stable account identity, and credential lifecycle for the API host.",
      ),
      tools: Object.freeze(["audiencetap.audiences.list", "audiencetap.campaigns.list"]),
    }),

    // Site scraping and browser infrastructure
    platformApiCredentialDefinition({
      key: "firecrawl",
      displayName: "Firecrawl",
      category: "site_scraping",
      auth: bearerTokenAuth("apiKey", "API key"),
      apiHosts: Object.freeze(["api.firecrawl.dev"]),
      defaultScopes: Object.freeze(["scrape:execute"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Read Firecrawl v2 team credit usage with bearer authentication before enabling scrape execution.",
        probe: Object.freeze({
          host: "api.firecrawl.dev",
          path: "/v2/team/credit-usage",
        }),
      }),
      tools: Object.freeze(["firecrawl.page.scrape"]),
    }),
    platformApiCredentialDefinition({
      key: "browserbase",
      displayName: "Browserbase",
      category: "site_scraping",
      auth: headerApiKeyAuth("x-bb-api-key", "apiKey", "API key"),
      apiHosts: Object.freeze(["api.browserbase.com"]),
      defaultScopes: Object.freeze(["session_logs:read"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "List Browserbase sessions with X-BB-API-Key before enabling session log reads; the API key determines the project.",
        probe: Object.freeze({ host: "api.browserbase.com", path: "/v1/sessions" }),
      }),
      tools: Object.freeze(["browserbase.session.logs.read"]),
    }),

    // CRO, partner ecosystem, product analytics, and competitive intelligence
    platformApiCredentialDefinition({
      key: "hotjar",
      displayName: "Hotjar",
      category: "cro",
      auth: Object.freeze({
        kind: "oauth_client_credentials",
        requestFieldKeys: Object.freeze(["clientId", "siteId"]),
        tokenExchange: Object.freeze({
          bodyFormat: "form",
          clientIdFieldKey: "clientId",
          clientSecretFieldKey: "clientSecret",
          endpoint: "https://api.hotjar.io/v1/oauth/token",
          type: "oauth_client_credentials",
        }),
        fields: Object.freeze([
          Object.freeze({
            key: "clientId",
            displayName: "Hotjar API client ID",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "clientSecret",
            displayName: "Hotjar API client secret",
            sensitive: true,
            required: true,
            displayFormat: "masked",
          }),
          Object.freeze({
            key: "siteId",
            displayName: "Hotjar site ID",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
        ]),
      }),
      apiHosts: Object.freeze(["api.hotjar.io"]),
      defaultScopes: Object.freeze(["surveys:read"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Exchange the customer-managed Hotjar API client credentials and list surveys for the connector-pinned site.",
        probe: Object.freeze({
          host: "api.hotjar.io",
          path: "/v1/sites/{siteId}/surveys?limit=1",
          pathFieldKeys: Object.freeze(["siteId"]),
          requiredScopes: Object.freeze(["surveys:read"]),
        }),
      }),
      tools: Object.freeze(["hotjar.surveys.list"]),
    }),
    platformApiCredentialDefinition({
      key: "firehose",
      displayName: "Firehose",
      category: "competitive_intelligence",
      auth: Object.freeze({
        ...bearerTokenWithPublicFieldAuth("tapId", "Tap ID", "tapToken", "Tap token"),
        requestFieldKeys: Object.freeze([]),
      }),
      apiHosts: Object.freeze(["api.firehose.com"]),
      defaultScopes: Object.freeze(["rules:read", "rules:write"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "List the selected Firehose tap's rules with its fh_ tap token before enabling rule reads or approval-gated rule creation.",
        probe: Object.freeze({
          host: "api.firehose.com",
          path: "/v1/rules",
          requiredScopes: Object.freeze(["rules:read"]),
        }),
      }),
      tools: Object.freeze(["firehose.rules.list", "firehose.rules.create"]),
    }),
  ]);
