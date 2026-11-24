import { objectSchema, staticProviderUrl, stringProperty } from "../tool-definition-builders.ts";
import { acquisitionRead, id } from "./common.ts";

const HOSTS = ["api.hotjar.io"] as const;

export const hotjarNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: (input) =>
      staticProviderUrl("api.hotjar.io", ["v1", "sites", id(input, "siteId"), "surveys"]),
    description: "List surveys for the connector-bound Hotjar site.",
    hosts: HOSTS,
    inputSchema: objectSchema({ siteId: stringProperty("Connector-bound Hotjar site ID.") }),
    provider: "hotjar",
    requiredScopes: ["surveys:read"],
    resourceTypes: ["site"],
    sampleInput: { siteId: "123456" },
    toolName: "hotjar.surveys.list",
  }),
] as const;
