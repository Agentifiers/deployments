/* eslint-disable no-await-in-loop -- artifact staging and zipping must remain deterministic. */
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const root = path.resolve(import.meta.dir, "..");

export const deploymentArtifactDirectory = path.join(root, ".artifacts", "deployment");

export const deploymentArtifacts = {
  "agent-email-runtime": {
    buildPackage: "@deployments-ai/agent-email-runtime",
    files: [
      "functions/agent-email-runtime/dist/api-main.js",
      "functions/agent-email-runtime/dist/inbound-main.js",
      "functions/agent-email-runtime/dist/maintenance-main.js",
      "functions/agent-email-runtime/dist/provider-events-main.js",
      "functions/agent-email-runtime/dist/send-main.js",
      "functions/agent-email-runtime/dist/stream-dispatcher-main.js",
      "functions/agent-email-runtime/package.json",
    ],
  },
  "agent-runtime": {
    buildPackage: "@deployments-ai/runtime-api",
    files: [
      "functions/runtime-api/dist/artifact-retention-main.mjs",
      "functions/runtime-api/dist/evaluation-worker-main.mjs",
      "functions/runtime-api/dist/heartbeat-fire.mjs",
      "functions/runtime-api/dist/model-catalog-sync-main.mjs",
      "functions/runtime-api/dist/model-token-issuer-main.mjs",
      "functions/runtime-api/dist/observability-erasure-main.mjs",
      "functions/runtime-api/dist/observability-normalizer-main.mjs",
      "functions/runtime-api/dist/observability-projector-main.mjs",
      "functions/runtime-api/dist/run-dispatch.mjs",
      "functions/runtime-api/dist/runtime-api-main.mjs",
      "functions/runtime-api/dist/schedule-fire.mjs",
      "functions/runtime-api/dist/trace-finalization-main.mjs",
      "functions/runtime-api/dist/usage-main.mjs",
      "functions/runtime-api/dist/webhook-event-handler.mjs",
      "functions/runtime-api/dist/queue-main.mjs",
      "functions/runtime-api/dist/event-router-main.mjs",
      "functions/runtime-api/dist/approval-timeout-main.mjs",
      "functions/runtime-api/dist/client-tool-timeout-main.mjs",
    ],
  },
  "app-domains": {
    buildPackage: "@deployments-ai/app-domains",
    files: ["functions/app-domains/dist/index.mjs"],
  },
  "apps-database": {
    buildPackage: "@deployments-ai/apps-database",
    directory: "functions/apps-database/dist",
  },
  "channel-provider-runtime": {
    buildPackage: "@deployments-ai/channel-provider-runtime",
    files: [
      "functions/channel-provider-runtime/dist/credentials.js",
      "functions/channel-provider-runtime/dist/delivery.js",
      "functions/channel-provider-runtime/dist/ingress-consumer-main.js",
      "functions/channel-provider-runtime/dist/ingress.js",
      "functions/channel-provider-runtime/dist/oauth.js",
      "functions/channel-provider-runtime/dist/oauth-refresh.js",
      "functions/channel-provider-runtime/dist/provider-tools.js",
      "functions/channel-provider-runtime/package.json",
    ],
  },
  // The nitro aws-lambda build emits a self-contained server tree; the archive keeps its layout.
  console: {
    buildPackage: "@deployments-ai/console",
    directory: "apps/console/.output/server",
  },
  "document-extraction": {
    buildPackage: "@deployments-ai/document-extraction",
    directory: "functions/document-extraction/dist",
  },
  "event-analytics-projector": {
    buildPackage: "@deployments-ai/event-analytics-projector",
    files: ["functions/event-analytics-projector/dist/index.mjs"],
  },
  "event-dispatcher": {
    buildPackage: "@deployments-ai/event-dispatcher",
    files: ["functions/event-dispatcher/dist/index.mjs"],
  },
  "identity-api": {
    buildPackage: "@deployments-ai/identity-api",
    files: [
      "functions/identity-api/dist/lambda-main.js",
      "functions/identity-api/dist/principal-status.js",
      "functions/identity-api/dist/public-email-worker.js",
      "functions/identity-api/package.json",
    ],
  },
  "identity-email-worker": {
    buildPackage: "@deployments-ai/identity-email-worker",
    files: [
      "functions/identity-email-worker/dist/dispatcher.js",
      "functions/identity-email-worker/dist/reconciler.js",
      "functions/identity-email-worker/dist/worker.js",
      "functions/identity-email-worker/package.json",
    ],
  },
  "memory-runtime": {
    buildPackage: "@deployments-ai/memory-runtime",
    files: [
      "functions/memory-runtime/dist/api.js",
      "functions/memory-runtime/dist/cleanup-worker.js",
      "functions/memory-runtime/dist/erasure-worker.js",
      "functions/memory-runtime/dist/flush-worker.js",
      "functions/memory-runtime/dist/index-dispatcher.js",
      "functions/memory-runtime/dist/index-worker.js",
      "functions/memory-runtime/dist/operation-reconciler.js",
      "functions/memory-runtime/dist/operation-worker.js",
      "functions/memory-runtime/dist/package.json",
      "functions/memory-runtime/dist/reconcile.js",
      "functions/memory-runtime/dist/search-placement-worker.js",
      "functions/memory-runtime/dist/shadow-worker.js",
      "functions/memory-runtime/dist/usage-worker.js",
    ],
  },
  "ops-alerts-notifier": {
    buildPackage: "@deployments-ai/ops-alerts-notifier",
    files: ["functions/ops-alerts-notifier/dist/index.mjs"],
  },
  "platform-api": {
    buildPackage: "@deployments-ai/api",
    files: [
      "functions/api/dist/e2e-callback-main.js",
      "functions/api/dist/e2e-mcp-main.js",
      "functions/api/dist/administration-api-main.js",
      "functions/api/dist/brain-api-main.js",
      "functions/api/dist/brain-content-maintenance-main.js",
      "functions/api/dist/brain-erasure-main.js",
      "functions/api/dist/brain-index-dispatcher-main.js",
      "functions/api/dist/brain-index-worker-main.js",
      "functions/api/dist/brain-search-erasure-main.js",
      "functions/api/dist/brain-search-placement-main.js",
      "functions/api/dist/brain-sync-dispatcher-main.js",
      "functions/api/dist/brain-sync-worker-main.js",
      "functions/api/dist/budget-api-main.js",
      "functions/api/dist/evaluation-api-main.js",
      "functions/api/dist/governance-api-main.js",
      "functions/api/dist/governance-worker-main.js",
      "functions/api/dist/lambda-main.js",
      "functions/api/dist/monitor-api-main.js",
      "functions/api/dist/observability-api-main.js",
      "functions/api/dist/system-api-main.js",
      "functions/api/package.json",
    ],
  },
} as const;

export type DeploymentArtifactName = keyof typeof deploymentArtifacts;

/**
 * Static asset trees the deploy tool uploads to S3. Each is produced by the build of the Lambda
 * artifact named in `artifact`, so building the artifacts also builds the assets.
 */
export const deploymentStaticAssets = {
  console: { artifact: "console", directory: "apps/console/.output/public" },
} as const satisfies Record<
  string,
  { readonly artifact: DeploymentArtifactName; readonly directory: string }
>;

export type DeploymentStaticAssetName = keyof typeof deploymentStaticAssets;

/** Bundle file holding one static asset tree as a deterministic zip archive. */
export function staticAssetArchiveName(name: DeploymentStaticAssetName) {
  return `${name}-assets.zip`;
}

/**
 * Where the release takes the console server and public trees from: this repository's console app,
 * or a TanStack Start build an install supplies with the same nitro `aws-lambda` output layout.
 */
export type ConsoleBuild =
  | { readonly kind: "platform" }
  | {
      readonly kind: "install";
      readonly publicDirectory: string;
      readonly serverDirectory: string;
    };

export const platformConsoleBuild: ConsoleBuild = { kind: "platform" };
const consoleOutputDirectoryVariable = "DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR";
const handlerExport =
  /\bexport\s*\{[^}]*\bhandler\b[^}]*\}|\bexport\s+(?:async\s+)?(?:function\*?|const|let|var)\s+handler\b/u;

/**
 * Reads `DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR`, a nitro `.output` directory resolved against the
 * working directory, and checks it holds what the console slot runs: `server/index.mjs` exporting
 * the Lambda `handler`, and the `public/assets` tree CloudFront serves.
 */
export async function consoleBuildFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ConsoleBuild> {
  const value = environment[consoleOutputDirectoryVariable]?.trim();
  if (!value) return platformConsoleBuild;
  const outputDirectory = path.resolve(value);
  const refuse = (reason: string) =>
    new Error(
      `${consoleOutputDirectoryVariable}=${outputDirectory} is not a console build: ${reason}.`,
    );
  const entry = path.join(outputDirectory, "server", "index.mjs");
  let source: string;
  try {
    source = await readFile(entry, "utf8");
  } catch {
    throw refuse("server/index.mjs is missing");
  }
  if (!handlerExport.test(source)) {
    throw refuse("server/index.mjs does not export handler, the console Lambda entry");
  }
  const assets = await stat(path.join(outputDirectory, "public", "assets")).catch(() => undefined);
  if (!assets?.isDirectory()) throw refuse("public/assets is missing");
  return {
    kind: "install",
    publicDirectory: path.join(outputDirectory, "public"),
    serverDirectory: path.join(outputDirectory, "server"),
  };
}

async function runChecked(command: readonly string[], cwd = root) {
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
}

async function packageFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await packageFiles(directory, entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files.toSorted();
}

export async function createDeterministicZip(packageRoot: string, zipPath: string) {
  const files = await packageFiles(packageRoot);
  for (const file of files) {
    await utimes(path.join(packageRoot, file), ZIP_EPOCH, ZIP_EPOCH);
  }

  await rm(zipPath, { force: true });
  const child = Bun.spawn(["zip", "-X", "-q", zipPath, "-@"], {
    cwd: packageRoot,
    env: { ...process.env, TZ: "UTC" },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  await child.stdin.write(`${files.join("\n")}\n`);
  await child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`zip failed: ${stderr.trim() || stdout.trim()}`);
  }
}

async function archiveStagedFiles(
  directory: string,
  archiveName: string,
  stagingDirectory: string,
) {
  const archivePath = path.join(directory, archiveName);
  await createDeterministicZip(stagingDirectory, archivePath);
  return {
    file: archiveName,
    sha256: createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex"),
  };
}

export async function assertSelfContainedEntry(file: string) {
  const relative = new Bun.Transpiler({ loader: "js" })
    .scanImports(await readFile(file, "utf8"))
    .find((entry) => /^\.\.?\//u.test(entry.path));
  if (relative) {
    throw new Error(
      `${file} imports ${relative.path}; a Lambda entry must be a self-contained bundle.`,
    );
  }
}

/** Copies a build output tree, resolving symlinks so the archive holds regular files only. */
async function stageDirectory(source: string, stagingDirectory: string) {
  await cp(path.resolve(root, source), stagingDirectory, { dereference: true, recursive: true });
}

export async function buildDeploymentArtifact(
  name: DeploymentArtifactName,
  directory: string,
  consoleBuild: ConsoleBuild = platformConsoleBuild,
) {
  const stagingDirectory = path.join(directory, "staging", name);
  if (name === "console" && consoleBuild.kind === "install") {
    await stageDirectory(consoleBuild.serverDirectory, stagingDirectory);
    return archiveStagedFiles(directory, `${name}.zip`, stagingDirectory);
  }
  const definition = deploymentArtifacts[name];
  await runChecked(["bun", "run", "--filter", definition.buildPackage, "build"]);

  if ("directory" in definition) {
    await stageDirectory(definition.directory, stagingDirectory);
  } else {
    await mkdir(stagingDirectory, { recursive: true });
    for (const source of definition.files) {
      if (path.basename(source) !== "package.json") {
        await assertSelfContainedEntry(path.join(root, source));
      }
      await copyFile(path.join(root, source), path.join(stagingDirectory, path.basename(source)));
    }
  }
  return archiveStagedFiles(directory, `${name}.zip`, stagingDirectory);
}

export async function buildStaticAssetArchive(
  name: DeploymentStaticAssetName,
  directory: string,
  consoleBuild: ConsoleBuild = platformConsoleBuild,
) {
  const stagingDirectory = path.join(directory, "staging", `${name}-assets`);
  await stageDirectory(
    name === "console" && consoleBuild.kind === "install"
      ? consoleBuild.publicDirectory
      : deploymentStaticAssets[name].directory,
    stagingDirectory,
  );
  return archiveStagedFiles(directory, staticAssetArchiveName(name), stagingDirectory);
}

export async function buildDeploymentArtifacts(input: {
  readonly consoleBuild: ConsoleBuild;
  readonly directory?: string;
}) {
  const { consoleBuild, directory = deploymentArtifactDirectory } = input;
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });

  const artifacts: Record<string, { file: string; sha256: string }> = {};
  for (const name of Object.keys(deploymentArtifacts) as DeploymentArtifactName[]) {
    artifacts[name] = await buildDeploymentArtifact(name, directory, consoleBuild);
  }

  const assets: Record<string, { file: string; sha256: string }> = {};
  for (const name of Object.keys(deploymentStaticAssets) as DeploymentStaticAssetName[]) {
    assets[name] = await buildStaticAssetArchive(name, directory, consoleBuild);
  }

  await rm(path.join(directory, "staging"), {
    force: true,
    recursive: true,
  });
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({ artifacts, assets }, null, 2)}\n`,
  );
  return { artifacts, assets };
}

if (import.meta.main) {
  consoleBuildFromEnvironment(process.env)
    .then((consoleBuild) => buildDeploymentArtifacts({ consoleBuild }))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
