import { objectSchema, staticProviderUrl, stringProperty } from "../tool-definition-builders.ts";
import { acquisitionRead } from "./common.ts";

const HOSTS = ["plausible.io"] as const;

export const plausibleNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: () => staticProviderUrl("plausible.io", ["api", "v1", "sites"]),
    description: "List Plausible sites accessible to the connected account.",
    hosts: HOSTS,
    inputSchema: objectSchema({ teamId: stringProperty("Optional Plausible team identifier.") }),
    provider: "plausible",
    requiredScopes: [],
    resourceTypes: ["site"],
    sampleInput: {},
    toolName: "plausible.sites.list",
  }),
] as const;
