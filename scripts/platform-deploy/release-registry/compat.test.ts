import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CommandRunner, runCommand as runWithInheritedEnvironment } from "../process.ts";
import { compatibilityReasons } from "./compat.ts";
import { useTemporaryDirectories } from "./registry.fixture.ts";

const temporaryDirectory = useTemporaryDirectories();
// A git hook exports GIT_DIR and GIT_INDEX_FILE; inheriting them would make the scratch
// repositories below commit into the repository that runs the tests.
const scratchEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);
const runCommand: CommandRunner = (command, options = {}) =>
  runWithInheritedEnvironment(command, { ...options, env: scratchEnvironment });

async function commitFiles(repository: string, files: Readonly<Record<string, string>>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), content);
  }
  const git = [
    "git",
    "-C",
    repository,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
  ];
  await runCommand([...git, "add", "--all"]);
  await runCommand([...git, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "change"]);
  return (await runCommand([...git, "rev-parse", "HEAD"])).trim();
}

const resource = 'resource "aws_s3_bucket" "artifacts" {\n  bucket = "artifacts"\n}\n';
const moved = (from: string, to: string) => `moved {\n  from = ${from}\n  to   = ${to}\n}\n`;

describe("release compatibility reasons", () => {
  test("flags added moved blocks, record schema changes, and deploy migrations", async () => {
    const repository = temporaryDirectory();
    await runCommand(["git", "init", "--quiet", repository]);
    const before = await commitFiles(repository, {
      "infrastructure/modules/data/main.tf": resource,
      "packages/db/src/records/system.ts": "export const version = 1;\n",
      "scripts/platform-deploy/deployment.ts": "export {};\n",
    });
    const after = await commitFiles(repository, {
      "infrastructure/environments/customer/moves.tf": moved("module.a", "module.b"),
      "infrastructure/modules/data/main.tf": `${resource}${moved("aws_s3_bucket.a", "aws_s3_bucket.artifacts")}${moved("aws_s3_bucket.b", "aws_s3_bucket.c")}`,
      "infrastructure/modules/data/outputs.tf": 'output "name" {\n  value = "artifacts"\n}\n',
      "packages/db/src/records/system.ts": "export const version = 2;\n",
      "scripts/platform-deploy/installation-record-migration.test.ts": "export {};\n",
      "scripts/platform-deploy/installation-record-migration.ts": "export {};\n",
    });

    expect(
      await compatibilityReasons({ cwd: repository, from: before, run: runCommand, to: after }),
    ).toEqual([
      { count: 1, file: "infrastructure/environments/customer/moves.tf", kind: "terraform-moved" },
      { count: 2, file: "infrastructure/modules/data/main.tf", kind: "terraform-moved" },
      { file: "packages/db/src/records/system.ts", kind: "record-schema" },
      { kind: "deploy-migration", name: "installation-record" },
    ]);
    expect(
      await compatibilityReasons({ cwd: repository, from: after, run: runCommand, to: after }),
    ).toEqual([]);
  });

  test("does not count moved blocks a commit renames with their file or removes", async () => {
    const repository = temporaryDirectory();
    await runCommand(["git", "init", "--quiet", repository]);
    const before = await commitFiles(repository, {
      "infrastructure/environments/customer/moves.tf": moved("module.a", "module.b"),
      "infrastructure/modules/data/main.tf": `${resource}${moved("aws_s3_bucket.a", "aws_s3_bucket.artifacts")}`,
    });
    await runCommand([
      "git",
      "-C",
      repository,
      "mv",
      "infrastructure/modules/data/main.tf",
      "infrastructure/modules/data/storage.tf",
    ]);
    const after = await commitFiles(repository, {
      "infrastructure/environments/customer/moves.tf": "# moves applied\n",
    });

    expect(
      await compatibilityReasons({ cwd: repository, from: before, run: runCommand, to: after }),
    ).toEqual([]);
  });
});
