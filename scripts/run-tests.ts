// One `bun test` process holds a directory handle for every module directory it resolves. Across the
// whole repository that passes 10,000 open descriptors on macOS, and past about 10,240 the pipes of
// `Bun.spawnSync` children stop working. Each part below covers a part of the tree in its own process;
// `--part <name>` runs one of them, which is how CI spreads the parts across jobs.
//
// Each run spreads its files over one worker per core. As in a serial `bun test`, the files a worker
// runs share one module registry and global object; `--parallel` alone would give every file a fresh
// one, which costs about twice the time. Which files share a worker varies from run to run, so a
// test file must undo what it changes before it ends: spies, fake timers, `process.env`, and globals
// such as `fetch`. Lint forbids `mock.module` in test files, since no restore undoes it.
const sharedWorkers = ["--parallel", "--no-isolate"];
const ignored = ["apps/docs/out/**", "dist/**"];
const directories = ["functions/worker", "apps", "packages"];

const ignoreFlags = (patterns: readonly string[]) =>
  patterns.flatMap((pattern) => ["--path-ignore-patterns", pattern]);

const parts: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    directories.map((directory) => [directory, [`./${directory}`, ...ignoreFlags(ignored)]]),
  ),
  rest: ignoreFlags([...ignored, ...directories.map((directory) => `${directory}/**`)]),
};

function selectedRuns(args: readonly string[]): readonly (readonly string[])[] {
  if (args.length === 0) return Object.values(parts);
  if (args[0] !== "--part") return [[...args, ...ignoreFlags(ignored)]];
  const run = args.length === 2 ? parts[args[1]!] : undefined;
  if (!run) {
    console.error(`Usage: bun scripts/run-tests.ts --part <${Object.keys(parts).join("|")}>`);
    process.exit(2);
  }
  return [run];
}

let failed = 0;
for (const run of selectedRuns(process.argv.slice(2))) {
  const args = [...sharedWorkers, ...run];
  console.log(`\n$ bun test ${args.join(" ")}`);
  const child = Bun.spawnSync(["bun", "test", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (child.exitCode !== 0) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
