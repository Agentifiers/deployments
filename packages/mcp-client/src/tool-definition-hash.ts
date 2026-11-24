import { createHash } from "node:crypto";
import { isRecord } from "./type-guards.ts";

export interface McpToolDefinition {
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly name: string;
}

/**
 * JSON serialization with recursively sorted object keys; array order is preserved and
 * `undefined` object members are omitted, matching `JSON.stringify` value semantics.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  }
  if (isRecord(value)) {
    const members = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Stable identity of an MCP tool definition used to pin synced tools and detect drift:
 * `sha256:` + hex digest of canonical JSON `{ name, description, inputSchema }`.
 */
export function mcpToolDefinitionHash(tool: McpToolDefinition): string {
  const canonical = canonicalJson({
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
    name: tool.name,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
