import { expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertSelfContainedEntry,
  buildDeploymentArtifact,
  buildStaticAssetArchive,
  consoleBuildFromEnvironment,
  createDeterministicZip,
  deploymentArtifacts,
  deploymentStaticAssets,
} from "./build-deployment-artifacts.ts";

async function zipEntries(archive: string) {
  const child = Bun.spawn(["unzip", "-Z1", archive], { stderr: "pipe", stdout: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim().split("\n").toSorted();
}

async function writeConsoleOutput(
  output: string,
  entry = "export const handler = async () => ({ statusCode: 200 });\n",
) {
  await mkdir(path.join(output, "server", "chunks"), { recursive: true });
  await mkdir(path.join(output, "public", "assets"), { recursive: true });
  await writeFile(path.join(output, "server", "index.mjs"), entry);
  await writeFile(path.join(output, "server", "chunks", "app.mjs"), "export const app = 1;\n");
  await writeFile(path.join(output, "public", "assets", "app-3f2a.js"), "console.log(1);\n");
  await writeFile(path.join(output, "public", "favicon.ico"), "icon");
}

it("ships the platform console when DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR is unset or empty", async () => {
  expect(await consoleBuildFromEnvironment({})).toEqual({ kind: "platform" });
  expect(await consoleBuildFromEnvironment({ DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR: " " })).toEqual({
    kind: "platform",
  });
  expect(deploymentArtifacts.console.directory).toBe("apps/console/.output/server");
  expect(deploymentStaticAssets.console).toEqual({
    artifact: "console",
    directory: "apps/console/.output/public",
  });
});

it("packages an install-supplied console build as the console archive and assets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "install-console-"));
  try {
    const output = path.join(directory, ".output");
    await writeConsoleOutput(output);
    const consoleBuild = await consoleBuildFromEnvironment({
      DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR: path.relative(process.cwd(), output),
    });
    expect(consoleBuild).toEqual({
      kind: "install",
      publicDirectory: path.join(output, "public"),
      serverDirectory: path.join(output, "server"),
    });

    const bundle = path.join(directory, "bundle");
    const archive = await buildDeploymentArtifact("console", bundle, consoleBuild);
    const assets = await buildStaticAssetArchive("console", bundle, consoleBuild);
    expect(archive.file).toBe("console.zip");
    expect(assets.file).toBe("console-assets.zip");
    expect(await zipEntries(path.join(bundle, "console.zip"))).toEqual([
      "chunks/app.mjs",
      "index.mjs",
    ]);
    expect(await zipEntries(path.join(bundle, "console-assets.zip"))).toEqual([
      "assets/app-3f2a.js",
      "favicon.ico",
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it("refuses a console output directory without a server entry or public assets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "install-console-"));
  try {
    const refusal = (output: string) =>
      consoleBuildFromEnvironment({ DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR: output }).then(
        () => "accepted",
        String,
      );
    const empty = path.join(directory, "empty");
    await mkdir(empty);
    expect(await refusal(empty)).toBe(
      `Error: DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR=${empty} is not a console build: server/index.mjs is missing.`,
    );

    const noHandler = path.join(directory, "no-handler");
    await writeConsoleOutput(noHandler, "export default () => 1;\n");
    expect(await refusal(noHandler)).toBe(
      `Error: DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR=${noHandler} is not a console build: server/index.mjs does not export handler, the console Lambda entry.`,
    );

    const noAssets = path.join(directory, "no-assets");
    await writeConsoleOutput(noAssets);
    await rm(path.join(noAssets, "public"), { force: true, recursive: true });
    expect(await refusal(noAssets)).toBe(
      `Error: DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR=${noAssets} is not a console build: public/assets is missing.`,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it("rejects a Lambda entry that imports a relative path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lambda-entry-"));
  try {
    const bundled = path.join(directory, "bundled.js");
    await writeFile(
      bundled,
      `import { Schema } from "effect";
const hint = "Did you mean import('./MyComponent')?";
export const handler = () => import("node:fs").then(() => [Schema, hint]);
`,
    );
    const chunked = path.join(directory, "chunked.js");
    await writeFile(
      chunked,
      `import { shared } from "./chunk-a1b2.js";\nexport const handler = () => shared;\n`,
    );
    const lazy = path.join(directory, "lazy.js");
    await writeFile(lazy, `export const handler = () => import("../routes/lazy.js");\n`);

    await assertSelfContainedEntry(bundled);
    expect(assertSelfContainedEntry(chunked)).rejects.toThrow(
      `${chunked} imports ./chunk-a1b2.js; a Lambda entry must be a self-contained bundle.`,
    );
    expect(assertSelfContainedEntry(lazy)).rejects.toThrow(
      `${lazy} imports ../routes/lazy.js; a Lambda entry must be a self-contained bundle.`,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it("loads the packaged channel credential handler under Lambda module semantics", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const directory = await mkdtemp(path.join(tmpdir(), "channel-artifact-"));
  try {
    const staging = path.join(directory, "staging");
    await mkdir(staging);
    const build = Bun.spawn(
      ["bun", "build", "src/credentials.ts", "--target=node", "--format=esm", "--outdir", staging],
      {
        cwd: path.join(root, "functions/channel-provider-runtime"),
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [buildExitCode, buildOutput, buildError] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    if (buildExitCode !== 0) throw new Error(buildError || buildOutput);
    for (const file of deploymentArtifacts["channel-provider-runtime"].files) {
      if (file.endsWith("/package.json")) {
        await copyFile(path.join(root, file), path.join(staging, "package.json"));
      }
    }
    const archive = path.join(directory, "runtime.zip");
    await createDeterministicZip(staging, archive);
    const extracted = path.join(directory, "extracted");
    const unzip = Bun.spawn(["unzip", "-q", archive, "-d", extracted], {
      stderr: "pipe",
      stdout: "pipe",
    });
    if ((await unzip.exited) !== 0) throw new Error(await new Response(unzip.stderr).text());
    const child = Bun.spawn(
      [
        "node",
        "--no-experimental-detect-module",
        "--input-type=module",
        "--eval",
        `import { handler } from "./credentials.js";
const response = await handler({
  pathParameters: { environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  requestContext: { http: { method: "POST" } }
});
process.stdout.write(JSON.stringify(response));`,
      ],
      {
        cwd: extracted,
        env: { PATH: process.env.PATH ?? "" },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout).statusCode).toBe(401);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

it("ships libpg-query.wasm beside an apps-database bundle that loads it from there", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const directory = await mkdtemp(path.join(tmpdir(), "apps-database-artifact-"));
  try {
    const { file } = await buildDeploymentArtifact("apps-database", directory);
    const extracted = path.join(directory, "extracted");
    const unzip = Bun.spawn(["unzip", "-q", path.join(directory, file), "-d", extracted], {
      stderr: "pipe",
      stdout: "pipe",
    });
    if ((await unzip.exited) !== 0) throw new Error(await new Response(unzip.stderr).text());
    const bundle = await readFile(path.join(extracted, "index.mjs"), "utf8");
    const child = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "--eval",
        `import { handler } from "./index.mjs";
const response = await handler({
  appId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  maxRows: 10,
  op: "query",
  sql: "SELEC 1",
});
process.stdout.write(JSON.stringify(response));`,
      ],
      {
        cwd: extracted,
        env: {
          APPS_BUCKET: "apps",
          APPS_DATABASE_HOST: "127.0.0.1",
          APPS_DATABASE_PORT: "5432",
          APPS_DATABASE_REGION: "us-east-2",
          APPS_KEY_VALUE_STORE_ARN:
            "arn:aws:cloudfront::123456789012:key-value-store/00000000-0000-0000-0000-000000000000",
          AWS_REGION: "us-east-2",
          PATH: process.env.PATH ?? "",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect((await readdir(extracted)).toSorted()).toEqual(["index.mjs", "libpg-query.wasm"]);
    expect(bundle.split(/["'`]/u).filter((text) => text.startsWith(root))).toEqual([]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      error: { code: "sql_rejected", message: 'syntax error at or near "SELEC" at character 1' },
      ok: false,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 60_000);
