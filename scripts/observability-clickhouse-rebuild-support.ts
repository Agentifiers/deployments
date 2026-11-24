import path from "node:path";

interface CommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

const root = path.resolve(import.meta.dir, "..");
const SAFE_RESOURCE = /^[A-Za-z0-9._:/=-]+$/u;

export async function command(
  program: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  const child = Bun.spawn([program, ...arguments_], {
    cwd: root,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr, stdout };
}

export async function checked(program: string, arguments_: readonly string[]) {
  const result = await command(program, arguments_);
  if (result.code !== 0) {
    throw new Error(
      `${program} ${arguments_.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

export function json<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new Error(`${label} did not return valid JSON.`, { cause });
  }
}

export function safe(value: string, label: string) {
  if (!SAFE_RESOURCE.test(value)) throw new Error(`${label} contains unsafe characters.`);
  return value;
}
