import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES,
  CALLBACK_WORKSPACE_FILES_MAX_FILES,
  CALLBACK_WORKSPACE_FILES_SCRIPT,
  CallbackWorkspaceFilesScriptOutput,
} from "./callback-workspace-files.ts";

const python = Bun.which("python3");
let base = "";
let root = "";

function expand(include: readonly string[], limits: { maxFiles?: number; maxBytes?: number } = {}) {
  const result = Bun.spawnSync([
    python!,
    "-c",
    CALLBACK_WORKSPACE_FILES_SCRIPT,
    JSON.stringify({
      include,
      maxContentBytes: limits.maxBytes ?? CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES,
      maxFiles: limits.maxFiles ?? CALLBACK_WORKSPACE_FILES_MAX_FILES,
      root,
    }),
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const stdout = result.stdout.toString();
  expect(stdout.trimEnd()).not.toContain("\n");
  return Schema.decodeUnknownSync(CallbackWorkspaceFilesScriptOutput)(JSON.parse(stdout));
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!python)("callback workspace files guest script", () => {
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "callback-workspace-")));
    root = join(base, "workspace");
    mkdirSync(join(root, "site", "assets"), { recursive: true });
    writeFileSync(join(root, "site", "index.html"), "<h1>Héllo</h1>\n");
    writeFileSync(join(root, "site", "style.css"), "body{}\n");
    writeFileSync(join(root, "site", "assets", "logo.png"), new Uint8Array([0x89, 0x50, 0xff, 0]));
    writeFileSync(join(base, "secret.txt"), "outside");
  });

  afterEach(() => {
    rmSync(base, { force: true, recursive: true });
  });

  test("expands recursive globs into deduplicated, path-sorted files with text content only for UTF-8", () => {
    expect(expand(["site/*.html", "site/**/*", "site/*.css"])).toEqual({
      files: [
        {
          byteSize: 4,
          path: "site/assets/logo.png",
          sha256: sha256(new Uint8Array([0x89, 0x50, 0xff, 0])),
        },
        {
          byteSize: Buffer.byteLength("<h1>Héllo</h1>\n"),
          content: "<h1>Héllo</h1>\n",
          path: "site/index.html",
          sha256: sha256("<h1>Héllo</h1>\n"),
        },
        { byteSize: 7, content: "body{}\n", path: "site/style.css", sha256: sha256("body{}\n") },
      ],
      status: "ok",
    });
  });

  test("skips directories and symlinks that resolve outside the workspace", () => {
    symlinkSync(join(base, "secret.txt"), join(root, "site", "escape.txt"));
    symlinkSync(base, join(root, "site", "parent"));
    symlinkSync(join(root, "site", "style.css"), join(root, "site", "alias.css"));

    const result = expand(["site/*", "site/parent/*", "site/**/*.txt"]);

    expect(result.status === "ok" && result.files.map((file) => file.path)).toEqual([
      "site/alias.css",
      "site/index.html",
      "site/style.css",
    ]);
  });

  test("refuses absolute and parent-relative patterns", () => {
    expect(expand(["/etc/*"])).toEqual({ pattern: "/etc/*", status: "invalid_pattern" });
    expect(expand(["site/../../*"])).toEqual({
      pattern: "site/../../*",
      status: "invalid_pattern",
    });
  });

  test("fails instead of truncating when the file count or text content exceeds its limit", () => {
    expect(expand(["site/**/*"], { maxFiles: 2 })).toEqual({ count: 3, status: "too_many_files" });
    // The budget counts JSON-encoded text: `"body{}\n"` is 10 bytes with its quotes and escape.
    expect(expand(["site/*.css"], { maxBytes: 10 })).toMatchObject({ status: "ok" });
    expect(expand(["site/*.css"], { maxBytes: 9 })).toEqual({ status: "content_too_large" });
    writeFileSync(join(root, "site", "big.txt"), "x".repeat(3 * 1024 * 1024));
    expect(expand(["site/big.txt"], { maxBytes: 1024 })).toEqual({ status: "content_too_large" });
  });

  test("returns an empty list when nothing matches", () => {
    expect(expand(["missing/**/*.html"])).toEqual({ files: [], status: "ok" });
  });
});
