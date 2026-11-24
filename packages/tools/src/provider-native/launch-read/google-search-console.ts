import {
  appendNativeQueryFields,
  boundedJsonProviderNativeBody,
  encodedPath,
  optionalToolObject,
  optionalToolString,
  optionalToolStringArray,
  readDateRangeBounds,
  requirePositiveLimit,
  requireToolString,
  siteResourceTargetAuditMetadata,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";

const GSC_READ_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"] as const;

/** Accept the Google OAuth app only for the canonical Search Console capability. */
const GSC_ACCEPTED_PROVIDERS = ["google_search_console", "google"] as const;

function requireSiteUrl(input: Record<string, unknown>): string {
  return (
    optionalToolString(input, "siteUrl") ??
    optionalToolString(input, "site") ??
    requireToolString(input, "siteUrl")
  );
}

function gscPerformanceBody(
  input: Record<string, unknown>,
): ReturnType<typeof boundedJsonProviderNativeBody> {
  const explicit = optionalToolObject(input, "body") ?? optionalToolObject(input, "query");
  if (explicit) return boundedJsonProviderNativeBody(explicit, "body");

  const { endDate, startDate } = readDateRangeBounds(input);
  const start =
    startDate ?? optionalToolString(input, "startDate") ?? optionalToolString(input, "since");
  const end = endDate ?? optionalToolString(input, "endDate") ?? optionalToolString(input, "until");
  if (!start || !end) {
    throw new Error("Tool input startDate and endDate are required");
  }

  const startRowRaw = input.startRow;
  let startRow = 0;
  if (startRowRaw !== undefined) {
    if (typeof startRowRaw !== "number" || !Number.isFinite(startRowRaw) || startRowRaw < 0) {
      throw new Error("Tool input startRow must be a non-negative number");
    }
    startRow = Math.min(Math.trunc(startRowRaw), 1_000_000);
  }

  return boundedJsonProviderNativeBody(
    {
      startDate: start,
      endDate: end,
      dimensions: optionalToolStringArray(input, "dimensions") ?? ["query"],
      rowLimit: requirePositiveLimit(input, "rowLimit", 25, 25_000),
      startRow,
      ...(optionalToolString(input, "searchType") || optionalToolString(input, "type")
        ? { type: optionalToolString(input, "searchType") ?? optionalToolString(input, "type") }
        : {}),
      ...(optionalToolString(input, "aggregationType")
        ? { aggregationType: optionalToolString(input, "aggregationType") }
        : {}),
      ...(Array.isArray(input.dimensionFilterGroups)
        ? { dimensionFilterGroups: input.dimensionFilterGroups }
        : {}),
      ...(optionalToolString(input, "dataState")
        ? { dataState: optionalToolString(input, "dataState") }
        : {}),
    },
    "query",
  );
}

export const googleSearchConsoleNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] =
  [
    {
      toolName: "google_search_console.sites.list",
      description: "List Search Console sites accessible to the connected Google account.",
      effect: "read",
      provider: "google_search_console",
      acceptedProviders: GSC_ACCEPTED_PROVIDERS,
      requiredScopes: GSC_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "gsc-sites-list",
      auditMetadata: siteResourceTargetAuditMetadata(),
      buildUrl(input) {
        const version = encodedPath(optionalToolString(input, "apiVersion") ?? "v3");
        const url = new URL(`https://searchconsole.googleapis.com/webmasters/${version}/sites`);
        appendNativeQueryFields(url, input, []);
        return url.toString();
      },
      successSummary: () => "Listed Google Search Console sites.",
    },
    {
      toolName: "google_search_console.performance.query",
      description: "Query Search Console search-analytics performance for a verified site.",
      effect: "read",
      provider: "google_search_console",
      acceptedProviders: GSC_ACCEPTED_PROVIDERS,
      requiredScopes: GSC_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "POST",
      filePrefix: "gsc-performance-query",
      auditMetadata: siteResourceTargetAuditMetadata(),
      buildUrl(input) {
        const siteUrl = requireSiteUrl(input);
        const version = encodedPath(optionalToolString(input, "apiVersion") ?? "v3");
        return `https://searchconsole.googleapis.com/webmasters/${version}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
      },
      buildBody: gscPerformanceBody,
      successSummary: (_response, input) =>
        `Queried Search Console performance for ${requireSiteUrl(input)}.`,
    },
  ];
