import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".output",
  ".terraform",
  ".worktrees",
  "dist",
  "node_modules",
]);

const PRODUCTION_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".hcl",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".tf",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const DYNAMODB_SCAN = /\bScanCommand\b|["'](?:dynamodb:)?Scan["']|\.(?:scan|scanRecords)\s*\(/u;

function productionFiles(path: string): readonly string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : productionFiles(child);
    }
    if (!PRODUCTION_EXTENSIONS.has(extname(entry.name)) || entry.name.endsWith(".test.ts")) {
      return [];
    }
    return [child];
  });
}

describe("DynamoDB scan prohibition", () => {
  test("keeps scans out of production code and IAM policies", () => {
    const matches = productionFiles(".")
      .filter((path) => DYNAMODB_SCAN.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path))
      .toSorted();

    expect(matches).toEqual([]);
  });
});
