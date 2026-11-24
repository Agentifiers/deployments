import { PlatformApiError } from "@agentifiers/deployments-sdk";
import { renderUsage, runCommand, type ArgsDef, type CommandDef, type CommandMeta } from "citty";
import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import { createRootCommand, type CliRuntime } from "./commands.ts";
import { CliError, errorMessage, exitCodeForError, ExitCode } from "./errors.ts";
import { interactiveCommand } from "./interactive.ts";
import { sanitizeTerminalText } from "./output.ts";
import type { CliIo } from "./types.ts";
import { CLI_VERSION } from "./version.ts";

export interface RunCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: CliIo;
}

function defaultIo(): CliIo {
  return {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

/** Resolves once every write already queued on the stream has been handed to the OS. */
function drained(stream: NodeJS.WriteStream) {
  return new Promise<void>((resolve, reject) =>
    stream.write("", (cause) => (cause ? reject(cause) : resolve())),
  );
}

/**
 * Waits for buffered stdout and stderr before the process may exit. A pipe whose reader is slow
 * (a spawning test harness under load) otherwise receives only the first pipe buffer of a large
 * JSON document such as `catalog --json`.
 */
export async function flushCliOutput() {
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
}

async function resolved<T>(value: T | Promise<T> | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof value === "function" ? (value as () => T | Promise<T>)() : value;
}

async function helpTarget(
  root: CommandDef<any>,
  rawArgs: readonly string[],
): Promise<{ command: CommandDef<any>; parent?: CommandDef<any> }> {
  let command = root;
  const segments = ["deployments"];
  for (const token of rawArgs) {
    if (token.startsWith("-")) break;
    const subCommands = command.subCommands ? await resolved(command.subCommands) : undefined;
    if (!subCommands) break;
    if (!Object.hasOwn(subCommands, token)) {
      throw new CliError(`Unknown command: ${token}`, ExitCode.usage);
    }
    const next = await resolved(subCommands[token]!);
    segments.push(token);
    command = next;
  }
  if (command === root) return { command };
  const rootMeta = root.meta ? await resolved(root.meta) : {};
  const commandMeta = command.meta ? await resolved(command.meta) : {};
  const parentMeta: CommandMeta = {
    name: segments.slice(0, -1).join(" "),
    ...(rootMeta.version ? { version: rootMeta.version } : {}),
  };
  return {
    command: { ...command, meta: { ...commandMeta, name: segments.at(-1)! } },
    parent: { meta: parentMeta },
  };
}

async function findSubCommand(
  command: CommandDef<any>,
  token: string,
): Promise<CommandDef<any> | undefined> {
  const subCommands = command.subCommands ? await resolved(command.subCommands) : undefined;
  if (!subCommands) return undefined;
  if (Object.hasOwn(subCommands, token)) return resolved(subCommands[token]!);
  for (const candidate of Object.values(subCommands)) {
    const resolvedCandidate = await resolved(candidate);
    const meta = resolvedCandidate.meta ? await resolved(resolvedCandidate.meta) : {};
    const aliases = Array.isArray(meta.alias) ? meta.alias : meta.alias ? [meta.alias] : [];
    if (aliases.includes(token)) return resolvedCandidate;
  }
  return undefined;
}

function camelCase(value: string): string {
  return value.replaceAll(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

async function validateLeafArgs(command: CommandDef<any>, rawArgs: readonly string[]) {
  const argsDef = (command.args ? await resolved(command.args) : {}) as ArgsDef;
  const options = new Map<string, { takesValue: boolean }>();
  let positionalLimit = 0;
  for (const [name, definition] of Object.entries(argsDef)) {
    if (definition.type === "positional") {
      positionalLimit += 1;
      continue;
    }
    const takesValue = definition.type === "string" || definition.type === "enum";
    const longNames = new Set([name, camelCase(name)]);
    for (const longName of longNames) {
      options.set(`--${longName}`, { takesValue });
      if (definition.type === "boolean" && name !== "live" && name !== "mock") {
        options.set(`--no-${longName}`, { takesValue: false });
      }
    }
    const alias = "alias" in definition ? definition.alias : undefined;
    const aliases = Array.isArray(alias) ? alias : alias ? [alias] : [];
    for (const alias of aliases) options.set(`-${alias}`, { takesValue });
  }

  let positionals = 0;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index]!;
    if (token === "--") {
      positionals += rawArgs.length - index - 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals += 1;
      continue;
    }
    const separator = token.indexOf("=");
    const optionName = separator >= 0 ? token.slice(0, separator) : token;
    const option = options.get(optionName);
    if (!option) throw new CliError(`Unknown option: ${optionName}`, ExitCode.usage);
    if (!option.takesValue && separator >= 0) {
      throw new CliError(`Boolean option does not accept a value: ${optionName}`, ExitCode.usage);
    }
    if (option.takesValue && separator < 0) {
      const next = rawArgs[index + 1];
      if (next === undefined) {
        throw new CliError(`Missing value for option: ${optionName}`, ExitCode.usage);
      }
      if (/^--?[a-z][a-z0-9-]*$/iu.test(next)) {
        throw new CliError(
          `Missing value for option: ${optionName}. Use ${optionName}=<value> for option-shaped values.`,
          ExitCode.usage,
        );
      }
      index += 1;
    }
  }
  if (positionals > positionalLimit) {
    throw new CliError("Too many positional arguments.", ExitCode.usage);
  }
}

async function validateInvocation(root: CommandDef<any>, rawArgs: readonly string[]) {
  let command = root;
  let index = 0;
  while (command.subCommands) {
    const token = rawArgs[index];
    if (!token) return;
    if (token.startsWith("-")) {
      throw new CliError(`Unknown option before command: ${token}`, ExitCode.usage);
    }
    const next = await findSubCommand(command, token);
    if (!next) throw new CliError(`Unknown command: ${token}`, ExitCode.usage);
    command = next;
    index += 1;
  }
  await validateLeafArgs(command, rawArgs.slice(index));
}

async function helpRequested(root: CommandDef<any>, rawArgs: readonly string[]): Promise<boolean> {
  let command = root;
  let index = 0;
  while (command.subCommands) {
    const token = rawArgs[index];
    if (!token) return false;
    if (token === "--help" || token === "-h") return true;
    if (token.startsWith("-")) return false;
    const next = await findSubCommand(command, token);
    if (!next) return false;
    command = next;
    index += 1;
  }

  const argsDef = (command.args ? await resolved(command.args) : {}) as ArgsDef;
  const valueOptions = new Set<string>();
  for (const [name, definition] of Object.entries(argsDef)) {
    if (definition.type !== "string" && definition.type !== "enum") continue;
    valueOptions.add(`--${name}`);
    valueOptions.add(`--${camelCase(name)}`);
    const alias = "alias" in definition ? definition.alias : undefined;
    for (const item of Array.isArray(alias) ? alias : alias ? [alias] : []) {
      valueOptions.add(`-${item}`);
    }
  }
  for (; index < rawArgs.length; index += 1) {
    const token = rawArgs[index]!;
    if (token === "--help" || token === "-h") return true;
    const optionName = token.split("=", 1)[0]!;
    if (valueOptions.has(optionName) && !token.includes("=")) index += 1;
  }
  return false;
}

export async function runCli(
  rawArgs: readonly string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo();
  const runtime: CliRuntime = { io, env: options.env ?? process.env };
  let args = [...rawArgs];
  try {
    if (rawArgs.length === 0 && io.isInteractive) args = await interactiveCommand(io);
    const root = createRootCommand(runtime);
    if (args.length === 0 || (await helpRequested(root, args))) {
      const target = await helpTarget(root, args);
      const usage = await renderUsage(target.command, target.parent);
      io.stdout(
        args.includes("--no-color") || runtime.env.NO_COLOR
          ? stripVTControlCharacters(usage)
          : usage,
      );
      return ExitCode.success;
    }
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
      io.stdout(CLI_VERSION);
      return ExitCode.success;
    }
    await validateInvocation(root, args);
    await runCommand(root, { rawArgs: args, showUsage: true });
    return ExitCode.success;
  } catch (error) {
    const exitCode = exitCodeForError(error);
    const requestId = error instanceof PlatformApiError ? error.problem.requestId : undefined;
    const safeErrorMessage =
      error instanceof PlatformApiError ? error.problem.title : errorMessage(error);
    const message = sanitizeTerminalText(
      `${safeErrorMessage}${requestId ? ` (request ${requestId})` : ""}`,
    );
    const noColor = Boolean(runtime.env.NO_COLOR || args.includes("--no-color"));
    io.stderr(noColor ? `Error: ${message}` : `${pc.red("Error:")} ${message}`);
    return exitCode;
  }
}
