import { isIP } from "node:net";
import {
  isPublicBrowserScreenshotAddress,
  isPublicBrowserScreenshotTarget,
  type BrowserScreenshotDnsLookup,
} from "@deployments-ai/browser-screenshot";
import {
  SELF_HOSTED_WEB_OPERATION_OPTION_NAMES,
  SELF_HOSTED_WEB_RENDERERS,
  SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES,
} from "@deployments-ai/tools";
import {
  MAX_FIRECRAWL_CRAWL_PAGES,
  MAX_FIRECRAWL_EXTRACT_URLS,
  MAX_FIRECRAWL_INPUT_BYTES,
  MAX_FIRECRAWL_SEARCH_RESULTS,
  SelfHostedWebToolError,
  type SelfHostedWebToolName,
} from "./config.ts";

export function inputRecord(
  toolName: SelfHostedWebToolName,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelfHostedWebToolError("Tool input must be a JSON object.");
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_FIRECRAWL_INPUT_BYTES) {
    throw new SelfHostedWebToolError(`Tool input exceeds ${MAX_FIRECRAWL_INPUT_BYTES} bytes.`);
  }
  const input = structuredClone(value as Record<string, unknown>);
  if (input.idempotencyKey !== undefined) {
    if (
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 512
    ) {
      throw new SelfHostedWebToolError(
        "idempotencyKey must be a non-empty string up to 512 characters.",
      );
    }
  }
  return input;
}

const MAX_WEB_TOOL_URLS = 100;
const MAX_WEB_TOOL_URL_LENGTH = 4_096;
const WEB_TOOL_ALLOWED_PORTS = new Set([80, 443]);

interface UrlValidationContext {
  readonly dnsLookup: BrowserScreenshotDnsLookup;
  readonly hosts: Map<string, Promise<void>>;
}

export function limitedDnsLookup(dnsLookup: BrowserScreenshotDnsLookup, concurrency = 8) {
  let active = 0;
  const pending: Array<() => void> = [];
  return (async (...args: Parameters<BrowserScreenshotDnsLookup>) => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => pending.push(resolve));
    }
    active += 1;
    try {
      return await dnsLookup(...args);
    } finally {
      active -= 1;
      pending.shift()?.();
    }
  }) as BrowserScreenshotDnsLookup;
}

async function normalizedPublicUrl(value: string, context: UrlValidationContext) {
  if (value.length > MAX_WEB_TOOL_URL_LENGTH) {
    throw new SelfHostedWebToolError(
      `Web tool URLs must not exceed ${MAX_WEB_TOOL_URL_LENGTH} characters.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SelfHostedWebToolError("Web tool URLs must be valid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SelfHostedWebToolError("Web tool URLs must use HTTP or HTTPS.");
  }
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!WEB_TOOL_ALLOWED_PORTS.has(port)) {
    throw new SelfHostedWebToolError("Web tool URLs must use port 80 or 443.");
  }
  if (parsed.username || parsed.password || !isPublicBrowserScreenshotTarget(parsed)) {
    throw new SelfHostedWebToolError(
      "Web tool URLs must target a public host without credentials.",
    );
  }
  if (isIP(parsed.hostname.replace(/^\[(.*)\]$/u, "$1")) === 0) {
    const hostname = parsed.hostname.toLowerCase();
    let validation = context.hosts.get(hostname);
    if (!validation) {
      validation = context.dnsLookup(hostname, { all: true, verbatim: true }).then((answers) => {
        if (
          answers.length === 0 ||
          answers.some(({ address }) => !isPublicBrowserScreenshotAddress(address)) ||
          !answers.some(({ address }) => isIP(address) === 4)
        ) {
          throw new SelfHostedWebToolError(
            "Web tool target must resolve exclusively to public addresses with public IPv4 support.",
          );
        }
      });
      context.hosts.set(hostname, validation);
    }
    await validation;
  }
  return parsed.toString();
}

const URL_FIELD = /(?:url|uri|webhook)$/iu;
const URLS_FIELD = /(?:urls|uris)$/iu;

export async function validateUrls(
  value: unknown,
  context: UrlValidationContext,
  key = "",
): Promise<unknown> {
  if (typeof value === "string" && URL_FIELD.test(key)) {
    return normalizedPublicUrl(value, context);
  }
  if (Array.isArray(value)) {
    if (URLS_FIELD.test(key)) {
      if (value.length > MAX_WEB_TOOL_URLS) {
        throw new SelfHostedWebToolError(
          `${key} must not contain more than ${MAX_WEB_TOOL_URLS} URLs.`,
        );
      }
      return Promise.all(
        value.map((entry) => {
          if (typeof entry !== "string") {
            throw new SelfHostedWebToolError(`${key} must contain only URL strings.`);
          }
          return normalizedPublicUrl(entry, context);
        }),
      );
    }
    return Promise.all(value.map((entry) => validateUrls(entry, context)));
  }
  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([entryKey, entry]) => [
        entryKey,
        await validateUrls(entry, context, entryKey),
      ]),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

export function optionsFromInput(input: Record<string, unknown>) {
  const options = input.options;
  if (options === undefined) return {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new SelfHostedWebToolError("options must be a JSON object.");
  }
  return options as Record<string, unknown>;
}

const SCRAPE_OPTION_FIELDS = new Set<string>(SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES);
const OPERATION_OPTION_FIELDS = Object.fromEntries(
  Object.entries(SELF_HOSTED_WEB_OPERATION_OPTION_NAMES).map(([toolName, names]) => [
    toolName,
    new Set<string>(names),
  ]),
) as Partial<Record<SelfHostedWebToolName, ReadonlySet<string>>>;

const OPERATION_INPUT_FIELDS = {
  "web.batch_scrape": ["idempotencyKey", "options", "renderer", "urls"],
  "web.batch_scrape_cancel": ["id", "idempotencyKey"],
  "web.batch_scrape_errors": ["id", "idempotencyKey"],
  "web.batch_scrape_status": ["cursor", "id", "idempotencyKey"],
  "web.crawl": [
    "allowExternalLinks",
    "allowSubdomains",
    "excludePaths",
    "idempotencyKey",
    "includePaths",
    "limit",
    "maxDiscoveryDepth",
    "options",
    "renderer",
    "scrapeOptions",
    "url",
  ],
  "web.crawl_cancel": ["id", "idempotencyKey"],
  "web.crawl_errors": ["id", "idempotencyKey"],
  "web.crawl_params_preview": ["idempotencyKey", "prompt", "url"],
  "web.crawl_status": ["cursor", "id", "idempotencyKey"],
  "web.deep_research": ["idempotencyKey", "maxDepth", "options", "query", "renderer", "timeLimit"],
  "web.deep_research_status": ["id", "idempotencyKey"],
  "web.extract": [
    "allowExternalLinks",
    "enableWebSearch",
    "idempotencyKey",
    "includeSubdomains",
    "options",
    "prompt",
    "renderer",
    "schema",
    "urls",
  ],
  "web.extract_status": ["id", "idempotencyKey"],
  "web.generate_llms_txt": ["idempotencyKey", "options", "renderer", "url"],
  "web.llms_txt_status": ["id", "idempotencyKey"],
  "web.map": [
    "idempotencyKey",
    "ignoreQueryParameters",
    "includeSubdomains",
    "limit",
    "options",
    "search",
    "sitemap",
    "url",
  ],
  "web.parse": ["artifactId", "idempotencyKey", "options"],
  "web.scrape": ["formats", "idempotencyKey", "onlyMainContent", "options", "renderer", "url"],
  "web.search": [
    "categories",
    "idempotencyKey",
    "limit",
    "options",
    "query",
    "renderer",
    "sources",
  ],
} as const satisfies Record<SelfHostedWebToolName, readonly string[]>;

const FIRECRAWL_SEARCH_SOURCE_TYPES = new Set(["images", "news", "web"]);
/** Firecrawl reads these operations' renderer from the per-page scrapeOptions. */
const SCRAPE_OPTIONS_RENDERER_TOOLS: Partial<Record<SelfHostedWebToolName, true>> = {
  "web.crawl": true,
  "web.extract": true,
  "web.search": true,
};

function validateSearchSources(value: unknown) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new SelfHostedWebToolError("web.search sources must be an array.");
  }
  for (const source of value) {
    const type =
      typeof source === "string"
        ? source
        : source && typeof source === "object" && !Array.isArray(source)
          ? (source as Record<string, unknown>).type
          : undefined;
    if (typeof type !== "string" || !FIRECRAWL_SEARCH_SOURCE_TYPES.has(type)) {
      throw new SelfHostedWebToolError("web.search sources must use web, images, or news.");
    }
  }
}

export function validateOperationInput(
  toolName: SelfHostedWebToolName,
  input: Record<string, unknown>,
) {
  const allowedInput = new Set<string>(OPERATION_INPUT_FIELDS[toolName]);
  const unknownInput = Object.keys(input).find((key) => !allowedInput.has(key));
  if (unknownInput) {
    throw new SelfHostedWebToolError(`${unknownInput} is not supported by ${toolName}.`);
  }
  if (
    input.renderer !== undefined &&
    !(SELF_HOSTED_WEB_RENDERERS as readonly unknown[]).includes(input.renderer)
  ) {
    throw new SelfHostedWebToolError(
      `${toolName} renderer must be one of ${SELF_HOSTED_WEB_RENDERERS.join(", ")}.`,
    );
  }
  const options = optionsFromInput(input);
  const allowedOptions = (
    OPERATION_OPTION_FIELDS as Partial<Record<SelfHostedWebToolName, ReadonlySet<string>>>
  )[toolName];
  const unknownOption = Object.keys(options).find((key) => !allowedOptions?.has(key));
  if (unknownOption) {
    throw new SelfHostedWebToolError(`${unknownOption} is not supported by ${toolName} options.`);
  }
  if (toolName === "web.batch_scrape" || toolName === "web.extract") {
    if (!Array.isArray(input.urls) || input.urls.length === 0) {
      throw new SelfHostedWebToolError(`${toolName} urls must contain at least one URL.`);
    }
  }
  if (
    toolName === "web.extract" &&
    Array.isArray(input.urls) &&
    input.urls.length > MAX_FIRECRAWL_EXTRACT_URLS
  ) {
    throw new SelfHostedWebToolError(
      `web.extract urls must not contain more than ${MAX_FIRECRAWL_EXTRACT_URLS} URLs.`,
    );
  }
  if (toolName === "web.crawl") {
    const limit = input.limit !== undefined ? input.limit : options.limit;
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > MAX_FIRECRAWL_CRAWL_PAGES)
    ) {
      throw new SelfHostedWebToolError(
        `web.crawl limit must be a safe integer between 1 and ${MAX_FIRECRAWL_CRAWL_PAGES}.`,
      );
    }
  }
  if (toolName === "web.search") {
    validateSearchSources(input.sources);
    validateSearchSources(options.sources);
    const limit = input.limit !== undefined ? input.limit : options.limit;
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > MAX_FIRECRAWL_SEARCH_RESULTS)
    ) {
      throw new SelfHostedWebToolError(
        `web.search limit must be a safe integer between 1 and ${MAX_FIRECRAWL_SEARCH_RESULTS}.`,
      );
    }
  }
  for (const value of [input.scrapeOptions, options.scrapeOptions]) {
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SelfHostedWebToolError("scrapeOptions must be a JSON object.");
    }
    const unknownScrapeOption = Object.keys(value).find((key) => !SCRAPE_OPTION_FIELDS.has(key));
    if (unknownScrapeOption) {
      throw new SelfHostedWebToolError(
        `${unknownScrapeOption} is not supported by ${toolName} scrapeOptions.`,
      );
    }
  }
}

export function hasInteractiveActions(input: Record<string, unknown>) {
  const options = optionsFromInput(input);
  const containers = [input, options, input.scrapeOptions, options.scrapeOptions];
  return containers.some(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).actions !== undefined,
  );
}

const PATH_FIELDS = new Set(["cursor", "id", "idempotencyKey", "options"]);

export function requestPayload(toolName: SelfHostedWebToolName, input: Record<string, unknown>) {
  const topLevel = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !PATH_FIELDS.has(key) && value !== undefined),
  );
  const payload = { ...optionsFromInput(input), ...topLevel };
  if (payload.renderer === undefined || !SCRAPE_OPTIONS_RENDERER_TOOLS[toolName]) {
    return payload;
  }
  const { renderer, ...body } = payload;
  return {
    ...body,
    scrapeOptions: { ...(body.scrapeOptions as Record<string, unknown> | undefined), renderer },
  };
}

export function appendQuery(url: URL, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, String(entry));
    } else if (value && typeof value === "object") {
      url.searchParams.set(key, JSON.stringify(value));
    } else if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      url.searchParams.set(key, String(value));
    }
  }
}
