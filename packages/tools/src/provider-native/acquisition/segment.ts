import { integerProperty, objectSchema, stringProperty } from "../tool-definition-builders.ts";
import { acquisitionRead, allowlistedProviderBaseUrl, optional, providerUrl } from "./common.ts";
import { optionalToolPositiveInteger } from "../core.ts";

const HOSTS = ["api.segmentapis.com", "eu1.api.segmentapis.com"] as const;

function segmentUrl(input: Record<string, unknown>, resource: "destinations" | "sources"): string {
  const url = new URL(
    providerUrl(allowlistedProviderBaseUrl(input, "baseUrl", "segment", HOSTS), [resource]),
  );
  const limit = optionalToolPositiveInteger(input, "limit");
  if (limit) url.searchParams.set("pagination.count", String(Math.min(limit, 200)));
  if (optional(input, "cursor")) {
    url.searchParams.set("pagination.cursor", optional(input, "cursor")!);
  }
  return url.toString();
}

function segmentInventoryTool(resource: "destinations" | "sources") {
  return acquisitionRead({
    buildUrl: (input) => segmentUrl(input, resource),
    description: `List Segment ${resource} visible to the connected workspace token.`,
    hosts: HOSTS,
    inputSchema: objectSchema({
      cursor: stringProperty("Optional Segment pagination cursor."),
      limit: integerProperty(1, 200),
    }),
    provider: "segment",
    requiredScopes: [`${resource}:read`],
    resourceTypes: ["workspace"],
    sampleInput: { baseUrl: "https://api.segmentapis.com", limit: 25 },
    toolName: `segment.${resource}.list`,
  });
}

export const segmentNativeHttpToolDefinitions = [
  segmentInventoryTool("sources"),
  segmentInventoryTool("destinations"),
] as const;
