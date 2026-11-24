import { boundedJsonProviderNativeBody, optionalToolObject } from "../core.ts";
import {
  jsonObjectProperty,
  objectSchema,
  staticProviderUrl,
  stringProperty,
} from "../tool-definition-builders.ts";
import {
  acquisitionRead,
  bodyFromFields,
  requireHttpsTarget,
  stringArrayProperty,
} from "./common.ts";

const HOSTS = ["api.firecrawl.dev"] as const;

export const firecrawlNativeHttpToolDefinitions = [
  acquisitionRead({
    buildBody: (input) =>
      (() => {
        const safeUrl = requireHttpsTarget(input, "url");
        const explicit = optionalToolObject(input, "body");
        const rawBody = bodyFromFields(input, [
          "url",
          "formats",
          "onlyMainContent",
          "includeTags",
          "excludeTags",
        ]);
        if (explicit) {
          return boundedJsonProviderNativeBody(
            {
              ...explicit,
              url:
                typeof explicit.url === "string"
                  ? requireHttpsTarget({ url: explicit.url }, "url")
                  : safeUrl,
            },
            "body",
          );
        }
        const encoded = rawBody?.body;
        if (typeof encoded !== "string") {
          throw new Error("Firecrawl scrape body must be encoded JSON text.");
        }
        return boundedJsonProviderNativeBody(
          { ...(JSON.parse(encoded) as Record<string, unknown>), url: safeUrl },
          "body",
        );
      })(),
    buildUrl: () => staticProviderUrl("api.firecrawl.dev", ["v2", "scrape"]),
    description: "Scrape one explicitly supplied HTTPS page through Firecrawl.",
    egress: "public",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        body: jsonObjectProperty(),
        formats: stringArrayProperty(),
        onlyMainContent: { type: "boolean" },
        url: stringProperty("HTTPS page on an approved target site."),
      },
      ["url"],
    ),
    method: "POST",
    provider: "firecrawl",
    requiredScopes: ["scrape:execute"],
    resourceTypes: ["site"],
    sampleInput: { url: "https://example.com" },
    toolName: "firecrawl.page.scrape",
  }),
] as const;
