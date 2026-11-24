import { describe, expect, test } from "bun:test";
import {
  BrowserScreenshotInputError,
  browserSessionExecutionResponse,
  browserSessionExecutionResultFromEvidence,
  decodeBrowserSessionExecutionResult,
  MAX_BROWSER_SESSION_ACTIONS,
  MAX_BROWSER_SESSION_DOM_BYTES,
  normalizeBrowserSessionExecuteInput,
} from "./index.ts";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const allowedOrigins = new Set(["https://app.deployments.ai"]);

describe("browser session execution", () => {
  test("normalizes the bounded action language", () => {
    expect(
      normalizeBrowserSessionExecuteInput(
        {
          actions: [
            { type: "click", selector: " [data-open] " },
            { type: "type", clear: true, selector: "#query", text: "  exact text  " },
            { type: "press", key: "Enter" },
            { type: "wait", milliseconds: 250 },
            { type: "scroll", y: 400 },
            { type: "navigate", url: "https://app.deployments.ai/results" },
          ],
          url: "https://app.deployments.ai/",
          viewport: "mobile",
        },
        allowedOrigins,
      ),
    ).toMatchObject({
      actions: [
        { type: "click", selector: "[data-open]" },
        { type: "type", clear: true, selector: "#query", text: "  exact text  " },
        { type: "press", key: "Enter" },
        { type: "wait", milliseconds: 250 },
        { type: "scroll", y: 400 },
        { type: "navigate", url: "https://app.deployments.ai/results" },
      ],
      viewport: "mobile",
      viewportSize: { height: 844, width: 390 },
    });
  });

  test("rejects unbounded, unknown, and disallowed actions", () => {
    for (const input of [
      { actions: [], url: "https://app.deployments.ai/" },
      {
        actions: Array.from({ length: MAX_BROWSER_SESSION_ACTIONS + 1 }, () => ({
          type: "wait",
          milliseconds: 1,
        })),
        url: "https://app.deployments.ai/",
      },
      {
        actions: [{ type: "navigate", url: "https://example.com/" }],
        url: "https://app.deployments.ai/",
      },
      {
        actions: [{ type: "evaluate", script: "document.cookie" }],
        url: "https://app.deployments.ai/",
      },
    ]) {
      expect(() => normalizeBrowserSessionExecuteInput(input as never, allowedOrigins)).toThrow(
        BrowserScreenshotInputError,
      );
    }
  });

  test("enforces the published browser-session timeout range", () => {
    const input = {
      actions: [{ type: "wait" as const, milliseconds: 1 }],
      url: "https://app.deployments.ai/",
    };

    expect(
      normalizeBrowserSessionExecuteInput({ ...input, timeoutMs: 1_000 }, allowedOrigins),
    ).toMatchObject({ timeoutMs: 1_000 });
    for (const timeoutMs of [999, 1_000.5, 60_001]) {
      expect(() =>
        normalizeBrowserSessionExecuteInput({ ...input, timeoutMs }, allowedOrigins),
      ).toThrow(BrowserScreenshotInputError);
    }
  });

  const expected = {
    actions: [
      { selector: "#search", type: "click" },
      { type: "navigate", url: "https://app.deployments.ai/results" },
    ] as const,
    allowedOrigins,
  };
  const summary = {
    actions: [
      { index: 0, type: "click" as const, url: "https://app.deployments.ai/" },
      { index: 1, type: "navigate" as const, url: "https://app.deployments.ai/results" },
    ],
    capturedAt: "2026-08-26T00:00:00.000Z",
    domTruncated: false,
    finalUrl: "https://app.deployments.ai/results",
    title: "Results",
  };
  const evidence = { dom: "<html><body>Rendered</body></html>", screenshot: PNG };

  test("validates rendered evidence and round-trips it through durable storage", () => {
    const result = browserSessionExecutionResultFromEvidence(summary, evidence, expected);

    expect(result).toEqual({
      ...summary,
      dom: evidence.dom,
      screenshot: PNG,
      screenshotContentType: "image/png",
    });
    const stored = JSON.parse(JSON.stringify(browserSessionExecutionResponse(result))) as unknown;
    expect(decodeBrowserSessionExecutionResult(stored, expected)).toEqual(result);
  });

  test("rejects evidence that does not answer the requested actions or leaves the allowlist", () => {
    for (const invalid of [
      { ...summary, actions: summary.actions.slice(0, 1) },
      { ...summary, actions: [summary.actions[1], summary.actions[0]] },
      {
        ...summary,
        actions: [{ ...summary.actions[0], type: "type" }, summary.actions[1]],
      },
      { ...summary, finalUrl: "https://other.example.com/" },
      { ...summary, capturedAt: "yesterday" },
      { ...summary, extra: true },
    ]) {
      expect(() =>
        browserSessionExecutionResultFromEvidence(invalid, evidence, expected),
      ).toThrow();
    }
    expect(() =>
      browserSessionExecutionResultFromEvidence(
        summary,
        { ...evidence, screenshot: Uint8Array.from([137, 80, 78, 71]) },
        expected,
      ),
    ).toThrow("Screenshot image does not match image/png.");
    expect(() =>
      browserSessionExecutionResultFromEvidence(
        summary,
        { ...evidence, dom: "x".repeat(MAX_BROWSER_SESSION_DOM_BYTES + 1) },
        expected,
      ),
    ).toThrow(BrowserScreenshotInputError);
  });
});
