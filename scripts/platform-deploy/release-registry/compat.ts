import { basename } from "node:path";
import type { CommandRunner } from "../process.ts";
import type { CompatibilityReason } from "./record.ts";

const recordSchemaPath = "packages/db/src/records/";
const deployMigrationPathspec = "scripts/platform-deploy/*-migration.ts";
const movedBlockLine = /^\+\s*moved\s*\{/u;

function addedMovedBlocks(diff: string) {
  const counts = new Map<string, number>();
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice("+++ b/".length) : undefined;
    } else if (file && movedBlockLine.test(line)) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
}

export async function compatibilityReasons(input: {
  readonly cwd: string;
  readonly from: string;
  readonly run: CommandRunner;
  readonly to: string;
}): Promise<readonly CompatibilityReason[]> {
  const git = (...args: string[]) => input.run(["git", ...args], { cwd: input.cwd });
  const range = [input.from, input.to];
  const [terraformDiff, recordFiles, migrationFiles] = await Promise.all([
    git("diff", "--unified=0", "--find-renames", "--no-color", ...range, "--", "*.tf"),
    git("diff", "--name-only", "--find-renames", ...range, "--", recordSchemaPath),
    git("diff", "--name-only", "--diff-filter=AM", ...range, "--", deployMigrationPathspec),
  ]);
  const moved = [...addedMovedBlocks(terraformDiff)]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([file, count]) => ({ count, file, kind: "terraform-moved" }) satisfies CompatibilityReason,
    );
  const records = recordFiles
    .split("\n")
    .filter((file) => file !== "")
    .toSorted()
    .map((file) => ({ file, kind: "record-schema" }) satisfies CompatibilityReason);
  const migrations = migrationFiles
    .split("\n")
    .filter((file) => file !== "")
    .map((file) => basename(file, "-migration.ts"))
    .toSorted()
    .map((name) => ({ kind: "deploy-migration", name }) satisfies CompatibilityReason);
  return [...moved, ...records, ...migrations];
}
