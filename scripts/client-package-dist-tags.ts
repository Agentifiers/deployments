interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface PublishedDistTagsOptions {
  readonly capture: (command: readonly string[]) => Promise<CommandResult>;
  readonly name: string;
  readonly packageVersion: string;
  readonly registry: string;
}

export async function publishedDistTags({
  capture,
  name,
  packageVersion,
  registry,
}: PublishedDistTagsOptions): Promise<Readonly<Record<string, string>>> {
  const result = await capture([
    "npm",
    "view",
    `${name}@${packageVersion}`,
    "dist-tags",
    "--json",
    "--registry",
    registry,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Reading ${name} dist-tags failed: ${result.stderr.trim()}`);
  }
  const tags = JSON.parse(result.stdout) as unknown;
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    throw new Error(`Registry returned invalid dist-tags for ${name}.`);
  }
  if (!Object.values(tags).every((value) => typeof value === "string")) {
    throw new Error(`Registry returned invalid dist-tags for ${name}.`);
  }
  return tags as Readonly<Record<string, string>>;
}
