/**
 * Python 3.9 program uploaded into the thread sandbox and run as
 * `python3 transfer.py start <spec.json>` / `python3 transfer.py status <job-dir>`.
 *
 * `start` stops any previous job in the same directory, launches `run` in its own session with
 * no inherited stdio (so the control server's exec returns immediately), and prints
 * `{"state":"started"}`. `run` performs one operation and atomically writes `status.json`:
 *
 * - `archive`: `tar | gzip -1` of `root` into `output`, hashed while written; stops at
 *   `maxBytes` → `too_large`, else `done {byteSize, sha256}`.
 * - `upload`: streams `file` to a presigned S3 `PUT` with the signed `headers`; deletes the
 *   file on success.
 * - `restore`: streams a presigned S3 `GET` into `file`, verifies `byteSize` and `sha256`,
 *   extracts it into `root`, and deletes it.
 *
 * Failure reasons are fixed, secret-free tokens. `status` prints the status file, `running`
 * while the job process lives, `failed {reason: "job_exited"}` if it died without a status, or
 * `missing` when no job was started.
 */
export const WORKSPACE_TRANSFER_SCRIPT = `
import errno, hashlib, http.client, json, os, re, signal, subprocess, sys, time, urllib.parse

CHUNK = 1024 * 1024


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")


def remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def write_status(job_dir, value):
    path = os.path.join(job_dir, "status.json")
    with open(path + ".tmp", "w") as handle:
        json.dump(value, handle, separators=(",", ":"))
    os.replace(path + ".tmp", path)


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
        emit({"state": "failed", "reason": "job_exited"})


def https_target(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        return None, None
    target = parsed.path + ("?" + parsed.query if parsed.query else "")
    connection = http.client.HTTPSConnection(
        parsed.hostname, parsed.port or 443, timeout=120, blocksize=CHUNK
    )
    return connection, target


def s3_error(status, payload):
    match = re.search(rb"<Code>([A-Za-z]{1,64})</Code>", payload)
    return "http_%d_%s" % (status, match.group(1).decode("ascii") if match else "unknown")


def archive(spec):
    output = spec["output"]
    remove(output)
    tar = subprocess.Popen(
        ["tar", "-C", spec["root"], "-cf", "-", "."],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    gzip = subprocess.Popen(
        ["gzip", "-1", "-c"], stdin=tar.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    tar.stdout.close()
    digest = hashlib.sha256()
    size = 0
    too_large = False
    with open(output, "wb") as handle:
        while True:
            chunk = gzip.stdout.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > spec["maxBytes"]:
                too_large = True
                break
            digest.update(chunk)
            handle.write(chunk)
    if too_large:
        tar.kill()
        gzip.kill()
    tar_code = tar.wait()
    gzip_code = gzip.wait()
    if too_large:
        remove(output)
        return {"state": "too_large"}
    # GNU tar exits 1 when a file changed while it was read; the archive is still complete.
    if tar_code not in (0, 1) or gzip_code != 0 or size == 0:
        remove(output)
        return {"state": "failed", "reason": "archive_exit_%d_%d" % (tar_code, gzip_code)}
    return {"state": "done", "byteSize": size, "sha256": digest.hexdigest()}


def upload(spec):
    path = spec["file"]
    connection, target = https_target(spec["url"])
    if connection is None:
        return {"state": "failed", "reason": "insecure_url"}
    headers = dict(spec["headers"])
    headers["content-length"] = str(os.path.getsize(path))
    try:
        with open(path, "rb") as body:
            connection.request("PUT", target, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read(8192)
    finally:
        connection.close()
    if response.status != 200:
        return {"state": "failed", "reason": s3_error(response.status, payload)}
    remove(path)
    return {"state": "done"}


def restore(spec):
    path = spec["file"]
    remove(path)
    connection, target = https_target(spec["url"])
    if connection is None:
        return {"state": "failed", "reason": "insecure_url"}
    digest = hashlib.sha256()
    size = 0
    try:
        connection.request("GET", target)
        response = connection.getresponse()
        if response.status != 200:
            return {"state": "failed", "reason": s3_error(response.status, response.read(8192))}
        with open(path, "wb") as handle:
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > spec["byteSize"]:
                    break
                digest.update(chunk)
                handle.write(chunk)
    finally:
        connection.close()
    if size != spec["byteSize"] or digest.hexdigest() != spec["sha256"]:
        remove(path)
        return {"state": "failed", "reason": "digest_mismatch"}
    os.makedirs(spec["root"], exist_ok=True)
    code = subprocess.call(
        ["tar", "-C", spec["root"], "-xzf", path, "--no-same-owner"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    remove(path)
    if code != 0:
        return {"state": "failed", "reason": "extract_exit_%d" % code}
    return {"state": "done"}


def run(spec_path):
    job_dir = os.path.dirname(spec_path)
    try:
        with open(spec_path) as handle:
            spec = json.load(handle)
        remove(spec_path)
        result = {"archive": archive, "restore": restore, "upload": upload}[spec["op"]](spec)
    except OSError as error:
        result = {"state": "failed", "reason": "os_" + errno.errorcode.get(error.errno, "error")}
    except Exception as error:
        result = {"state": "failed", "reason": "unexpected_" + type(error).__name__}
    write_status(job_dir, result)


if __name__ == "__main__":
    {"run": run, "start": start, "status": status}[sys.argv[1]](sys.argv[2])
`;
