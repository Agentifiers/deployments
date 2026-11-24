import {
  APP_RELEASE_MAX_PATH_CHARACTERS,
  isReleaseDocumentFile,
  isReleasePath,
  releaseDocumentsProblem,
  type Ulid,
} from "@deployments-ai/db";
import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { APP_RELEASE_MAX_BYTES, APP_RELEASE_MAX_FILES } from "@deployments-ai/tools";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  RELEASE_MANIFEST_SCRIPT,
  RELEASE_UPLOAD_SCRIPT,
  ReleaseManifestScriptOutput,
  ReleaseUploadStatus,
} from "./app-release-guest-scripts.ts";
import type { AppReleaseObject, AppReleaseObjects } from "./app-runtime-ports.ts";
import { AppToolRefusal } from "./app-tool-refusal.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tool-planning.ts";
import { runGuestScript } from "./sandbox-file-runtime-tools.ts";
import { runSandboxJob } from "./sandbox-job-runner.ts";
import { THREAD_SANDBOX_WORKSPACE_ROOT } from "./thread-sandbox/contracts.ts";

const RELEASE_JOB_DIRECTORY = "/var/tmp/deployments-ai-app-release";
const RELEASE_JOB_SCRIPT_PATH = `${RELEASE_JOB_DIRECTORY}/upload.py`;
const RELEASE_JOB_SPEC_PATH = `${RELEASE_JOB_DIRECTORY}/spec.json`;
const RELEASE_UPLOAD_DEADLINE_MS = 10 * 60_000;
const RELEASE_VERIFY_CONCURRENCY = 16;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const GATEWAY_DOCUMENT_PATH = "index.html";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webm: "video/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};

type SandboxToolRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];

export interface ReleaseFile {
  readonly byteSize: number;
  readonly path: string;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly bundleSha256: string;
  readonly bytes: number;
  readonly documents: readonly string[];
  readonly files: readonly ReleaseFile[];
}

function invalid(message: string): never {
  throw new AppToolRefusal("release_invalid", message);
}

function releasePath(value: string, label: string): string {
  if (!isReleasePath(value)) {
    invalid(
      `${label} ${JSON.stringify(value)} must be a relative path of 1 to ${APP_RELEASE_MAX_PATH_CHARACTERS} characters without empty, "." or ".." segments, backslashes, control characters, or invalid UTF-8.`,
    );
  }
  return value;
}

export function releaseDirectory(value: string): string {
  return `${THREAD_SANDBOX_WORKSPACE_ROOT}/${releasePath(value.replace(/\/+$/u, ""), "directory")}`;
}

export function releaseManifest(
  directory: string,
  output: ReleaseManifestScriptOutput,
): ReleaseManifest {
  switch (output.status) {
    case "not_found":
      return invalid(`${directory} does not exist in the sandbox; build the app first.`);
    case "not_a_directory":
      return invalid(`${directory} is not a directory.`);
    case "too_many_files":
      return invalid(`${directory} has more than ${APP_RELEASE_MAX_FILES} files.`);
    case "too_large":
      return invalid(`${directory} holds more than ${APP_RELEASE_MAX_BYTES / (1024 * 1024)} MiB.`);
    case "ok":
      break;
  }
  const files: ReleaseFile[] = [];
  for (const entry of output.entries) {
    switch (entry.type) {
      case "symlink":
        return invalid(`${entry.path} is a symbolic link; copy its target into the build output.`);
      case "other":
        return invalid(`${entry.path} is not a regular file.`);
      case "file":
        files.push({
          byteSize: entry.byteSize,
          path: releasePath(entry.path, "file"),
          sha256: entry.sha256,
        });
    }
  }
  const bytes = files.reduce((total, file) => total + file.byteSize, 0);
  if (files.length > APP_RELEASE_MAX_FILES) {
    invalid(`${directory} has more than ${APP_RELEASE_MAX_FILES} files.`);
  }
  if (bytes > APP_RELEASE_MAX_BYTES) {
    invalid(`${directory} holds more than ${APP_RELEASE_MAX_BYTES / (1024 * 1024)} MiB.`);
  }
  if (!files.some((file) => file.path === GATEWAY_DOCUMENT_PATH)) {
    invalid(`${directory} has no ${GATEWAY_DOCUMENT_PATH} at its root.`);
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const documents = files.flatMap((file) => (isReleaseDocumentFile(file.path) ? [file.path] : []));
  const documentsProblem = releaseDocumentsProblem(documents);
  if (documentsProblem !== undefined) invalid(`${directory}: ${documentsProblem}`);
  const bundle = createHash("sha256");
  for (const file of files) bundle.update(`${file.path}\t${file.byteSize}\t${file.sha256}\n`);
  return { bundleSha256: bundle.digest("hex"), bytes, documents, files };
}

export function releaseObject(appId: Ulid, releaseId: Ulid, file: ReleaseFile): AppReleaseObject {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return {
    byteSize: file.byteSize,
    cacheControl: file.path === GATEWAY_DOCUMENT_PATH ? undefined : IMMUTABLE_CACHE_CONTROL,
    contentType: Object.hasOwn(CONTENT_TYPE_BY_EXTENSION, extension)
      ? CONTENT_TYPE_BY_EXTENSION[extension]!
      : DEFAULT_CONTENT_TYPE,
    key: `apps/${appId}/releases/${releaseId}/${file.path}`,
    sha256: file.sha256,
  };
}

async function forEachConcurrently<Item>(
  items: readonly Item[],
  concurrency: number,
  visit: (item: Item) => Promise<void>,
) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor]!;
        cursor += 1;
        // eslint-disable-next-line no-await-in-loop -- Each lane visits its items in turn.
        await visit(item);
      }
    }),
  );
}

export async function uploadRelease(input: {
  readonly appId: Ulid;
  readonly directory: string;
  readonly manager: SandboxManagerService;
  readonly now: () => number;
  readonly objects: AppReleaseObjects;
  readonly releaseId: Ulid;
  readonly request: SandboxToolRequest;
  readonly sandbox: ManagedSandbox;
}): Promise<ReleaseManifest> {
  const { appId, objects, releaseId, request, sandbox } = input;
  const manifest = releaseManifest(
    input.directory,
    await runGuestScript(input.manager, {
      args: {
        maxBytes: APP_RELEASE_MAX_BYTES,
        maxFiles: APP_RELEASE_MAX_FILES,
        root: input.directory,
      },
      decode: Schema.decodeUnknownSync(ReleaseManifestScriptOutput),
      request,
      sandbox,
      script: RELEASE_MANIFEST_SCRIPT,
      toolName: request.toolName,
    }),
  );
  const uploads = await Promise.all(
    manifest.files.map(async (file) => ({
      ...(await objects.presignCreate(releaseObject(appId, releaseId, file))),
      path: file.path,
    })),
  );
  const uploaded = await runSandboxJob(
    {
      deadline: input.now() + RELEASE_UPLOAD_DEADLINE_MS,
      manager: input.manager,
      now: input.now,
      sandbox,
      signal: request.signal,
    },
    {
      control: ["python3", RELEASE_JOB_SCRIPT_PATH],
      decodeStatus: Schema.decodeUnknownSync(ReleaseUploadStatus),
      label: "App release upload",
      startArgument: RELEASE_JOB_SPEC_PATH,
      statusArgument: RELEASE_JOB_DIRECTORY,
      uploads: [
        { content: RELEASE_UPLOAD_SCRIPT, path: RELEASE_JOB_SCRIPT_PATH },
        {
          content: JSON.stringify({ files: uploads, root: input.directory }),
          path: RELEASE_JOB_SPEC_PATH,
        },
      ],
    },
  );
  if (uploaded.state === "timeout") {
    throw new Error("The release upload did not finish before its deadline.");
  }
  if (uploaded.state === "failed") {
    throw new AppToolRefusal(
      "release_upload_failed",
      `Uploading ${manifest.files[uploaded.file]?.path ?? "a file"} failed (${uploaded.reason}).`,
    );
  }
  await forEachConcurrently(manifest.files, RELEASE_VERIFY_CONCURRENCY, async (file) => {
    const stored = await objects.head(releaseObject(appId, releaseId, file).key, request.signal);
    if (stored?.byteSize !== file.byteSize || stored.sha256 !== file.sha256) {
      throw new AppToolRefusal(
        "release_upload_failed",
        `${file.path} in storage does not match the sandbox file; call app.release again.`,
      );
    }
  });
  return manifest;
}
