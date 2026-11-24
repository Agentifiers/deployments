import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  SANDBOX_FILES_LIST_SCRIPT,
  SANDBOX_FILES_READ_SCRIPT,
  SANDBOX_FILES_WRITE_SCRIPT,
  SandboxFilesListScriptOutput,
  SandboxFilesReadScriptOutput,
  SandboxFilesWriteScriptOutput,
} from "./sandbox-file-guest-scripts.ts";

const python = Bun.which("python3");
let root = "";

function run<A>(
  script: string,
  schema: Schema.Codec<A, unknown>,
  args: Readonly<Record<string, unknown>>,
): A {
  const result = Bun.spawnSync([python!, "-c", script, JSON.stringify(args)]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const stdout = result.stdout.toString();
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trimEnd()).not.toContain("\n");
  return Schema.decodeUnknownSync(schema)(JSON.parse(stdout));
}

const read = (path: string, maxBytes: number) =>
  run(SANDBOX_FILES_READ_SCRIPT, SandboxFilesReadScriptOutput, { maxBytes, path });

function write(path: string, content: Uint8Array | string) {
  const source = join(root, `.upload-${Math.random().toString(36).slice(2)}`);
  writeFileSync(source, content);
  const result = run(SANDBOX_FILES_WRITE_SCRIPT, SandboxFilesWriteScriptOutput, { path, source });
  expect(existsSync(source)).toBe(false);
  return result;
}

const list = (path: string, recursive: boolean, limit: number) =>
  run(SANDBOX_FILES_LIST_SCRIPT, SandboxFilesListScriptOutput, { limit, path, recursive });

describe.skipIf(!python)("sandbox file guest scripts", () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-files-")));
  });
  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  test("read drops a multi-byte character cut by the byte limit without reporting not_utf8", () => {
    const path = join(root, "text.txt");
    writeFileSync(path, "aé€b");
    expect(read(path, 2)).toEqual({ byteSize: 7, content: "a", status: "ok", truncated: true });
    expect(read(path, 5)).toEqual({ byteSize: 7, content: "aé", status: "ok", truncated: true });
    expect(read(path, 6)).toEqual({ byteSize: 7, content: "aé€", status: "ok", truncated: true });
    expect(read(path, 7)).toEqual({ byteSize: 7, content: "aé€b", status: "ok", truncated: false });
  });

  test("read reports invalid UTF-8, missing paths, and non-files", () => {
    const binary = join(root, "binary.bin");
    writeFileSync(binary, new Uint8Array([0x61, 0xff, 0x62]));
    const cut = join(root, "cut.txt");
    writeFileSync(cut, new Uint8Array([0x61, 0xc3]));
    writeFileSync(join(root, "file"), "x");

    expect(read(binary, 64)).toEqual({ status: "not_utf8" });
    expect(read(cut, 64)).toEqual({ status: "not_utf8" });
    expect(read(join(root, "missing"), 64)).toEqual({ status: "not_found" });
    expect(read(join(root, "file", "child"), 64)).toEqual({ status: "not_found" });
    expect(read(root, 64)).toEqual({ status: "not_a_file" });
  });

  test("write creates parents, replaces files atomically, and preserves an existing mode", () => {
    const path = join(root, "a", "b", "c.txt");
    const bytes = new TextEncoder().encode("héllo\n");
    expect(write(path, bytes)).toEqual({
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      status: "ok",
    });
    expect(readFileSync(path, "utf8")).toBe("héllo\n");

    Bun.spawnSync(["chmod", "755", path]);
    expect(write(path, "")).toMatchObject({ byteSize: 0, status: "ok" });
    expect(readFileSync(path, "utf8")).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test("write refuses directory targets and file ancestors and removes the upload", () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "file"), "keep");

    expect(write(join(root, "dir"), "x")).toEqual({ status: "is_a_directory" });
    expect(write(join(root, "file", "child.txt"), "x")).toEqual({
      status: "parent_not_directory",
    });
    expect(write(join(root, "file", "deeper", "child.txt"), "x")).toEqual({
      status: "parent_not_directory",
    });
    expect(readFileSync(join(root, "file"), "utf8")).toBe("keep");
  });

  test("list sorts entries, recurses without following symlinks, and truncates at the limit", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-files-outside-")));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside");
      mkdirSync(join(root, "b", "nested"), { recursive: true });
      writeFileSync(join(root, "b", "nested", "deep.txt"), "12345");
      writeFileSync(join(root, "a.txt"), "abc");
      symlinkSync(outside, join(root, "link"));

      expect(list(root, false, 10)).toEqual({
        entries: [
          { byteSize: 3, path: join(root, "a.txt"), type: "file" },
          { path: join(root, "b"), type: "directory" },
          { path: join(root, "link"), type: "symlink" },
        ],
        status: "ok",
        truncated: false,
      });
      expect(list(root, true, 10)).toEqual({
        entries: [
          { byteSize: 3, path: join(root, "a.txt"), type: "file" },
          { path: join(root, "b"), type: "directory" },
          { path: join(root, "b", "nested"), type: "directory" },
          { byteSize: 5, path: join(root, "b", "nested", "deep.txt"), type: "file" },
          { path: join(root, "link"), type: "symlink" },
        ],
        status: "ok",
        truncated: false,
      });
      expect(list(root, true, 5)).toMatchObject({ status: "ok", truncated: false });
      expect(list(root, true, 4)).toEqual({
        entries: [
          { byteSize: 3, path: join(root, "a.txt"), type: "file" },
          { path: join(root, "b"), type: "directory" },
          { path: join(root, "b", "nested"), type: "directory" },
          { byteSize: 5, path: join(root, "b", "nested", "deep.txt"), type: "file" },
        ],
        status: "ok",
        truncated: true,
      });
      expect(list(join(root, "link"), true, 10)).toEqual({ status: "not_a_directory" });
      expect(list(join(root, "a.txt"), false, 10)).toEqual({ status: "not_a_directory" });
      expect(list(join(root, "missing"), false, 10)).toEqual({ status: "not_found" });
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});
