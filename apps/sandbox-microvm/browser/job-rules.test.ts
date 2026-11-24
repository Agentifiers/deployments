import { describe, expect, test } from "bun:test";
import {
  BrowserJobFailure,
  MAX_FAILURE_MESSAGE_LENGTH,
  assertImageSize,
  assertRenderBounds,
  failureStatus,
  isAllowedNavigation,
  navigationFailure,
  parseBrowserJobSpec,
  sandboxControlPort,
  selectorFailure,
  targetsSandboxControlServer,
  truncateUtf8,
} from "./job-rules.ts";

const captureInput = {
  format: "png",
  fullPage: true,
  timeoutMs: 45_000,
  url: "https://example.com/",
  viewport: "desktop",
  viewportSize: { height: 900, width: 1280 },
};
const sessionInput = {
  actions: [{ selector: "#go", type: "click" }],
  timeoutMs: 45_000,
  url: "https://example.com/",
  viewport: "desktop",
  viewportSize: { height: 900, width: 1280 },
};

function spec(kind: string, input: unknown, allowedOrigins: unknown = ["https://example.com"]) {
  return JSON.stringify({ allowedOrigins, input, kind });
}

function failureCode(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    return error instanceof BrowserJobFailure ? error.code : "not-a-job-failure";
  }
  return "no-failure";
}

function namedError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("browser job spec", () => {
  test("accepts the normalized capture and session shapes", () => {
    expect(parseBrowserJobSpec(spec("capture", { ...captureInput, selector: "main" }))).toEqual({
      allowedOrigins: ["https://example.com"],
      anyPublicOrigin: false,
      input: { ...captureInput, selector: "main" } as never,
      kind: "capture",
    });
    const actions = [
      { type: "navigate", url: "https://example.com/next" },
      { clear: true, selector: "input", text: "", type: "type" },
      { selector: "select", type: "select", values: ["a", ""] },
      { key: "Enter", type: "press" },
      { milliseconds: 10_000, type: "wait" },
      { type: "scroll", y: -100_000 },
    ];
    expect(parseBrowserJobSpec(spec("session", { ...sessionInput, actions })).input).toEqual({
      ...sessionInput,
      actions,
    } as never);
  });

  test("reads any-public mode only from a boolean anyPublicOrigin", () => {
    const source = JSON.stringify({
      allowedOrigins: [],
      anyPublicOrigin: true,
      input: captureInput,
      kind: "capture",
    });
    expect(parseBrowserJobSpec(source)).toMatchObject({
      allowedOrigins: [],
      anyPublicOrigin: true,
    });
    expect(parseBrowserJobSpec(spec("capture", captureInput)).anyPublicOrigin).toBe(false);
  });

  test("rejects malformed specs as invalid_spec", () => {
    const invalidSpecs = [
      "not json",
      JSON.stringify({
        allowedOrigins: [],
        anyPublicOrigin: "true",
        input: captureInput,
        kind: "capture",
      }),
      JSON.stringify({ allowedOrigins: [], input: captureInput, kind: "pdf" }),
      JSON.stringify({ allowedOrigins: [], extra: true, input: captureInput, kind: "capture" }),
      spec("capture", captureInput, ["https://example.com/path"]),
      spec("capture", { ...captureInput, script: "alert(1)" }),
      spec("capture", { ...captureInput, format: "gif" }),
      spec("capture", { ...captureInput, url: "file:///etc/passwd" }),
      spec("capture", { ...captureInput, timeoutMs: 60_001 }),
      spec("capture", { ...captureInput, viewportSize: { height: 99, width: 1280 } }),
      spec("capture", { ...captureInput, selector: "x".repeat(2_001) }),
      spec("session", { ...sessionInput, actions: [] }),
      spec("session", {
        ...sessionInput,
        actions: Array.from({ length: 17 }, () => sessionInput.actions[0]),
      }),
      spec("session", { ...sessionInput, timeoutMs: 999 }),
      spec("session", { ...sessionInput, actions: [{ type: "wait" }] }),
      spec("session", { ...sessionInput, actions: [{ type: "scroll" }] }),
      spec("session", { ...sessionInput, actions: [{ key: "F12", type: "press" }] }),
      spec("session", { ...sessionInput, actions: [{ milliseconds: 10_001, type: "wait" }] }),
      spec("session", {
        ...sessionInput,
        actions: [{ selector: "a", type: "select", values: [] }],
      }),
      spec("session", { ...sessionInput, actions: [{ selector: " ", type: "click" }] }),
      spec("session", { ...sessionInput, actions: [{ script: "x", type: "evaluate" }] }),
      // 129 selector characters of 2-byte UTF-8 exceed the 256-byte selector limit.
      spec("session", { ...sessionInput, actions: [{ selector: "é".repeat(129), type: "click" }] }),
    ];
    for (const source of invalidSpecs) {
      expect(failureCode(() => parseBrowserJobSpec(source))).toBe("invalid_spec");
    }
  });
});

describe("browser navigation and render rules", () => {
  test("allows only exact configured origins without credentials", () => {
    const allowed = { allowedOrigins: new Set(["https://example.com"]), anyPublicOrigin: false };
    expect(isAllowedNavigation("https://example.com/dashboard?x=1", allowed)).toBe(true);
    expect(isAllowedNavigation("https://redirected.example.net/", allowed)).toBe(false);
    expect(isAllowedNavigation("https://example.com:8443/", allowed)).toBe(false);
    expect(isAllowedNavigation("http://example.com/", allowed)).toBe(false);
    expect(isAllowedNavigation("https://user:secret@example.com/", allowed)).toBe(false);
    expect(isAllowedNavigation("chrome-error://chromewebdata/", allowed)).toBe(false);
    expect(isAllowedNavigation("not a url", allowed)).toBe(false);
  });

  test("any-public mode allows public http(s) hosts and still refuses local and private ones", () => {
    const anyPublic = {
      allowedOrigins: new Set(["http://127.0.0.1:4173"]),
      anyPublicOrigin: true,
    };
    for (const url of [
      "https://news.ycombinator.com/item?id=1",
      "http://example.org/",
      "https://example.com:8443/",
      "http://93.184.216.34/",
      "https://[2606:4700::6810:84e5]/",
      "http://127.0.0.1:4173/app",
    ]) {
      expect({ allowed: isAllowedNavigation(url, anyPublic), url }).toEqual({ allowed: true, url });
    }
    for (const url of [
      "http://127.0.0.1:5000/",
      "http://localhost/",
      "http://app.localhost/",
      "http://10.0.0.8/",
      "http://169.254.169.254/latest/meta-data/",
      "http://2130706433/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "https://user:secret@example.com/",
      "ftp://example.com/",
      "file:///etc/passwd",
      "chrome-error://chromewebdata/",
    ]) {
      expect({ allowed: isAllowedNavigation(url, anyPublic), url }).toEqual({
        allowed: false,
        url,
      });
    }
    expect(
      isAllowedNavigation("https://example.org/", { ...anyPublic, anyPublicOrigin: false }),
    ).toBe(false);
  });

  test("blocks every request that could reach the sandbox control server", () => {
    const allowed = new Set(["http://127.0.0.1:4173", "https://example.com"]);
    for (const url of [
      "http://127.0.0.1:8080/__sandbox/exec",
      "http://127.1.2.3:8080/",
      "http://2130706433:8080/",
      "http://0x7f.1:8080/",
      "http://0.0.0.0:8080/",
      "http://localhost:8080/",
      "http://LOCALHOST.:8080/",
      "http://app.localhost:8080/",
      "http://[::1]:8080/",
      "http://[::]:8080/",
      "http://[::ffff:127.0.0.1]:8080/",
      "http://10.0.3.7:8080/",
      "http://169.254.1.1:8080/",
      "ws://127.0.0.1:8080/",
      "http://rebind.attacker.example:8080/",
    ]) {
      expect({ blocked: targetsSandboxControlServer(url, 8080, allowed), url }).toEqual({
        blocked: true,
        url,
      });
    }
    for (const url of [
      "http://127.0.0.1:4173/",
      "http://127.0.0.1/",
      "https://127.0.0.1/",
      "https://example.com/app.js",
      "http://93.184.216.34:8080/",
      "data:text/plain,hello",
      "not a url",
    ]) {
      expect({ blocked: targetsSandboxControlServer(url, 8080, allowed), url }).toEqual({
        blocked: false,
        url,
      });
    }
    expect(targetsSandboxControlServer("http://127.0.0.1/", 80, allowed)).toBe(true);
    expect(
      targetsSandboxControlServer(
        "http://allowed.example:8080/",
        8080,
        new Set(["http://allowed.example:8080"]),
      ),
    ).toBe(false);
  });

  test("reads the control port from SANDBOX_CONTROL_PORT with an 8080 default", () => {
    expect(sandboxControlPort({})).toBe(8080);
    expect(sandboxControlPort({ SANDBOX_CONTROL_PORT: "9000" })).toBe(9000);
    expect(failureCode(() => sandboxControlPort({ SANDBOX_CONTROL_PORT: "0" }))).toBe("internal");
  });

  test("enforces per-side and total pixel render limits", () => {
    expect(failureCode(() => assertRenderBounds({ height: 16_384, width: 1_525 }))).toBe(
      "no-failure",
    );
    expect(failureCode(() => assertRenderBounds({ height: 16_385, width: 100 }))).toBe(
      "dimensions_exceeded",
    );
    expect(failureCode(() => assertRenderBounds({ height: 5_000, width: 5_001 }))).toBe(
      "dimensions_exceeded",
    );
    expect(failureCode(() => assertRenderBounds({ height: 0, width: 100 }))).toBe(
      "dimensions_exceeded",
    );
    expect(failureCode(() => assertRenderBounds({ height: "900", width: 100 }))).toBe(
      "dimensions_exceeded",
    );
    expect(failureCode(() => assertImageSize(25 * 1024 * 1024))).toBe("no-failure");
    expect(failureCode(() => assertImageSize(25 * 1024 * 1024 + 1))).toBe("dimensions_exceeded");
    expect(failureCode(() => assertImageSize(0))).toBe("internal");
  });

  test("truncates evidence at a UTF-8 code point boundary", () => {
    expect(truncateUtf8("ab€", 4)).toEqual({ text: "ab", truncated: true });
    expect(truncateUtf8("ab€", 5)).toEqual({ text: "ab€", truncated: false });
    expect(truncateUtf8("😀😀", 7)).toEqual({ text: "😀", truncated: true });
  });
});

describe("browser job failure classification", () => {
  test("maps blocked, network, and timed-out navigations to deterministic codes", () => {
    const blocked = navigationFailure(
      new Error("net::ERR_BLOCKED_BY_CLIENT at https://example.net/"),
      false,
    );
    expect(blocked instanceof BrowserJobFailure && blocked.code).toBe("origin_not_allowed");
    const redirected = navigationFailure(
      new Error("net::ERR_ABORTED at https://example.com/"),
      true,
    );
    expect(redirected instanceof BrowserJobFailure && redirected.code).toBe("origin_not_allowed");
    const unresolved = navigationFailure(
      new Error("net::ERR_NAME_NOT_RESOLVED at https://example.com/?t=1"),
      false,
    );
    expect(unresolved).toMatchObject({
      code: "navigation_failed",
      message: "Browser navigation failed: net::ERR_NAME_NOT_RESOLVED.",
    });
    const timedOut = navigationFailure(
      namedError("TimeoutError", "Navigation timeout of 5 ms exceeded"),
      false,
    );
    expect(timedOut instanceof BrowserJobFailure && timedOut.code).toBe("timeout");
    const unknown = new Error("Protocol error: Target closed");
    expect(navigationFailure(unknown, false)).toBe(unknown);
  });

  test("maps selector waits that time out or cannot parse to selector_not_found", () => {
    expect(selectorFailure(namedError("TimeoutError", "Waiting failed"), "#missing")).toMatchObject(
      {
        code: "selector_not_found",
      },
    );
    expect(selectorFailure(new Error("'##' is not a valid selector."), "##")).toMatchObject({
      code: "selector_not_found",
    });
    const crashed = new Error("Target closed");
    expect(selectorFailure(crashed, "#x")).toBe(crashed);
  });

  test("reports unclassified errors as internal with redacted, bounded messages", () => {
    expect(
      failureStatus(
        new BrowserJobFailure("popup_not_allowed", "Browser popup navigation is not allowed."),
      ),
    ).toEqual({
      code: "popup_not_allowed",
      message: "Browser popup navigation is not allowed.",
      state: "failed",
    });
    const internal = failureStatus(
      new TypeError(`bad https://example.com/?token=secret ${"x".repeat(600)}`),
    );
    expect(internal.code).toBe("internal");
    expect(internal.message).not.toContain("secret");
    expect(internal.message.startsWith("Browser job failed: TypeError: bad <url> ")).toBe(true);
    expect(internal.message.length).toBe(MAX_FAILURE_MESSAGE_LENGTH);
    expect(failureStatus(namedError("TimeoutError", "Waiting failed")).code).toBe("timeout");
  });
});
