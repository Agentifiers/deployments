import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readTerraformFiles(directory: string, prefix: string) {
  return readdirSync(directory)
    .filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith(".tf"))
    .sort()
    .map((fileName) => readFileSync(join(directory, fileName), "utf8"))
    .join("\n");
}

export function terraformFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith(".") ? [] : terraformFilesUnder(path);
    return entry.name.endsWith(".tf") ? [path] : [];
  });
}

export function blockAt(source: string, start: number) {
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unbalanced block at offset ${start}.`);
}

export function block(source: string, header: string) {
  const start = source.indexOf(`${header} {`);
  if (start === -1) throw new Error(`Missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

export function attribute(source: string, name: string) {
  return new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "mu").exec(source)?.[1];
}

export function statements(document: string) {
  return [...document.matchAll(/^ {2}statement \{\n([\s\S]*?)^ {2}\}$/gmu)].map(
    (match) => match[1] ?? "",
  );
}

export function listAttribute(source: string, name: string) {
  const list = new RegExp(`^\\s*${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "mu").exec(source)?.[1];
  if (list === undefined) throw new Error(`Missing ${name}`);
  return [...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}
