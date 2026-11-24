import type { DocsManifest, ManifestCommand } from "../reference/manifest.ts";

export interface CodeProblem {
  readonly line: number;
  readonly message: string;
}

interface CommandNode {
  readonly command: ManifestCommand | undefined;
  readonly children: Map<string, CommandNode>;
}

const SHELL_OPERATORS = new Set(["|", "||", "&&", ";"]);
const UNIVERSAL_FLAGS = new Set(["help", "h"]);
const ROOT_FLAGS = new Set(["help", "h", "version", "v"]);

export function buildCommandTree(manifest: DocsManifest): CommandNode {
  const root: CommandNode = { command: undefined, children: new Map() };
  const nodes = new Map<string, CommandNode>([["", root]]);
  const byDepth = manifest.cliCommands.toSorted(
    (left, right) => left.path.length - right.path.length,
  );
  for (const command of byDepth) {
    const parent = nodes.get(command.path.slice(0, -1).join(" "));
    const name = command.path.at(-1);
    if (!parent || name === undefined)
      throw new Error(`Manifest command ${command.command} has no parent.`);
    const node: CommandNode = { command, children: new Map() };
    nodes.set(command.path.join(" "), node);
    for (const key of [name, ...command.aliases]) parent.children.set(key, node);
  }
  return root;
}

function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"') current += line.charAt(++index);
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\") {
      current += line.charAt(++index);
      started = true;
    } else if (
      /\s/u.test(character) ||
      character === "|" ||
      character === "&" ||
      character === ";"
    ) {
      if (started) words.push(current);
      current = "";
      started = false;
      if (character !== " " && character !== "\t") {
        const doubled = line.charAt(index + 1) === character && character !== ";";
        words.push(doubled ? character + character : character);
        if (doubled) index += 1;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

function flagProblem(word: string, command: ManifestCommand): string | undefined {
  if (word.startsWith("--")) {
    const name = word.slice(2).split("=")[0] ?? "";
    if (UNIVERSAL_FLAGS.has(name)) return undefined;
    const known = command.flags.some(
      (flag) =>
        flag.name === name ||
        flag.aliases.includes(name) ||
        (flag.negatable && name === `no-${flag.name}`),
    );
    return known ? undefined : `\`${command.command}\` has no flag --${name}.`;
  }
  const shortNames = word.slice(1).split("=")[0] ?? "";
  for (const short of shortNames) {
    if (UNIVERSAL_FLAGS.has(short)) continue;
    if (!command.flags.some((flag) => flag.aliases.includes(short))) {
      return `\`${command.command}\` has no flag -${short}.`;
    }
  }
  return undefined;
}

function segmentProblems(words: readonly string[], tree: CommandNode): string[] {
  let node = tree;
  let index = 1;
  for (; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word.startsWith("-")) break;
    const child = node.children.get(word);
    if (!child) break;
    node = child;
  }
  const rest = words.slice(index);
  const isFlag = (word: string) => word.startsWith("-") && word !== "--" && !/^-\d/u.test(word);
  const command = node.command;
  if (!command || !command.leaf) {
    const label = ["deployments", ...(command?.path ?? [])].join(" ");
    const [next] = rest;
    if (next !== undefined && !isFlag(next)) return [`Unknown command \`${label} ${next}\`.`];
    const allowed = command ? UNIVERSAL_FLAGS : ROOT_FLAGS;
    return rest
      .filter(isFlag)
      .map((word) => word.replace(/^-+/u, "").split("=")[0] ?? "")
      .filter((name) => !allowed.has(name))
      .map(
        (name) =>
          `\`${label}\` is a command group; it accepts no flag ${name.length === 1 ? "-" : "--"}${name}.`,
      );
  }
  const endOfOptions = rest.indexOf("--");
  return (endOfOptions === -1 ? rest : rest.slice(0, endOfOptions))
    .filter(isFlag)
    .flatMap((word) => flagProblem(word, command) ?? []);
}

export function cliUsageProblems(code: string, tree: CommandNode): CodeProblem[] {
  const problems: CodeProblem[] = [];
  const lines = code.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    let logical = lines[start] ?? "";
    let end = start;
    while (logical.trimEnd().endsWith("\\") && end + 1 < lines.length) {
      end += 1;
      logical = `${logical.trimEnd().slice(0, -1)} ${lines[end] ?? ""}`;
    }
    const words = shellWords(logical.replace(/^\s*\$\s+/u, ""));
    let segment: string[] = [];
    for (const word of [...words, ";"]) {
      if (!SHELL_OPERATORS.has(word)) {
        segment.push(word);
        continue;
      }
      if (segment[0] === "deployments") {
        for (const message of segmentProblems(segment, tree))
          problems.push({ line: start + 1, message });
      }
      segment = [];
    }
    start = end;
  }
  return problems;
}
