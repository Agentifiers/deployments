import { objectSchema, staticProviderUrl, stringProperty } from "../tool-definition-builders.ts";
import { acquisitionRead, id } from "./common.ts";

const HOSTS = ["api.rankparse.com"] as const;

export const rankparseNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: (input) =>
      `${staticProviderUrl("api.rankparse.com", ["v1", "domain-authority"])}?domain=${encodeURIComponent(id(input, "domain"))}`,
    description: "Read RankParse domain authority for a target domain.",
    hosts: HOSTS,
    inputSchema: objectSchema({ domain: stringProperty("Domain to inspect.") }, ["domain"]),
    provider: "rankparse",
    requiredScopes: ["domain_authority:read"],
    resourceTypes: ["site"],
    sampleInput: { domain: "example.com" },
    toolName: "rankparse.domain.authority.read",
  }),
] as const;
