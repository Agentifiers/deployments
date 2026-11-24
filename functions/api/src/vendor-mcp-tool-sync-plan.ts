import { Metadata } from "@deployments-ai/db";
import type { RemoteMcpAdvertisedTool } from "@deployments-ai/mcp-client";
import { mcpToolDefinitionHash } from "@deployments-ai/mcp-client";
import type { ProviderDefinition } from "@deployments-ai/providers";
import {
  vendorMcpResolveToolNames,
  vendorMcpToolEffect,
  vendorMcpToolRequiredScopes,
} from "@deployments-ai/providers";
import { findPlatformToolAdapterDefinition } from "@deployments-ai/tools";
import { Option, Schema } from "effect";

const VENDOR_MCP_MAX_INPUT_SCHEMA_BYTES = 64 * 1024;
const VENDOR_MCP_MAX_DESCRIPTION_BYTES = 8 * 1024;

type VendorMcpToolSyncChangeKind = "archived" | "created" | "rejected" | "unchanged" | "updated";

type VendorMcpToolRejection =
  | "description_too_large"
  | "input_schema_not_object"
  | "input_schema_too_large"
  | "input_schema_unrepresentable"
  | "invalid_name"
  | "name_collision"
  | "name_reserved";

/** One entry of the `SyncConnectionToolsResponse.tools` list. */
export interface VendorMcpToolSyncChange {
  readonly change: VendorMcpToolSyncChangeKind;
  readonly classified: boolean;
  readonly destructive: boolean;
  readonly effect: "read" | "write";
  readonly reason?: string;
  readonly remoteName: string;
  readonly toolName?: string;
}

/** Tenant tool-adapter content a discovered tool must be reconciled to. */
export interface VendorMcpDesiredTool {
  readonly classified: boolean;
  readonly defaultPolicyAction: "allow" | "require_approval";
  readonly description: string;
  readonly destructive: boolean;
  readonly effect: "read" | "write";
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly remoteName: string;
  readonly requiredScopes: readonly string[];
  readonly toolHash: string;
  readonly toolName: string;
}

export interface VendorMcpToolSyncPlan {
  readonly desired: readonly VendorMcpDesiredTool[];
  readonly rejected: readonly VendorMcpToolSyncChange[];
}

const decodeMetadata = Schema.decodeUnknownOption(Metadata);

function rejection(tool: RemoteMcpAdvertisedTool): VendorMcpToolRejection | undefined {
  if (
    !tool.inputSchema ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema) ||
    tool.inputSchema.type !== "object"
  ) {
    return "input_schema_not_object";
  }
  if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > VENDOR_MCP_MAX_INPUT_SCHEMA_BYTES) {
    return "input_schema_too_large";
  }
  // The adapter persists the schema as DynamoDB metadata, which cannot hold e.g. int64 bounds.
  if (Option.isNone(decodeMetadata(tool.inputSchema))) return "input_schema_unrepresentable";
  if (
    tool.description !== undefined &&
    Buffer.byteLength(tool.description) > VENDOR_MCP_MAX_DESCRIPTION_BYTES
  ) {
    return "description_too_large";
  }
  return undefined;
}

/**
 * Validates and classifies a vendor server's full tool list. Effects come only from the
 * code-owned classification (unclassified tools are approval-gated writes); MCP annotations
 * are ignored. Tools that cannot be represented safely are rejected, never truncated.
 */
export function planVendorMcpToolSync(
  definition: ProviderDefinition,
  tools: readonly RemoteMcpAdvertisedTool[],
): VendorMcpToolSyncPlan {
  const names = vendorMcpResolveToolNames(
    definition.key,
    tools.map((tool) => tool.name),
  );
  const desired: VendorMcpDesiredTool[] = [];
  const rejected: VendorMcpToolSyncChange[] = [];
  tools.forEach((tool, index) => {
    const resolution = names[index]!;
    const classification = vendorMcpToolEffect(definition, tool.name);
    const toolName = "toolName" in resolution ? resolution.toolName : undefined;
    const reason =
      "rejected" in resolution
        ? resolution.rejected
        : findPlatformToolAdapterDefinition(resolution.toolName)
          ? "name_reserved"
          : rejection(tool);
    if (reason || toolName === undefined) {
      rejected.push({
        ...classification,
        change: "rejected",
        reason: reason ?? "invalid_name",
        remoteName: tool.name,
        ...(toolName ? { toolName } : {}),
      });
      return;
    }
    const description = tool.description?.trim();
    desired.push({
      ...classification,
      defaultPolicyAction:
        classification.classified && classification.effect === "read"
          ? "allow"
          : "require_approval",
      description: description || `${definition.displayName} MCP tool ${tool.name}`,
      inputSchema: tool.inputSchema,
      remoteName: tool.name,
      requiredScopes: [...vendorMcpToolRequiredScopes(classification.effect)],
      toolHash: mcpToolDefinitionHash({
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
        name: tool.name,
      }),
      toolName,
    });
  });
  return { desired, rejected };
}
