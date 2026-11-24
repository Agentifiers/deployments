import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appToolHarness } from "./app-runtime-tools.fixture.ts";

let harness = appToolHarness();
afterEach(() => {
  harness.guest.remove();
  harness = appToolHarness();
});

const INDEX_HTML = '<!doctype html><script type="module" src="./assets/app.js"></script>';
const APP_JS = 'console.log("orders");\n';

async function createApp() {
  const created = await harness.call("app.create", { name: "Orders", slug: "orders" });
  const appId = created.result?.output?.appId;
  if (typeof appId !== "string")
    throw new Error(`app.create failed: ${created.result?.outputSummary}`);
  return appId;
}

async function release(appId: string, directory: string) {
  return (await harness.call("app.release", { appId, directory })).result;
}

describe("app.release", () => {
  test("refuses a directory outside the workspace, a symlink, and a build without index.html", async () => {
    const appId = await createApp();
    harness.guest.write("linked/index.html", INDEX_HTML);
    harness.guest.symlink("linked/secrets", "/etc/passwd");
    harness.guest.write("noindex/app.js", APP_JS);

    const outcomes = [
      await release(appId, "../x"),
      await release(appId, "/etc"),
      await release(appId, "linked"),
      await release(appId, "noindex"),
    ];

    expect(outcomes.map((outcome) => outcome?.output)).toEqual([
      {
        error: {
          code: "release_invalid",
          message:
            'directory "../x" must be a relative path of 1 to 512 characters without empty, "." or ".." segments, backslashes, control characters, or invalid UTF-8.',
        },
      },
      {
        error: {
          code: "release_invalid",
          message:
            'directory "/etc" must be a relative path of 1 to 512 characters without empty, "." or ".." segments, backslashes, control characters, or invalid UTF-8.',
        },
      },
      {
        error: {
          code: "release_invalid",
          message: "secrets is a symbolic link; copy its target into the build output.",
        },
      },
      {
        error: {
          code: "release_invalid",
          message: "/workspace/noindex has no index.html at its root.",
        },
      },
    ]);
    expect(harness.stored.size).toBe(0);
    expect(await harness.apps.listReleases((await harness.apps.getApp(appId as never))!)).toEqual(
      [],
    );
  });

  test("refuses a symlinked directory instead of releasing what it points to", async () => {
    const appId = await createApp();
    harness.guest.write("dist/index.html", INDEX_HTML);
    harness.guest.write("shared/app.js", APP_JS);
    harness.guest.symlink("dist/assets", "../shared");

    const released = await release(appId, "dist");

    expect(released?.output).toEqual({
      error: {
        code: "release_invalid",
        message: "assets is a symbolic link; copy its target into the build output.",
      },
    });
  });

  test("uploads every file under the release prefix and records one release", async () => {
    const appId = await createApp();
    harness.guest.write("dist/index.html", INDEX_HTML);
    harness.guest.write("dist/assets/app.js", APP_JS);

    const released = await release(appId, "dist");
    const releaseId = String(released?.output?.releaseId);
    const app = (await harness.apps.getApp(appId as never))!;

    expect(released?.output).toMatchObject({ appId, bytes: 91, files: 2 });
    expect(
      (await harness.apps.listReleases(app)).map((entry) => ({
        bytes: entry.data.bytes,
        files: entry.data.files,
        id: String(entry.data.id),
      })),
    ).toEqual([{ bytes: 91, files: 2, id: releaseId }]);
    expect(harness.presigned).toEqual([
      {
        byteSize: 23,
        cacheControl: "public, max-age=31536000, immutable",
        contentType: "text/javascript; charset=utf-8",
        key: `apps/${appId}/releases/${releaseId}/assets/app.js`,
        sha256: createHash("sha256").update(APP_JS).digest("hex"),
      },
      {
        byteSize: 68,
        cacheControl: undefined,
        contentType: "text/html; charset=utf-8",
        key: `apps/${appId}/releases/${releaseId}/index.html`,
        sha256: createHash("sha256").update(INDEX_HTML).digest("hex"),
      },
    ]);
    expect([...harness.stored.keys()]).toEqual([
      `apps/${appId}/releases/${releaseId}/assets/app.js`,
      `apps/${appId}/releases/${releaseId}/index.html`,
    ]);
  });

  test("records the release's HTML documents in path order, whatever their extension's case", async () => {
    const appId = await createApp();
    for (const path of [
      "index.html",
      "about/index.html",
      "404.html",
      "docs/Guide.HTM",
      "assets/app.js",
      "logo.svg",
      "notes.xhtml",
    ]) {
      harness.guest.write(`dist/${path}`, INDEX_HTML);
    }

    const released = await release(appId, "dist");
    const app = (await harness.apps.getApp(appId as never))!;

    expect(released?.output).toMatchObject({ appId, files: 7 });
    expect<unknown>(
      (await harness.apps.listReleases(app)).map((entry) => entry.data.documents),
    ).toEqual([["404.html", "about/index.html", "docs/Guide.HTM", "index.html"]]);
  });

  test("refuses a build over the document limits before uploading anything", async () => {
    const appId = await createApp();
    harness.guest.write("many/index.html", INDEX_HTML);
    for (let index = 0; index < 500; index += 1) {
      harness.guest.write(`many/pages/${String(index).padStart(3, "0")}.html`, INDEX_HTML);
    }
    harness.guest.write("long/index.html", INDEX_HTML);
    for (let index = 0; index < 200; index += 1) {
      harness.guest.write(
        `long/${"d".repeat(200)}/${"e".repeat(150)}${String(index).padStart(3, "0")}.html`,
        INDEX_HTML,
      );
    }

    const outcomes = [await release(appId, "many"), await release(appId, "long")];

    expect(outcomes.map((outcome) => outcome?.output)).toEqual([
      {
        error: {
          code: "release_invalid",
          message: "/workspace/many: A release lists at most 500 HTML documents; this one has 501.",
        },
      },
      {
        error: {
          code: "release_invalid",
          message:
            "/workspace/long: The paths of a release's HTML documents total at most 64 KiB; this one's total 71810 bytes.",
        },
      },
    ]);
    expect(harness.stored.size).toBe(0);
    expect(harness.presigned).toEqual([]);
  });

  test("refuses a file path the release record would refuse before uploading anything", async () => {
    const appId = await createApp();
    harness.guest.write("dist/index.html", INDEX_HTML);
    harness.guest.write("dist/caf\u0085.html", INDEX_HTML);

    const released = await release(appId, "dist");

    expect(released?.output).toEqual({
      error: {
        code: "release_invalid",
        message: `file "caf\u0085.html" must be a relative path of 1 to 512 characters without empty, "." or ".." segments, backslashes, control characters, or invalid UTF-8.`,
      },
    });
    expect(harness.stored.size).toBe(0);
    expect(harness.presigned).toEqual([]);
    expect(await harness.apps.listReleases((await harness.apps.getApp(appId as never))!)).toEqual(
      [],
    );
  });

  test("a retry after verification failed reuses the release id and records one release", async () => {
    const appId = await createApp();
    harness.guest.write("dist/index.html", INDEX_HTML);
    const request = harness.runRequest("app.release", { appId, directory: "dist" });
    const decision = await harness.service.authorizeToolCall(request);
    if (decision.action !== "allow") throw new Error("Expected allow.");
    harness.failNextHead();

    const interrupted = await harness.execute(request, decision).catch((cause: unknown) => cause);
    const retried = await harness.execute(request, decision);

    expect(interrupted).toMatchObject({ name: "RuntimeToolPreparationRetryableError" });
    expect(
      (await harness.apps.listReleases((await harness.apps.getApp(appId as never))!)).map((entry) =>
        String(entry.data.id),
      ),
    ).toEqual([String(retried.output?.releaseId)]);
    expect(new Set(harness.presigned.map((object) => object.key)).size).toBe(1);
  });

  test("the guest upload job reports a failed upload by file", async () => {
    const appId = await createApp();
    harness.guest.write("dist/index.html", INDEX_HTML);
    harness.guest.write("dist/assets/app.js", APP_JS);
    harness.useRealUploadJob();

    const released = await release(appId, "dist");

    expect(released?.output).toEqual({
      error: {
        code: "release_upload_failed",
        message: "Uploading assets/app.js failed (insecure_url).",
      },
    });
  });

  test("the guest upload job deletes the spec that holds the presigned URLs", async () => {
    const appId = await createApp();
    harness.guest.write("dist/index.html", INDEX_HTML);
    harness.useRealUploadJob();

    await release(appId, "dist");

    expect(harness.guest.files("/var/tmp/deployments-ai-app-release")).toEqual([
      "pid",
      "status.json",
      "upload.py",
    ]);
  });
});
