import {
  optionalToolString,
  requireToolString,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";
import { microsoftFileBody } from "./graph-file-body.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SHAREPOINT_READ_SCOPES = ["Sites.Read.All"] as const;
const SHAREPOINT_WRITE_SCOPES = ["Sites.ReadWrite.All"] as const;

function graphHeaders(): Record<string, string> {
  return { accept: "application/json" };
}

export const microsoftSharePointNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] =
  [
    {
      toolName: "microsoft_sharepoint.sites.search",
      description: "Search Microsoft SharePoint sites by keyword.",
      effect: "read",
      provider: "microsoft-sharepoint",
      requiredScopes: SHAREPOINT_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "sharepoint-sites-search",
      buildUrl(input) {
        const url = new URL(`${GRAPH_BASE}/sites`);
        url.searchParams.set("search", requireToolString(input, "query"));
        return url.toString();
      },
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_sharepoint.drives.list",
      description: "List document libraries for a Microsoft SharePoint site.",
      effect: "read",
      provider: "microsoft-sharepoint",
      requiredScopes: SHAREPOINT_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "sharepoint-drives-list",
      buildUrl: (input) =>
        `${GRAPH_BASE}/sites/${encodeURIComponent(requireToolString(input, "siteId"))}/drives`,
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_sharepoint.files.list",
      description: "List files in a Microsoft SharePoint document library folder.",
      effect: "read",
      provider: "microsoft-sharepoint",
      requiredScopes: SHAREPOINT_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "sharepoint-files-list",
      buildUrl(input) {
        const driveId = encodeURIComponent(requireToolString(input, "driveId"));
        const itemId = optionalToolString(input, "itemId");
        return itemId
          ? `${GRAPH_BASE}/drives/${driveId}/items/${encodeURIComponent(itemId)}/children`
          : `${GRAPH_BASE}/drives/${driveId}/root/children`;
      },
      buildHeaders: graphHeaders,
    },
    {
      toolName: "microsoft_sharepoint.files.upload",
      description: "Upload a small file to Microsoft SharePoint after approval.",
      effect: "write",
      provider: "microsoft-sharepoint",
      requiredScopes: SHAREPOINT_WRITE_SCOPES,
      defaultPolicyAction: "require_approval",
      method: "PUT",
      filePrefix: "sharepoint-file-upload",
      buildUrl(input) {
        const driveId = encodeURIComponent(requireToolString(input, "driveId"));
        const parentId = optionalToolString(input, "parentId");
        const name = encodeURIComponent(requireToolString(input, "name"));
        return parentId
          ? `${GRAPH_BASE}/drives/${driveId}/items/${encodeURIComponent(parentId)}:/${name}:/content`
          : `${GRAPH_BASE}/drives/${driveId}/root:/${name}:/content`;
      },
      buildBody: microsoftFileBody,
      buildHeaders: graphHeaders,
    },
  ];
