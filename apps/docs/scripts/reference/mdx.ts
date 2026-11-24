export function escapeMdxText(text: string): string {
  return text.replaceAll(/[\\{}<>|*_[\]]/gu, (character) => `\\${character}`);
}

export function frontmatter(fields: {
  readonly title: string;
  readonly description: string;
}): string {
  return [
    "---",
    `title: ${JSON.stringify(fields.title)}`,
    `description: ${JSON.stringify(fields.description)}`,
    "---",
    "",
  ].join("\n");
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

export function codeBlock(language: string, source: string): string {
  return ["```" + language, source.trimEnd(), "```"].join("\n");
}
