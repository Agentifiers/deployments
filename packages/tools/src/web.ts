import type { ToolEgress } from "@deployments-ai/db";
import type { ToolAdapterDefinition, ToolEffect, ToolPolicyAction } from "./types.ts";

type JsonSchema = Readonly<Record<string, unknown>>;

interface WebToolSpec {
  readonly defaultPolicyAction?: ToolPolicyAction;
  readonly description: string;
  readonly effect?: ToolEffect;
  /**
   * Job status, error, and cancel calls send only a job ticket to the self-hosted Firecrawl and
   * read its stored state, so they stay in the platform. Every other web tool is public.
   */
  readonly egress?: ToolEgress;
  readonly inputSchema: JsonSchema;
  readonly providerOutboundMutation?: boolean;
  readonly toolName: string;
}

const string = (description: string): JsonSchema => ({
  description,
  type: "string",
});
const number = (description: string): JsonSchema => ({
  description,
  type: "number",
});
const boundedInteger = (description: string, maximum: number): JsonSchema => ({
  description,
  maximum,
  minimum: 1,
  type: "integer",
});
const boolean = (description: string): JsonSchema => ({
  description,
  type: "boolean",
});
const object = (description: string): JsonSchema => ({
  additionalProperties: true,
  description,
  type: "object",
});
const strings = (description: string): JsonSchema => ({
  description,
  items: { type: "string" },
  type: "array",
});

export const SELF_HOSTED_WEB_RENDERERS = ["auto", "lightpanda", "chromium"] as const;

const renderer: JsonSchema = {
  description:
    "Page renderer. auto (default) renders with the lightweight Lightpanda browser and falls back to full Chromium when Lightpanda fails, returns an empty page, or is blocked (HTTP 401, 403, or 429). chromium forces full Chromium rendering for pages that need it. lightpanda forces the lightweight renderer and never falls back to Chromium.",
  enum: SELF_HOSTED_WEB_RENDERERS,
  type: "string",
};

export const SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES = [
  "blockAds",
  "excludeTags",
  "formats",
  "headers",
  "includeTags",
  "location",
  "maxAge",
  "mobile",
  "onlyMainContent",
  "parsers",
  "proxy",
  "removeBase64Images",
  "skipTlsVerification",
  "storeInCache",
  "timeout",
  "waitFor",
] as const;

export const SELF_HOSTED_WEB_OPERATION_OPTION_NAMES = {
  "web.batch_scrape": [
    ...SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES,
    "ignoreInvalidURLs",
    "maxConcurrency",
    "zeroDataRetention",
  ],
  "web.crawl": [
    "allowExternalLinks",
    "allowSubdomains",
    "crawlEntireDomain",
    "delay",
    "excludePaths",
    "ignoreQueryParameters",
    "includePaths",
    "limit",
    "maxConcurrency",
    "maxDiscoveryDepth",
    "prompt",
    "scrapeOptions",
    "sitemap",
    "zeroDataRetention",
  ],
  "web.deep_research": ["maxDepth", "maxUrls", "timeLimit"],
  "web.extract": [
    "allowExternalLinks",
    "enableWebSearch",
    "ignoreSitemap",
    "includeSubdomains",
    "prompt",
    "schema",
    "showSources",
  ],
  "web.generate_llms_txt": ["maxUrls", "showFullText"],
  "web.map": [
    "ignoreQueryParameters",
    "includeSubdomains",
    "limit",
    "location",
    "search",
    "sitemap",
    "timeout",
    "useIndex",
  ],
  "web.parse": [
    "blockAds",
    "excludeTags",
    "fastMode",
    "formats",
    "headers",
    "includeTags",
    "onlyCleanContent",
    "onlyMainContent",
    "parsers",
    // The pinned v2 parse schema extends baseScrapeOptions, which includes redactPII.
    "redactPII",
    "removeBase64Images",
    "timeout",
    "zeroDataRetention",
  ],
  "web.scrape": [...SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES, "zeroDataRetention"],
  "web.search": [
    "categories",
    "country",
    "enterprise",
    "excludeDomains",
    "filter",
    "highlights",
    "ignoreInvalidURLs",
    "includeDomains",
    "lang",
    "limit",
    "location",
    "scrapeOptions",
    "sources",
    "tbs",
    "timeout",
  ],
} as const;

const BOOLEAN_OPTION_NAMES = new Set([
  "allowExternalLinks",
  "allowSubdomains",
  "blockAds",
  "crawlEntireDomain",
  "enableWebSearch",
  "enterprise",
  "fastMode",
  "highlights",
  "ignoreInvalidURLs",
  "ignoreQueryParameters",
  "ignoreSitemap",
  "includeSubdomains",
  "mobile",
  "onlyCleanContent",
  "onlyMainContent",
  "redactPII",
  "removeBase64Images",
  "showFullText",
  "showSources",
  "skipTlsVerification",
  "storeInCache",
  "useIndex",
  "zeroDataRetention",
]);
const NUMBER_OPTION_NAMES = new Set([
  "delay",
  "limit",
  "maxAge",
  "maxConcurrency",
  "maxDepth",
  "maxDiscoveryDepth",
  "maxUrls",
  "timeLimit",
  "timeout",
  "waitFor",
]);
const STRING_OPTION_NAMES = new Set([
  "country",
  "filter",
  "lang",
  "prompt",
  "proxy",
  "search",
  "tbs",
]);
const STRING_ARRAY_OPTION_NAMES = new Set([
  "excludeDomains",
  "excludePaths",
  "excludeTags",
  "includeDomains",
  "includePaths",
  "includeTags",
  "sources",
]);

function optionPropertySchema(name: string, operation?: string): JsonSchema {
  if (operation === "web.search") {
    if (name === "enterprise") {
      return { items: { enum: ["default", "anon", "zdr"], type: "string" }, type: "array" };
    }
    if (name === "location") return { type: "string" };
    if (name === "limit") return { maximum: 100, minimum: 1, type: "integer" };
    if (name === "sources") {
      return searchSources;
    }
  }
  if (name === "redactPII") {
    return { oneOf: [{ type: "boolean" }, { additionalProperties: true, type: "object" }] };
  }
  if (BOOLEAN_OPTION_NAMES.has(name)) return { type: "boolean" };
  if (NUMBER_OPTION_NAMES.has(name)) return { type: "number" };
  if (STRING_OPTION_NAMES.has(name)) return { type: "string" };
  if (STRING_ARRAY_OPTION_NAMES.has(name)) return { items: { type: "string" }, type: "array" };
  if (name === "sitemap") return { enum: ["only", "include", "skip"], type: "string" };
  if (name === "formats" || name === "parsers") return { items: {}, type: "array" };
  if (name === "categories") return searchCategories;
  if (name === "scrapeOptions") return closedOptions(SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES);
  return { additionalProperties: true, type: "object" };
}

function closedOptions(names: readonly string[], operation?: string): JsonSchema {
  return {
    additionalProperties: false,
    description: "Additional allowlisted Firecrawl options for this operation.",
    properties: Object.fromEntries(
      names.map((name) => [name, optionPropertySchema(name, operation)]),
    ),
    type: "object",
  };
}

function inputSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    additionalProperties: false,
    properties: {
      ...properties,
      idempotencyKey: {
        description: "Caller-stable platform idempotency key for safe retries.",
        maxLength: 512,
        type: "string",
      },
    },
    ...(required.length > 0 ? { required } : {}),
    type: "object",
  };
}

const id = string("Platform-scoped Firecrawl job ticket returned by a start operation.");
const artifactId = string(
  "Organization-scoped available artifact containing the document to parse.",
);
const url: JsonSchema = {
  description: "Public HTTP or HTTPS target URL.",
  maxLength: 4_096,
  type: "string",
};
const urls: JsonSchema = {
  description: "Public HTTP or HTTPS target URLs.",
  items: { maxLength: 4_096, type: "string" },
  maxItems: 100,
  minItems: 1,
  type: "array",
};
const extractUrls: JsonSchema = {
  description: "Public HTTP or HTTPS target URLs.",
  items: { maxLength: 4_096, type: "string" },
  maxItems: 10,
  minItems: 1,
  type: "array",
};
const searchSources: JsonSchema = {
  oneOf: [
    {
      items: { enum: ["web", "images", "news"], type: "string" },
      type: "array",
    },
    {
      items: {
        oneOf: [
          {
            additionalProperties: false,
            properties: {
              country: { type: "string" },
              filter: { type: "string" },
              lang: { type: "string" },
              location: { type: "string" },
              tbs: { type: "string" },
              type: { const: "web", type: "string" },
            },
            required: ["type"],
            type: "object",
          },
          ...["images", "news"].map((type) => ({
            additionalProperties: false,
            properties: { type: { const: type, type: "string" } },
            required: ["type"],
            type: "object",
          })),
        ],
      },
      type: "array",
    },
  ],
};
const searchCategories: JsonSchema = {
  description: "Specialized GitHub, research-paper, or PDF search categories.",
  oneOf: [
    {
      items: { enum: ["github", "research", "pdf"], type: "string" },
      type: "array",
    },
    {
      items: {
        oneOf: ["github", "research", "pdf"].map((type) => ({
          additionalProperties: false,
          properties: { type: { const: type, type: "string" } },
          required: ["type"],
          type: "object",
        })),
      },
      type: "array",
    },
  ],
};

const WEB_TOOL_SPECS = [
  {
    description:
      "Scrape one public page into Markdown, HTML, links, images, JSON, branding, or media metadata.",
    inputSchema: inputSchema(
      {
        formats: strings("Requested Firecrawl output formats."),
        onlyMainContent: boolean("Exclude navigation and other secondary page content."),
        options: closedOptions(SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.scrape"], "web.scrape"),
        renderer,
        url,
      },
      ["url"],
    ),
    toolName: "web.scrape",
  },
  {
    description: "Start one Firecrawl batch scrape for multiple public URLs.",
    effect: "execute",
    providerOutboundMutation: true,
    inputSchema: inputSchema(
      {
        options: closedOptions(
          SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.batch_scrape"],
          "web.batch_scrape",
        ),
        renderer,
        urls,
      },
      ["urls"],
    ),
    toolName: "web.batch_scrape",
  },
  {
    egress: "platform",
    description: "Read the status and results of a Firecrawl batch scrape.",
    inputSchema: inputSchema(
      {
        cursor: string("Opaque pagination cursor returned by the previous status call."),
        id,
      },
      ["id"],
    ),
    toolName: "web.batch_scrape_status",
  },
  {
    egress: "platform",
    defaultPolicyAction: "require_approval",
    description: "Cancel an active Firecrawl batch scrape.",
    effect: "execute",
    providerOutboundMutation: true,
    inputSchema: inputSchema({ id }, ["id"]),
    toolName: "web.batch_scrape_cancel",
  },
  {
    egress: "platform",
    description: "Read errors recorded for a Firecrawl batch scrape.",
    inputSchema: inputSchema({ id }, ["id"]),
    toolName: "web.batch_scrape_errors",
  },
  {
    description: "Start a bounded website crawl and content extraction job.",
    effect: "execute",
    providerOutboundMutation: true,
    inputSchema: inputSchema(
      {
        allowExternalLinks: boolean("Allow discovered links outside the starting origin."),
        allowSubdomains: boolean("Allow discovered links on subdomains."),
        excludePaths: strings("Path patterns to exclude."),
        includePaths: strings("Path patterns to include."),
        limit: boundedInteger("Maximum pages to crawl.", 100),
        maxDiscoveryDepth: number("Maximum link discovery depth."),
        options: closedOptions(SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.crawl"], "web.crawl"),
        renderer,
        scrapeOptions: closedOptions(SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES),
        url,
      },
      ["url"],
    ),
    toolName: "web.crawl",
  },
  {
    description: "Generate crawl parameters from a natural-language crawl objective.",
    inputSchema: inputSchema({ prompt: string("Natural-language crawl objective."), url }, [
      "url",
      "prompt",
    ]),
    toolName: "web.crawl_params_preview",
  },
  {
    egress: "platform",
    description: "Read the status, progress, and results of a Firecrawl crawl.",
    inputSchema: inputSchema(
      {
        cursor: string("Opaque pagination cursor returned by the previous status call."),
        id,
      },
      ["id"],
    ),
    toolName: "web.crawl_status",
  },
  {
    egress: "platform",
    defaultPolicyAction: "require_approval",
    description: "Cancel an active Firecrawl crawl.",
    effect: "execute",
    providerOutboundMutation: true,
    inputSchema: inputSchema({ id }, ["id"]),
    toolName: "web.crawl_cancel",
  },
  {
    egress: "platform",
    description: "Read errors recorded for a Firecrawl crawl.",
    inputSchema: inputSchema({ id }, ["id"]),
    toolName: "web.crawl_errors",
  },
  {
    description: "Discover and rank URLs from a website without scraping every page.",
    inputSchema: inputSchema(
      {
        ignoreQueryParameters: boolean("Deduplicate URLs that differ only by query parameters."),
        includeSubdomains: boolean("Include subdomains in discovery."),
        limit: number("Maximum discovered URLs to return."),
        options: closedOptions(SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.map"], "web.map"),
        search: string("Optional semantic filter for discovered URLs."),
        sitemap: {
          description: "Sitemap handling mode.",
          enum: ["only", "include", "skip"],
          type: "string",
        },
        url,
      },
      ["url"],
    ),
    toolName: "web.map",
  },
  {
    description: "Search the web, news, or image indexes and optionally scrape result pages.",
    inputSchema: inputSchema(
      {
        categories: searchCategories,
        limit: boundedInteger("Maximum search results.", 100),
        options: closedOptions(SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.search"], "web.search"),
        query: string("Search query."),
        renderer,
        sources: searchSources,
      },
      ["query"],
    ),
    toolName: "web.search",
  },
  {
    description:
      "Start legacy schema-guided LLM extraction across one or more public pages. Prefer web.scrape with a JSON format for new callers.",
    effect: "execute",
    providerOutboundMutation: true,
    inputSchema: inputSchema(
      {
        allowExternalLinks: boolean("Allow extraction to follow external links."),
        enableWebSearch: boolean("Allow search to find supporting sources."),
        includeSubdomains: boolean("Include matching subdomains."),
        options: closedOptions(
          SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.extract"],
          "web.extract",
        ),
        prompt: string("Extraction instructions."),
        renderer,
        schema: object("JSON Schema for the extracted result."),
        urls: extractUrls,
      },
      ["urls"],
    ),
    toolName: "web.extract",
  },
  {
    egress: "platform",
    description: "Read the status and result of a legacy Firecrawl extraction job.",
    inputSchema: inputSchema({ id }, ["id"]),
    toolName: "web.extract_status",
  },
  {
    description: "Parse a document from a version-pinned organization artifact.",
    inputSchema: inputSchema(
      {
        artifactId,
        options: closedOptions(SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.parse"], "web.parse"),
      },
      ["artifactId"],
    ),
    toolName: "web.parse",
  },
  {
    description: "Start Firecrawl's deprecated self-hosted deep research job.",
    effect: "execute",
    providerOutboundMutation: true,
    inputSchema: inputSchema(
      {
        maxDepth: number("Maximum research depth."),
        options: closedOptions(
          SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.deep_research"],
          "web.deep_research",
        ),
        query: string("Research question."),
        renderer,
        timeLimit: number("Maximum runtime in seconds."),
      },
      ["query"],
    ),
    toolName: "web.deep_research",
  },
  {
    egress: "platform",
    description: "Read the status and results of a deprecated deep research job.",
    inputSchema: inputSchema({ id }, ["id"]),
    toolName: "web.deep_research_status",
  },
  {
    description: "Start Firecrawl's deprecated llms.txt generation job.",
    effect: "execute",
    providerOutboundMutation: true,
    inputSchema: inputSchema(
      {
        options: closedOptions(
          SELF_HOSTED_WEB_OPERATION_OPTION_NAMES["web.generate_llms_txt"],
          "web.generate_llms_txt",
        ),
        renderer,
        url,
      },
      ["url"],
    ),
    toolName: "web.generate_llms_txt",
  },
  {
    egress: "platform",
    description: "Read the status and generated output of a deprecated llms.txt job.",
    inputSchema: inputSchema({ id }, ["id"]),
    toolName: "web.llms_txt_status",
  },
] as const satisfies readonly WebToolSpec[];

function definition(spec: WebToolSpec): ToolAdapterDefinition {
  return {
    defaultPolicyAction: spec.defaultPolicyAction ?? "allow",
    description: spec.description,
    effect: spec.effect ?? "read",
    egress: spec.egress ?? "public",
    execution: { adapterKey: spec.toolName, type: "builtin" },
    inputSchema: spec.inputSchema,
    ...(spec.providerOutboundMutation ? { providerOutboundMutation: true } : {}),
    requiredScopes: [],
    status: "active",
    toolName: spec.toolName,
  };
}

export const selfHostedWebToolDefinitions = WEB_TOOL_SPECS.map(definition);
export const SELF_HOSTED_WEB_TOOL_NAMES = WEB_TOOL_SPECS.map(({ toolName }) => toolName);
