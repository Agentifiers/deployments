import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import { platformApiCredentialDefinition } from "./shared.ts";
export const PLATFORM_API_CREDENTIAL_CONTENT_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    // AI content, video, reviews, push, and webinars
    platformApiCredentialDefinition({
      key: "demio",
      displayName: "Demio",
      category: "webinar",
      auth: Object.freeze({
        kind: "api_key",
        requestFieldKeys: Object.freeze(["accountLabel"]),
        transport: Object.freeze({
          headerFields: Object.freeze([
            Object.freeze({ fieldKey: "apiKey", headerName: "Api-Key" }),
            Object.freeze({ fieldKey: "apiSecret", headerName: "Api-Secret" }),
          ]),
          type: "headers",
        }),
        fields: Object.freeze([
          Object.freeze({
            key: "accountLabel",
            displayName: "Account label",
            sensitive: false,
            required: true,
            displayFormat: "none",
            description: "Stable label used to identify this Demio account inside deployments.ai.",
          }),
          Object.freeze({
            key: "apiKey",
            displayName: "API key",
            sensitive: true,
            required: true,
            displayFormat: "masked",
          }),
          Object.freeze({
            key: "apiSecret",
            displayName: "API secret",
            sensitive: true,
            required: true,
            displayFormat: "masked",
          }),
        ]),
      }),
      apiHosts: Object.freeze(["my.demio.com"]),
      defaultScopes: Object.freeze(["account:read", "registrations:write"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Call Demio's ping endpoint with separate Api-Key and Api-Secret headers before enabling event registration.",
        probe: Object.freeze({ host: "my.demio.com", path: "/api/v1/ping" }),
      }),
      tools: Object.freeze(["demio.account.ping", "demio.event.registration.create"]),
    }),

    // Headless CMS
    platformApiCredentialDefinition({
      key: "strapi",
      displayName: "Strapi",
      category: "headless_cms",
      auth: Object.freeze({
        kind: "api_key",
        requestFieldKeys: Object.freeze(["baseUrl", "verificationContentType"]),
        transport: Object.freeze({ fieldKey: "apiToken", type: "bearer" }),
        fields: Object.freeze([
          Object.freeze({
            key: "baseUrl",
            displayName: "Instance base URL",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "verificationContentType",
            displayName: "Verification content-type API ID",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
          Object.freeze({
            key: "apiToken",
            displayName: "Content API token",
            sensitive: true,
            required: true,
            displayFormat: "masked",
          }),
        ]),
      }),
      originPolicy: Object.freeze({ fieldKey: "baseUrl", requireHttps: true }),
      apiHosts: Object.freeze([]),
      defaultScopes: Object.freeze(["documents:read", "documents:write"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "List one document from a configured Strapi plural content-type API ID using a Content API bearer token on the pinned instance origin.",
        probe: Object.freeze({
          path: "/api/{verificationContentType}?pagination%5BpageSize%5D=1",
          pathFieldKeys: Object.freeze(["verificationContentType"]),
        }),
      }),
      tools: Object.freeze(["strapi.documents.list", "strapi.documents.create"]),
    }),
  ]);
