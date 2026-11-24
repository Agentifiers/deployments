import { Schema } from "effect";

/**
 * Python 3.9-compatible programs run as `python3 -c <script> <json-args>` inside the
 * thread sandbox. Each receives an absolute, already-jailed path (the TypeScript layer
 * enforces `/workspace`) and prints exactly one ASCII JSON line on stdout, described by
 * the matching `*ScriptOutput` schema.
 */

const ByteSize = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

export const SandboxFilesReadScriptOutput = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["not_found", "not_a_file", "not_utf8"]) }),
  Schema.Struct({
    byteSize: ByteSize,
    content: Schema.String,
    status: Schema.Literal("ok"),
    truncated: Schema.Boolean,
  }),
]);

export const SandboxFilesWriteScriptOutput = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["is_a_directory", "parent_not_directory"]) }),
  Schema.Struct({ byteSize: ByteSize, sha256: Schema.String, status: Schema.Literal("ok") }),
]);

export const SandboxFilesListScriptOutput = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["not_found", "not_a_directory"]) }),
  Schema.Struct({
    entries: Schema.Array(
      Schema.Union([
        Schema.Struct({ byteSize: ByteSize, path: Schema.String, type: Schema.Literal("file") }),
        Schema.Struct({
          path: Schema.String,
          type: Schema.Literals(["directory", "symlink", "other"]),
        }),
      ]),
    ),
    status: Schema.Literal("ok"),
    truncated: Schema.Boolean,
  }),
]);

const EMIT = `
def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")
`;

/** args: `{ path, maxBytes }` → not_found | not_a_file | not_utf8 | ok {byteSize, content, truncated}. */
export const SANDBOX_FILES_READ_SCRIPT = `
import codecs, json, os, stat, sys
${EMIT}

def main():
    args = json.loads(sys.argv[1])
    path = args["path"]
    max_bytes = args["maxBytes"]
    try:
        info = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return emit({"status": "not_found"})
    if not stat.S_ISREG(info.st_mode):
        return emit({"status": "not_a_file"})
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode):
            return emit({"status": "not_a_file"})
        data = file.read(max_bytes + 1)
    truncated = len(data) > max_bytes
    # A non-final incremental decode withholds an incomplete trailing sequence cut by the
    # byte limit instead of rejecting it; genuinely invalid bytes still raise.
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    try:
        content = decoder.decode(data[:max_bytes], final=not truncated)
    except UnicodeDecodeError:
        return emit({"status": "not_utf8"})
    emit({"status": "ok", "byteSize": info.st_size, "content": content, "truncated": truncated})


main()
`;

/**
 * args: `{ path, source }` → is_a_directory | parent_not_directory | ok {byteSize, sha256}.
 * Moves the uploaded `source` over `path` atomically and always removes `source`.
 */
export const SANDBOX_FILES_WRITE_SCRIPT = `
import errno, hashlib, json, os, stat, sys, tempfile
${EMIT}

def is_directory(path):
    try:
        return stat.S_ISDIR(os.stat(path).st_mode)
    except (FileNotFoundError, NotADirectoryError):
        return False


def blocked_ancestor(parent):
    prefix = "/"
    for part in parent.strip("/").split("/"):
        if not part:
            continue
        prefix = os.path.join(prefix, part)
        try:
            info = os.stat(prefix)
        except FileNotFoundError:
            return False
        except NotADirectoryError:
            return True
        if not stat.S_ISDIR(info.st_mode):
            return True
    return False


def target_mode(path):
    try:
        info = os.stat(path)
        if stat.S_ISREG(info.st_mode):
            return stat.S_IMODE(info.st_mode)
    except (FileNotFoundError, NotADirectoryError):
        pass
    umask = os.umask(0)
    os.umask(umask)
    return 0o666 & ~umask


def place(source, path, parent, data, mode):
    os.chmod(source, mode)
    try:
        os.replace(source, path)
        return
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
    descriptor, staged = tempfile.mkstemp(dir=parent, prefix="." + os.path.basename(path) + ".")
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(staged, mode)
        os.replace(staged, path)
    except BaseException:
        try:
            os.unlink(staged)
        except FileNotFoundError:
            pass
        raise


def main():
    args = json.loads(sys.argv[1])
    path = args["path"]
    source = args["source"]
    try:
        with open(source, "rb") as file:
            data = file.read()
        if is_directory(path):
            return emit({"status": "is_a_directory"})
        parent = os.path.dirname(path)
        if blocked_ancestor(parent):
            return emit({"status": "parent_not_directory"})
        try:
            os.makedirs(parent, exist_ok=True)
        except (FileExistsError, NotADirectoryError):
            return emit({"status": "parent_not_directory"})
        try:
            place(source, path, parent, data, target_mode(path))
        except IsADirectoryError:
            return emit({"status": "is_a_directory"})
        emit({"status": "ok", "byteSize": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    finally:
        try:
            os.unlink(source)
        except FileNotFoundError:
            pass


main()
`;

/**
 * args: `{ path, recursive, limit }` → not_found | not_a_directory |
 * ok {entries: [{path, type, byteSize?}] sorted by path, truncated}. Never follows symlinks.
 */
export const SANDBOX_FILES_LIST_SCRIPT = `
import json, os, stat, sys
${EMIT}

def text(path):
    return os.fsencode(path).decode("utf-8", "replace")


def children(directory):
    try:
        with os.scandir(directory) as iterator:
            return sorted(iterator, key=lambda entry: entry.name)
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return []


def describe(entry):
    path = text(entry.path)
    if entry.is_symlink():
        return {"path": path, "type": "symlink"}
    if entry.is_dir(follow_symlinks=False):
        return {"path": path, "type": "directory"}
    if entry.is_file(follow_symlinks=False):
        size = entry.stat(follow_symlinks=False).st_size
        return {"byteSize": size, "path": path, "type": "file"}
    return {"path": path, "type": "other"}


def main():
    args = json.loads(sys.argv[1])
    root = args["path"]
    recursive = args["recursive"]
    limit = args["limit"]
    try:
        info = os.lstat(root)
    except (FileNotFoundError, NotADirectoryError):
        return emit({"status": "not_found"})
    if not stat.S_ISDIR(info.st_mode):
        return emit({"status": "not_a_directory"})
    entries = []
    truncated = False
    stack = [iter(children(root))]
    while stack:
        entry = next(stack[-1], None)
        if entry is None:
            stack.pop()
            continue
        try:
            described = describe(entry)
        except FileNotFoundError:
            continue
        if len(entries) == limit:
            truncated = True
            break
        entries.append(described)
        if recursive and described["type"] == "directory":
            stack.append(iter(children(entry.path)))
    entries.sort(key=lambda item: item["path"])
    emit({"entries": entries, "status": "ok", "truncated": truncated})


main()
`;
