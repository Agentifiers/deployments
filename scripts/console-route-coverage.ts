import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PUBLIC_API_ROUTES } from "../packages/api-contract/src/product.ts";

interface Site {
  readonly file: string;
  readonly line: number;
}

export interface CallSite extends Site {
  readonly callee: string;
}

export interface NameSite extends Site {
  readonly name: string;
}

export interface RouteCallScan {
  readonly called: ReadonlySet<string>;
  readonly unresolved: readonly CallSite[];
  readonly outsideServer: readonly CallSite[];
  readonly unreached: readonly NameSite[];
}

const OPERATIONS = new Set<string>(PUBLIC_API_ROUTES.map((route) => route.name));
const STRING_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;
const IMPORT_LIST = /\bimport\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}/gu;
const ROUTE_ALIAS = /^\s*callRoute(?:Once)?\s+as\s+([\w$]+)\s*$/u;
const QUOTED_WORD = /(?<!<\s*)(["'`])(\w+)\1/gu;
const DEFINITION_FILES: Readonly<Record<string, true>> = {
  "server/hot-plane-queue.ts": true,
  "server/platform-api.ts": true,
};

const blank = (match: string) => match.replaceAll(/[^\n]/gu, " ");

function callPattern(code: string) {
  const aliases = [...code.matchAll(IMPORT_LIST)]
    .flatMap((clause) => clause[1]!.split(",").map((specifier) => ROUTE_ALIAS.exec(specifier)?.[1]))
    .filter((alias) => alias !== undefined)
    .map((alias) => String.raw`|(?<!\.\s*)${alias.replaceAll("$", "\\$")}`);
  return new RegExp(
    String.raw`(?<![\w$])(callRoute|callRouteOnce|hotPlane${aliases.join("")})\s*!?\s*(?:\?\.\s*)?(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*(?:(["'\x60])(\w+)\2(?:\s+as\s+const)?\s*[,)])?`,
    "gu",
  );
}

export async function scanRouteCalls(root: string): Promise<RouteCallScan> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.name.includes(".test."),
    )
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter((file) => DEFINITION_FILES[file] === undefined)
    .sort();
  const called = new Set<string>();
  const unresolved: CallSite[] = [];
  const outsideServer: CallSite[] = [];
  const named: NameSite[] = [];
  for (const file of files) {
    const text = (await readFile(path.join(root, file), "utf8")).replace(
      STRING_OR_COMMENT,
      (match, literal: string | undefined) => literal ?? blank(match),
    );
    const code = text.replace(STRING_OR_COMMENT, blank);
    const lineAt = (index: number) => text.slice(0, index).split("\n").length;
    const inServer = file.startsWith("server/");
    for (const match of text.matchAll(callPattern(code))) {
      const site = { callee: match[1]!, file, line: lineAt(match.index) };
      const name = match[3];
      if (name === undefined) unresolved.push(site);
      if (!inServer) outsideServer.push(site);
      else if (name !== undefined && code[match.index] !== " ") called.add(name);
    }
    if (!inServer) continue;
    for (const word of text.matchAll(QUOTED_WORD)) {
      const name = word[2]!;
      if (OPERATIONS.has(name)) named.push({ file, line: lineAt(word.index), name });
    }
  }
  const unreached = named.filter((site) => !called.has(site.name));
  return { called, outsideServer, unreached, unresolved };
}

export function checkProblems(scan: RouteCallScan): string[] {
  return [
    ...scan.unresolved.map(
      (site) => `${site.file}:${site.line} ${site.callee} needs a string-literal operation name`,
    ),
    ...scan.outsideServer.map(
      (site) => `${site.file}:${site.line} calls ${site.callee} outside src/server/`,
    ),
    ...scan.unreached.map(
      (site) => `${site.file}:${site.line} names ${site.name} but no counted call reaches it`,
    ),
  ];
}

if (import.meta.main) {
  const scan = await scanRouteCalls(path.join(import.meta.dir, "../apps/console/src"));
  const rows = PUBLIC_API_ROUTES.map((route) => ({
    covered: scan.called.has(route.name),
    method: route.method,
    name: route.name,
    path: route.path,
    tag: route.tag ?? "untagged",
  }));
  const covered = rows.filter((row) => row.covered).length;
  const byTag = Map.groupBy(rows, (row) => row.tag);
  const summary = [...byTag]
    .map(([tag, tagRows]) => ({
      covered: tagRows.filter((row) => row.covered).length,
      tag,
      total: tagRows.length,
    }))
    .sort((left, right) => right.total - right.covered - (left.total - left.covered));

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ rows, scan: { ...scan, called: [...scan.called] }, summary }));
  } else {
    console.log(`console calls ${covered}/${rows.length} public operations\n`);
    for (const { covered: tagCovered, tag, total } of summary) {
      console.log(`${tag.padEnd(32)} ${String(tagCovered).padStart(3)}/${total}`);
    }
    if (process.argv.includes("--uncovered")) {
      for (const [tag, tagRows] of byTag) {
        const missing = tagRows.filter((row) => !row.covered);
        if (missing.length === 0) continue;
        console.log(`\n## ${tag}`);
        for (const row of missing) console.log(`${row.method.padEnd(6)} ${row.path}  ${row.name}`);
      }
    }
  }

  if (process.argv.includes("--check")) {
    const problems = checkProblems(scan);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
  }
}
