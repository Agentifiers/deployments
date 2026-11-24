import { Schema } from "effect";

/** Python 3.9 programs for `app.release`, run inside the thread sandbox. */

const ByteSize = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

export const ReleaseManifestScriptOutput = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["not_found", "not_a_directory", "too_large", "too_many_files"]),
  }),
  Schema.Struct({
    entries: Schema.Array(
      Schema.Union([
        Schema.Struct({
          byteSize: ByteSize,
          path: Schema.String,
          sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
          type: Schema.Literal("file"),
        }),
        Schema.Struct({ path: Schema.String, type: Schema.Literals(["symlink", "other"]) }),
      ]),
    ),
    status: Schema.Literal("ok"),
  }),
]);
export type ReleaseManifestScriptOutput = typeof ReleaseManifestScriptOutput.Type;

export const RELEASE_MANIFEST_SCRIPT = `
import hashlib, json, os, stat, sys

CHUNK = 1024 * 1024


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")


def text(path):
    return os.fsencode(path).decode("utf-8", "replace")


def digest(path):
    hasher = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            hasher.update(chunk)
    return size, hasher.hexdigest()


def main():
    args = json.loads(sys.argv[1])
    root = args["root"]
    try:
        info = os.lstat(root)
    except (FileNotFoundError, NotADirectoryError):
        return emit({"status": "not_found"})
    if not stat.S_ISDIR(info.st_mode):
        return emit({"status": "not_a_directory"})
    entries = []
    files = 0
    total = 0
    pending = [root]
    while pending:
        with os.scandir(pending.pop()) as iterator:
            children = sorted(iterator, key=lambda entry: entry.name)
        for entry in children:
            path = text(os.path.relpath(entry.path, root))
            if entry.is_symlink():
                entries.append({"path": path, "type": "symlink"})
            elif entry.is_dir(follow_symlinks=False):
                pending.append(entry.path)
            elif entry.is_file(follow_symlinks=False):
                files += 1
                total += entry.stat(follow_symlinks=False).st_size
                if files > args["maxFiles"]:
                    return emit({"status": "too_many_files"})
                if total > args["maxBytes"]:
                    return emit({"status": "too_large"})
                size, sha256 = digest(entry.path)
                entries.append({"byteSize": size, "path": path, "sha256": sha256, "type": "file"})
            else:
                entries.append({"path": path, "type": "other"})
    emit({"entries": entries, "status": "ok"})


main()
`;

export const ReleaseUploadStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["done", "missing", "running", "started"]) }),
  Schema.Struct({
    file: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
    reason: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9_A-Z]{1,96}$/u))),
    state: Schema.Literal("failed"),
  }),
]);

export const RELEASE_UPLOAD_SCRIPT = `
import concurrent.futures, errno, http.client, json, os, re, signal, subprocess, sys, time, urllib.parse


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")


def remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def job_pid(job_dir):
    try:
        with open(os.path.join(job_dir, "pid")) as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        return None


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def start(spec_path):
    job_dir = os.path.dirname(spec_path)
    previous = job_pid(job_dir)
    if previous is not None:
        try:
            os.killpg(previous, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        for _ in range(50):
            if not alive(previous):
                break
            time.sleep(0.1)
    remove(os.path.join(job_dir, "status.json"))
    remove(os.path.join(job_dir, "pid"))
    process = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "run", spec_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )
    with open(os.path.join(job_dir, "pid"), "w") as handle:
        handle.write(str(process.pid))
    emit({"state": "started"})


def status(job_dir):
    try:
        with open(os.path.join(job_dir, "status.json")) as handle:
            emit(json.load(handle))
            return
    except FileNotFoundError:
        pass
    pid = job_pid(job_dir)
    if pid is None:
        emit({"state": "missing"})
    elif alive(pid):
        emit({"state": "running"})
    else:
        emit({"state": "failed", "reason": "job_exited", "file": 0})


def put(root, file):
    parsed = urllib.parse.urlsplit(file["url"])
    if parsed.scheme != "https" or not parsed.hostname:
        return "insecure_url"
    target = parsed.path + ("?" + parsed.query if parsed.query else "")
    path = os.path.join(root, file["path"])
    try:
        headers = dict(file["headers"])
        headers["content-length"] = str(os.path.getsize(path))
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=120)
        try:
            with open(path, "rb") as body:
                connection.request("PUT", target, body=body, headers=headers)
                response = connection.getresponse()
                payload = response.read(8192)
        finally:
            connection.close()
    except OSError as error:
        return "os_" + errno.errorcode.get(error.errno, "error")
    if response.status in (200, 412):
        return None
    match = re.search(rb"<Code>([A-Za-z]{1,64})</Code>", payload)
    return "http_%d_%s" % (response.status, match.group(1).decode("ascii") if match else "unknown")


def upload(spec):
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        reasons = list(pool.map(lambda file: put(spec["root"], file), spec["files"]))
    for index, reason in enumerate(reasons):
        if reason is not None:
            return {"state": "failed", "reason": reason, "file": index}
    return {"state": "done"}


def run(spec_path):
    job_dir = os.path.dirname(spec_path)
    try:
        with open(spec_path) as handle:
            spec = json.load(handle)
        remove(spec_path)
        result = upload(spec)
    except Exception as error:
        result = {"state": "failed", "reason": "unexpected_" + type(error).__name__, "file": 0}
    path = os.path.join(job_dir, "status.json")
    with open(path + ".tmp", "w") as handle:
        json.dump(result, handle, separators=(",", ":"))
    os.replace(path + ".tmp", path)


if __name__ == "__main__":
    {"run": run, "start": start, "status": status}[sys.argv[1]](sys.argv[2])
`;
