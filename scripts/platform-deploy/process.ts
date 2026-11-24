import { resolve } from "node:path";

/** The platform checkout containing this tool, independent of the caller's working directory. */
export const repositoryRoot = resolve(import.meta.dir, "../..");

export type Environment = Readonly<Record<string, string | undefined>>;

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Environment;
  readonly input?: string;
  /** Stream child stdout to this process's stderr instead of capturing it. */
  readonly stream?: boolean;
  /** With `stream`, prefix every streamed line so concurrent commands stay readable. */
  readonly prefix?: string;
}

/** Runs a command and returns its captured stdout; rejects with a single-line error. */
export type CommandRunner = (command: readonly string[], options?: RunOptions) => Promise<string>;

export class CommandFailure extends Error {
  constructor(
    readonly stderr: string,
    command: readonly string[],
  ) {
    super(`${command.slice(0, 3).join(" ")} failed: ${singleLine(stderr) || "no error output"}`);
  }
}

export function singleLine(value: unknown) {
  return (value instanceof Error ? value.message : String(value)).replaceAll(/\s+/gu, " ").trim();
}

export function log(message: string) {
  process.stderr.write(`[deploy] ${message}\n`);
}

/**
 * The error, then each `cause` in its chain, as `<name>: <message>` the way Bun and Node print
 * them. AWS SDK errors keep their type only in `name`. Single-line output collapses whitespace in
 * each message for event records; multi-line output keeps messages as written for a terminal.
 */
export function describeError(error: unknown, layout: "multi-line" | "single-line") {
  const links: string[] = [];
  const seen = new Set<unknown>();
  for (let link = error; link !== undefined && !seen.has(link); ) {
    seen.add(link);
    let text: string;
    if (link instanceof Error) {
      text = link.name === "Error" ? link.message : `${link.name}: ${link.message}`;
    } else {
      text = typeof link === "string" ? link : Bun.inspect(link);
    }
    links.push(layout === "single-line" ? text.replaceAll(/\s+/gu, " ").trim() : text);
    link = link instanceof Error ? link.cause : undefined;
  }
  return links.join(layout === "single-line" ? " Caused by: " : "\nCaused by: ");
}

/**
 * Runs a CLI command and prints a rejection with `describeError`, exiting 1. Bun exits 0 once its
 * event loop drains, even while the command awaits a promise nothing will settle, as when Bun
 * aborts a node:http request without emitting `error`. That exit fails here instead.
 */
export function runMain(main: () => Promise<void>) {
  const unfinished = () => {
    process.stderr.write("The command stopped before it finished, with no error to report.\n");
    process.exitCode = 1;
  };
  process.once("beforeExit", unfinished);
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${describeError(error, "multi-line")}\n`);
      process.exitCode = 1;
    })
    .finally(() => process.off("beforeExit", unfinished));
}

/** Registers a value with the GitHub Actions log masker; a no-op elsewhere. */
export function mask(value: string) {
  if (process.env.GITHUB_ACTIONS === "true" && value) {
    process.stdout.write(
      `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`,
    );
  }
}

export const runCommand: CommandRunner = async (command, options = {}) => {
  const spawnOptions = {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...(options.env ?? process.env) },
    stdin: options.input === undefined ? ("ignore" as const) : new Blob([options.input]),
  };
  if (options.stream && options.prefix !== undefined) {
    const { prefix } = options;
    const child = Bun.spawn([...command], { ...spawnOptions, stderr: "pipe", stdout: "pipe" });
    const [exitCode] = await Promise.all([
      child.exited,
      relayLines(child.stdout, prefix),
      relayLines(child.stderr, prefix),
    ]);
    if (exitCode !== 0) throw new CommandFailure(`exit ${exitCode}`, command);
    return "";
  }
  if (options.stream) {
    // Child output is progress: route its stdout to stderr and keep it out of results.
    const exitCode = await Bun.spawn([...command], {
      ...spawnOptions,
      stderr: "inherit",
      stdout: 2,
    }).exited;
    if (exitCode !== 0) throw new CommandFailure(`exit ${exitCode}`, command);
    return "";
  }
  const child = Bun.spawn([...command], { ...spawnOptions, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new CommandFailure(stderr || `exit ${exitCode}`, command);
  return stdout;
};

async function relayLines(stream: ReadableStream<Uint8Array>, prefix: string) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    const lines = `${pending}${decoder.decode(chunk, { stream: true })}`.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) process.stderr.write(`${prefix}${line}\n`);
  }
  pending += decoder.decode();
  if (pending !== "") process.stderr.write(`${prefix}${pending}\n`);
}
