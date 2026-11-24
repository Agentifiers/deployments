import type { GeneratedPage } from "./cli-pages.ts";
import { escapeMdxText, frontmatter, table } from "./mdx.ts";
import type { DocumentedOperation } from "./operations.ts";
import { slugify } from "./urls.ts";

export function apiReferenceIndexPage(operations: readonly DocumentedOperation[]): GeneratedPage {
  const tags = [...new Set(operations.map((operation) => operation.route.tag))].toSorted();
  const sections = tags.flatMap((tag) => [
    `## ${tag} [#${slugify(tag)}]`,
    "",
    table(
      ["Operation", "Endpoint"],
      operations
        .filter((operation) => operation.route.tag === tag)
        .toSorted((left, right) => left.summary.localeCompare(right.summary))
        .map((operation) => [
          `[${escapeMdxText(operation.summary)}](${operation.url})`,
          `\`${operation.endpoint}\``,
        ]),
    ),
    "",
  ]);
  return {
    contentPath: "index.mdx",
    content: [
      frontmatter({
        title: "API reference",
        description: "Every public API operation, grouped by area.",
      }),
      `The public API has ${operations.length} operations. Each page shows the request and response schemas, the authentication it takes, and curl, SDK, and CLI samples.`,
      "",
      ...sections,
    ].join("\n"),
  };
}
