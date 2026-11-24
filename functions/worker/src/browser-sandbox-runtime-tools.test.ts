import { describe, expect, test } from "bun:test";
import { BROWSER_SESSION_EXECUTE_TOOL_NAME } from "@deployments-ai/browser-screenshot";
import { createHash } from "node:crypto";
import type {
  RuntimeSandboxPolicy,
  RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import {
  ALLOWED_ORIGIN,
  PNG,
  browserExecutors,
  fakeS3,
  fakeSandbox,
  planArtifact,
  request,
  sandboxPolicy,
  type FakeSandbox,
} from "./browser-runtime-tools.fixture.ts";

const JOB_DIR = `/var/tmp/deployments-ai-browser/${request.decision.toolCallId}`;
const CAPTURED_AT = "2026-09-29T00:00:00.000Z";

const captureFiles = {
  "result.json": JSON.stringify({
    byteSize: PNG.byteLength,
    capturedAt: CAPTURED_AT,
    contentType: "image/png",
    finalUrl: `${ALLOWED_ORIGIN}/page?ref=1`,
    sha256: createHash("sha256").update(PNG).digest("hex"),
  }),
  "screenshot.png": PNG,
};

const sessionFiles = {
  "dom.html": "<html><body>Done</body></html>",
  "result.json": JSON.stringify({
    actions: [{ index: 0, type: "click", url: `${ALLOWED_ORIGIN}/done?secret=1` }],
    capturedAt: CAPTURED_AT,
    domTruncated: false,
    finalUrl: `${ALLOWED_ORIGIN}/done?secret=1`,
    title: "Done",
  }),
  "screenshot.png": PNG,
};

function captureRequest(policy?: RuntimeSandboxPolicy) {
  return {
    ...request,
    input: { url: `${ALLOWED_ORIGIN}/page` },
    ...(policy ? { sandboxPolicy: policy } : {}),
    toolName: "browser.capture_screenshot",
  };
}

function sessionRequest(policy: RuntimeSandboxPolicy = sandboxPolicy("run-ephemeral")) {
  return {
    ...request,
    effect: "write" as const,
    input: {
      actions: [{ selector: "#complete", type: "click" }],
      sessionPlanId: request.decision.toolCallId,
      url: `${ALLOWED_ORIGIN}/page`,
    },
    sandboxPolicy: policy,
    toolName: BROWSER_SESSION_EXECUTE_TOOL_NAME,
  };
}

/** A refused target comes back as a failed tool result the model reads, not a run failure. */
function refusal(result: RuntimeToolExecutionResult) {
  return { error: result.output?.error, status: result.status };
}

function capture(sandbox: FakeSandbox) {
  return browserExecutors({
    manager: sandbox.manager,
    threadSandbox: sandbox.threadSandbox,
  })["browser.capture_screenshot"]!;
}

function session(sandbox: FakeSandbox, s3 = fakeS3()) {
  return browserExecutors({
    artifactS3: s3.client,
    manager: sandbox.manager,
    records: [planArtifact({})],
    threadSandbox: sandbox.threadSandbox,
  })[BROWSER_SESSION_EXECUTE_TOOL_NAME]!;
}

describe("sandboxed browser tools", () => {
  test("captures in a fresh MicroVM, destroys it, and binds the screenshot to the tool call", async () => {
    const sandbox = fakeSandbox({ files: captureFiles });

    const result = await capture(sandbox)(
      captureRequest(sandboxPolicy("run-ephemeral")),
      {} as never,
    );

    expect(sandbox.calls.creates).toEqual([
      expect.objectContaining({
        allocationId: request.decision.toolCallId,
        isolationMode: "run-ephemeral",
        runId: request.runId,
      }),
    ]);
    expect(sandbox.calls.specs).toEqual([
      {
        path: `${JOB_DIR}/spec.json`,
        spec: {
          allowedOrigins: [ALLOWED_ORIGIN],
          input: expect.objectContaining({
            format: "png",
            fullPage: true,
            url: `${ALLOWED_ORIGIN}/page`,
          }),
          kind: "capture",
        },
      },
    ]);
    expect(sandbox.calls.commands[0]).toEqual([
      "node",
      "/opt/agent-sandbox/browser/driver.ts",
      "start",
      JOB_DIR,
    ]);
    expect(sandbox.calls.destroyed).toEqual(["ephemeral"]);
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        content: PNG,
        contentType: "image/png",
        metadata: expect.objectContaining({
          capturedAt: CAPTURED_AT,
          captureService: "sandbox-chromium",
          screenshotUrl: `${ALLOWED_ORIGIN}/page?ref=1`,
          toolCallId: request.decision.toolCallId,
        }),
        type: "screenshot",
        visibility: "private",
      }),
    ]);
  });

  test("reuses the thread sandbox without destroying it and removes the job directory", async () => {
    const sandbox = fakeSandbox({ files: captureFiles });

    await capture(sandbox)(captureRequest(sandboxPolicy("thread-persistent")), {} as never);

    expect(sandbox.calls.acquired).toHaveLength(1);
    expect(sandbox.calls.creates).toEqual([]);
    expect(sandbox.calls.destroyed).toEqual([]);
    expect(sandbox.calls.cleanups).toEqual([JOB_DIR]);
  });

  test("rejects calls without a MicroVM sandbox before allocating one", async () => {
    const sandbox = fakeSandbox({ files: captureFiles });
    for (const policy of [undefined, sandboxPolicy("none")]) {
      expect(capture(sandbox)(captureRequest(policy), {} as never)).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    expect(sandbox.calls.creates).toEqual([]);
    expect(sandbox.calls.acquired).toEqual([]);
  });

  test("returns targets resolving to private addresses as a tool error before allocating a sandbox", async () => {
    const sandbox = fakeSandbox({ files: captureFiles });
    const executor = browserExecutors({
      dnsLookup: async () => [{ address: "10.0.0.8", family: 4 }],
      manager: sandbox.manager,
    })["browser.capture_screenshot"]!;

    const result = await executor(captureRequest(sandboxPolicy("run-ephemeral")), {} as never);

    expect(refusal(result)).toEqual({
      error: {
        code: "origin_not_allowed",
        message: "Screenshot target must resolve exclusively to public addresses",
      },
      status: "completed",
    });
    expect(result.outputSummary).toBe(
      "Tool browser.capture_screenshot failed: Screenshot target must resolve exclusively to public addresses",
    );
    expect(sandbox.calls.creates).toEqual([]);
  });

  test("returns a failed DNS lookup as navigation_failed, and still fails malformed input", async () => {
    const sandbox = fakeSandbox({ files: captureFiles });
    const executor = browserExecutors({
      dnsLookup: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
      manager: sandbox.manager,
    })["browser.capture_screenshot"]!;

    expect(
      refusal(await executor(captureRequest(sandboxPolicy("run-ephemeral")), {} as never)),
    ).toMatchObject({ error: { code: "navigation_failed" }, status: "completed" });
    expect(
      executor(
        { ...captureRequest(sandboxPolicy("run-ephemeral")), input: { url: 42 } },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(sandbox.calls.creates).toEqual([]);
  });

  test("in any-public mode, captures an unlisted public origin and asks the driver for that mode", async () => {
    const other = "https://news.example.org";
    const sandbox = fakeSandbox({
      files: {
        ...captureFiles,
        "result.json": JSON.stringify({
          ...(JSON.parse(captureFiles["result.json"]) as Record<string, unknown>),
          finalUrl: `${other}/item`,
        }),
      },
    });
    const anyPublic = (dnsAddress: string) =>
      browserExecutors({
        dnsLookup: async () => [{ address: dnsAddress, family: 4 }],
        loadScreenshotConfig: () => ({ kind: "any-public" }),
        manager: sandbox.manager,
      })["browser.capture_screenshot"]!;
    const call = { ...captureRequest(sandboxPolicy("run-ephemeral")), input: { url: `${other}/` } };

    const result = await anyPublic("93.184.216.34")(call, {} as never);

    expect(sandbox.calls.specs[0]?.spec).toMatchObject({
      allowedOrigins: [],
      anyPublicOrigin: true,
      input: { url: `${other}/` },
    });
    expect(result.artifacts?.[0]?.metadata).toMatchObject({ screenshotUrl: `${other}/item` });
    expect(refusal(await anyPublic("169.254.169.254")(call, {} as never))).toMatchObject({
      error: { code: "origin_not_allowed" },
    });
    expect(sandbox.calls.creates).toHaveLength(1);
  });

  describe("loopback dev server targets", () => {
    const LOOPBACK = "http://127.0.0.1:4173";
    const loopbackFiles = {
      ...captureFiles,
      "result.json": JSON.stringify({
        ...(JSON.parse(captureFiles["result.json"]) as Record<string, unknown>),
        finalUrl: `${LOOPBACK}/index.html`,
      }),
    };
    const loopbackRequest = (url: string, policy = sandboxPolicy("thread-persistent")) => ({
      ...captureRequest(policy),
      input: { url },
    });
    const executor = (sandbox: FakeSandbox, sandboxControlPort?: number) =>
      browserExecutors({
        dnsLookup: async () => {
          throw new Error("loopback captures must not resolve DNS");
        },
        manager: sandbox.manager,
        ...(sandboxControlPort === undefined ? {} : { sandboxControlPort }),
        threadSandbox: sandbox.threadSandbox,
      })["browser.capture_screenshot"]!;

    test("captures the thread sandbox's own server and allows exactly its origin in the driver", async () => {
      const sandbox = fakeSandbox({ files: loopbackFiles });

      const result = await executor(sandbox)(loopbackRequest(`${LOOPBACK}/`), {} as never);

      expect(sandbox.calls.acquired).toHaveLength(1);
      expect(sandbox.calls.creates).toEqual([]);
      expect(sandbox.calls.specs[0]?.spec).toMatchObject({
        allowedOrigins: [ALLOWED_ORIGIN, LOOPBACK],
        input: { url: `${LOOPBACK}/` },
        kind: "capture",
      });
      expect(result.artifacts?.[0]?.metadata).toMatchObject({
        screenshotUrl: `${LOOPBACK}/index.html`,
      });
    });

    test("rejects loopback targets outside thread-persistent sandboxes before allocating one", async () => {
      const sandbox = fakeSandbox({ files: loopbackFiles });
      const result = await executor(sandbox)(
        loopbackRequest(`${LOOPBACK}/`, sandboxPolicy("run-ephemeral")),
        {} as never,
      );

      expect(refusal(result).error).toMatchObject({
        code: "origin_not_allowed",
        message: expect.stringContaining("require a thread-persistent sandbox policy"),
      });
      expect(sandbox.calls.creates).toEqual([]);
    });

    test("rejects the control port, https, localhost, missing ports, and other local hosts", async () => {
      const cases = [
        ["http://127.0.0.1:8080/", "sandbox control port"],
        ["https://127.0.0.1:4173/", "must use plain http"],
        ["http://127.0.0.1/", "explicit port"],
        ["http://localhost:4173/", "http://127.0.0.1:<port>/"],
        ["http://127.0.0.2:4173/", "http://127.0.0.1:<port>/"],
        ["http://[::1]:4173/", "http://127.0.0.1:<port>/"],
        ["http://10.0.0.8:4173/", "http://127.0.0.1:<port>/"],
      ] as const;
      for (const [url, message] of cases) {
        const sandbox = fakeSandbox({ files: loopbackFiles });
        const result = await executor(sandbox)(loopbackRequest(url), {} as never);
        expect({ error: refusal(result).error, url }).toMatchObject({
          error: { code: "origin_not_allowed", message: expect.stringContaining(message) },
          url,
        });
        expect(sandbox.calls.acquired).toEqual([]);
      }
    });

    test("blocks the configured control port instead of the default", async () => {
      const configured = fakeSandbox({ files: loopbackFiles });
      expect(
        refusal(
          await executor(configured, 9000)(loopbackRequest("http://127.0.0.1:9000/"), {} as never),
        ).error,
      ).toMatchObject({
        message: expect.stringContaining("Port 9000 is the sandbox control port"),
      });

      const moved = fakeSandbox({
        files: {
          ...loopbackFiles,
          "result.json": JSON.stringify({
            ...(JSON.parse(captureFiles["result.json"]) as Record<string, unknown>),
            finalUrl: "http://127.0.0.1:8080/",
          }),
        },
      });
      await executor(moved, 9000)(loopbackRequest("http://127.0.0.1:8080/"), {} as never);
      expect(moved.calls.specs[0]?.spec).toMatchObject({
        allowedOrigins: [ALLOWED_ORIGIN, "http://127.0.0.1:8080"],
      });
    });

    test("rejects a final URL that left the loopback origin", async () => {
      const sandbox = fakeSandbox({
        files: {
          ...loopbackFiles,
          "result.json": JSON.stringify({
            ...(JSON.parse(captureFiles["result.json"]) as Record<string, unknown>),
            finalUrl: "http://127.0.0.1:5000/",
          }),
        },
      });
      expect(executor(sandbox)(loopbackRequest(`${LOOPBACK}/`), {} as never)).rejects.toThrow();
    });
  });

  test("returns every job that failed inside the MicroVM to the model as a failed tool result", async () => {
    for (const [code, message] of [
      ["selector_not_found", "Selector #ready did not become visible before the timeout."],
      ["internal", "Browser job failed: ProtocolError: Target.setDiscoverTargets timed out."],
      ["job_exited", "Browser job process exited without a status."],
    ]) {
      const sandbox = fakeSandbox({ status: { code, message, state: "failed" } });

      const result = await capture(sandbox)(
        captureRequest(sandboxPolicy("run-ephemeral")),
        {} as never,
      );

      expect(result).toEqual({
        output: { error: { code, message } },
        outputSummary: `Tool browser.capture_screenshot failed: ${message}`,
        status: "completed",
      });
      expect(sandbox.calls.destroyed).toEqual(["ephemeral"]);
    }
  });

  test("treats screenshots that disagree with the recorded digest as runtime failures", async () => {
    const sandbox = fakeSandbox({
      files: { ...captureFiles, "screenshot.png": PNG.slice(0, PNG.byteLength - 1) },
    });
    const failure = capture(sandbox)(captureRequest(sandboxPolicy("run-ephemeral")), {} as never);

    expect(failure).rejects.toThrow("returned invalid browser evidence");
    expect(failure).rejects.not.toBeInstanceOf(TypeError);
    expect(sandbox.calls.destroyed).toEqual(["ephemeral"]);
  });

  test("reports a failed MicroVM teardown even when the capture succeeded", async () => {
    const sandbox = fakeSandbox({ destroyFails: true, files: captureFiles });
    expect(
      capture(sandbox)(captureRequest(sandboxPolicy("run-ephemeral")), {} as never),
    ).rejects.toThrow("sandbox cleanup did not complete");
  });

  test("executes a session, stores replay evidence, and keeps session screenshots out of tool-result images", async () => {
    const sandbox = fakeSandbox({ files: sessionFiles });
    const s3 = fakeS3();
    const executor = session(sandbox, s3);

    const result = await executor(sessionRequest(), {} as never);

    expect(sandbox.calls.specs[0]?.spec).toMatchObject({ kind: "session" });
    expect(result).toMatchObject({
      artifacts: [
        { contentType: "text/html; charset=utf-8", type: "report", visibility: "private" },
        { content: PNG, contentType: "image/png", type: "screenshot", visibility: "private" },
      ],
      output: { finalUrl: `${ALLOWED_ORIGIN}/done?secret=1`, title: "Done" },
      outputSummary: `Executed 1 browser action and captured rendered evidence for ${ALLOWED_ORIGIN}/done.`,
      status: "completed",
    });
    for (const artifact of result.artifacts ?? []) {
      expect(artifact.metadata).not.toHaveProperty("toolCallId");
    }
    expect([...s3.objects.keys()]).toEqual([
      expect.stringMatching(/^browser-session-idempotency\/[0-9a-f]{64}$/u),
    ]);
    expect(executor.mutationClaimResult?.(result)).toEqual({
      artifacts: [],
      outputSummary: `Executed 1 browser action and captured rendered evidence for ${ALLOWED_ORIGIN}/done.`,
      status: "completed",
    });
  });

  test("replays from stored evidence without running the browser again", async () => {
    const s3 = fakeS3();
    const first = await session(fakeSandbox({ files: sessionFiles }), s3)(
      sessionRequest(),
      {} as never,
    );
    const replaySandbox = fakeSandbox();

    const replay = await session(replaySandbox, s3).refreshReplay!(sessionRequest(), {} as never, {
      artifacts: [],
      outputSummary: first.outputSummary!,
      status: "completed",
    });

    expect(replay).toEqual(first);
    expect(replaySandbox.calls.commands).toEqual([]);
    expect(replaySandbox.calls.creates).toEqual([]);
  });

  test("refuses to replay missing or mismatched evidence", async () => {
    const persisted = { artifacts: [], status: "completed" as const };
    expect(
      session(fakeSandbox()).refreshReplay!(sessionRequest(), {} as never, persisted),
    ).rejects.toThrow("was not found");

    const s3 = fakeS3();
    await session(fakeSandbox({ files: sessionFiles }), s3)(sessionRequest(), {} as never);
    const changed = sessionRequest();
    const mismatched = {
      ...changed,
      input: { ...changed.input, actions: [{ selector: "#other", type: "click" }] },
    };
    const replay = session(fakeSandbox(), s3).refreshReplay!(mismatched, {} as never, persisted);
    expect(replay).rejects.toThrow("different session input");
    expect(replay).rejects.not.toBeInstanceOf(TypeError);
  });

  test("returns the earlier durable evidence when a retried session finds it already stored", async () => {
    const s3 = fakeS3();
    const first = await session(fakeSandbox({ files: sessionFiles }), s3)(
      sessionRequest(),
      {} as never,
    );
    const later = JSON.parse(sessionFiles["result.json"]) as Record<string, unknown>;
    const retried = await session(
      fakeSandbox({
        files: {
          ...sessionFiles,
          "result.json": JSON.stringify({ ...later, capturedAt: "2026-09-29T00:05:00.000Z" }),
        },
      }),
      s3,
    )(sessionRequest(), {} as never);

    expect(retried).toEqual(first);
    expect(s3.calls.puts).toBe(2);
    expect(s3.objects.size).toBe(1);
  });
});
