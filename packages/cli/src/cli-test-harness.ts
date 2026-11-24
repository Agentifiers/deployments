import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "./types.ts";

const temporaryDirectories: string[] = [];

/** Removes every directory created by `harness`; register with `afterEach`. */
export async function removeTemporaryDirectories() {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
}

export async function harness() {
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
