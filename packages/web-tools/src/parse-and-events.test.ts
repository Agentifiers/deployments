import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Ulid } from "@deployments-ai/db";
import {
  MAX_FIRECRAWL_RESPONSE_BYTES,
  executeSelfHostedWebTool,
  makeSelfHostedWebToolCompletedSemanticEvent,
  makeSelfHostedWebToolFailedSemanticEvent,
  makeSelfHostedWebToolRequestedSemanticEvent,
  type SelfHostedWebToolParseArtifact,
  type SelfHostedWebToolCallRecord,
} from "./index.ts";

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

describe("self-hosted Firecrawl parsing and events", () => {
  test("sends document bytes as bounded multipart content", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input instanceof Request ? input.url : input.toString(), init));
      return ok();
    };
    await executeSelfHostedWebTool(
      "web.parse",
      {
        artifactId: PARSE_ARTIFACT_ID,
        idempotencyKey: "parse-once",
        options: {
          formats: ["markdown"],
          includeTags: ["article"],
          onlyMainContent: true,
          parsers: [{ type: "pdf" }],
          redactPII: true,
        },
      },
      JOB_CONFIG,
      {
        fetch: fetchImpl,
        loadParseArtifact: async ({ artifactId, scopeId }) => {
          expect({ artifactId, scopeId }).toEqual({
            artifactId: PARSE_ARTIFACT_ID,
            scopeId: "org-1",
          });
          return loadedParseArtifact();
        },
      },
    );
    const multipartRequest = requests[0];
    expect(multipartRequest).toBeDefined();
    expect(multipartRequest?.headers.get("x-idempotency-key")).toBeNull();
    const form = await multipartRequest!.formData();
    expect((form.get("file") as File).name).toBe("report.html");
    expect(await (form.get("file") as File).text()).toBe("<article>hello</article>");
    expect(form?.get("options")).toBe(
      '{"formats":["markdown"],"includeTags":["article"],"onlyMainContent":true,"parsers":[{"type":"pdf"}],"redactPII":true}',
    );
    expect(
      executeSelfHostedWebTool("web.parse", { artifactId: PARSE_ARTIFACT_ID }, JOB_CONFIG, {
        loadParseArtifact: async () => loadedParseArtifact(PARSE_CONTENT, "org-1", "private"),
      }),
    ).rejects.toThrow("organization-scoped");
    expect(
      executeSelfHostedWebTool("web.parse", { artifactId: PARSE_ARTIFACT_ID }, JOB_CONFIG, {
        loadParseArtifact: async () =>
          loadedParseArtifact(PARSE_CONTENT, "org-1", "organization", "report.txt", "text/plain"),
      }),
    ).rejects.toThrow("not supported by Firecrawl");
    expect(
      executeSelfHostedWebTool(
        "web.parse",
        {
          artifactId: PARSE_ARTIFACT_ID,
          options: { maxPages: 1 },
        },
        JOB_CONFIG,
      ),
    ).rejects.toThrow("maxPages is not supported by web.parse options");
  });

  test("bounds responses and emits generic upstream failures", async () => {
    expect(
      executeSelfHostedWebTool(
        "web.search",
        { query: "test" },
        { ...DENY_PRIVATE_EGRESS, baseUrl: "http://127.0.0.1:3002" },
        {
          fetch: async () =>
            new Response("{}", {
              headers: {
                "content-length": String(MAX_FIRECRAWL_RESPONSE_BYTES + 1),
              },
            }),
        },
      ),
    ).rejects.toThrow("maximum size");
    expect(
      executeSelfHostedWebTool(
        "web.search",
        { query: "test" },
        { ...DENY_PRIVATE_EGRESS, baseUrl: "http://127.0.0.1:3002" },
        {
          fetch: async () => new Response("sensitive upstream body", { status: 500 }),
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        message: "Firecrawl request failed with HTTP 500.",
        status: 500,
      }),
    );
    expect(
      executeSelfHostedWebTool("web.search", { query: "test" }, JOB_CONFIG, {
        fetch: async () => ok({ error: "sensitive DNS failure", success: false }),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ message: "Firecrawl request failed.", status: 502 }),
    );
  });

  test("builds redacted semantic lifecycle events for web tool calls", () => {
    const base = {
      data: {
        createdAt: "2026-07-21T00:00:00.000Z",
        effect: "read",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        input: { url: "https://example.com/private?token=secret" },
        inputSummary: "Scrape a private URL",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        requiredScopes: [],
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        toolName: "web.scrape",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
      itemType: "tool-call",
      pk: "ignored",
      sk: "ignored",
    } as unknown as SelfHostedWebToolCallRecord;
    const requested = makeSelfHostedWebToolRequestedSemanticEvent({
      eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid,
      occurredAt: "2026-07-21T00:00:00.000Z",
      toolCall: {
        ...base,
        data: { ...base.data, status: "pending", version: 1 },
      },
    });
    const completed = makeSelfHostedWebToolCompletedSemanticEvent({
      eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid,
      occurredAt: "2026-07-21T00:00:01.000Z",
      toolCall: {
        ...base,
        data: { ...base.data, status: "succeeded", version: 2 },
      },
      toolCallEventVersion: 2,
    });
    const failed = makeSelfHostedWebToolFailedSemanticEvent({
      eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB3" as Ulid,
      occurredAt: "2026-07-21T00:00:01.000Z",
      toolCall: {
        ...base,
        data: { ...base.data, status: "failed", version: 2 },
      },
      toolCallEventVersion: 2,
    });
    expect([requested.data.eventType, completed.data.eventType, failed.data.eventType]).toEqual([
      "tool-call.requested",
      "tool-call.completed",
      "tool-call.failed",
    ]);
    expect(JSON.stringify([requested, completed, failed])).not.toContain("example.com");
    expect(JSON.stringify([requested, completed, failed])).not.toContain("secret");
  });
});
