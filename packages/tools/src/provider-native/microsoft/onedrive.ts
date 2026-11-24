import {
  jsonProviderNativeBody,
  optionalToolString,
  requireToolString,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";
import { requiredObject } from "../tool-input-guards.ts";
import { microsoftFileBody } from "./graph-file-body.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const ONEDRIVE_READ_SCOPES = ["Files.Read.All"] as const;
const ONEDRIVE_WRITE_SCOPES = ["Files.ReadWrite.All"] as const;

function graphHeaders(): Record<string, string> {
  return { accept: "application/json" };
}

function drivePrefix(input: Record<string, unknown>): string {
  const driveId = optionalToolString(input, "driveId");
  return driveId ? `/drives/${encodeURIComponent(driveId)}` : "/me/drive";
}

export const oneDriveNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "onedrive.files.list",
    description: "List files in a OneDrive folder.",
    effect: "read",
    provider: "onedrive",
    requiredScopes: ONEDRIVE_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "onedrive-files-list",
    buildUrl(input) {
      const itemId = optionalToolString(input, "itemId");
      return itemId
        ? `${GRAPH_BASE}${drivePrefix(input)}/items/${encodeURIComponent(itemId)}/children`
        : `${GRAPH_BASE}${drivePrefix(input)}/root/children`;
    },
    buildHeaders: graphHeaders,
  },
  {
    toolName: "onedrive.files.search",
    description: "Search OneDrive files by name or content.",
    effect: "read",
    provider: "onedrive",
    requiredScopes: ONEDRIVE_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "onedrive-files-search",
    buildUrl(input) {
      const query = requireToolString(input, "query").replaceAll("'", "''");
      return `${GRAPH_BASE}${drivePrefix(input)}/root/search(q='${encodeURIComponent(query)}')`;
    },
    buildHeaders: graphHeaders,
  },
  {
    toolName: "onedrive.files.get",
    description: "Read OneDrive file metadata by item id.",
    effect: "read",
    provider: "onedrive",
    requiredScopes: ONEDRIVE_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "onedrive-file",
    buildUrl: (input) =>
      `${GRAPH_BASE}${drivePrefix(input)}/items/${encodeURIComponent(requireToolString(input, "itemId"))}`,
    buildHeaders: graphHeaders,
  },
  {
    toolName: "onedrive.files.upload",
    description: "Upload a small file to OneDrive after approval.",
    effect: "write",
    provider: "onedrive",
    requiredScopes: ONEDRIVE_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "PUT",
    filePrefix: "onedrive-file-upload",
    buildUrl(input) {
      const parentId = optionalToolString(input, "parentId");
      const name = encodeURIComponent(requireToolString(input, "name"));
      return parentId
        ? `${GRAPH_BASE}${drivePrefix(input)}/items/${encodeURIComponent(parentId)}:/${name}:/content`
        : `${GRAPH_BASE}${drivePrefix(input)}/root:/${name}:/content`;
    },
    buildBody: microsoftFileBody,
    buildHeaders: graphHeaders,
  },
  {
    toolName: "onedrive.permissions.create",
    description: "Create a OneDrive sharing permission after approval.",
    effect: "write",
    provider: "onedrive",
    requiredScopes: ONEDRIVE_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "onedrive-permission-create",
    buildUrl: (input) =>
      `${GRAPH_BASE}${drivePrefix(input)}/items/${encodeURIComponent(requireToolString(input, "itemId"))}/invite`,
    buildBody: (input) => jsonProviderNativeBody(requiredObject(input, "invitation")),
    buildHeaders: graphHeaders,
  },
];
