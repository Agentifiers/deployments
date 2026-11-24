#!/usr/bin/env python3
import ctypes
import errno
import json
import os
import selectors
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("SANDBOX_CONTROL_HOST", "0.0.0.0")
PORT = int(os.environ.get("SANDBOX_CONTROL_PORT", "8080"))
WORKSPACE = Path(os.environ.get("SANDBOX_WORKSPACE", "/workspace"))
PATH_PREFIX = "/__sandbox"
LAMBDA_READY_PATH = "/aws/lambda-microvms/runtime/v1/ready"
LAMBDA_VALIDATE_PATH = "/aws/lambda-microvms/runtime/v1/validate"
LAMBDA_RUNTIME_HOOK_PATHS = {
    "/aws/lambda-microvms/runtime/v1/run",
    "/aws/lambda-microvms/runtime/v1/resume",
    "/aws/lambda-microvms/runtime/v1/suspend",
    "/aws/lambda-microvms/runtime/v1/terminate",
}
LAMBDA_HOOK_PATHS = {LAMBDA_READY_PATH, LAMBDA_VALIDATE_PATH, *LAMBDA_RUNTIME_HOOK_PATHS}
MAX_FILE_TRANSFER_BYTES = 64 * 1024 * 1024
MAX_JSON_BODY_BYTES = 1024 * 1024
MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_COMMAND_TIMEOUT_MS = int(os.environ.get("SANDBOX_CONTROL_EXEC_TIMEOUT_MS", "50000"))
CLONE_NEWUSER = 0x10000000
CLONE_NEWNET = 0x40000000
NETWORK_ISOLATION_UNAVAILABLE = "Network isolation is unavailable in this sandbox."
BROWSER_WARM_UP_COMMAND = ["node", "/opt/agent-sandbox/browser/driver.ts", "warm"]


class RequestBodyTooLarge(ValueError):
    pass


class NetworkIsolationUnavailable(RuntimeError):
    pass


class BrowserWarmUp:
    """One browser launch on the image's validation MicroVM.

    A MicroVM restores its image snapshot lazily, so the first browser job in a fresh MicroVM read
    about 350 MiB of Chromium, fonts, and Node modules at 10-20 MiB/s. Lambda records the snapshot
    regions read during /validate and prefetches them when later MicroVMs start.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._process = None

    def exit_code(self):
        """Starts the warm-up on first call; None while it runs."""
        with self._lock:
            if self._process is None:
                self._process = subprocess.Popen(BROWSER_WARM_UP_COMMAND, stdin=subprocess.DEVNULL)
            return self._process.poll()


BROWSER_WARM_UP = BrowserWarmUp()


def write_own_process_file(name, content):
    descriptor = os.open(f"/proc/self/{name}", os.O_WRONLY)
    try:
        os.write(descriptor, content.encode("ascii"))
    finally:
        os.close(descriptor)


def own_network_interfaces():
    # /proc/self/net follows the calling process's network namespace; /sys/class/net does not
    # (it shows the namespace sysfs was mounted in).
    with open("/proc/self/net/dev", encoding="ascii") as interfaces:
        return sorted(line.split(":", 1)[0].strip() for line in interfaces.readlines()[2:])


def network_namespace_preexec():
    try:
        unshare = ctypes.CDLL(None, use_errno=True).unshare
    except (AttributeError, OSError) as error:
        raise NetworkIsolationUnavailable(NETWORK_ISOLATION_UNAVAILABLE) from error
    unshare.argtypes = [ctypes.c_int]
    unshare.restype = ctypes.c_int
    uid = os.geteuid()
    gid = os.getegid()

    # Runs in the forked child before exec; a failure aborts the exec so the command never runs.
    def enter_network_namespace():
        # The new network namespace is owned by a new user namespace created in the same call, so
        # this needs no CAP_SYS_ADMIN (Lambda MicroVM guests run without it). The command keeps its
        # own uid and gid, mapped one-to-one, and holds privileges only over its own namespaces:
        # it cannot reach or move the guest's interfaces.
        if unshare(CLONE_NEWUSER | CLONE_NEWNET) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        write_own_process_file("setgroups", "deny")
        write_own_process_file("uid_map", f"{uid} {uid} 1\n")
        write_own_process_file("gid_map", f"{gid} {gid} 1\n")
        # Verify rather than assume: a fresh network namespace holds only its (down) loopback.
        if own_network_interfaces() != ["lo"]:
            raise OSError(errno.EPERM, "The command's network namespace is not empty.")

    return enter_network_namespace


def json_bytes(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def read_json_body(handler):
    body = b"".join(
        iter_request_body(
            handler,
            maximum_bytes=MAX_JSON_BODY_BYTES,
            too_large_message="Request body is too large",
        )
    )
    if not body:
        return {}
    return json.loads(body)


def request_path(handler):
    return urlparse(handler.path)


# Browsers attach `Origin` to page-initiated POST, PUT, and WebSocket requests and `Sec-Fetch-Site`
# to requests for trustworthy (loopback) URLs; server-side fetch clients such as the worker's never
# send either (undici adds only `Sec-Fetch-Mode`).
BROWSER_REQUEST_HEADERS = ("origin", "sec-fetch-site")


def browser_originated(handler):
    return any(handler.headers.get(name) is not None for name in BROWSER_REQUEST_HEADERS)


def requested_file_path(handler):
    parsed = request_path(handler)
    query = parse_qs(parsed.query)
    raw_path = (query.get("path") or [""])[0]
    if not raw_path:
        raise ValueError("Missing required path query parameter")
    return Path(raw_path)


def read_exact(handler, length):
    chunks = []
    remaining = length
    while remaining > 0:
        chunk = handler.rfile.read(min(remaining, 1024 * 1024))
        if not chunk:
            raise ValueError("Request body ended before the declared length")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def iter_request_body(
    handler,
    maximum_bytes=MAX_FILE_TRANSFER_BYTES,
    too_large_message="Sandbox file exceeds the transfer limit",
):
    transfer_encoding = (handler.headers.get("transfer-encoding") or "").lower().strip()
    content_length = handler.headers.get("content-length")
    transferred = 0

    if transfer_encoding:
        if transfer_encoding != "chunked":
            raise ValueError("Unsupported Transfer-Encoding")
        while True:
            size_line = handler.rfile.readline(8192)
            if not size_line or not size_line.endswith(b"\r\n"):
                raise ValueError("Invalid chunked request body")
            size = int(size_line.split(b";", 1)[0].strip(), 16)
            if size == 0:
                while True:
                    trailer = handler.rfile.readline(8192)
                    if trailer in (b"\r\n", b""):
                        return

            transferred += size
            if transferred > maximum_bytes:
                raise RequestBodyTooLarge(too_large_message)
            yield read_exact(handler, size)
            if handler.rfile.read(2) != b"\r\n":
                raise ValueError("Invalid chunk terminator")

    if content_length is None:
        raise ValueError("Content-Length or chunked Transfer-Encoding is required")
    remaining = int(content_length)
    if remaining < 0 or remaining > maximum_bytes:
        raise RequestBodyTooLarge(too_large_message)
    while remaining > 0:
        chunk = handler.rfile.read(min(remaining, 1024 * 1024))
        if not chunk:
            raise ValueError("Request body ended before the declared length")
        remaining -= len(chunk)
        yield chunk


def terminate_process_group(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=1)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    process.wait()


def bounded_command_timeout_ms(value):
    if value is None:
        return MAX_COMMAND_TIMEOUT_MS
    if not isinstance(value, (int, float)) or value <= 0:
        raise ValueError("timeoutMs must be positive")
    return min(int(value), MAX_COMMAND_TIMEOUT_MS)


def append_bounded(buffer, chunk, remaining):
    captured = chunk[:remaining]
    buffer.extend(captured)
    return len(captured), len(chunk) > remaining


def run_bounded_command(command, cwd, env, timeout_ms, isolate_network):
    started = time.monotonic()
    preexec_fn = network_namespace_preexec() if isolate_network else None
    try:
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=preexec_fn,
        )
    except subprocess.SubprocessError as error:
        if isolate_network:
            raise NetworkIsolationUnavailable(NETWORK_ISOLATION_UNAVAILABLE) from error
        raise
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    output = {"stdout": bytearray(), "stderr": bytearray()}
    captured_bytes = 0
    deadline = started + timeout_ms / 1000
    termination = None

    try:
        while selector.get_map():
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                termination = "timeout"
                break
            events = selector.select(timeout=min(0.1, remaining_seconds))
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                captured, exceeded = append_bounded(
                    output[key.data],
                    chunk,
                    max(0, MAX_COMMAND_OUTPUT_BYTES - captured_bytes),
                )
                captured_bytes += captured
                if exceeded:
                    termination = "output_limit"
                    break
            if termination:
                break
    finally:
        selector.close()

    if termination:
        terminate_process_group(process)
    else:
        try:
            process.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            termination = "timeout"
            terminate_process_group(process)

    stderr = output["stderr"].decode("utf-8", errors="replace")
    if termination == "timeout":
        exit_code = 124
        stderr = stderr or "Command timed out"
    elif termination == "output_limit":
        exit_code = 137
        stderr = f"{stderr}\nCommand output exceeded the sandbox limit.".lstrip()
    else:
        exit_code = process.returncode if process.returncode >= 0 else 128 - process.returncode

    return {
        "exitCode": exit_code,
        "stdout": output["stdout"].decode("utf-8", errors="replace"),
        "stderr": stderr,
        "durationMs": int((time.monotonic() - started) * 1000),
    }


class SandboxControlHandler(BaseHTTPRequestHandler):
    server_version = "DeploymentsSandboxControl/1.0"

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def send_json(self, status, value):
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json(status, {"error": message})

    def send_hook_ready(self):
        self.send_json(200, {"ok": True})

    def send_hook_response(self, path):
        if path != LAMBDA_VALIDATE_PATH:
            self.send_hook_ready()
            return
        try:
            exit_code = BROWSER_WARM_UP.exit_code()
        except OSError as error:
            self.send_error_json(500, f"Browser warm-up did not start: {error}")
            return
        if exit_code is None:
            self.send_json(503, {"ok": False})
        elif exit_code == 0:
            self.send_hook_ready()
        else:
            self.send_error_json(500, f"Browser warm-up exited with status {exit_code}")

    def do_GET(self):
        parsed = request_path(self)
        if parsed.path.startswith(PATH_PREFIX) and browser_originated(self):
            self.send_error_json(403, "Browser requests cannot reach the sandbox control server")
            return
        if parsed.path == f"{PATH_PREFIX}/health":
            self.send_hook_ready()
            return
        if parsed.path in LAMBDA_HOOK_PATHS:
            self.send_hook_response(parsed.path)
            return

        if parsed.path == f"{PATH_PREFIX}/files":
            try:
                file_path = requested_file_path(self)
                if not file_path.is_file():
                    self.send_error_json(404, "File not found")
                    return
                file_size = file_path.stat().st_size
                if file_size > MAX_FILE_TRANSFER_BYTES:
                    self.send_error_json(413, "Sandbox file exceeds the transfer limit")
                    return
                self.send_response(200)
                self.send_header("content-length", str(file_size))
                self.end_headers()
                with file_path.open("rb") as file:
                    while True:
                        chunk = file.read(1024 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except Exception as error:
                self.send_error_json(400, str(error))
            return

        self.send_error_json(404, "Not found")

    def do_PUT(self):
        parsed = request_path(self)
        if browser_originated(self):
            self.send_error_json(403, "Browser requests cannot reach the sandbox control server")
            return
        if parsed.path != f"{PATH_PREFIX}/files":
            self.send_error_json(404, "Not found")
            return

        try:
            file_path = requested_file_path(self)
            file_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = None
            try:
                with tempfile.NamedTemporaryFile(
                    dir=file_path.parent,
                    prefix=f".{file_path.name}.",
                    delete=False,
                ) as file:
                    temporary_path = Path(file.name)
                    for chunk in iter_request_body(self):
                        file.write(chunk)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temporary_path, file_path)
            except Exception:
                if temporary_path:
                    temporary_path.unlink(missing_ok=True)
                raise
            self.send_response(204)
            self.end_headers()
        except RequestBodyTooLarge as error:
            self.send_error_json(413, str(error))
        except Exception as error:
            self.send_error_json(400, str(error))

    def do_POST(self):
        parsed = request_path(self)
        if parsed.path.startswith(PATH_PREFIX) and browser_originated(self):
            self.send_error_json(403, "Browser requests cannot reach the sandbox control server")
            return
        if parsed.path in LAMBDA_HOOK_PATHS:
            self.send_hook_response(parsed.path)
            return

        # Isolation is its own route, never a body field: a guest image that predates it answers
        # 404, so an isolation request can never silently run with the sandbox's egress.
        if parsed.path == f"{PATH_PREFIX}/exec-isolated":
            isolate_network = True
        elif parsed.path == f"{PATH_PREFIX}/exec":
            isolate_network = False
        else:
            self.send_error_json(404, "Not found")
            return

        try:
            body = read_json_body(self)
            command = body.get("command")
            if (
                not isinstance(command, list)
                or not command
                or not all(isinstance(part, str) and part for part in command)
            ):
                self.send_error_json(400, "command must be a non-empty array of non-empty strings")
                return

            if "network" in body:
                self.send_error_json(
                    400, f"network is not an exec field; use POST {PATH_PREFIX}/exec-isolated"
                )
                return

            cwd = Path(body.get("cwd") or WORKSPACE)
            cwd.mkdir(parents=True, exist_ok=True)
            env = os.environ.copy()
            requested_env = body.get("env") or {}
            if isinstance(requested_env, dict):
                env.update({str(key): str(value) for key, value in requested_env.items()})

            self.send_json(
                200,
                run_bounded_command(
                    command,
                    cwd,
                    env,
                    bounded_command_timeout_ms(body.get("timeoutMs")),
                    isolate_network,
                ),
            )
        except NetworkIsolationUnavailable as error:
            # 4xx: the command provably did not run, so callers treat the outcome as deterministic.
            self.send_error_json(422, str(error))
        except RequestBodyTooLarge as error:
            self.send_error_json(413, str(error))
        except Exception as error:
            self.send_error_json(500, str(error))


def main():
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), SandboxControlHandler)
    print(f"Sandbox control server listening on {HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
