import { describe, expect, test } from "bun:test";
import {
  createSelfHostedWebToolJobTicket,
  executeSelfHostedWebTool,
  type FirecrawlJobKind,
  type SelfHostedWebToolName,
} from "./index.ts";

const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
const DENY_PRIVATE_EGRESS = { denyPrivateEgress: true } as const;
const JOB_CONFIG = {
  baseUrl: "http://127.0.0.1:3002",
  ...DENY_PRIVATE_EGRESS,
  jobTicketSecret: "j".repeat(32),
  scopeId: "org-1",
} as const;

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

describe("self-hosted Firecrawl job security", () => {
  test("replaces upstream job IDs with encrypted scope-bound tickets", async () => {
    const requests: Request[] = [];
    const started = await executeSelfHostedWebTool(
      "web.crawl",
      { limit: 1, url: "https://example.com" },
      JOB_CONFIG,
      {
        dnsLookup: publicLookup,
        fetch: async (input, init) => {
          requests.push(new Request(input instanceof Request ? input.url : input.toString(), init));
          return ok({
            id: "upstream-job-1",
            success: true,
            url: "http://api:3002/v2/crawl/upstream-job-1",
          });
        },
      },
    );
    const ticket = (started as { id: string }).id;
    expect(ticket).toStartWith("fcj1.");
    expect(JSON.stringify(started)).not.toContain("upstream-job-1");
    expect(started).not.toHaveProperty("url");

    const status = await executeSelfHostedWebTool("web.crawl_status", { id: ticket }, JOB_CONFIG, {
      fetch: async (input, init) => {
        requests.push(new Request(input instanceof Request ? input.url : input.toString(), init));
        return ok({
          errors: [{ id: "child-error-id", message: "failed" }],
          metadata: { scrapeId: "child-scrape-id" },
          next: "http://api:3002/v2/crawl/upstream-job-1?skip=1",
          scrapeIds: ["child-scrape-id"],
          success: true,
        });
      },
    });
    expect(requests[1]?.url).toBe("http://127.0.0.1:3002/v2/crawl/upstream-job-1");
    expect(JSON.stringify(status)).toContain(ticket);
    expect(JSON.stringify(status)).not.toContain("upstream-job-1");
    expect(JSON.stringify(status)).not.toContain("child-error-id");
    expect(JSON.stringify(status)).not.toContain("child-scrape-id");
    expect(status).toMatchObject({ errors: [{ message: "failed" }], metadata: {} });
    const nextCursor = (status as { nextCursor: string }).nextCursor;
    expect(nextCursor).toStartWith("fcc1.");
    await executeSelfHostedWebTool(
      "web.crawl_status",
      { cursor: nextCursor, id: ticket },
      JOB_CONFIG,
      {
        fetch: async (input, init) => {
          requests.push(new Request(input instanceof Request ? input.url : input.toString(), init));
          return ok({ success: true });
        },
      },
    );
    expect(requests[2]?.url).toBe("http://127.0.0.1:3002/v2/crawl/upstream-job-1?skip=1");

    const failedStatus = await executeSelfHostedWebTool(
      "web.crawl_status",
      { id: ticket },
      JOB_CONFIG,
      {
        fetch: async () => ok({ progress: 25, status: "failed", success: false }),
      },
    );
    expect(failedStatus).toMatchObject({
      id: ticket,
      progress: 25,
      status: "failed",
      success: false,
    });

    expect(
      executeSelfHostedWebTool(
        "web.crawl_status",
        { id: ticket },
        { ...JOB_CONFIG, scopeId: "org-2" },
      ),
    ).rejects.toThrow("not valid for this scope");
    expect(
      executeSelfHostedWebTool("web.crawl_status", { id: "upstream-job-1" }, JOB_CONFIG),
    ).rejects.toThrow("Invalid Firecrawl job token");
  });

  test("removes raw identifiers from synchronous and job error results", async () => {
    for (const toolName of ["web.scrape", "web.search"] as const) {
      const result = await executeSelfHostedWebTool(
        toolName,
        toolName === "web.scrape" ? { url: "https://example.com" } : { query: "deployments" },
        JOB_CONFIG,
        {
          dnsLookup: publicLookup,
          fetch: async () =>
            ok({
              id: "raw-sync-id",
              metadata: { scrapeId: "raw-scrape-id" },
              success: true,
            }),
        },
      );
      expect(result).toEqual({ metadata: {}, success: true });
    }

    const result = await executeSelfHostedWebTool(
      "web.crawl_errors",
      { id: jobTicket("web.crawl_errors") },
      JOB_CONFIG,
      {
        fetch: async () =>
          ok({
            crawlId: "job-1",
            errors: [{ id: "child-id", message: "failed" }],
            id: "job-1",
            success: true,
          }),
      },
    );
    expect(result).toEqual({ errors: [{ message: "failed" }], success: true });
  });
});
