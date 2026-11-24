import { join, sep } from "node:path";
import { CONTENT_DIRECTORY, GENERATED_CONTENT } from "../reference/urls.ts";

const GENERATED_FILES = Object.values(GENERATED_CONTENT).map((path) =>
  join(CONTENT_DIRECTORY, path),
);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

function isGenerated(file: string): boolean {
  return GENERATED_FILES.some(
    (generated) => file === generated || file.startsWith(`${generated}${sep}`),
  );
}

export function listHandWrittenPages(): readonly string[] {
  return Array.from(new Bun.Glob("**/*.mdx").scanSync({ cwd: CONTENT_DIRECTORY, absolute: true }))
    .filter((file) => !isGenerated(file))
    .toSorted();
}

export interface PageSource {
  readonly frontmatter: string | undefined;
  readonly bodyAtFileLines: string;
}

export function splitFrontmatter(source: string): PageSource {
  const match = FRONTMATTER.exec(source);
  if (!match) return { frontmatter: undefined, bodyAtFileLines: source };
  return {
    frontmatter: match[1] ?? "",
    bodyAtFileLines: "\n".repeat(match[0].split("\n").length - 1) + source.slice(match[0].length),
  };
}
