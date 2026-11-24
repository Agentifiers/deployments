import { commandCatalog } from "@agentifiers/deployments-cli/catalog";
import { createRootCommand } from "@agentifiers/deployments-cli/commands";
import type { ActionSpec } from "@agentifiers/deployments-cli";
import type { ArgDef, ArgsDef, CommandDef, CommandMeta, Resolvable, SubCommandsDef } from "citty";

export const CLI_BINARY = "deployments";

export interface CliArgument {
  readonly name: string;
  readonly kind: "boolean" | "enum" | "positional" | "string";
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly valueHint?: string;
  readonly options?: readonly string[];
}

export interface CliActionMetadata {
  readonly method: ActionSpec["method"];
  readonly path: string;
  readonly scope: ActionSpec["scope"];
  readonly output: ActionSpec["output"];
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly requiresExplicitIdempotencyKey: boolean;
  readonly sensitiveOutput: boolean;
  readonly paginated: boolean;
}

interface CliNodeBase {
  readonly path: readonly [string, ...string[]];
  readonly command: string;
  readonly summary: string;
  readonly aliases: readonly string[];
}

export interface CliGroup extends CliNodeBase {
  readonly kind: "group";
}

export interface CliCommand extends CliNodeBase {
  readonly kind: "command";
  readonly arguments: readonly CliArgument[];
  readonly action?: CliActionMetadata;
}

export interface CliTree {
  readonly description: string;
  readonly version: string;
  readonly groups: readonly CliGroup[];
  readonly commands: readonly CliCommand[];
  readonly globalArguments: readonly CliArgument[];
}

async function resolved<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

function toArgument(name: string, definition: ArgDef): CliArgument {
  const alias = "alias" in definition ? definition.alias : undefined;
  const defaultValue = definition.default;
  return {
    name,
    kind: definition.type ?? "string",
    required: definition.required === true,
    description: definition.description ?? "",
    aliases: alias === undefined ? [] : [alias].flat(),
    ...(defaultValue === undefined ? {} : { defaultValue: String(defaultValue) }),
    ...(definition.valueHint ? { valueHint: definition.valueHint } : {}),
    ...("options" in definition && definition.options ? { options: definition.options } : {}),
  };
}

function catalogActions(): ReadonlyMap<string, ActionSpec> {
  const actions = new Map<string, ActionSpec>();
  for (const [resourceName, resource] of Object.entries(commandCatalog)) {
    const prefix = resource.namespace
      ? [resource.namespace.name, resource.namespace.command]
      : [resourceName];
    for (const [actionName, spec] of Object.entries(resource.actions)) {
      actions.set([...prefix, actionName].join(" "), spec);
    }
  }
  return actions;
}

function actionMetadata(spec: ActionSpec): CliActionMetadata {
  return {
    method: spec.method,
    path: spec.path,
    scope: spec.scope,
    output: spec.output,
    destructive: spec.destructive === true,
    idempotent: spec.idempotent === true,
    requiresExplicitIdempotencyKey: spec.requiresExplicitIdempotencyKey === true,
    sensitiveOutput: spec.sensitiveOutput === true || (spec.sensitiveOutputFields?.length ?? 0) > 0,
    paginated:
      spec.pagination !== false && (spec.output === "list" || spec.pagination !== undefined),
  };
}

export async function readCliTree(): Promise<CliTree> {
  const root = createRootCommand({
    io: { stdout: () => undefined, stderr: () => undefined, isInteractive: false },
    env: { NODE_ENV: "production" },
  });
  const actions = catalogActions();
  const groups: CliGroup[] = [];
  const commands: CliCommand[] = [];

  async function visit(definition: CommandDef<ArgsDef>, path: readonly [string, ...string[]]) {
    const meta: CommandMeta = (await resolved(definition.meta)) ?? {};
    const subCommands: SubCommandsDef = (await resolved(definition.subCommands)) ?? {};
    const base = {
      path,
      command: [CLI_BINARY, ...path].join(" "),
      summary: meta.description ?? "",
      aliases: meta.alias === undefined ? [] : [meta.alias].flat(),
    };
    const children = Object.entries(subCommands);
    if (children.length > 0) {
      groups.push({ kind: "group", ...base });
      for (const [name, child] of children) {
        const childDefinition = await resolved(child);
        if (!childDefinition)
          throw new Error(`CLI command ${base.command} ${name} did not resolve.`);
        await visit(childDefinition, [...path, name]);
      }
      return;
    }
    const args: ArgsDef = (await resolved(definition.args)) ?? {};
    const spec = actions.get(path.join(" "));
    commands.push({
      kind: "command",
      ...base,
      arguments: Object.entries(args).map(([name, argument]) => toArgument(name, argument)),
      ...(spec ? { action: actionMetadata(spec) } : {}),
    });
  }

  const rootMeta: CommandMeta = (await resolved(root.meta)) ?? {};
  const topLevel: SubCommandsDef = (await resolved(root.subCommands)) ?? {};
  for (const [name, child] of Object.entries(topLevel)) {
    const childDefinition = await resolved(child);
    if (!childDefinition) throw new Error(`CLI command ${CLI_BINARY} ${name} did not resolve.`);
    await visit(childDefinition, [name]);
  }

  const missingActions = [...actions.keys()].filter(
    (path) => !commands.some((command) => command.path.join(" ") === path),
  );
  if (missingActions.length > 0) {
    throw new Error(`Catalog actions missing from the CLI tree: ${missingActions.join(", ")}`);
  }

  const catalogCommands = commands.filter((command) => command.action);
  const [first, ...rest] = catalogCommands;
  if (!first) throw new Error("The CLI tree contains no catalog actions.");
  const globalArguments = first.arguments
    .filter((argument) =>
      rest.every((command) =>
        command.arguments.some((candidate) => candidate.name === argument.name),
      ),
    )
    .map((argument) => {
      const definitions = new Map<string, { argument: CliArgument; count: number }>();
      for (const command of catalogCommands) {
        const candidate = command.arguments.find(({ name }) => name === argument.name);
        if (!candidate) continue;
        const key = JSON.stringify(candidate);
        const entry = definitions.get(key) ?? { argument: candidate, count: 0 };
        definitions.set(key, { argument: candidate, count: entry.count + 1 });
      }
      return [...definitions.values()].reduce((best, entry) =>
        entry.count > best.count ? entry : best,
      ).argument;
    });
  return {
    description: rootMeta.description ?? "",
    version: rootMeta.version ?? "",
    groups,
    commands,
    globalArguments,
  };
}

export function acceptsGlobalArguments(
  command: CliCommand,
  globals: readonly CliArgument[],
): boolean {
  return globals.every((global) => command.arguments.some(({ name }) => name === global.name));
}

export function ownArguments(
  command: CliCommand,
  globals: readonly CliArgument[],
): readonly CliArgument[] {
  if (!acceptsGlobalArguments(command, globals)) return command.arguments;
  const globalDefinitions = new Set(globals.map((global) => JSON.stringify(global)));
  return command.arguments.filter((argument) => !globalDefinitions.has(JSON.stringify(argument)));
}
