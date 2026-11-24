import type { CliActionMetadata, CliArgument, CliCommand, CliTree } from "./cli-tree.ts";
import { CLI_BINARY, acceptsGlobalArguments, ownArguments } from "./cli-tree.ts";
import { codeBlock, escapeMdxText, frontmatter, table } from "./mdx.ts";
import type { DocumentedOperation } from "./operations.ts";
import { cliExample } from "./samples.ts";
import { cliCommandAnchor, cliPageUrl } from "./urls.ts";

export interface GeneratedPage {
  readonly contentPath: string;
  readonly content: string;
}

const SCOPE_REQUIREMENT: Readonly<Record<CliActionMetadata["scope"], string>> = {
  none: "No tenancy context required.",
  organization: "Needs an organization: `--org` or the saved context.",
  project: "Needs a project: `--project` or the saved context.",
  environment: "Needs an environment: `--env` or the saved context.",
  tenant:
    "Needs an organization, project, and environment: `--org`, `--project`, `--env`, or the saved context.",
};

function flagLabel(argument: CliArgument): string {
  if (argument.kind === "positional") return `\`<${argument.name}>\``;
  const aliases = argument.aliases.map((alias) => `\`-${alias.length === 1 ? "" : "-"}${alias}\``);
  const negation =
    argument.kind === "boolean" && argument.defaultValue === "true"
      ? [`\`--no-${argument.name}\``]
      : [];
  return [`\`--${argument.name}\``, ...aliases, ...negation].join(", ");
}

function typeLabel(argument: CliArgument): string {
  if (argument.kind === "enum")
    return (argument.options ?? []).map((option) => `\`${option}\``).join(" \\| ");
  if (argument.kind === "boolean" || argument.kind === "positional") return argument.kind;
  return argument.valueHint ? `string (\`${escapeMdxText(argument.valueHint)}\`)` : "string";
}

export function argumentTable(arguments_: readonly CliArgument[]): string {
  return table(
    ["Flag", "Type", "Required", "Default", "Description"],
    arguments_.map((argument) => [
      flagLabel(argument),
      typeLabel(argument),
      argument.required ? "yes" : "",
      argument.defaultValue === undefined ? "" : `\`${escapeMdxText(argument.defaultValue)}\``,
      escapeMdxText(argument.description),
    ]),
  );
}

function actionNotes(action: CliActionMetadata): readonly string[] {
  const notes: string[] = [SCOPE_REQUIREMENT[action.scope]];
  if (action.destructive) {
    notes.push(
      "Destructive. Live runs ask for confirmation; pass `--yes` in scripts or with `--json`.",
    );
  }
  if (action.requiresExplicitIdempotencyKey) {
    notes.push("Requires `--idempotency-key`; reuse the same key when you retry.");
  } else if (action.idempotent) {
    notes.push(
      "Sends an idempotency key. The CLI generates one per run; pass `--idempotency-key` to retry safely.",
    );
  }
  if (action.sensitiveOutput)
    notes.push("Output contains secrets. They are redacted unless you pass `--reveal`.");
  if (action.paginated) {
    notes.push(
      "Paginated. `--page-size` sets the page size; pass the returned cursor as `--cursor` for the next page.",
    );
  }
  if (action.output === "stream") {
    notes.push("Streams events as they arrive. With `--json`, each event prints as a JSON object.");
  }
  return notes;
}

function commandSection(
  command: CliCommand,
  tree: CliTree,
  operationsByCommand: ReadonlyMap<string, readonly DocumentedOperation[]>,
): string {
  const operations = operationsByCommand.get(command.command) ?? [];
  const calls = operations.map(
    (operation) =>
      `[\`${operation.endpoint}\`](${operation.url}) (SDK \`${operation.route.name}\`)`,
  );
  const notes = [
    ...(calls.length > 0 ? [`Calls ${calls.join(", ")}.`] : []),
    ...(command.action ? actionNotes(command.action) : []),
  ];
  const documented = ownArguments(command, tree.globalArguments);
  const globalsNote = acceptsGlobalArguments(command, tree.globalArguments)
    ? "Also accepts the [global flags](/docs/cli/reference/#global-flags)."
    : "Accepts only the flags listed here.";
  return [
    `## ${command.command} [#${cliCommandAnchor(command.path)}]`,
    "",
    `${escapeMdxText(command.summary)}${/[.!?]$/u.test(command.summary) ? "" : "."}`,
    "",
    codeBlock("bash", cliExample(command)),
    "",
    ...notes.map((note) => `- ${note}`),
    "",
    ...(documented.length > 0 ? [argumentTable(documented), ""] : []),
    globalsNote,
    "",
  ].join("\n");
}

function commandsByTopLevel(tree: CliTree): ReadonlyMap<string, readonly CliCommand[]> {
  const pages = new Map<string, CliCommand[]>();
  for (const command of tree.commands) {
    const commands = pages.get(command.path[0]) ?? [];
    commands.push(command);
    pages.set(command.path[0], commands);
  }
  return pages;
}

export function cliReferencePages(
  tree: CliTree,
  operations: readonly DocumentedOperation[],
): readonly GeneratedPage[] {
  const operationsByCommand = new Map<string, DocumentedOperation[]>();
  for (const operation of operations) {
    for (const command of new Set(operation.cli)) {
      const list = operationsByCommand.get(command.command) ?? [];
      list.push(operation);
      operationsByCommand.set(command.command, list);
    }
  }
  const pages = commandsByTopLevel(tree);
  const topLevelNames = [...pages.keys()].toSorted();
  const summaryOf = (name: string) =>
    tree.groups.find((group) => group.path.length === 1 && group.path[0] === name)?.summary ??
    pages.get(name)?.[0]?.summary ??
    "";

  const index: GeneratedPage = {
    contentPath: "index.mdx",
    content: [
      frontmatter({
        title: "Command reference",
        description: `Every \`${CLI_BINARY}\` command, generated from the CLI source.`,
      }),
      `Generated from the \`${CLI_BINARY}\` command tree (CLI ${tree.version}). Each page documents one top-level command and all of its subcommands.`,
      "",
      "## Global flags [#global-flags]",
      "",
      "Every resource command accepts these flags. A command page lists them again only when the command changes one.",
      "",
      argumentTable(tree.globalArguments),
      "",
      "## Commands [#commands]",
      "",
      table(
        ["Command", "Summary"],
        topLevelNames.map((name) => [
          `[\`${CLI_BINARY} ${name}\`](${cliPageUrl(name)})`,
          escapeMdxText(summaryOf(name)),
        ]),
      ),
      "",
    ].join("\n"),
  };

  const commandPages = topLevelNames.map((name): GeneratedPage => {
    const commands = pages.get(name) ?? [];
    return {
      contentPath: `${name}.mdx`,
      content: [
        frontmatter({ title: `${CLI_BINARY} ${name}`, description: summaryOf(name) }),
        ...(commands.length > 1
          ? [
              table(
                ["Command", "Summary"],
                commands.map((command) => [
                  `[\`${command.command}\`](#${cliCommandAnchor(command.path)})`,
                  escapeMdxText(command.summary),
                ]),
              ),
              "",
            ]
          : []),
        ...commands.map((command) => commandSection(command, tree, operationsByCommand)),
      ].join("\n"),
    };
  });

  const meta: GeneratedPage = {
    contentPath: "meta.json",
    content: `${JSON.stringify({ title: "Command reference", pages: ["index", ...topLevelNames] }, null, 2)}\n`,
  };
  return [index, ...commandPages, meta];
}
