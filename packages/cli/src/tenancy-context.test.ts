import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { MOCK_TENANCY_FIXTURE_IDS } from "@agentifiers/deployments-sdk";
import type { CliIo } from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-"));
  temporaryDirectories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    isInteractive: false,
  };
  return {
    directory,
    env: { DEPLOYMENTS_CONFIG_DIR: directory, DEPLOYMENTS_MOCK: "1", NO_COLOR: "1" },
    io,
    stdout,
    stderr,
  };
}

describe("CLI tenancy context", () => {
  it("requires canonical context IDs for tenancy commands", async () => {
    const test = await harness();
    expect(await runCli(["context", "set", "--org", "org_01", "--json"], test)).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["project", "list", "--json", "--no-color"], test)).toBe(7);
    expect(test.stderr.join("\n")).toContain("organizationId must be a canonical ULID");
  });

  it("ignores unrelated stale descendants for broader tenancy commands", async () => {
    const test = await harness();
    expect(
      await runCli(
        [
          "context",
          "set",
          "--org",
          MOCK_TENANCY_FIXTURE_IDS.organization,
          "--project",
          "prj_legacy",
          "--env",
          "env_legacy",
          "--json",
        ],
        test,
      ),
    ).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["org", "list", "--json", "--no-color"], test)).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["project", "list", "--json", "--no-color"], test)).toBe(0);
  });
});
