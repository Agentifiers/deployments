import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RemoteMcpSession } from "./remote-client-transport.ts";
import { isRecord } from "./type-guards.ts";
import {
  MAX_REMOTE_MCP_TOOL_PAGES,
  MAX_REMOTE_MCP_TOOLS,
  RemoteMcpError,
  type RemoteMcpAdvertisedTool,
} from "./remote-client-types.ts";

export function normalizeAllowlist(values: readonly string[]): ReadonlySet<string> {
  const normalized = new Set(values.map((value) => value.trim()).filter(Boolean));
  if (normalized.size === 0) {
    throw new RemoteMcpError("configuration", "MCP server tool allowlist must not be empty.");
  }
  return normalized;
}

/**
 * Projects an SDK-parsed tool onto the stable shape returned by discovery and hashed for
 * drift detection. Empty descriptions/titles are treated as absent.
 */
export function advertisedTool(tool: Tool): RemoteMcpAdvertisedTool {
  return {
    ...(isRecord(tool.annotations) ? { annotations: tool.annotations } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
  };
}

/** Cumulative serialized-size cap for tools retained from discovery. */
export class DiscoveryByteBudget {
  private bytes = 2;
  private entries = 0;

  constructor(private readonly maximumBytes: number) {}

  add(value: unknown): void {
    this.bytes +=
      new TextEncoder().encode(JSON.stringify(value)).byteLength + (this.entries > 0 ? 1 : 0);
    this.entries += 1;
    if (this.bytes > this.maximumBytes) {
      throw new RemoteMcpError(
        "protocol",
        `MCP tool discovery exceeded ${this.maximumBytes} bytes.`,
      );
    }
  }
}

/**
 * Pages through `tools/list` (at most `MAX_REMOTE_MCP_TOOL_PAGES` pages and
 * `MAX_REMOTE_MCP_TOOLS` tools), rejecting duplicate names. `visit` sees every tool in
 * order; when `stopAfterPage` returns true the scan ends after the current page.
 * Returns `complete: false` when pages remained unread.
 */
export async function scanRemoteTools(
  session: RemoteMcpSession,
  visit: (tool: Tool) => void,
  stopAfterPage: () => boolean = () => false,
): Promise<{ readonly complete: boolean }> {
  let cursor: string | undefined;
  let observed = 0;
  const observedNames = new Set<string>();
  for (let page = 0; page < MAX_REMOTE_MCP_TOOL_PAGES; page += 1) {
    const listed = await session.client.listTools(
      cursor ? { cursor } : undefined,
      session.requestOptions,
    );
    observed += listed.tools.length;
    if (observed > MAX_REMOTE_MCP_TOOLS) {
      throw new RemoteMcpError(
        "protocol",
        `MCP server exposed more than ${MAX_REMOTE_MCP_TOOLS} tools.`,
      );
    }
    for (const tool of listed.tools) {
      if (observedNames.has(tool.name)) {
        throw new RemoteMcpError("protocol", `MCP server advertised duplicate tool ${tool.name}.`);
      }
      observedNames.add(tool.name);
      visit(tool);
    }
    cursor =
      typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
    if (!cursor) return { complete: true };
    if (stopAfterPage()) return { complete: false };
  }
  return { complete: false };
}
