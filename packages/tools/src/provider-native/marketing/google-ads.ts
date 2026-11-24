import {
  encodedPath,
  jsonProviderNativeBody,
  optionalToolString,
  readDateRangeBounds,
  requirePositiveLimit,
  requireToolString,
  type ProviderNativeInputSchema,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";

const GOOGLE_ADS_SCOPES = ["https://www.googleapis.com/auth/adwords"] as const;
const GOOGLE_ADS_API_VERSION = "v24";
const GOOGLE_ADS_CUSTOMER_ID = /^\d{10}$/u;

function googleAdsApiVersion(input: Record<string, unknown>): string {
  const version = optionalToolString(input, "apiVersion") ?? GOOGLE_ADS_API_VERSION;
  if (version !== GOOGLE_ADS_API_VERSION) {
    throw new Error(`Tool input apiVersion must be ${GOOGLE_ADS_API_VERSION}`);
  }
  return version;
}

function googleAdsCustomerId(input: Record<string, unknown>, key: string): string {
  const customerId = requireToolString(input, key).replaceAll("-", "");
  if (!GOOGLE_ADS_CUSTOMER_ID.test(customerId)) {
    throw new Error(`Tool input ${key} must be a ten-digit Google Ads customer id`);
  }
  return customerId;
}

function optionalGoogleAdsCustomerId(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  return optionalToolString(input, key) ? googleAdsCustomerId(input, key) : undefined;
}

function googleAdsCustomerAuditMetadata(): unknown {
  return {
    resourceTargets: {
      requireProofWhenConstrained: true,
      selectors: [
        {
          constraintKey: "customerId",
          defaultFromAuthorization: true,
          inputKeys: ["customerId"],
          required: true,
        },
        {
          constraintKey: "loginCustomerId",
          defaultFromAuthorization: true,
          inputKeys: ["loginCustomerId"],
          required: false,
        },
      ],
    },
  };
}

const GOOGLE_ADS_LIST_INPUT_SCHEMA: ProviderNativeInputSchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
};

const GOOGLE_ADS_REPORT_INPUT_SCHEMA: ProviderNativeInputSchema = {
  additionalProperties: false,
  properties: {
    apiVersion: { enum: [GOOGLE_ADS_API_VERSION], type: "string" },
    customerId: { pattern: "^[0-9-]{10,13}$", type: "string" },
    endDate: { format: "date", type: "string" },
    limit: { maximum: 1_000, minimum: 1, type: "integer" },
    loginCustomerId: { pattern: "^[0-9-]{10,13}$", type: "string" },
    query: { minLength: 1, type: "string" },
    startDate: { format: "date", type: "string" },
  },
  type: "object",
};

function googleAdsCampaignReportQuery(input: Record<string, unknown>): string {
  const explicitQuery = optionalToolString(input, "query");
  if (explicitQuery) return explicitQuery;
  const { endDate, startDate } = readDateRangeBounds(input);
  const where =
    startDate && endDate
      ? `WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`
      : "WHERE segments.date DURING LAST_30_DAYS";
  return [
    "SELECT",
    "campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc, segments.date",
    "FROM campaign",
    where,
    "ORDER BY metrics.cost_micros DESC",
    `LIMIT ${requirePositiveLimit(input, "limit", 100, 1_000)}`,
  ].join(" ");
}

export const googleAdsNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "google_ads.customers.list_accessible",
    description: "List Google Ads customer accounts directly accessible to the OAuth user.",
    effect: "read",
    provider: "google_ads",
    requiredScopes: GOOGLE_ADS_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "google-ads-accessible-customers",
    inputSchema: GOOGLE_ADS_LIST_INPUT_SCHEMA,
    buildUrl: (input) =>
      `https://googleads.googleapis.com/${encodedPath(googleAdsApiVersion(input))}/customers:listAccessibleCustomers`,
  },
  {
    toolName: "google_ads.campaign_report",
    description: "Read Google Ads campaign metrics for a customer account.",
    effect: "read",
    provider: "google_ads",
    requiredScopes: GOOGLE_ADS_SCOPES,
    defaultPolicyAction: "allow",
    method: "POST",
    filePrefix: "google-ads-campaign-report",
    auditMetadata: googleAdsCustomerAuditMetadata(),
    inputSchema: GOOGLE_ADS_REPORT_INPUT_SCHEMA,
    buildUrl: (input) =>
      `https://googleads.googleapis.com/${encodedPath(
        googleAdsApiVersion(input),
      )}/customers/${encodeURIComponent(googleAdsCustomerId(input, "customerId"))}/googleAds:searchStream`,
    buildBody: (input) => jsonProviderNativeBody({ query: googleAdsCampaignReportQuery(input) }),
    buildHeaders: (input) =>
      optionalGoogleAdsCustomerId(input, "loginCustomerId")
        ? { "login-customer-id": optionalGoogleAdsCustomerId(input, "loginCustomerId") }
        : {},
  },
];
