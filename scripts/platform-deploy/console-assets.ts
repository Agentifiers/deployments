/* eslint-disable no-await-in-loop -- directory walks and uploads run in a fixed, logged order. */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { type CommandRunner, log } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

/** Vite's content-hashed output directory; its file names change whenever their bytes do. */
const hashedAssetDirectory = "assets";
const immutableCacheControl = "public, max-age=31536000, immutable";
const mutableCacheControl = "public, max-age=300";

/** Content types by extension; an unlisted extension fails the deploy instead of guessing. */
const staticAssetContentTypes: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

/** The console static asset bucket, when the applied root deploys the console. */
export function consoleAssetsBucket(outputs: TerraformOutputs) {
  const bucket = outputs.console_assets_bucket;
  return typeof bucket === "string" && bucket ? bucket : undefined;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(directory, path)));
    else files.push(path);
  }
  return files;
}

/**
 * Plans one `aws s3 cp --recursive` per (cache class, extension) so every object gets an explicit
 * content type and cache policy: content-hashed files under `assets/` are immutable for a year,
 * everything else revalidates after five minutes.
 */
export function staticAssetUploads(files: readonly string[], source: string, bucket: string) {
  const extensions = new Map<string, { hashed: boolean; mutable: boolean }>();
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (!Object.hasOwn(staticAssetContentTypes, extension)) {
      throw new Error(`Static asset ${file} has no declared content type.`);
    }
    const classes = extensions.get(extension) ?? { hashed: false, mutable: false };
    if (file.startsWith(`${hashedAssetDirectory}/`)) classes.hashed = true;
    else classes.mutable = true;
    extensions.set(extension, classes);
  }
  const commands: string[][] = [];
  for (const [extension, classes] of [...extensions].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const base = [
      "aws",
      "s3",
      "cp",
      source,
      `s3://${bucket}/`,
      "--recursive",
      "--only-show-errors",
    ];
    const contentType = ["--content-type", staticAssetContentTypes[extension]!];
    if (classes.hashed) {
      commands.push([
        ...base,
        "--exclude",
        "*",
        "--include",
        `${hashedAssetDirectory}/*${extension}`,
        ...contentType,
        "--cache-control",
        immutableCacheControl,
      ]);
    }
    if (classes.mutable) {
      commands.push([
        ...base,
        "--exclude",
        "*",
        "--include",
        `*${extension}`,
        "--exclude",
        `${hashedAssetDirectory}/*`,
        ...contentType,
        "--cache-control",
        mutableCacheControl,
      ]);
    }
  }
  return commands;
}

/**
 * Uploads the release's console static assets to the console bucket. Objects are only added or
 * replaced, never deleted, so pages rendered by the previous release keep loading their assets
 * while the new Lambda code rolls out.
 */
export async function publishConsoleAssets(input: {
  readonly archivePath: string;
  readonly bucket: string;
  readonly run: CommandRunner;
}) {
  const directory = await mkdtemp(join(tmpdir(), "console-assets-"));
  try {
    await input.run(["unzip", "-q", input.archivePath, "-d", directory]);
    const files = await listFiles(directory);
    if (files.length === 0) throw new Error("The console asset archive is empty.");
    for (const command of staticAssetUploads(files, directory, input.bucket)) {
      await input.run(command);
    }
    log(`console assets published (${files.length} files) to s3://${input.bucket}/`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
