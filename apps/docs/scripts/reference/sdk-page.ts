import { RELEASE_ENTRY_EXPORTS } from "@agentifiers/deployments-sdk/release-entry";
import type { GeneratedPage } from "./cli-pages.ts";
import { frontmatter, table } from "./mdx.ts";
import type { DocumentedOperation } from "./operations.ts";
import { SDK_PACKAGE } from "./samples.ts";
import { cliCommandUrl, slugify } from "./urls.ts";

export function sdkReferencePage(operations: readonly DocumentedOperation[]): GeneratedPage {
  const tags = [...new Set(operations.map((operation) => operation.route.tag))].toSorted();
  const runtimeList = RELEASE_ENTRY_EXPORTS.map(
    (entry) => `\`${entry.name}\`${entry.typeOnly ? " (type)" : ""}`,
  ).join(", ");
  const sections = tags.flatMap((tag) => {
    const tagged = operations
      .filter((operation) => operation.route.tag === tag)
      .toSorted((left, right) => left.route.name.localeCompare(right.route.name));
    return [
      `## ${tag} [#${slugify(tag)}]`,
      "",
      table(
        ["Function", "Endpoint", "CLI"],
        tagged.map((operation) => [
          `[\`${operation.route.name}\`](${operation.url})`,
          `\`${operation.endpoint}\``,
          [...new Set(operation.cli)]
            .map((command) => `[\`${command.command}\`](${cliCommandUrl(command.path)})`)
            .join("<br />"),
        ]),
      ),
      "",
    ];
  });
  return {
    contentPath: "reference.mdx",
    content: [
      frontmatter({
        title: "Function reference",
        description: `Every operation function in ${SDK_PACKAGE}, with its endpoint and CLI command.`,
      }),
      `\`${SDK_PACKAGE}\` exports one function per public API operation (${operations.length} in total), named after the operation ID. Each function links to its API reference page, which shows the request and response schemas and a complete SDK example.`,
      "",
      `Besides the operation functions, the package exports ${runtimeList}.`,
      "",
      ...sections,
    ].join("\n"),
  };
}
