import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import {
  apiKeyWithPublicFieldAuth,
  bearerTokenAuth,
  bearerTokenWithPublicFieldAuth,
  platformApiCredentialDefinition,
} from "./shared.ts";

export const PLATFORM_API_CREDENTIAL_ANALYTICS_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    // Analytics
    platformApiCredentialDefinition({
      key: "segment",
      displayName: "Segment",
      category: "analytics",
      auth: bearerTokenWithPublicFieldAuth(
        "baseUrl",
        "Public API base URL",
        "workspaceToken",
        "Workspace token",
        "https://api.segmentapis.com",
      ),
      apiHosts: Object.freeze(["api.segmentapis.com", "eu1.api.segmentapis.com"]),
      defaultScopes: Object.freeze(["destinations:read", "sources:read"]),
      originPolicy: Object.freeze({ fieldKey: "baseUrl", hostMatch: "exact" }),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "List Segment sources through the regional Public API with a workspace bearer token before enabling source and destination inventory reads.",
        probe: Object.freeze({ path: "/sources" }),
      }),
      tools: Object.freeze(["segment.sources.list", "segment.destinations.list"]),
    }),
    platformApiCredentialDefinition({
      key: "plausible",
      displayName: "Plausible",
      category: "analytics",
      auth: bearerTokenAuth(),
      apiHosts: Object.freeze(["plausible.io"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Probe Plausible with the bearer token and confirm the token can list accessible sites.",
        probe: Object.freeze({ host: "plausible.io", path: "/api/v1/sites" }),
      }),
      tools: Object.freeze(["plausible.sites.list"]),
    }),

    // SEO
    platformApiCredentialDefinition({
      key: "rankparse",
      displayName: "RankParse",
      category: "seo",
      auth: Object.freeze({
        ...apiKeyWithPublicFieldAuth(
          "verificationDomain",
          "Verification domain",
          "apiKey",
          "API key",
        ),
        transport: Object.freeze({
          fieldKey: "apiKey",
          headerName: "x-api-key",
          type: "header",
        }),
      }),
      apiHosts: Object.freeze(["api.rankparse.com"]),
      defaultScopes: Object.freeze(["domain_authority:read"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Read domain authority for the connector-bound verification domain using X-API-Key authentication.",
        probe: Object.freeze({
          host: "api.rankparse.com",
          path: "/v1/domain-authority?domain={verificationDomain}",
          pathFieldKeys: Object.freeze(["verificationDomain"]),
          requiredScopes: Object.freeze(["domain_authority:read"]),
        }),
      }),
      tools: Object.freeze(["rankparse.domain.authority.read"]),
    }),

    // Data enrichment and aggregation
    platformApiCredentialDefinition({
      key: "clearbit",
      displayName: "Clearbit",
      category: "data_enrichment",
      auth: bearerTokenWithPublicFieldAuth(
        "verificationDomain",
        "Verification domain",
        "privateToken",
        "Legacy Clearbit API key",
      ),
      apiHosts: Object.freeze(["company.clearbit.com", "person.clearbit.com"]),
      defaultScopes: Object.freeze([]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Enrich the connector-bound verification domain with the legacy Clearbit Company API to verify the API key and entitlement.",
        probe: Object.freeze({
          expectedStatusCodes: Object.freeze([200, 202, 404]),
          host: "company.clearbit.com",
          path: "/v2/companies/find?domain={verificationDomain}",
          pathFieldKeys: Object.freeze(["verificationDomain"]),
        }),
      }),
      tools: Object.freeze(["clearbit.company.enrich", "clearbit.person.enrich"]),
    }),
    platformApiCredentialDefinition({
      key: "savvycal",
      displayName: "SavvyCal",
      category: "scheduling",
      auth: bearerTokenAuth("personalAccessToken", "Personal access token"),
      apiHosts: Object.freeze(["api.savvycal.com"]),
      defaultScopes: Object.freeze(["links:read", "events:read"]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: Object.freeze({
        required: true,
        method: "api_probe",
        description:
          "Read the SavvyCal profile with the customer-owned personal access token before enabling link and event reads.",
        probe: Object.freeze({ host: "api.savvycal.com", path: "/v1/me" }),
      }),
      tools: Object.freeze(["savvycal.links.list", "savvycal.bookings.list"]),
    }),
  ]);
