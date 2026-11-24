import { Schema } from "effect";
import type { SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { RuntimeHttpCallbackKnownFailureError } from "./runtime-http-callback.ts";
import type { ReadRuntimeCallbackWorkspaceFiles } from "./runtime-tool-planning.ts";
import { acquireThreadSandbox, runGuestScript } from "./sandbox-file-runtime-tools.ts";
import {
  THREAD_SANDBOX_WORKSPACE_ROOT,
  type ThreadSandboxWorkspace,
} from "./thread-sandbox/contracts.ts";

export const CALLBACK_WORKSPACE_FILES_MAX_FILES = 200;
/** Bound on the UTF-8 bytes of every attached file's JSON-encoded `content` string combined. */
export const CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES = 192 * 1024;

const ByteSize = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

export const CallbackWorkspaceFilesScriptOutput = Schema.Union([
  Schema.Struct({ pattern: Schema.String, status: Schema.Literal("invalid_pattern") }),
  Schema.Struct({ count: ByteSize, status: Schema.Literal("too_many_files") }),
  Schema.Struct({ status: Schema.Literal("content_too_large") }),
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        byteSize: ByteSize,
        content: Schema.optional(Schema.String),
        path: Schema.String,
        sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
      }),
    ),
    status: Schema.Literal("ok"),
  }),
]);

/**
 * Python 3.9-compatible; run as `python3 -c <script> <json-args>`.
 * args: `{ root, include, maxFiles, maxContentBytes }` → invalid_pattern | too_many_files |
 * content_too_large | ok {files: [{path, byteSize, sha256, content?}] sorted by path}.
 * Expands each pattern with `glob.glob(recursive=True)` under `root`, keeps regular files whose
 * realpath stays inside `root` (symlinks out and non-UTF-8 names are skipped), and attaches
 * `content` only for files that decode as UTF-8.
 */
export const CALLBACK_WORKSPACE_FILES_SCRIPT = `
import codecs, glob, hashlib, json, os, stat, sys

CHUNK_BYTES = 1024 * 1024


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")


def encoded_size(text):
    # Matches the UTF-8 length of JavaScript's JSON.stringify(text) for text decoded from UTF-8.
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8"))


def describe(path, remaining):
    """Hashes one file; returns (metadata, content) where content is None for non-UTF-8 files
    and False for UTF-8 files larger than the remaining content budget."""
    digest = hashlib.sha256()
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    pieces = []
    is_text = True
    size = 0
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            return None, None
        while True:
            chunk = handle.read(CHUNK_BYTES)
            digest.update(chunk)
            size += len(chunk)
            if is_text:
                try:
                    piece = decoder.decode(chunk, final=not chunk)
                except UnicodeDecodeError:
                    is_text = False
                    pieces = []
                else:
                    # Encoded text is never smaller than its UTF-8 bytes, so stop buffering early.
                    if size <= remaining:
                        pieces.append(piece)
            if not chunk:
                break
    metadata = {"byteSize": size, "sha256": digest.hexdigest()}
    if not is_text:
        return metadata, None
    return metadata, "".join(pieces) if size <= remaining else False


def main():
    args = json.loads(sys.argv[1])
    root = os.path.realpath(args["root"])
    max_files = args["maxFiles"]
    max_content = args["maxContentBytes"]
    matches = set()
    for pattern in args["include"]:
        if not pattern or pattern.startswith("/") or ".." in pattern.split("/") or "\\0" in pattern:
            return emit({"pattern": pattern, "status": "invalid_pattern"})
        for match in glob.glob(os.path.join(root, pattern), recursive=True):
            real = os.path.realpath(match)
            if not real.startswith(root + os.sep):
                continue
            try:
                if not stat.S_ISREG(os.stat(real).st_mode):
                    continue
                relative = os.path.relpath(match, root)
                relative.encode("utf-8")
            except (OSError, UnicodeEncodeError):
                continue
            matches.add(relative)
    if len(matches) > max_files:
        return emit({"count": len(matches), "status": "too_many_files"})
    files = []
    content_bytes = 0
    for relative in sorted(matches):
        try:
            metadata, content = describe(os.path.join(root, relative), max_content - content_bytes)
        except OSError:
            continue
        if metadata is None:
            continue
        described = {"path": relative, **metadata}
        if content is not None:
            content_bytes += max_content + 1 if content is False else encoded_size(content)
            if content_bytes > max_content:
                return emit({"status": "content_too_large"})
            described["content"] = content
        files.append(described)
    emit({"files": files, "status": "ok"})


main()
`;

const encoder = new TextEncoder();

function limitFailure(toolName: string, message: string): never {
  throw new RuntimeHttpCallbackKnownFailureError(toolName, message);
}

/**
 * Reads the files an HTTP callback tool attaches from the run's thread-persistent sandbox.
 * Limit and pattern violations are known failures naming the limit; sandbox allocation and guest
 * failures are plain errors the dispatch path retries, since nothing was dispatched yet.
 */
export function createCallbackWorkspaceFileReader(options: {
  readonly manager: SandboxManagerService;
  readonly threadSandbox: ThreadSandboxWorkspace;
}): ReadRuntimeCallbackWorkspaceFiles {
  return async (request, spec) => {
    const { toolName } = request;
    const sandbox = await acquireThreadSandbox(options.threadSandbox, request, toolName);
    const result = await runGuestScript(options.manager, {
      args: {
        include: spec.include,
        maxContentBytes: CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES,
        maxFiles: CALLBACK_WORKSPACE_FILES_MAX_FILES,
        root: THREAD_SANDBOX_WORKSPACE_ROOT,
      },
      decode: Schema.decodeUnknownSync(CallbackWorkspaceFilesScriptOutput),
      request,
      sandbox,
      script: CALLBACK_WORKSPACE_FILES_SCRIPT,
      toolName,
    });
    switch (result.status) {
      case "invalid_pattern":
        return limitFailure(
          toolName,
          `HTTP callback ${toolName} workspace file pattern ${JSON.stringify(result.pattern)} must be relative to ${THREAD_SANDBOX_WORKSPACE_ROOT} without '..' segments.`,
        );
      case "too_many_files":
        return limitFailure(
          toolName,
          `HTTP callback ${toolName} workspace files matched ${result.count} files; the limit is ${CALLBACK_WORKSPACE_FILES_MAX_FILES}.`,
        );
      case "content_too_large":
        return limitFailure(
          toolName,
          `HTTP callback ${toolName} workspace file text content exceeds the ${CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES}-byte limit.`,
        );
      case "ok": {
        const paths = result.files.map((file) => file.path);
        let contentBytes = 0;
        for (const file of result.files) {
          if (file.content !== undefined) {
            contentBytes += encoder.encode(JSON.stringify(file.content)).byteLength;
          }
        }
        if (contentBytes > CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES) {
          return limitFailure(
            toolName,
            `HTTP callback ${toolName} workspace file text content exceeds the ${CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES}-byte limit.`,
          );
        }
        if (
          result.files.length > CALLBACK_WORKSPACE_FILES_MAX_FILES ||
          paths.some(
            (path, index) =>
              path.startsWith("/") ||
              path.split("/").includes("..") ||
              (index > 0 && paths[index - 1]! >= path),
          )
        ) {
          throw new Error(`${toolName} returned workspace files outside the requested bounds.`);
        }
        return result.files;
      }
    }
  };
}
