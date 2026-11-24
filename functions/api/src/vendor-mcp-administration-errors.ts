import type { AdministrationPersistenceDependencies } from "./administration-persistence-contracts.ts";
import type { VendorMcpAdministrationDependencies } from "./vendor-mcp-dependencies.ts";

/**
 * Vendor MCP administration failure with an explicit HTTP status (for example 502 discovery
 * failures and 503 missing configuration) that `PersistenceError` kinds cannot express.
 * The administration API maps any error carrying numeric `status` and string `code`.
 */
export class VendorMcpAdministrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VendorMcpAdministrationError";
  }
}

/** Vendor MCP network ports, or 503 `vendor_mcp_unconfigured` when this deployment has none. */
export function requireVendorMcpDependencies(
  dependencies: Pick<AdministrationPersistenceDependencies, "vendorMcp">,
): VendorMcpAdministrationDependencies {
  if (!dependencies.vendorMcp) {
    throw new VendorMcpAdministrationError(
      503,
      "vendor_mcp_unconfigured",
      "Vendor MCP connections are not configured in this deployment.",
    );
  }
  return dependencies.vendorMcp;
}
