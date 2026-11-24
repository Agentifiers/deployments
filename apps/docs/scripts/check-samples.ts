import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createProcessor } from "@mdx-js/mdx";
import { applyMdxPreset } from "fumadocs-mdx/config";
import type { Code, Nodes } from "mdast";
import { listHandWrittenPages, splitFrontmatter } from "./checks/hand-written-pages.ts";
import {
  CONTINUES_FENCE_META,
  locateInModule,
  moduleSource,
  operationSampleModules,
  pageSampleModules,
  parseTscOutput,
  type SampleModule,
  type SampleProblem,
} from "./checks/typescript-samples.ts";
import { readCliTree } from "./reference/cli-tree.ts";
import { buildDocsOpenApi } from "./reference/openapi-document.ts";
import { buildOperations } from "./reference/operations.ts";
import { DOCS_APP_DIRECTORY } from "./reference/urls.ts";

const SDK_DIRECTORY = join(DOCS_APP_DIRECTORY, "..", "..", "packages", "sdk");
const STAGED_SDK_PACKAGE_DIRECTORY = join(SDK_DIRECTORY, "dist", "package");
const TSC = join(DOCS_APP_DIRECTORY, "node_modules", ".bin", "tsc");
const SAMPLE_FILE = /(?:^|[\\/])sample-(\d+)\.tsx?$/u;
const COMPILER_OPTIONS = {
  jsx: "react-jsx",
  lib: ["ES2024", "DOM", "DOM.Iterable"],
  module: "nodenext",
  moduleDetection: "force",
  moduleResolution: "nodenext",
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: "ES2024",
  types: ["node"],
};

async function run(command: readonly string[], cwd: string) {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

function codeBlocks(node: Nodes): Code[] {
  if (node.type === "code") return [node];
  const children: readonly Nodes[] = "children" in node ? node.children : [];
  return children.flatMap(codeBlocks);
}

function formatProblem(problem: SampleProblem): string {
  if (problem.kind === "fence") {
    const { origin } = problem;
    return `${relative(process.cwd(), origin.file)}:${origin.firstLine - 1}:${origin.fenceIndent + 1}: ${problem.message}`;
  }
  const { origin } = problem;
  switch (origin.kind) {
    case "page":
      return `${relative(process.cwd(), origin.file)}:${origin.firstLine + problem.line - 1}:${origin.fenceIndent + problem.column}: ${problem.message}`;
    case "operation":
      return `generated ${origin.operationId} SDK sample:${problem.line}:${problem.column}: ${problem.message}`;
    default: {
      const exhaustive: never = origin;
      return exhaustive;
    }
  }
}

const started = performance.now();
const sdkBuild = await run([process.execPath, "run", "build"], SDK_DIRECTORY);
if (sdkBuild.exitCode !== 0) {
  console.error(sdkBuild.output);
  console.error("Building @agentifiers/deployments-sdk failed, so no sample was checked.");
  process.exit(1);
}

const generated = operationSampleModules(buildDocsOpenApi(buildOperations(await readCliTree())));
const processor = createProcessor(await applyMdxPreset({})("bundler"));
const handWritten: SampleModule[] = [];
const problems: SampleProblem[] = [];
let pagesWithSamples = 0;
for (const file of listHandWrittenPages()) {
  const { bodyAtFileLines } = splitFrontmatter(await Bun.file(file).text());
  let blocks: Code[];
  try {
    blocks = codeBlocks(processor.parse({ value: bodyAtFileLines, path: file }));
  } catch {
    problems.push({
      kind: "code",
      origin: { kind: "page", file, firstLine: 1, fenceIndent: 0 },
      line: 1,
      column: 1,
      message: "MDX does not parse, so its samples were not checked. Run check:content.",
    });
    continue;
  }
  const page = pageSampleModules(file, blocks);
  if (page.modules.length > 0) pagesWithSamples += 1;
  handWritten.push(...page.modules);
  problems.push(...page.problems);
}

const modules = [...generated, ...handWritten];
const files = modules.map((module, index) => ({
  name: `sample-${index}${module.extension}`,
  module,
}));
const directory = await realpath(await mkdtemp(join(tmpdir(), "docs-samples-")));
const unlocated: string[] = [];
try {
  await mkdir(join(directory, "node_modules", "@agentifiers"), { recursive: true });
  await mkdir(join(directory, "node_modules", "@types"), { recursive: true });
  await Promise.all([
    symlink(
      STAGED_SDK_PACKAGE_DIRECTORY,
      join(directory, "node_modules", "@agentifiers", "deployments-sdk"),
    ),
    ...["node", "react"].map((name) =>
      symlink(
        dirname(Bun.resolveSync(`@types/${name}/package.json`, DOCS_APP_DIRECTORY)),
        join(directory, "node_modules", "@types", name),
      ),
    ),
    Bun.write(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" })),
    Bun.write(
      join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: COMPILER_OPTIONS, files: files.map(({ name }) => name) }),
    ),
    ...files.map(({ name, module }) => Bun.write(join(directory, name), moduleSource(module))),
  ]);
  const tsc = await run(
    [TSC, "-p", join(directory, "tsconfig.json"), "--pretty", "false"],
    directory,
  );
  const { diagnostics, unparsed } = parseTscOutput(tsc.output);
  unlocated.push(...unparsed);
  for (const diagnostic of diagnostics) {
    const index = SAMPLE_FILE.exec(diagnostic.file)?.[1];
    const module = index === undefined ? undefined : modules[Number(index)];
    if (module) {
      problems.push({
        kind: "code",
        ...locateInModule(module, diagnostic.line, diagnostic.column),
        message: diagnostic.message,
      });
    } else {
      unlocated.push(
        `${diagnostic.file}(${diagnostic.line},${diagnostic.column}): ${diagnostic.message}`,
      );
    }
  }
  if (tsc.exitCode !== 0 && diagnostics.length === 0 && unlocated.length === 0) {
    unlocated.push(`tsc exited with code ${tsc.exitCode} without a diagnostic.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

const blockCount = handWritten.reduce((count, module) => count + module.samples.length, 0);
const summary = `${generated.length} generated SDK samples and ${blockCount} TypeScript blocks on ${pagesWithSamples} hand-written pages against ${relative(process.cwd(), STAGED_SDK_PACKAGE_DIRECTORY)} in ${Math.round(performance.now() - started)} ms`;

for (const line of problems
  .map(formatProblem)
  .toSorted((left, right) => left.localeCompare(right, "en", { numeric: true }))) {
  console.error(line);
}
for (const line of unlocated) console.error(line);
if (problems.length > 0 || unlocated.length > 0) {
  console.error(
    `\n${problems.length + unlocated.length} problem(s) type-checking ${summary}.\n` +
      `Each \`\`\`ts block must compile on its own. A block that builds on the TypeScript block before it on the page opens with \`\`\`ts ${CONTINUES_FENCE_META} and compiles appended to it. Generated samples come from scripts/reference/samples.ts.`,
  );
  process.exit(1);
}
console.log(`Type-checked ${summary}.`);
