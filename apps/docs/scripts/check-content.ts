import { relative, resolve, sep } from "node:path";
import { createProcessor } from "@mdx-js/mdx";
import { applyMdxPreset } from "fumadocs-mdx/config";
import type { Nodes } from "mdast";
import { docsComponents } from "../components/mdx.tsx";
import { buildCommandTree, cliUsageProblems, type CodeProblem } from "./checks/cli-usage.ts";
import { listHandWrittenPages, splitFrontmatter } from "./checks/hand-written-pages.ts";
import { sdkImportProblems } from "./checks/sdk-imports.ts";
import { findLeaks, loadVerticalNameDigests } from "./leak-guard.ts";
import { readManifest } from "./reference/manifest.ts";
import { CONTENT_DIRECTORY, normalizeDocsPath } from "./reference/urls.ts";

interface Problem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const SHELL_LANGUAGES = new Set(["", "bash", "console", "sh", "shell", "zsh"]);
const SCRIPT_LANGUAGES = new Set([
  "javascript",
  "js",
  "jsx",
  "mjs",
  "mts",
  "ts",
  "tsx",
  "typescript",
]);

function pageUrl(file: string): string {
  const segments = relative(CONTENT_DIRECTORY, file)
    .replace(/\.mdx$/u, "")
    .split(sep)
    .filter((segment) => !/^\(.+\)$/u.test(segment));
  if (segments.at(-1) === "index") segments.pop();
  return normalizeDocsPath(`/docs/${segments.join("/")}`);
}

function walk(node: Nodes, visit: (node: Nodes) => void) {
  visit(node);
  if ("children" in node) for (const child of node.children) walk(child, visit);
}

function frontmatterProblems(frontmatter: string | undefined): string[] {
  if (frontmatter === undefined) return ["Missing frontmatter with title and description."];
  const parsed: unknown = Bun.YAML.parse(frontmatter);
  const fields = typeof parsed === "object" && parsed !== null ? parsed : {};
  return (["title", "description"] as const).flatMap((field) => {
    const value = field in fields ? Reflect.get(fields, field) : undefined;
    return typeof value === "string" && value.trim().length > 0
      ? []
      : [`Frontmatter needs a non-empty \`${field}\`.`];
  });
}

const handWrittenPages = listHandWrittenPages();
const requested = process.argv.slice(2);
const files = requested.length > 0 ? requested.map((file) => resolve(file)) : handWrittenPages;

const manifest = await readManifest();
const commandTree = buildCommandTree(manifest);
const knownUrls = new Set([...manifest.urls, ...handWrittenPages.map(pageUrl)]);
const components = new Set(Object.keys(docsComponents));
const processor = createProcessor(await applyMdxPreset({})("bundler"));
const verticalNameDigests = await loadVerticalNameDigests();
const problems: Problem[] = [];

for (const file of files) {
  const report = (line: number, column: number, message: string) =>
    problems.push({ file: relative(process.cwd(), file), line, column, message });
  const source = await Bun.file(file).text();
  const { bodyAtFileLines, frontmatter } = splitFrontmatter(source);
  for (const message of frontmatterProblems(frontmatter)) report(1, 1, message);
  for (const leak of findLeaks(source, verticalNameDigests)) {
    report(
      leak.line,
      leak.column,
      leak.kind === "content-pending"
        ? `Replace the ${leak.match} placeholder with the page content.`
        : `Leak (${leak.kind}): \`${leak.match}\` must not be published.`,
    );
  }

  let tree: Nodes;
  try {
    tree = processor.parse({ value: bodyAtFileLines, path: file });
    await processor.process({ value: bodyAtFileLines, path: file });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [, line = "1", column = "1"] = /\((\d+):(\d+)(?:-\d+:\d+)?\)/u.exec(message) ?? [];
    report(Number(line), Number(column), `MDX does not compile: ${message}`);
    continue;
  }

  walk(tree, (node) => {
    const line = node.position?.start.line ?? 1;
    const column = node.position?.start.column ?? 1;
    const hrefs =
      node.type === "link" || node.type === "definition"
        ? [node.url]
        : node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement"
          ? node.attributes.flatMap((attribute) =>
              attribute.type === "mdxJsxAttribute" &&
              attribute.name === "href" &&
              typeof attribute.value === "string"
                ? [attribute.value]
                : [],
            )
          : [];
    for (const href of hrefs) {
      if (/^\/docs(?:[/?#]|$)/u.test(href) && !knownUrls.has(normalizeDocsPath(href))) {
        report(line, column, `Broken link \`${href}\`: no page has that URL.`);
      }
    }
    if ((node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") && node.name) {
      const name = node.name.split(".")[0] ?? node.name;
      if (/^[A-Z]/u.test(name) && !components.has(name)) {
        report(
          line,
          column,
          `Unknown component <${node.name}>. Registered: ${[...components].filter((key) => /^[A-Z]/u.test(key)).join(", ")}.`,
        );
      }
    }
    if (node.type === "code") {
      const language = (node.lang ?? "").toLowerCase();
      const codeProblems: CodeProblem[] = SHELL_LANGUAGES.has(language)
        ? cliUsageProblems(node.value, commandTree)
        : SCRIPT_LANGUAGES.has(language)
          ? sdkImportProblems(node.value, manifest)
          : [];
      for (const problem of codeProblems) report(line + problem.line, 1, problem.message);
    }
  });
}

const sorted = problems.toSorted(
  (left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column,
);
for (const problem of sorted) {
  console.error(`${problem.file}:${problem.line}:${problem.column}: ${problem.message}`);
}
if (problems.length > 0) {
  console.error(
    `\n${problems.length} problem(s) in ${new Set(problems.map((problem) => problem.file)).size} of ${files.length} file(s).`,
  );
  process.exit(1);
}
console.log(`${files.length} hand-written page(s) passed.`);
