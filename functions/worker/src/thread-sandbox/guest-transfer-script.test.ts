import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_TRANSFER_SCRIPT } from "./guest-transfer-script.ts";

const python = Bun.which("python3");
let base = "";

function transfer(...args: string[]) {
  const result = Bun.spawnSync([python!, join(base, "job", "transfer.py"), ...args]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}

async function runJob(spec: Record<string, unknown>) {
  writeFileSync(join(base, "job", "spec.json"), JSON.stringify(spec));
  expect(transfer("start", join(base, "job", "spec.json"))).toEqual({ state: "started" });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = transfer("status", join(base, "job"));
    if (status.state !== "running") return status;
    // The job is a detached OS process, so fake timers cannot advance it; poll its real status.
    // eslint-disable-next-line no-await-in-loop -- Polling the detached job.
    await Bun.sleep(25);
  }
  throw new Error("transfer job did not settle");
}

describe.skipIf(!python)("workspace transfer guest script", () => {
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "workspace-transfer-")));
    mkdirSync(join(base, "job"));
    mkdirSync(join(base, "workspace", "nested"), { recursive: true });
    writeFileSync(join(base, "job", "transfer.py"), WORKSPACE_TRANSFER_SCRIPT);
    writeFileSync(join(base, "workspace", "notes.txt"), "hello\n");
    writeFileSync(join(base, "workspace", "nested", "data.bin"), new Uint8Array([0, 1, 2, 255]));
  });

  afterEach(() => {
    rmSync(base, { force: true, recursive: true });
  });

  test("reports missing before any job starts", () => {
    expect(transfer("status", join(base, "job"))).toEqual({ state: "missing" });
  });

  test("archives the workspace in a detached job with the size and digest of the written file", async () => {
    const output = join(base, "job", "snapshot.tar.gz");

    const status = await runJob({
      maxBytes: 1024 * 1024,
      op: "archive",
      output,
      root: join(base, "workspace"),
    });

    const archive = readFileSync(output);
    expect(status).toEqual({
      byteSize: archive.byteLength,
      sha256: createHash("sha256").update(archive).digest("hex"),
      state: "done",
    });
    const extracted = join(base, "extracted");
    mkdirSync(extracted);
    expect(Bun.spawnSync(["tar", "-C", extracted, "-xzf", output]).exitCode).toBe(0);
    expect(readFileSync(join(extracted, "notes.txt"), "utf8")).toBe("hello\n");
    expect([...readFileSync(join(extracted, "nested", "data.bin"))]).toEqual([0, 1, 2, 255]);
    expect(readdirSync(join(base, "job"))).not.toContain("spec.json");
  });

  test("stops at the size limit and leaves no partial archive", async () => {
    writeFileSync(
      join(base, "workspace", "random.bin"),
      new Uint8Array(crypto.getRandomValues(new Uint8Array(65_536))),
    );
    const output = join(base, "job", "snapshot.tar.gz");

    const status = await runJob({
      maxBytes: 1024,
      op: "archive",
      output,
      root: join(base, "workspace"),
    });

    expect(status).toEqual({ state: "too_large" });
    expect(readdirSync(join(base, "job"))).not.toContain("snapshot.tar.gz");
  });

  test.each(["upload", "restore"])("refuses a non-HTTPS %s URL", async (op) => {
    writeFileSync(join(base, "job", "snapshot.tar.gz"), "archive");

    const status = await runJob({
      byteSize: 7,
      file: join(base, "job", "snapshot.tar.gz"),
      headers: {},
      op,
      root: join(base, "workspace"),
      sha256: "0".repeat(64),
      url: "http://s3.example/key",
    });

    expect(status).toEqual({ reason: "insecure_url", state: "failed" });
  });
});
