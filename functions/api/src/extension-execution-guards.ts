import { PersistenceError } from "@deployments-ai/db";

/**
 * Extension execution types that the public extensions API may not create or modify:
 * builtin tools are code-owned and vendor MCP tools are owned by connection tool sync.
 */
export function assertWritableExtensionExecution(type: unknown): void {
  if (type === "builtin") {
    throw new PersistenceError(
      "unprocessable",
      "builtin_extension_forbidden",
      "Public extensions cannot register builtin tools.",
    );
  }
  if (type === "vendor_mcp") {
    throw new PersistenceError(
      "invalid-input",
      "vendor_mcp_tools_are_synced",
      "Vendor MCP tools are managed by POST /v1/connections/:connectionId/tools/sync.",
    );
  }
}
