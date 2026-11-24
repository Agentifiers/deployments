import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, runCommand } from "./process.ts";
import { assertSourcePairing, runningSource } from "./source-pairing.ts";

const releaseCommit = "0123456789abcdef0123456789abcdef01234567";
const fixedIdentity = {
  GIT_AUTHOR_DATE: "2026-10-09T00:00:00Z",
  GIT_AUTHOR_EMAIL: "release@example.com",
  GIT_AUTHOR_NAME: "Release",
  GIT_COMMITTER_DATE: "2026-10-09T00:00:00Z",
  GIT_COMMITTER_EMAIL: "release@example.com",
  GIT_COMMITTER_NAME: "Release",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
// Git hooks export GIT_DIR and GIT_INDEX_FILE, which would point these commands at this repository.
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  ...fixedIdentity,
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "platform-source-"));
  directories.push(path);
  return path;
}

async function checkout() {
  const root = directory();
  const git = (...args: string[]) => runCommand(["git", "-C", root, ...args], { env: environment });
  await git("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "release\n");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "release");
  return root;
}

describe("deploy tool source pairing", () => {
  test("accepts a clean checkout at the release commit and ignores untracked files", async () => {
    const root = await checkout();
    writeFileSync(join(root, "notes.txt"), "scratch\n");
    const source = await runningSource({ environment, root });
    expect(source).toEqual({
      commit: "a0b1e211ec7fdacc1ad4875a5a2c05645d6443ff",
      kind: "checkout",
      modified: [],
    });
    expect(
      await assertSourcePairing({ environment, releaseCommit: source.commit, root }),
    ).toBeUndefined();
  });

  test("rejects a release built from another commit", async () => {
    const root = await checkout();
    expect(assertSourcePairing({ environment, releaseCommit, root })).rejects.toThrow(
      "The release bundle is from 0123456789abcdef0123456789abcdef01234567, but the deploy tool runs from a0b1e211ec7fdacc1ad4875a5a2c05645d6443ff. Run the deploy tool from the release's commit.",
    );
  });

  test("rejects a checkout with tracked modifications", async () => {
    const root = await checkout();
    writeFileSync(join(root, "README.md"), "patched\n");
    expect(
      assertSourcePairing({
        environment,
        releaseCommit: "a0b1e211ec7fdacc1ad4875a5a2c05645d6443ff",
        root,
      }),
    ).rejects.toThrow(
      "The deploy tool's checkout has tracked modifications (README.md). Deploy from a clean checkout of a0b1e211ec7fdacc1ad4875a5a2c05645d6443ff.",
    );
  });

  test("uses PLATFORM_SOURCE_COMMIT outside a checkout", async () => {
    const root = directory();
    const baked = { ...environment, PLATFORM_SOURCE_COMMIT: releaseCommit };
    expect(await runningSource({ environment: baked, root })).toEqual({
      commit: releaseCommit,
      kind: "environment",
    });
    expect(await assertSourcePairing({ environment: baked, releaseCommit, root })).toBeUndefined();
    expect(
      assertSourcePairing({
        environment: baked,
        releaseCommit: "89abcdef0123456789abcdef0123456789abcdef",
        root,
      }),
    ).rejects.toThrow(
      "The release bundle is from 89abcdef0123456789abcdef0123456789abcdef, but the deploy tool runs from 0123456789abcdef0123456789abcdef01234567.",
    );
    expect(assertSourcePairing({ environment, releaseCommit, root })).rejects.toThrow(
      `${root} is not a git checkout, so PLATFORM_SOURCE_COMMIT must name the deploy tool's 40-hex commit.`,
    );
  });

  test("reads the baked PLATFORM_SOURCE_COMMIT only when no .git is present, so the deployer image leaves out .git", async () => {
    const dockerignore = await Bun.file(
      join(repositoryRoot, "infrastructure/deployer/Dockerfile.dockerignore"),
    ).text();
    expect(dockerignore.split("\n")).toContain("**/.git");
    const baked = { ...environment, PLATFORM_SOURCE_COMMIT: releaseCommit };
    expect(await runningSource({ environment: baked, root: await checkout() })).toEqual({
      commit: "a0b1e211ec7fdacc1ad4875a5a2c05645d6443ff",
      kind: "checkout",
      modified: [],
    });
  });
});
