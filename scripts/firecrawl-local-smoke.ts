/**
 * Exercises the local Firecrawl stack (`infrastructure/firecrawl/compose.yml`)
 * through the platform adapter: scrape, JavaScript rendering through each
 * forced renderer, batch scrape and status, crawl with cursor-paginated
 * status, map, search, and batch/crawl cancellation.
 *
 *   bun run firecrawl:smoke [--base-url http://127.0.0.1:3002]
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  executeSelfHostedWebTool,
  type SelfHostedWebToolName,
  type SelfHostedWebToolsConfig,
} from "@deployments-ai/web-tools";

const { values } = parseArgs({
  options: { "base-url": { default: "http://127.0.0.1:3002", type: "string" } },
});

const config: SelfHostedWebToolsConfig = {
  baseUrl: values["base-url"],
  denyPrivateEgress: true,
  jobTicketSecret: randomBytes(32).toString("base64url"),
  scopeId: "firecrawl-local-smoke",
  timeoutMs: 180_000,
};

type Json = Record<string, unknown>;

async function call(tool: SelfHostedWebToolName, input: Json) {
  return (await executeSelfHostedWebTool(tool, input, config)) as Json;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`firecrawl smoke: ${message}`);
}

function documents(value: Json) {
  return Array.isArray(value.data) ? (value.data as Json[]) : [];
}

function summary(step: string, detail: Json) {
  console.log(JSON.stringify({ step, ...detail }));
}

async function waitForStatus(
  tool: "web.batch_scrape_status" | "web.crawl_status",
  id: string,
  done: (status: unknown) => boolean,
) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const status = await call(tool, { id });
    if (done(status.status)) return status;
    await Bun.sleep(2_000);
  }
  throw new Error(`firecrawl smoke: ${tool} did not settle within 240 seconds`);
}

/** Follows `nextCursor` pages and returns every document of a settled job. */
async function allPages(tool: "web.batch_scrape_status" | "web.crawl_status", first: Json) {
  const pages = [documents(first)];
  let cursor = first.nextCursor;
  while (typeof cursor === "string") {
    const page = await call(tool, { cursor, id: first.id as string });
    pages.push(documents(page));
    cursor = page.nextCursor;
  }
  return pages;
}

const scrape = await call("web.scrape", { formats: ["markdown"], url: "https://example.com/" });
const scrapeMarkdown = (scrape.data as Json | undefined)?.markdown;
check(typeof scrapeMarkdown === "string", "scrape returned no markdown");
check(scrapeMarkdown.includes("documentation examples"), "scrape markdown misses page content");
summary("scrape", { markdownBytes: scrapeMarkdown.length, success: scrape.success });

// The quotes exist only after page JavaScript runs, so plain fetch (the last
// fallback) cannot satisfy these checks; each forced renderer must render them.
for (const renderer of ["lightpanda", "chromium"] as const) {
  const rendered = await call("web.scrape", {
    formats: ["markdown"],
    renderer,
    url: "https://quotes.toscrape.com/js/",
  });
  const markdown = (rendered.data as Json | undefined)?.markdown;
  check(typeof markdown === "string", `${renderer} scrape returned no markdown`);
  check(markdown.includes("Albert Einstein"), `${renderer} did not render page JavaScript`);
  summary("scrape_renderer", { markdownBytes: markdown.length, renderer });
}

const map = await call("web.map", { limit: 20, url: "https://nodejs.org/" });
const links = Array.isArray(map.links) ? map.links : [];
check(links.length > 0, "map returned no links");
summary("map", { links: links.length });

const search = await call("web.search", { limit: 3, query: "IANA example domain" });
const searchData = search.data as Json | undefined;
const webResults = Array.isArray(searchData?.web) ? searchData.web : [];
check(webResults.length > 0, "search returned no web results");
summary("search", { results: webResults.length });

const batchUrls = ["https://example.com/", "https://www.iana.org/", "https://www.iana.org/about"];
const batch = await call("web.batch_scrape", {
  options: { formats: ["markdown"] },
  urls: batchUrls,
});
check(typeof batch.id === "string", "batch scrape returned no job ticket");
const batchStatus = await waitForStatus("web.batch_scrape_status", batch.id, (status) =>
  ["completed", "failed", "cancelled"].includes(String(status)),
);
check(batchStatus.status === "completed", `batch scrape ended ${String(batchStatus.status)}`);
const batchDocs = (await allPages("web.batch_scrape_status", batchStatus)).flat();
check(batchDocs.length === batchUrls.length, `batch returned ${batchDocs.length} documents`);
const batchErrors = await call("web.batch_scrape_errors", { id: batch.id });
summary("batch_scrape", {
  completed: batchStatus.completed,
  documents: batchDocs.length,
  errors: Array.isArray(batchErrors.errors) ? batchErrors.errors.length : null,
  total: batchStatus.total,
});

const crawl = await call("web.crawl", {
  limit: 8,
  options: { maxConcurrency: 2 },
  scrapeOptions: { formats: ["markdown"] },
  url: "https://quotes.toscrape.com/",
});
check(typeof crawl.id === "string", "crawl returned no job ticket");
const midCrawl = await call("web.crawl_status", { id: crawl.id });
const midCursor = midCrawl.nextCursor;
const crawlStatus = await waitForStatus("web.crawl_status", crawl.id, (status) =>
  ["completed", "failed", "cancelled"].includes(String(status)),
);
check(crawlStatus.status === "completed", `crawl ended ${String(crawlStatus.status)}`);
const crawlPages = await allPages("web.crawl_status", crawlStatus);
const crawlDocs = crawlPages.flat();
check(crawlDocs.length === crawlStatus.completed, "crawl pages disagree with completed count");
let resumedDocs: number | null = null;
if (typeof midCursor === "string") {
  const resumed = await allPages("web.crawl_status", {
    ...(await call("web.crawl_status", { cursor: midCursor, id: crawl.id })),
    id: crawl.id,
  });
  resumedDocs = resumed.flat().length;
  check(
    resumedDocs + documents(midCrawl).length === crawlDocs.length,
    "mid-crawl cursor did not resume where the first page ended",
  );
}
const crawlErrors = await call("web.crawl_errors", { id: crawl.id });
summary("crawl", {
  completed: crawlStatus.completed,
  documents: crawlDocs.length,
  errors: Array.isArray(crawlErrors.errors) ? crawlErrors.errors.length : null,
  firstPageWhileScraping: documents(midCrawl).length,
  pages: crawlPages.length,
  resumedFromMidCrawlCursor: resumedDocs,
  total: crawlStatus.total,
});

const cancelledCrawl = await call("web.crawl", {
  limit: 50,
  options: { delay: 5 },
  url: "https://quotes.toscrape.com/",
});
check(typeof cancelledCrawl.id === "string", "cancellable crawl returned no job ticket");
const crawlCancel = await call("web.crawl_cancel", { id: cancelledCrawl.id });
const crawlAfterCancel = await waitForStatus(
  "web.crawl_status",
  cancelledCrawl.id,
  (status) => status !== "scraping",
);
check(
  crawlAfterCancel.status === "cancelled",
  `cancelled crawl is ${JSON.stringify(crawlAfterCancel.status)}`,
);
summary("crawl_cancel", {
  cancel: crawlCancel.status ?? crawlCancel.success,
  completedBeforeCancel: crawlAfterCancel.completed,
  status: crawlAfterCancel.status,
});

const cancelledBatch = await call("web.batch_scrape", {
  options: { maxConcurrency: 1 },
  urls: Array.from({ length: 10 }, (_, page) => `https://example.com/?page=${page}`),
});
check(typeof cancelledBatch.id === "string", "cancellable batch returned no job ticket");
const batchCancel = await call("web.batch_scrape_cancel", { id: cancelledBatch.id });
const batchAfterCancel = await waitForStatus(
  "web.batch_scrape_status",
  cancelledBatch.id,
  (status) => status !== "scraping",
);
check(
  batchAfterCancel.status === "cancelled",
  `cancelled batch is ${JSON.stringify(batchAfterCancel.status)}`,
);
summary("batch_scrape_cancel", {
  cancel: batchCancel.status ?? batchCancel.success,
  completedBeforeCancel: batchAfterCancel.completed,
  status: batchAfterCancel.status,
});

console.log(JSON.stringify({ result: "passed" }));
