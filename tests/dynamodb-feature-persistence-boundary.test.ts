import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const LOW_LEVEL_DATABASE_CALL =
  /\.(?:getRecord|putRecord|deleteRecord|queryRecords|scanRecords|transactWrite|transactWriteForErasure|transactGet|batchWrite|batchGet)\s*(?:\?\.)?\s*\(/u;
const DYNAMODB_COMMAND =
  /new\s+(?:GetItem|PutItem|UpdateItem|DeleteItem|Get|Put|Update|Delete|Query|Scan|BatchGet|BatchWrite|TransactGet|TransactWrite)Command\s*\(/u;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".terraform",
  ".worktrees",
  "dist",
  "node_modules",
  "scripts",
  "tests",
]);

function productionTypescriptFiles(path: string): readonly string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const normalized = relative(process.cwd(), child);
      if (EXCLUDED_DIRECTORIES.has(entry.name) || normalized === "packages/db") return [];
      return productionTypescriptFiles(child);
    }
    if (extname(entry.name) !== ".ts" || entry.name.endsWith(".test.ts")) return [];
    return [child];
  });
}

function matchingFiles(pattern: RegExp) {
  return productionTypescriptFiles(".")
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(process.cwd(), path))
    .toSorted();
}

describe("DynamoDB feature persistence boundary", () => {
  test("keeps all production DynamoDB persistence in packages/db", () => {
    expect(matchingFiles(LOW_LEVEL_DATABASE_CALL)).toEqual([]);
    expect(matchingFiles(DYNAMODB_COMMAND)).toEqual([]);
  });
});
