import { afterEach, describe, expect, test } from "bun:test";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import type { DynamoDatabaseService, PlatformRecord } from "@deployments-ai/db";
import { NetSecurityRedirectError } from "@deployments-ai/net-security";
import type { RuntimeBrowserToolOptions } from "./browser-runtime-tools.ts";
import {
  browserExecutors,
  database,
  id,
  planArtifact,
  request,
} from "./browser-runtime-tools.fixture.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type DomSnapshotRequest = NonNullable<RuntimeBrowserToolOptions["requestDomSnapshot"]>;

const defaultDomSnapshotRequest: DomSnapshotRequest = async ({ signal, url }) => ({
  addresses: [],
  finalUrl: new URL(url).toString(),
  hopCount: 1,
  response: await globalThis.fetch(url, { redirect: "manual", signal }),
});

function executors(
  records: readonly PlatformRecord[] = [],
  requestDomSnapshot: DomSnapshotRequest = defaultDomSnapshotRequest,
) {
  return browserExecutors({ records, requestDomSnapshot });
}

describe("browser runtime tools", () => {
  test("retries native DOM snapshot transport failures", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(
      executors([planArtifact({})])["browser.dom_snapshot.capture"]!(
        {
          ...request,
          input: {
            sessionPlanId: request.decision.toolCallId,
            url: "https://example.com/page",
          },
        },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });

  test("returns a DOM snapshot target off the allowlist as a tool error, and fails malformed input", async () => {
    const snapshot = executors([planArtifact({})])["browser.dom_snapshot.capture"]!;
    const result = await snapshot(
      {
        ...request,
        input: { sessionPlanId: request.decision.toolCallId, url: "https://other.example/page" },
      },
      {} as never,
    );

    expect(result.output?.error).toEqual({
      code: "origin_not_allowed",
      message: "Target origin https://other.example is not allowed",
    });
    expect(
      snapshot(
        { ...request, input: { sessionPlanId: request.decision.toolCallId, url: "not a url" } },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("records durable session-plan identity in private artifact metadata", async () => {
    const result = await executors()["browser.session.plan"]!(
      { ...request, input: { url: "https://example.com/page" }, toolName: "browser.session.plan" },
      {} as never,
    );

    expect(result.artifacts?.[0]).toMatchObject({
      metadata: {
        kind: "browser-session-plan",
        runId: request.runId,
        sessionPlanId: request.decision.toolCallId,
        target: { url: "https://example.com/page" },
      },
      visibility: "private",
    });
    expect(result.outputSummary).toBe(
      `Prepared browser session plan ${request.decision.toolCallId} for https://example.com.`,
    );
  });

  test("requires the approved current-run plan for both capture tools", async () => {
    for (const toolName of [
      "browser.screenshot.capture",
      "browser.dom_snapshot.capture",
    ] as const) {
      expect(
        executors()[toolName]!(
          { ...request, input: { url: "https://example.com/page" }, toolName },
          {} as never,
        ),
      ).rejects.toThrow("sessionPlanId");
    }
  });

  test("rejects another run's plan and a changed normalized target", async () => {
    const input = {
      sessionPlanId: request.decision.toolCallId,
      url: "https://example.com/page",
    };
    expect(
      executors([planArtifact({ runId: id("11") })])["browser.dom_snapshot.capture"]!(
        { ...request, input },
        {} as never,
      ),
    ).rejects.toThrow("approved browser session plan");
    expect(
      executors([planArtifact({ url: "https://example.com/approved" })])[
        "browser.dom_snapshot.capture"
      ]!({ ...request, input }, {} as never),
    ).rejects.toThrow("approved browser session plan");
  });

  test("captures DOM evidence only when its normalized target matches the approved plan", async () => {
    globalThis.fetch = (async () =>
      new Response("<main>ok</main>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch;

    const result = await executors([planArtifact({ reverseTargetKeys: true })])[
      "browser.dom_snapshot.capture"
    ]!(
      {
        ...request,
        input: {
          sessionPlanId: request.decision.toolCallId,
          url: "https://example.com/page",
        },
      },
      {} as never,
    );

    expect(result.status).toBe("completed");
    expect(result.artifacts?.[0]?.content).toContain('"html": "<main>ok</main>"');
  });

  test("authorizes DOM evidence by URL when the approved plan has screenshot options", async () => {
    globalThis.fetch = (async () =>
      new Response("<main>planned</main>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch;

    const result = await executors([
      planArtifact({
        targetInput: {
          format: "webp",
          fullPage: false,
          selector: "main",
          url: "https://example.com/page",
          viewport: "mobile",
        },
      }),
    ])["browser.dom_snapshot.capture"]!(
      {
        ...request,
        input: {
          sessionPlanId: request.decision.toolCallId,
          url: "https://example.com/page",
        },
      },
      {} as never,
    );

    expect(result.status).toBe("completed");
    expect(result.artifacts?.[0]?.content).toContain('"html": "<main>planned</main>"');
  });

  test("rejects DOM evidence when a redirect leaves the approved origin", async () => {
    expect(
      executors([planArtifact({})], async () => {
        throw new NetSecurityRedirectError(
          "redirect-cross-origin",
          "Redirect Location must stay on the verified origin.",
        );
      })["browser.dom_snapshot.capture"]!(
        {
          ...request,
          input: {
            sessionPlanId: request.decision.toolCallId,
            url: "https://example.com/page",
          },
        },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("binds bounded audit reports to an approved current-run plan", async () => {
    const toolName = "browser.session.audit_report";
    const input = { actions: [{ type: "capture" }], sessionPlanId: request.decision.toolCallId };
    expect(
      executors()[toolName]!({ ...request, effect: "write", input, toolName }, {} as never),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(
      executors([planArtifact({ runId: id("11") })])[toolName]!(
        { ...request, effect: "write", input, toolName },
        {} as never,
      ),
    ).rejects.toThrow("approved browser session plan");

    const result = await executors([planArtifact({})])[toolName]!(
      { ...request, effect: "write", input, toolName },
      {} as never,
    );
    expect(result.artifacts?.[0]).toMatchObject({
      metadata: {
        kind: "browser-session-audit",
        runId: request.runId,
        sessionPlanId: request.decision.toolCallId,
      },
    });
    expect(
      executors([planArtifact({})])[toolName]!(
        {
          ...request,
          effect: "write",
          input: {
            actions: [{ detail: "x".repeat(150_000) }],
            sessionPlanId: request.decision.toolCallId,
          },
          toolName,
        },
        {} as never,
      ),
    ).rejects.toThrow("audit report is too large");
  });

  test("stops plan pagination as soon as the approved plan is found", async () => {
    let queries = 0;
    const browser = browserExecutors({
      database: {
        ...database(),
        queryRecords: () => {
          queries += 1;
          if (queries > 1) throw new Error("matching first page must stop pagination");
          return Promise.resolve({
            items: [planArtifact({})],
            lastEvaluatedKey: { cursor: "more-artifacts" },
          });
        },
      } as DynamoDatabaseService,
    });
    const result = await browser["browser.session.audit_report"]!(
      {
        ...request,
        effect: "write",
        input: { actions: [], sessionPlanId: request.decision.toolCallId },
        toolName: "browser.session.audit_report",
      },
      {} as never,
    );
    expect(result.status).toBe("completed");
    expect(queries).toBe(1);
  });
});
