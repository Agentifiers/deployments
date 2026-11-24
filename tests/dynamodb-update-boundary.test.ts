import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const UPDATE_SEND = /\bUpdate(?:Item)?Command\b|\bupdateItem\s*\(/u;
const REQUEST_ADMISSION = join("packages", "db", "src", "request-admission");
const THIS_TEST = join("tests", "dynamodb-update-boundary.test.ts");
const NON_SOURCE_DIRECTORIES = new Set([
  ".git",
  ".terraform",
  ".worktrees",
  "dist",
  "node_modules",
]);
const PERSISTENCE_POLICY_EXEMPT_DIRECTORY = "scripts";
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".mts", ".ts", ".tsx"]);

function sourceFiles(path: string): readonly string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (
        NON_SOURCE_DIRECTORIES.has(entry.name) ||
        entry.name === PERSISTENCE_POLICY_EXEMPT_DIRECTORY ||
        relative(".", child) === REQUEST_ADMISSION
      ) {
        return [];
      }
      return sourceFiles(child);
    }
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [child] : [];
  });
}

describe("DynamoDB partial update boundary", () => {
  test("only the request-admission store sends UpdateItem", () => {
    const offenders = sourceFiles(".")
      .map((path) => relative(".", path))
      .filter((path) => path !== THIS_TEST && UPDATE_SEND.test(readFileSync(path, "utf8")))
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
