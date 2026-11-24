import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  advertisedTool,
  DiscoveryByteBudget,
  normalizeAllowlist,
  scanRemoteTools,
} from "./remote-client-tools.ts";
import { positiveInteger, withRemoteMcpSession } from "./remote-client-transport.ts";
import {
  DEFAULT_REMOTE_MCP_MAX_RESPONSE_BYTES,
  MAX_REMOTE_MCP_TOOL_PAGES,
  RemoteMcpError,
  type RemoteMcpAdministrationClient,
  type RemoteMcpAdvertisedTool,
  type RemoteMcpClientOptions,
  type RemoteMcpDiscoveredTool,
} from "./remote-client-types.ts";
import { isRecord } from "./type-guards.ts";
import { mcpToolDefinitionHash } from "./tool-definition-hash.ts";

const pageLimitMessage = `MCP tool discovery exceeded ${MAX_REMOTE_MCP_TOOL_PAGES} pages.`;

export function createRemoteMcpClient(
  options: RemoteMcpClientOptions = {},
): RemoteMcpAdministrationClient {
  const settings = {
    clientInfo: options.clientInfo ?? {
      name: "deployments-ai-agent-runtime",
      version: "1.0.0",
    },
    ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
    maxResponseBytes: positiveInteger(
      options.maxResponseBytes,
      DEFAULT_REMOTE_MCP_MAX_RESPONSE_BYTES,
      "MCP response byte limit",
    ),
    ...(options.pinnedRequest ? { pinnedRequest: options.pinnedRequest } : {}),
  };

  return {
    callTool: async (input) => {
      const allowlist = normalizeAllowlist(input.toolAllowlist);
      const toolName = input.toolName.trim();
      if (!toolName || !allowlist.has(toolName)) {
        throw new RemoteMcpError(
          "tool-not-allowed",
          `MCP tool ${toolName || "<empty>"} is not in the server allowlist.`,
        );
      }
      return withRemoteMcpSession(settings, input, async (session) => {
        let pinned: Tool | undefined;
        await scanRemoteTools(
          session,
          (tool) => {
            if (tool.name === toolName) pinned = tool;
          },
          () => pinned !== undefined,
        );
        if (!pinned) {
          throw new RemoteMcpError(
            "tool-not-found",
            `MCP server did not advertise allowed tool ${toolName}.`,
          );
        }
        if (
          input.expectedToolHash !== undefined &&
          mcpToolDefinitionHash(advertisedTool(pinned)) !== input.expectedToolHash
        ) {
          throw new RemoteMcpError(
            "tool-drift",
            `MCP tool ${toolName} definition changed since it was approved.`,
          );
        }
        input.onToolCallDispatch?.();
        const result = await session.client.callTool(
          { arguments: input.arguments ?? {}, name: toolName },
          undefined,
          session.requestOptions,
        );
        if (!isRecord(result)) {
          throw new RemoteMcpError("protocol", "MCP tool returned an invalid result.");
        }
        return { isError: result.isError === true, result, ...session.metadata() };
      });
    },
    discoverAllTools: (input) =>
      withRemoteMcpSession(settings, input, async (session) => {
        const budget = new DiscoveryByteBudget(settings.maxResponseBytes);
        const tools: RemoteMcpAdvertisedTool[] = [];
        const { complete } = await scanRemoteTools(session, (tool) => {
          const discovered = advertisedTool(tool);
          budget.add(discovered);
          tools.push(discovered);
        });
        if (!complete) throw new RemoteMcpError("protocol", pageLimitMessage);
        return { ...session.metadata(), tools };
      }),
    discoverTools: async (input) => {
      const allowlist = normalizeAllowlist(input.toolAllowlist);
      return withRemoteMcpSession(settings, input, async (session) => {
        const budget = new DiscoveryByteBudget(settings.maxResponseBytes);
        const tools: RemoteMcpDiscoveredTool[] = [];
        const { complete } = await scanRemoteTools(session, (tool) => {
          if (!allowlist.has(tool.name)) return;
          const discovered = {
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
            remoteName: tool.name,
          };
          budget.add(discovered);
          tools.push(discovered);
        });
        if (!complete) throw new RemoteMcpError("protocol", pageLimitMessage);
        return { tools };
      });
    },
  };
}
