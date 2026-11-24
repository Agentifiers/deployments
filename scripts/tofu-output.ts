import path from "node:path";

/** Resolves a required OpenTofu root directory flag against the invoking directory. */
export function tofuRoot(value: string | undefined, usage: string) {
  const root = value?.trim();
  if (!root) throw new Error(`--root is required.\n${usage}`);
  return path.resolve(root);
}

/** Reads one output of an initialized OpenTofu root with `tofu output -json`. */
export function tofuOutput<T>(root: string, name: string): T {
  const result = Bun.spawnSync(["tofu", `-chdir=${root}`, "output", "-json", name], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `tofu output ${name} failed in ${root}: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    );
  }
  try {
    return JSON.parse(result.stdout.toString()) as T;
  } catch (cause) {
    throw new Error(`tofu output ${name} in ${root} did not return valid JSON.`, { cause });
  }
}
