import { type BrowserScreenshotDnsLookup } from "@deployments-ai/browser-screenshot";
import { ArtifactRecord, ToolCallRecord } from "@deployments-ai/db";

export const FIRECRAWL_ENV_KEYS = {
  apiKey: ["DEPLOYMENTS_AI_FIRECRAWL_API_KEY", "FIRECRAWL_API_KEY"],
  baseUrl: ["DEPLOYMENTS_AI_FIRECRAWL_BASE_URL", "FIRECRAWL_BASE_URL"],
  denyPrivateEgress: ["DEPLOYMENTS_AI_FIRECRAWL_DENY_PRIVATE_EGRESS"],
  jobTicketSecret: ["DEPLOYMENTS_AI_FIRECRAWL_JOB_TICKET_SECRET"],
} as const;

export const MAX_FIRECRAWL_INPUT_BYTES = 256 * 1024;
export const MAX_FIRECRAWL_PARSE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FIRECRAWL_CRAWL_PAGES = 100;
export const MAX_FIRECRAWL_EXTRACT_URLS = 10;
export const MAX_FIRECRAWL_SEARCH_RESULTS = 100;
export const MAX_FIRECRAWL_RESPONSE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_FIRECRAWL_TIMEOUT_MS = 120_000;
/** Firecrawl's own deadline for one `web.scrape` when the model sets none. */
export const DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_MS = 45_000;
/** How long before the client aborts Firecrawl must give up, so its timeout reaches the model. */
export const FIRECRAWL_SCRAPE_TIMEOUT_MARGIN_MS = 10_000;
export const SELF_HOSTED_WEB_TOOL_SEMANTIC_EVENT_TYPES = [
  "tool-call.requested",
  "tool-call.completed",
  "tool-call.failed",
] as const;

export type SelfHostedWebToolCallRecord = typeof ToolCallRecord.Type;
export type SelfHostedWebToolArtifactRecord = typeof ArtifactRecord.Type;

export interface SelfHostedWebToolParseArtifact {
  readonly artifact: SelfHostedWebToolArtifactRecord;
  readonly content: Uint8Array;
}

export interface SelfHostedWebToolsConfig {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly denyPrivateEgress: true;
  readonly jobTicketSecret?: string;
  readonly scopeId?: string;
  readonly timeoutMs?: number;
}

export interface SelfHostedWebToolsDependencies {
  readonly dnsLookup?: BrowserScreenshotDnsLookup;
  readonly fetch?: FirecrawlFetch;
  readonly loadParseArtifact?: (options: {
    readonly artifactId: string;
    readonly scopeId: string;
  }) => Promise<SelfHostedWebToolParseArtifact>;
}

export class SelfHostedWebToolError extends Error {
  readonly status: number | undefined;
  /** Firecrawl's error code from a failed response, such as `SCRAPE_TIMEOUT`. */
  readonly code: string | undefined;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "SelfHostedWebToolError";
    this.status = status;
    this.code = code;
  }
}

export type FirecrawlMethod = "DELETE" | "GET" | "POST";
export type FirecrawlFetch = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FirecrawlOperation {
  readonly jobKind?: FirecrawlJobKind;
  readonly method: FirecrawlMethod;
  readonly path: (input: Record<string, unknown>) => string;
  readonly startsJob?: boolean;
  readonly supportsCursor?: boolean;
  readonly version?: "v1" | "v2";
}

export type FirecrawlJobKind = "batch-scrape" | "crawl" | "deep-research" | "extract" | "llms-txt";

export const encoded = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new SelfHostedWebToolError(`${field} must be a non-empty string.`);
  }
  if (value.length > 512) throw new SelfHostedWebToolError(`${field} is too long.`);
  return encodeURIComponent(value.trim());
};

const idPath =
  (prefix: string, suffix = "") =>
  (input: Record<string, unknown>) =>
    `${prefix}/${encoded(input.id, "id")}${suffix}`;

export const FIRECRAWL_OPERATIONS = {
  "web.batch_scrape": {
    jobKind: "batch-scrape",
    method: "POST",
    path: () => "/batch/scrape",
    startsJob: true,
  },
  "web.batch_scrape_cancel": {
    jobKind: "batch-scrape",
    method: "DELETE",
    path: idPath("/batch/scrape"),
  },
  "web.batch_scrape_errors": {
    jobKind: "batch-scrape",
    method: "GET",
    path: idPath("/batch/scrape", "/errors"),
  },
  "web.batch_scrape_status": {
    jobKind: "batch-scrape",
    method: "GET",
    path: idPath("/batch/scrape"),
    supportsCursor: true,
  },
  "web.crawl": {
    jobKind: "crawl",
    method: "POST",
    path: () => "/crawl",
    startsJob: true,
  },
  "web.crawl_cancel": {
    jobKind: "crawl",
    method: "DELETE",
    path: idPath("/crawl"),
  },
  "web.crawl_errors": {
    jobKind: "crawl",
    method: "GET",
    path: idPath("/crawl", "/errors"),
  },
  "web.crawl_params_preview": {
    method: "POST",
    path: () => "/crawl/params-preview",
  },
  "web.crawl_status": {
    jobKind: "crawl",
    method: "GET",
    path: idPath("/crawl"),
    supportsCursor: true,
  },
  "web.deep_research": {
    jobKind: "deep-research",
    method: "POST",
    path: () => "/deep-research",
    startsJob: true,
    version: "v1",
  },
  "web.deep_research_status": {
    jobKind: "deep-research",
    method: "GET",
    path: idPath("/deep-research"),
    version: "v1",
  },
  "web.extract": {
    jobKind: "extract",
    method: "POST",
    path: () => "/extract",
    startsJob: true,
  },
  "web.extract_status": {
    jobKind: "extract",
    method: "GET",
    path: idPath("/extract"),
  },
  "web.generate_llms_txt": {
    jobKind: "llms-txt",
    method: "POST",
    path: () => "/llmstxt",
    startsJob: true,
    version: "v1",
  },
  "web.llms_txt_status": {
    jobKind: "llms-txt",
    method: "GET",
    path: idPath("/llmstxt"),
    version: "v1",
  },
  "web.map": { method: "POST", path: () => "/map" },
  "web.parse": { method: "POST", path: () => "/parse" },
  "web.scrape": { method: "POST", path: () => "/scrape" },
  "web.search": { method: "POST", path: () => "/search" },
} as const satisfies Record<string, FirecrawlOperation>;

export type SelfHostedWebToolName = keyof typeof FIRECRAWL_OPERATIONS;

export function nonEmpty(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function canonicalHostname(value: string) {
  return value
    .toLowerCase()
    .replace(/\.+$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

function normalizeBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SelfHostedWebToolError("Firecrawl baseUrl must be a valid URL.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SelfHostedWebToolError(
      "Firecrawl baseUrl must not contain credentials or query data.",
    );
  }
  const hostname = canonicalHostname(parsed.hostname);
  if (parsed.hostname.endsWith(".")) parsed.hostname = parsed.hostname.replace(/\.+$/u, "");
  if (hostname === "firecrawl.dev" || hostname.endsWith(".firecrawl.dev")) {
    throw new SelfHostedWebToolError(
      "Firecrawl cloud is disabled; configure a self-hosted endpoint.",
    );
  }
  const localHttp =
    parsed.protocol === "http:" &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
  if (parsed.protocol !== "https:" && !localHttp && parsed.protocol !== "http:") {
    throw new SelfHostedWebToolError("Firecrawl baseUrl must use HTTP or HTTPS.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\/(?:v1|v2)$/u, "") || "/";
  return parsed;
}

export function configuredBaseUrl(config: SelfHostedWebToolsConfig) {
  const parsed = normalizeBaseUrl(config.baseUrl);
  if (config.denyPrivateEgress !== true) {
    throw new SelfHostedWebToolError(
      "Firecrawl must use connection-time deny-private egress enforcement.",
    );
  }
  const hostname = canonicalHostname(parsed.hostname);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (parsed.protocol === "http:" && !loopback) {
    throw new SelfHostedWebToolError("Firecrawl baseUrl must use HTTPS unless it is loopback.");
  }
  return parsed;
}

export function readSelfHostedWebToolsConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SelfHostedWebToolsConfig {
  const baseUrl = FIRECRAWL_ENV_KEYS.baseUrl.map((key) => nonEmpty(env[key])).find(Boolean);
  if (!baseUrl) throw new SelfHostedWebToolError(`${FIRECRAWL_ENV_KEYS.baseUrl[0]} is required.`);
  const apiKey = FIRECRAWL_ENV_KEYS.apiKey.map((key) => nonEmpty(env[key])).find(Boolean);
  const jobTicketSecret = FIRECRAWL_ENV_KEYS.jobTicketSecret
    .map((key) => nonEmpty(env[key]))
    .find(Boolean);
  if (env[FIRECRAWL_ENV_KEYS.denyPrivateEgress[0]] !== "true") {
    throw new SelfHostedWebToolError(
      `${FIRECRAWL_ENV_KEYS.denyPrivateEgress[0]} must be set to true after connection-time deny-private egress is configured.`,
    );
  }
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    denyPrivateEgress: true,
    ...(jobTicketSecret ? { jobTicketSecret } : {}),
  };
}
