import { afterEach, describe, expect, test } from "bun:test";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import { createRuntimeWebBuiltinExecutors } from "./web-runtime-tools.ts";
import { SelfHostedWebToolError } from "@deployments-ai/web-tools";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const request = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
  decision: { action: "allow" as const, reason: "test", toolCallId: id("09") },
  effect: "read" as const,
  environmentId: id("04"),
  idempotencyKey: "web-test",
  inputSummary: "test",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
  toolName: "web.search",
};

function database(record?: PlatformRecord): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: () => Promise.resolve(record ? record : undefined),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async () => {},
  };
}

function executors(options: {
  readonly artifact?: PlatformRecord;
  readonly send?: () => Promise<unknown>;
}) {
  return createRuntimeWebBuiltinExecutors({
    artifactBucket: "artifacts",
    artifactS3: { send: options.send ?? (async () => ({})) } as never,
    database: database(options.artifact),
    loadConfig: () => ({
      baseUrl: "http://127.0.0.1:3002",
      denyPrivateEgress: true,
      jobTicketSecret: "12345678901234567890123456789012",
    }),
  });
}

describe("web runtime executors", () => {
  test("wraps a self-hosted search response as a bounded runtime artifact", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            images: [{ title: "Image" }],
            news: [],
            web: [{ title: "One" }, { title: "Two" }],
          },
          success: true,
        }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await executors({})["web.search"]!(
      { ...request, input: { query: "runtime tools" } },
      {} as never,
    );
    expect(result.outputSummary).toBe("web.search completed with 3 result(s).");
    expect(result.artifacts?.[0]?.visibility).toBe("private");
    expect(JSON.parse(String(result.artifacts?.[0]?.content))).toMatchObject({
      data: { web: [{ title: "One" }, { title: "Two" }] },
      success: true,
    });
  });

  test("rejects oversized parse artifacts before loading S3 bytes", async () => {
    const artifact = {
      data: {
        environmentId: request.environmentId,
        id: id("10"),
        organizationId: request.organizationId,
        projectId: request.projectId,
        status: "available",
        storage: {
          bucket: "artifacts",
          byteSize: 50 * 1024 * 1024 + 1,
          contentType: "application/pdf",
          fileName: "large.pdf",
          key: "large.pdf",
          sha256: "0".repeat(64),
          versionId: "version-1",
        },
        visibility: "organization",
      },
      itemType: "artifact",
      pk: "test",
      sk: "test",
    } as unknown as PlatformRecord;
    let sends = 0;
    const executor = executors({
      artifact,
      send: async () => {
        sends += 1;
        return {};
      },
    })["web.parse"]!;
    expect(
      executor(
        {
          ...request,
          input: { artifactId: id("10") },
          toolName: "web.parse",
        },
        {} as never,
      ),
    ).rejects.toThrow("current run scope");
    expect(sends).toBe(0);
  });

  test("rejects logically expired parse artifacts before loading S3 bytes", async () => {
    const artifact = {
      data: {
        environmentId: request.environmentId,
        id: id("10"),
        organizationId: request.organizationId,
        projectId: request.projectId,
        retentionExpiresAt: "2000-01-01T00:00:00.000Z",
        status: "available",
        storage: {
          bucket: "artifacts",
          byteSize: 10,
          contentType: "application/pdf",
          fileName: "expired.pdf",
          key: "expired.pdf",
          sha256: "0".repeat(64),
          versionId: "version-1",
        },
        visibility: "organization",
      },
      itemType: "artifact",
      pk: "test",
      sk: "test",
    } as unknown as PlatformRecord;
    let sends = 0;
    expect(
      executors({
        artifact,
        send: async () => {
          sends += 1;
          return {};
        },
      })["web.parse"]!(
        { ...request, input: { artifactId: id("10") }, toolName: "web.parse" },
        {} as never,
      ),
    ).rejects.toThrow("current run scope");
    expect(sends).toBe(0);
  });

  test("keeps a post-dispatch Firecrawl 408 ambiguous for mutations", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: false }), {
        headers: { "content-type": "application/json" },
        status: 408,
      })) as unknown as typeof fetch;
    expect(
      executors({})["web.deep_research"]!(
        {
          ...request,
          effect: "execute",
          input: { query: "runtime safety" },
          toolName: "web.deep_research",
        },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(SelfHostedWebToolError);
  });

  test("summarizes oversized mutation responses below the durable claim envelope", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ id: "upstream-job", padding: "x".repeat(400_000), success: true }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await executors({})["web.crawl"]!(
      {
        ...request,
        effect: "execute",
        input: { url: "https://example.com" },
        toolName: "web.crawl",
      },
      {} as never,
    );
    const content = String(result.artifacts?.[0]?.content);
    const value = JSON.parse(content) as Record<string, unknown>;

    expect(new TextEncoder().encode(content).byteLength).toBeLessThan(150 * 1024);
    expect(value).toMatchObject({ id: expect.any(String), success: true, truncated: true });
    expect(value).not.toHaveProperty("padding");
  });

  test("hands a read the page's failure as a tool result, so the run goes on instead of replaying it", async () => {
    const failing = (status: number, body: unknown) => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status,
        })) as unknown as typeof fetch;
      return executors({})["web.search"]!(
        { ...request, input: { query: "hotels near the venue" } },
        {} as never,
      );
    };
    const antibot = await failing(500, {
      code: "SCRAPE_RETRY_LIMIT",
      error: "Scrape aborted after exceeding retry limit (document_antibot).",
      success: false,
    });
    expect(antibot).toEqual({
      output: {
        error: {
          code: "SCRAPE_RETRY_LIMIT",
          message: "Firecrawl request failed with HTTP 500 (SCRAPE_RETRY_LIMIT).",
        },
      },
      outputSummary:
        "web.search failed: Firecrawl request failed with HTTP 500 (SCRAPE_RETRY_LIMIT).",
      status: "completed",
    });
    expect(await failing(408, { code: "SCRAPE_TIMEOUT", success: false })).toMatchObject({
      output: { error: { code: "SCRAPE_TIMEOUT" } },
      status: "completed",
    });
    expect(await failing(403, { code: "unsafe_domain_blocked", success: false })).toMatchObject({
      output: { error: { code: "unsafe_domain_blocked" } },
      status: "completed",
    });
    // A body without a code still names the status, and an odd code never reaches the model.
    expect(await failing(502, { code: "has spaces <b>", success: false })).toMatchObject({
      output: { error: { code: "http_502" } },
      status: "completed",
    });

    // A busy Firecrawl may answer the same request later, so the run still retries.
    expect(failing(429, { success: false })).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );
  });

  test("hands a read that ran past the client deadline to the model as a timeout", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(
      await executors({})["web.search"]!(
        { ...request, input: { query: "hotels near the venue" } },
        {} as never,
      ),
    ).toMatchObject({ output: { error: { code: "timeout" } }, status: "completed" });
  });

  test("classifies native fetch transport TypeErrors by operation effect", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(
      executors({})["web.search"]!({ ...request, input: { query: "runtime safety" } }, {} as never),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
    try {
      await executors({})["web.deep_research"]!(
        {
          ...request,
          effect: "execute",
          input: { query: "runtime safety" },
          toolName: "web.deep_research",
        },
        {} as never,
      );
      throw new Error("Expected mutation transport failure.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBeInstanceOf(TypeError);
      expect(cause).not.toBeInstanceOf(RuntimeToolPreparationRetryableError);
    }
  });
});
