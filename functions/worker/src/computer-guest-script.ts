import { Schema } from "effect";

/**
 * Runs as `python3 -c <script> <json-args>` in the sandbox desktop image. It sends at most one
 * Cua Driver call for the action, waits `settleMs`, captures the desktop to `screenshotPath`, and
 * prints one JSON line described by `ComputerScriptOutput`.
 *
 * Every driver call uses desktop coordinates (`scope: "desktop"`) and one named session, so x and y
 * are pixels of the latest capture and the driver maps them back if it ever downsizes a capture.
 */

const NonNegativeInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

export const ComputerWindow = Schema.Struct({
  app: Schema.NullOr(Schema.String),
  height: Schema.Number,
  title: Schema.NullOr(Schema.String),
  width: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
});

export const ComputerScriptOutput = Schema.Union([
  Schema.Struct({ status: Schema.Literal("no_desktop") }),
  Schema.Struct({
    /** Present when the driver refused or failed the action; the capture still ran. */
    actionError: Schema.optional(Schema.String),
    /** For `launch`: whether the app showed a window before the call returned. */
    launchStatus: Schema.optional(Schema.Literals(["ready", "starting"])),
    screenHeight: NonNegativeInt,
    screenWidth: NonNegativeInt,
    status: Schema.Literal("ok"),
    windows: Schema.Array(ComputerWindow),
  }),
]);

/** The Cua Driver session every computer tool call shares. */
export const COMPUTER_DRIVER_SESSION = "deployments-ai-agent";

export const COMPUTER_SCRIPT = `
import json, os, shutil, subprocess, sys, time

SESSION = ${JSON.stringify(COMPUTER_DRIVER_SESSION)}
# Two driver calls plus the 5 s settle cap stay inside the worker's 30 s guest-script timeout. A
# launch skips the settle and waits up to LAUNCH_WAIT_SECONDS for its window instead, which leaves
# the capture its full driver timeout.
DRIVER_TIMEOUT_SECONDS = 8
LAUNCH_WAIT_SECONDS = float(os.environ.get("LAUNCH_WAIT_SECONDS", "18"))
LAUNCH_POLL_SECONDS = 1
MAX_ERROR_CHARACTERS = 1000


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")


def driver(tool, args, timeout=DRIVER_TIMEOUT_SECONDS):
    """Runs one Cua Driver tool; returns (structured result, None) or (None, error text)."""
    try:
        completed = subprocess.run(
            ["cua-driver", tool, json.dumps(args)],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None, tool + " timed out after " + str(round(timeout, 1)) + " s"
    output = completed.stdout.strip()
    if completed.returncode != 0:
        message = (completed.stderr.strip() or output or "exit " + str(completed.returncode))
        return None, message[:MAX_ERROR_CHARACTERS]
    # The CLI prints the structured result as JSON, then human-readable lines after it.
    try:
        value, _ = json.JSONDecoder().raw_decode(output)
    except ValueError:
        value = {}
    return (value if isinstance(value, dict) else {}), None


def desktop(args):
    return dict(args, scope="desktop", session=SESSION)


def driver_call(action):
    kind = action["action"]
    if kind in ("click", "double_click", "right_click"):
        args = {"x": action["x"], "y": action["y"]}
        if kind == "double_click":
            args["count"] = 2
        if kind == "right_click":
            args["button"] = "right"
        return "click", desktop(args)
    if kind == "move":
        return "move_cursor", desktop({"x": action["x"], "y": action["y"]})
    if kind == "drag":
        return "drag", desktop({
            "from_x": action["x"],
            "from_y": action["y"],
            "to_x": action["toX"],
            "to_y": action["toY"],
        })
    if kind == "type":
        return "type_text", desktop({"text": action["text"]})
    if kind == "key":
        return "press_key", desktop({"key": action["key"], "modifiers": action.get("modifiers", [])})
    if kind == "scroll":
        return "scroll", desktop({
            "x": action["x"],
            "y": action["y"],
            "direction": action["direction"],
            "amount": action.get("amount", 3),
        })
    raise ValueError("unknown action " + kind)


def window_pids(timeout):
    windows, error = driver("list_windows", {"session": SESSION}, timeout)
    if error is not None:
        return set()
    return {window.get("pid") for window in windows.get("windows", [])}


def process_tree(roots):
    """The pids of roots and their descendants; Firefox draws its windows from child processes."""
    children = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/" + entry + "/stat") as stat:
                parent = int(stat.read().rsplit(")", 1)[1].split()[1])
        except (OSError, IndexError, ValueError):
            continue
        children.setdefault(parent, []).append(int(entry))
    tree, pending = set(), list(roots)
    while pending:
        pid = pending.pop()
        tree.add(pid)
        pending.extend(children.get(pid, []))
    return tree


def running(app):
    """Pids of processes named app, such as an earlier launch still starting.

    /proc/<pid>/comm holds the program's own name (the kernel keeps 15 characters) for a binary
    and for a script run through its shebang alike, where cmdline would start with the interpreter.
    """
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/" + entry + "/comm") as comm:
                name = comm.read().strip()
        except OSError:
            continue
        if name == app[:15]:
            pids.append(int(entry))
    return pids


def wait_for_window(app, roots, process):
    """Waits up to LAUNCH_WAIT_SECONDS for a window of roots' process tree: (error, status).

    A launched process that exits 0 handed its request to an instance already running, as Firefox
    does, so from then on the wait watches every process named app.
    """
    deadline = time.monotonic() + LAUNCH_WAIT_SECONDS
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            if process.returncode != 0:
                return app + " exited with status " + str(process.returncode), None
            process, roots = None, running(app)
        if window_pids(max(0.5, deadline - time.monotonic())) & process_tree(roots):
            return None, "ready"
        time.sleep(LAUNCH_POLL_SECONDS)
    return None, "starting"


def launch(action):
    """Starts the app detached and waits up to LAUNCH_WAIT_SECONDS for one of its windows.

    Cua Driver's launch_app opens URLs through xdg-open, which the image does not ship, so the app
    starts here. Firefox's first window in a new sandbox takes about 50 s, longer than one call may
    wait, so an app that is running without a window yet is taken to be an earlier launch still
    starting: this call waits for it again instead of starting a second copy, which Firefox answers
    with a "Firefox is already running" dialog. The app outlives this script either way. Returns
    (error, launch_status), where launch_status is "ready" or "starting".
    """
    program = shutil.which(action["app"])
    if program is None:
        return "no app named " + action["app"] + " is installed", None
    starting = running(action["app"])
    if starting and not window_pids(DRIVER_TIMEOUT_SECONDS) & process_tree(starting):
        return wait_for_window(action["app"], starting, None)
    process = subprocess.Popen(
        [program] + ([action["url"]] if action.get("url") else []),
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return wait_for_window(action["app"], [process.pid], process)


def window_record(window):
    bounds = window.get("bounds") or window
    return {
        "app": window.get("app_name"),
        "height": bounds.get("height", 0),
        "title": window.get("title"),
        "width": bounds.get("width", 0),
        "x": bounds.get("x", 0),
        "y": bounds.get("y", 0),
    }


def main():
    args = json.loads(sys.argv[1])
    if shutil.which("cua-driver") is None:
        emit({"status": "no_desktop"})
        return
    screenshot_path = args["screenshotPath"]
    directory = os.path.dirname(screenshot_path)
    os.makedirs(directory, exist_ok=True)
    # Keep only this call's capture, so captures never accumulate in the sandbox.
    for name in os.listdir(directory):
        os.remove(os.path.join(directory, name))

    result = {"status": "ok"}
    action = args.get("action")
    if action is not None:
        if action["action"] == "launch":
            error, launch_status = launch(action)
            if launch_status is not None:
                result["launchStatus"] = launch_status
        else:
            tool, tool_args = driver_call(action)
            _, error = driver(tool, tool_args)
            time.sleep(args["settleMs"] / 1000)
        if error is not None:
            result["actionError"] = error

    state, error = driver("get_desktop_state", {"session": SESSION, "screenshot_out_file": screenshot_path})
    if error is not None or not os.path.isfile(screenshot_path):
        sys.stderr.write("Desktop capture failed: " + (error or "no screenshot was written") + "\\n")
        sys.exit(1)
    result["screenWidth"] = int(state.get("screenshot_width", 0))
    result["screenHeight"] = int(state.get("screenshot_height", 0))
    result["windows"] = [window_record(window) for window in state.get("windows", [])]
    emit(result)


main()
`;
