import { VENDOR_MCP_TENANT_PLACEHOLDER } from "./vendor-mcp-types.ts";

/** DNS label accepted for a vendor MCP tenant (`{tenant}` host label). */
export const VENDOR_MCP_TENANT_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export type VendorMcpConfigurationErrorCode = "invalid_mcp_definition" | "invalid_mcp_resource";

export class VendorMcpConfigurationError extends Error {
  readonly code: VendorMcpConfigurationErrorCode;

  constructor(code: VendorMcpConfigurationErrorCode, message: string) {
    super(message);
    this.name = "VendorMcpConfigurationError";
    this.code = code;
  }
}

export function vendorMcpIsTemplated(value: string): boolean {
  return value.includes(VENDOR_MCP_TENANT_PLACEHOLDER);
}

/**
 * Replace `{tenant}` in a pinned template. Static values pass through unchanged;
 * templated values require a valid tenant label.
 */
export function vendorMcpSubstitute(template: string, tenant: string | undefined): string {
  if (!vendorMcpIsTemplated(template)) return template;
  if (tenant === undefined || !VENDOR_MCP_TENANT_LABEL_PATTERN.test(tenant)) {
    throw new VendorMcpConfigurationError(
      "invalid_mcp_resource",
      "A valid tenant host label is required for a templated MCP server.",
    );
  }
  return template.replaceAll(VENDOR_MCP_TENANT_PLACEHOLDER, tenant);
}

/** Returns the tenant label when `candidate` is exactly `template` with one valid label. */
export function vendorMcpTemplateTenant(template: string, candidate: string): string | undefined {
  const parts = template.split(VENDOR_MCP_TENANT_PLACEHOLDER);
  if (parts.length !== 2) return undefined;
  const [prefix, suffix] = parts as [string, string];
  if (
    candidate.length <= prefix.length + suffix.length ||
    !candidate.startsWith(prefix) ||
    !candidate.endsWith(suffix)
  ) {
    return undefined;
  }
  const tenant = candidate.slice(prefix.length, candidate.length - suffix.length);
  return VENDOR_MCP_TENANT_LABEL_PATTERN.test(tenant) ? tenant : undefined;
}
