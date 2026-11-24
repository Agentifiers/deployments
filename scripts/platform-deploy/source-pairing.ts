import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CommandRunner, type Environment, repositoryRoot, runCommand } from "./process.ts";

export type RunningSource =
  | { readonly commit: string; readonly kind: "checkout"; readonly modified: readonly string[] }
  | { readonly commit: string; readonly kind: "environment" };

interface SourceOptions {
  readonly environment?: Environment;
  readonly root?: string;
  readonly run?: CommandRunner;
}

export async function runningSource({
  environment = process.env,
  root = repositoryRoot,
  run = runCommand,
}: SourceOptions = {}): Promise<RunningSource> {
  if (existsSync(join(root, ".git"))) {
    const head = await run(["git", "-C", root, "rev-parse", "HEAD"], { env: environment });
    const status = await run(["git", "-C", root, "status", "--porcelain", "--untracked-files=no"], {
      env: environment,
    });
    return {
      commit: head.trim(),
      kind: "checkout",
      modified: status
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.slice(3)),
    };
  }
  const commit = environment.PLATFORM_SOURCE_COMMIT;
  if (!commit || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(
      `${root} is not a git checkout, so PLATFORM_SOURCE_COMMIT must name the deploy tool's 40-hex commit.`,
    );
  }
  return { commit, kind: "environment" };
}

export async function assertSourcePairing(
  input: SourceOptions & { readonly releaseCommit: string },
) {
  const source = await runningSource(input);
  if (source.commit !== input.releaseCommit) {
    throw new Error(
      `The release bundle is from ${input.releaseCommit}, but the deploy tool runs from ${source.commit}. Run the deploy tool from the release's commit.`,
    );
  }
  if (source.kind === "checkout" && source.modified.length > 0) {
    throw new Error(
      `The deploy tool's checkout has tracked modifications (${source.modified.join(", ")}). Deploy from a clean checkout of ${input.releaseCommit}.`,
    );
  }
}
