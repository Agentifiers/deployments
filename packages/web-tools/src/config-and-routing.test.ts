import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SELF_HOSTED_WEB_TOOL_NAMES } from "@deployments-ai/tools";
import {
  FIRECRAWL_OPERATIONS,
  createSelfHostedWebToolJobTicket,
  executeSelfHostedWebTool,
  readSelfHostedWebToolsConfig,
  type FirecrawlJobKind,
  type SelfHostedWebToolParseArtifact,
  type SelfHostedWebToolName,
} from "./index.ts";

const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
const DENY_PRIVATE_EGRESS = { denyPrivateEgress: true } as const;
const PARSE_ARTIFACT_ID = "artifact-1";
const PARSE_CONTENT = Buffer.from("<article>hello</article>");
const JOB_CONFIG = {
  baseUrl: "http://127.0.0.1:3002",
  ...DENY_PRIVATE_EGRESS,
  jobTicketSecret: "j".repeat(32),
  scopeId: "org-1",
} as const;

function loadedParseArtifact(
  content: Uint8Array = PARSE_CONTENT,
  organizationId = "org-1",
  visibility = "organization",
  fileName = "report.html",
  contentType = "text/html",
): SelfHostedWebToolParseArtifact {
  return {
    artifact: {
      data: {
        id: PARSE_ARTIFACT_ID,
        organizationId,
        status: "available",
        storage: {
          byteSize: content.byteLength,
          contentType,
          fileName,
          sha256: createHash("sha256").update(content).digest("hex"),
          versionId: "version-1",
        },
        visibility,
      },
      itemType: "artifact",
    },
    content,
  } as unknown as SelfHostedWebToolParseArtifact;
}

function ok(value: unknown = { success: true }) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function jobKind(toolName: SelfHostedWebToolName): FirecrawlJobKind | undefined {
  if (toolName.startsWith("web.batch_scrape")) return "batch-scrape";
  if (toolName.startsWith("web.crawl") && toolName !== "web.crawl_params_preview") {
    return "crawl";
  }
  if (toolName.startsWith("web.deep_research")) return "deep-research";
  if (toolName.startsWith("web.extract")) return "extract";
  if (toolName === "web.generate_llms_txt" || toolName === "web.llms_txt_status") {
    return "llms-txt";
  }
  return undefined;
}

function jobTicket(toolName: SelfHostedWebToolName) {
  const kind = jobKind(toolName);
  if (!kind) throw new Error(`Missing job kind for ${toolName}`);
  return createSelfHostedWebToolJobTicket({
    config: JOB_CONFIG,
    jobKind: kind,
    upstreamId: "job-1",
  });
}

function fixture(toolName: SelfHostedWebToolName): Record<string, unknown> {
  if (["web.scrape", "web.crawl", "web.map", "web.generate_llms_txt"].includes(toolName)) {
    return { url: "https://example.com/" };
  }
  if (toolName === "web.crawl_params_preview") {
    return {
      prompt: "Only crawl the documentation pages",
      url: "https://example.com/",
    };
  }
  if (toolName === "web.batch_scrape" || toolName === "web.extract") {
    return { urls: ["https://example.com/"] };
  }
  if (["web.search", "web.deep_research"].includes(toolName)) {
    return { query: "deployments" };
  }
  if (toolName === "web.parse") {
    return { artifactId: PARSE_ARTIFACT_ID };
  }
  if (
    toolName.endsWith("_status") ||
    toolName.endsWith("_cancel") ||
    toolName.endsWith("_errors")
  ) {
    return { id: jobTicket(toolName) };
  }
  return {};
}

describe("self-hosted Firecrawl configuration and routing", () => {
  test("keeps the executable operation map aligned with the registered catalog", () => {
    expect(Object.keys(FIRECRAWL_OPERATIONS).toSorted()).toEqual(
      [...SELF_HOSTED_WEB_TOOL_NAMES].toSorted(),
    );
  });

  test("requires a self-hosted endpoint and reads optional authentication", () => {
    expect(() => readSelfHostedWebToolsConfig({})).toThrow("is required");
    expect(() =>
      readSelfHostedWebToolsConfig({
        DEPLOYMENTS_AI_FIRECRAWL_BASE_URL: "http://127.0.0.1:3002",
      }),
    ).toThrow("DENY_PRIVATE_EGRESS");
    expect(
      readSelfHostedWebToolsConfig({
        DEPLOYMENTS_AI_FIRECRAWL_API_KEY: "secret",
        DEPLOYMENTS_AI_FIRECRAWL_BASE_URL: "http://127.0.0.1:3002",
        DEPLOYMENTS_AI_FIRECRAWL_DENY_PRIVATE_EGRESS: "true",
        DEPLOYMENTS_AI_FIRECRAWL_JOB_TICKET_SECRET: "j".repeat(32),
      }),
    ).toEqual({
      apiKey: "secret",
      baseUrl: "http://127.0.0.1:3002",
      denyPrivateEgress: true,
      jobTicketSecret: "j".repeat(32),
    });
  });

  test("routes every registered capability through the self-hosted API", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input.url : input.toString(), init);
      requests.push(request);
      return ok({ id: "job-1", success: true });
    };
    for (const toolName of SELF_HOSTED_WEB_TOOL_NAMES as readonly SelfHostedWebToolName[]) {
      await executeSelfHostedWebTool(
        toolName,
        fixture(toolName),
        { ...JOB_CONFIG, apiKey: "secret" },
        {
          dnsLookup: publicLookup,
          fetch: fetchImpl,
          loadParseArtifact: async () => loadedParseArtifact(),
        },
      );
    }
    expect(requests).toHaveLength(SELF_HOSTED_WEB_TOOL_NAMES.length);
    expect(
      requests.every((request) => /^http:\/\/127\.0\.0\.1:3002\/v[12]\//u.test(request.url)),
    ).toBe(true);
    expect(
      requests.every((request) => request.headers.get("authorization") === "Bearer secret"),
    ).toBe(true);
  });

  test("normalizes scrape input and keeps idempotency material out of the body", async () => {
    let request: Request | undefined;
    await executeSelfHostedWebTool(
      "web.scrape",
      {
        formats: ["markdown", "branding"],
        idempotencyKey: "scrape-once",
        onlyMainContent: true,
        options: { waitFor: 1000 },
        url: "https://example.com",
      },
      { ...DENY_PRIVATE_EGRESS, baseUrl: "https://firecrawl.internal" },
      {
        dnsLookup: publicLookup,
        fetch: async (input, init) => {
          request = new Request(input instanceof Request ? input.url : input.toString(), init);
          return ok({ data: { markdown: "ok" }, success: true });
        },
      },
    );
    expect(request?.url).toBe("https://firecrawl.internal/v2/scrape");
    expect(request?.headers.get("x-idempotency-key")).toBeNull();
    expect(await request?.json()).toEqual({
      formats: ["markdown", "branding"],
      onlyMainContent: true,
      timeout: 45_000,
      url: "https://example.com/",
      waitFor: 1000,
    });
    expect(
      executeSelfHostedWebTool(
        "web.scrape",
        { idempotencyKey: " ", url: "https://example.com" },
        { ...DENY_PRIVATE_EGRESS, baseUrl: "https://firecrawl.internal" },
        { dnsLookup: publicLookup },
      ),
    ).rejects.toThrow("idempotencyKey must be a non-empty string");
  });

  test("gives every scrape a Firecrawl deadline inside the client's abort", async () => {
    const bodies: unknown[] = [];
    const scrape = (options: Record<string, unknown>, timeoutMs?: number) =>
      executeSelfHostedWebTool(
        "web.scrape",
        { options, url: "https://example.com" },
        {
          ...DENY_PRIVATE_EGRESS,
          baseUrl: "https://firecrawl.internal",
          ...(timeoutMs ? { timeoutMs } : {}),
        },
        {
          dnsLookup: publicLookup,
          fetch: async (input, init) => {
            bodies.push(
              await new Request(
                input instanceof Request ? input.url : input.toString(),
                init,
              ).json(),
            );
            return ok({ data: { markdown: "ok" }, success: true });
          },
        },
      );
    await scrape({});
    await scrape({ timeout: 300_000 });
    await scrape({ timeout: 20_000 });
    await scrape({ waitFor: 30_000 });
    await scrape({}, 30_000);
    expect(bodies.map((body) => (body as { timeout: number }).timeout)).toEqual([
      45_000, 110_000, 20_000, 60_000, 20_000,
    ]);
  });

  test("places renderer where each Firecrawl endpoint reads it", async () => {
    const requests: Request[] = [];
    const dependencies = {
      dnsLookup: publicLookup,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(input instanceof Request ? input.url : input.toString(), init));
        return ok({ id: "job-1", success: true });
      },
    };
    await executeSelfHostedWebTool(
      "web.scrape",
      { options: { waitFor: 500 }, renderer: "chromium", url: "https://example.com" },
      JOB_CONFIG,
      dependencies,
    );
    await executeSelfHostedWebTool(
      "web.crawl",
      {
        renderer: "lightpanda",
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
        url: "https://example.com",
      },
      JOB_CONFIG,
      dependencies,
    );
    await executeSelfHostedWebTool(
      "web.search",
      {
        options: { scrapeOptions: { formats: ["markdown"] } },
        query: "deployments",
        renderer: "chromium",
      },
      JOB_CONFIG,
      dependencies,
    );
    await executeSelfHostedWebTool(
      "web.deep_research",
      { query: "deployments", renderer: "auto" },
      JOB_CONFIG,
      dependencies,
    );
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3002/v2/scrape",
      "http://127.0.0.1:3002/v2/crawl",
      "http://127.0.0.1:3002/v2/search",
      "http://127.0.0.1:3002/v1/deep-research",
    ]);
    expect(await Promise.all(requests.map((request) => request.json()))).toEqual([
      { renderer: "chromium", timeout: 45_000, url: "https://example.com/", waitFor: 500 },
      {
        limit: 100,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true, renderer: "lightpanda" },
        url: "https://example.com/",
      },
      { query: "deployments", scrapeOptions: { formats: ["markdown"], renderer: "chromium" } },
      { query: "deployments", renderer: "auto" },
    ]);
  });

  test("rejects unsupported renderer values and placements before dispatch", async () => {
    let fetched = 0;
    const dependencies = {
      dnsLookup: publicLookup,
      fetch: async () => {
        fetched += 1;
        return ok({ id: "job-1", success: true });
      },
    };
    for (const [toolName, input, message] of [
      [
        "web.scrape",
        { renderer: "webkit", url: "https://example.com" },
        "web.scrape renderer must be one of auto, lightpanda, chromium",
      ],
      [
        "web.generate_llms_txt",
        { renderer: null, url: "https://example.com" },
        "web.generate_llms_txt renderer must be one of auto, lightpanda, chromium",
      ],
      [
        "web.map",
        { renderer: "chromium", url: "https://example.com" },
        "renderer is not supported by web.map.",
      ],
      [
        "web.scrape",
        { options: { renderer: "chromium" }, url: "https://example.com" },
        "renderer is not supported by web.scrape options",
      ],
      [
        "web.crawl",
        { scrapeOptions: { renderer: "chromium" }, url: "https://example.com" },
        "renderer is not supported by web.crawl scrapeOptions",
      ],
      [
        "web.search",
        { options: { scrapeOptions: { renderer: "chromium" } }, query: "deployments" },
        "renderer is not supported by web.search scrapeOptions",
      ],
    ] as const) {
      expect(executeSelfHostedWebTool(toolName, input, JOB_CONFIG, dependencies)).rejects.toThrow(
        message,
      );
    }
    expect(fetched).toBe(0);
  });

  test("rejects cloud routing, private targets, DNS rebinding, and interactive scrape actions", async () => {
    expect(
      executeSelfHostedWebTool("web.search", { query: "test" }, {
        baseUrl: "http://127.0.0.1:3002",
      } as never),
    ).rejects.toThrow("connection-time deny-private egress");
    expect(
      executeSelfHostedWebTool(
        "web.search",
        { query: "test" },
        { ...DENY_PRIVATE_EGRESS, baseUrl: "https://api.firecrawl.dev" },
      ),
    ).rejects.toThrow("cloud is disabled");
    expect(
      executeSelfHostedWebTool(
        "web.search",
        { query: "test" },
        { ...DENY_PRIVATE_EGRESS, apiKey: "secret", baseUrl: "https://api.firecrawl.dev." },
      ),
    ).rejects.toThrow("cloud is disabled");
    expect(
      executeSelfHostedWebTool(
        "web.scrape",
        { url: "http://169.254.169.254/latest/meta-data" },
        { ...DENY_PRIVATE_EGRESS, baseUrl: "http://127.0.0.1:3002" },
      ),
    ).rejects.toThrow("public host");
    expect(
      executeSelfHostedWebTool(
        "web.scrape",
        { url: "https://example.com" },
        { ...DENY_PRIVATE_EGRESS, baseUrl: "http://127.0.0.1:3002" },
        {
          dnsLookup: (async () => [{ address: "10.0.0.4", family: 4 }]) as never,
        },
      ),
    ).rejects.toThrow("public addresses");
    expect(
      executeSelfHostedWebTool("web.scrape", { url: "https://example.com:8443" }, JOB_CONFIG, {
        dnsLookup: publicLookup,
      }),
    ).rejects.toThrow("port 80 or 443");
    expect(
      executeSelfHostedWebTool(
        "web.scrape",
        {
          options: { actions: [{ type: "click" }] },
          url: "https://example.com",
        },
        { ...DENY_PRIVATE_EGRESS, baseUrl: "http://127.0.0.1:3002" },
        { dnsLookup: publicLookup },
      ),
    ).rejects.toThrow("hosted Fire Engine");
    expect(
      executeSelfHostedWebTool(
        "web.search",
        { query: "test" },
        {
          ...DENY_PRIVATE_EGRESS,
          baseUrl: "http://firecrawl.internal",
        },
      ),
    ).rejects.toThrow("must use HTTPS unless it is loopback");
    for (const [toolName, input] of [
      [
        "web.batch_scrape",
        {
          options: { actions: [{ type: "click" }] },
          urls: ["https://example.com"],
        },
      ],
      [
        "web.crawl",
        {
          scrapeOptions: { actions: [{ type: "click" }] },
          url: "https://example.com",
        },
      ],
      [
        "web.search",
        {
          options: { scrapeOptions: { actions: [{ type: "click" }] } },
          query: "test",
        },
      ],
      [
        "web.parse",
        {
          artifactId: PARSE_ARTIFACT_ID,
          options: { actions: [{ type: "click" }] },
        },
      ],
    ] as const) {
      expect(
        executeSelfHostedWebTool(toolName, input, JOB_CONFIG, {
          dnsLookup: publicLookup,
        }),
      ).rejects.toThrow("hosted Fire Engine");
    }
    expect(
      executeSelfHostedWebTool(
        "web.batch_scrape",
        {
          options: { appendToId: "raw-upstream-job" },
          urls: ["https://example.com"],
        },
        JOB_CONFIG,
        { dnsLookup: publicLookup },
      ),
    ).rejects.toThrow("appendToId is not supported");
    expect(
      executeSelfHostedWebTool(
        "web.crawl",
        {
          options: { webhook: "https://example.com/callback" },
          url: "https://example.com",
        },
        JOB_CONFIG,
        { dnsLookup: publicLookup },
      ),
    ).rejects.toThrow("webhook is not supported");
  });

  test("bounds and deduplicates URL DNS validation", async () => {
    let active = 0;
    let lookups = 0;
    let maximumActive = 0;
    const dnsLookup = (async () => {
      active += 1;
      lookups += 1;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(2);
      active -= 1;
      return [{ address: "93.184.216.34", family: 4 }];
    }) as never;
    const urls = Array.from({ length: 20 }, (_, index) => `https://host-${index}.example.com/`);
    urls.push(urls[0]!);
    await executeSelfHostedWebTool("web.batch_scrape", { urls }, JOB_CONFIG, {
      dnsLookup,
      fetch: async () => ok({ id: "job-1", success: true }),
    });
    expect(lookups).toBe(20);
    expect(maximumActive).toBeLessThanOrEqual(8);

    expect(
      executeSelfHostedWebTool(
        "web.batch_scrape",
        {
          urls: Array.from({ length: 101 }, () => "https://example.com/"),
        },
        JOB_CONFIG,
        { dnsLookup: publicLookup },
      ),
    ).rejects.toThrow("must not contain more than 100 URLs");

    expect(
      executeSelfHostedWebTool(
        "web.extract",
        {
          urls: Array.from({ length: 11 }, () => "https://example.com/"),
        },
        JOB_CONFIG,
        { dnsLookup: publicLookup },
      ),
    ).rejects.toThrow("must not contain more than 10 URLs");

    for (const toolName of ["web.batch_scrape", "web.extract"] as const) {
      expect(
        executeSelfHostedWebTool(toolName, { urls: [] }, JOB_CONFIG, {
          dnsLookup: publicLookup,
        }),
      ).rejects.toThrow("must contain at least one URL");
    }
  });

  test("enforces bounded crawl limits and v2 sitemap options", async () => {
    for (const limit of [101, 1.5, "100", null] as const) {
      expect(
        executeSelfHostedWebTool("web.crawl", { limit, url: "https://example.com" }, JOB_CONFIG, {
          dnsLookup: publicLookup,
        }),
      ).rejects.toThrow("safe integer between 1 and 100");
    }
    expect(
      executeSelfHostedWebTool(
        "web.crawl",
        { options: { limit: 101 }, url: "https://example.com" },
        JOB_CONFIG,
        { dnsLookup: publicLookup },
      ),
    ).rejects.toThrow("safe integer between 1 and 100");

    let crawlRequest: Request | undefined;
    await executeSelfHostedWebTool("web.crawl", { url: "https://example.com" }, JOB_CONFIG, {
      dnsLookup: publicLookup,
      fetch: async (input, init) => {
        crawlRequest = new Request(input instanceof Request ? input.url : input.toString(), init);
        return ok({ id: "job-1", success: true });
      },
    });
    expect(await crawlRequest?.json()).toEqual({
      limit: 100,
      url: "https://example.com/",
    });

    let request: Request | undefined;
    await executeSelfHostedWebTool(
      "web.map",
      { sitemap: "only", url: "https://example.com" },
      JOB_CONFIG,
      {
        dnsLookup: publicLookup,
        fetch: async (input, init) => {
          request = new Request(input instanceof Request ? input.url : input.toString(), init);
          return ok();
        },
      },
    );
    expect(await request?.json()).toEqual({
      sitemap: "only",
      url: "https://example.com/",
    });
    for (const legacyOption of ["ignoreSitemap", "sitemapOnly"] as const) {
      expect(
        executeSelfHostedWebTool(
          "web.map",
          { options: { [legacyOption]: true }, url: "https://example.com" },
          JOB_CONFIG,
          { dnsLookup: publicLookup },
        ),
      ).rejects.toThrow(`${legacyOption} is not supported`);
    }
  });

  test("enforces bounded search limits", async () => {
    for (const limit of [0, 1.5, 101, "10"] as const) {
      expect(
        executeSelfHostedWebTool("web.search", { limit, query: "deployments" }, JOB_CONFIG),
      ).rejects.toThrow("safe integer between 1 and 100");
    }
    expect(
      executeSelfHostedWebTool(
        "web.search",
        { options: { limit: 101 }, query: "deployments" },
        JOB_CONFIG,
      ),
    ).rejects.toThrow("safe integer between 1 and 100");
    for (const input of [
      { query: "deployments", sources: ["github"] },
      { options: { sources: [{ type: "github" }] }, query: "deployments" },
    ]) {
      expect(executeSelfHostedWebTool("web.search", input, JOB_CONFIG)).rejects.toThrow(
        "must use web, images, or news",
      );
    }
  });

  test("uses v1 only for deprecated deep research and llms.txt jobs", async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(new Request(input instanceof Request ? input.url : input.toString(), init).url);
      return ok({ id: "job-1", success: true });
    };
    await executeSelfHostedWebTool("web.deep_research", { query: "deployments" }, JOB_CONFIG, {
      fetch: fetchImpl,
    });
    await executeSelfHostedWebTool(
      "web.generate_llms_txt",
      { url: "https://example.com" },
      JOB_CONFIG,
      { dnsLookup: publicLookup, fetch: fetchImpl },
    );
    expect(urls).toEqual([
      "http://127.0.0.1:3002/v1/deep-research",
      "http://127.0.0.1:3002/v1/llmstxt",
    ]);
  });
});
