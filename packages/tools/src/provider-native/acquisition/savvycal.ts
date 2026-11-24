import { appendNativeQueryFields, requirePositiveLimit } from "../core.ts";
import {
  integerProperty,
  objectSchema,
  staticProviderUrl,
  stringProperty,
} from "../tool-definition-builders.ts";
import { acquisitionRead } from "./common.ts";

const SAVVYCAL_HOST = "api.savvycal.com";

function collectionUrl(path: string, input: Record<string, unknown>): string {
  const url = new URL(staticProviderUrl(SAVVYCAL_HOST, ["v1", path]));
  url.searchParams.set("limit", String(requirePositiveLimit(input, "limit", 50, 100)));
  appendNativeQueryFields(url, input, ["cursor", "after", "before", "link_id"]);
  return url.toString();
}

export const savvycalNativeHttpToolDefinitions = [
  acquisitionRead({
    toolName: "savvycal.links.list",
    description: "List scheduling links owned by the connected SavvyCal account.",
    provider: "savvycal",
    hosts: [SAVVYCAL_HOST],
    requiredScopes: ["links:read"],
    inputSchema: objectSchema({
      cursor: stringProperty("Optional SavvyCal pagination cursor."),
      limit: integerProperty(1, 100),
    }),
    resourceTypes: ["account"],
    sampleInput: { limit: 25 },
    buildUrl: (input) => collectionUrl("links", input),
  }),
  acquisitionRead({
    toolName: "savvycal.bookings.list",
    description: "List scheduled events for the connected SavvyCal account.",
    provider: "savvycal",
    hosts: [SAVVYCAL_HOST],
    requiredScopes: ["events:read"],
    inputSchema: objectSchema({
      after: stringProperty("Optional ISO-8601 lower event-time bound."),
      before: stringProperty("Optional ISO-8601 upper event-time bound."),
      cursor: stringProperty("Optional SavvyCal pagination cursor."),
      link_id: stringProperty("Optional scheduling link identifier."),
      limit: integerProperty(1, 100),
    }),
    auditSelectorKeys: ["link_id"],
    resourceTypes: ["link"],
    sampleInput: { limit: 25 },
    buildUrl: (input) => collectionUrl("events", input),
  }),
] as const;
