import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  COMPUTER_DRIVER_SESSION,
  COMPUTER_SCRIPT,
  ComputerScriptOutput,
} from "./computer-guest-script.ts";

const python = Bun.which("python3");
let root = "";

/**
 * A stand-in for the `cua-driver` CLI: it logs each call's tool and JSON args, prints the
 * structured result Cua Driver prints followed by a human-readable line, and writes a PNG for
 * get_desktop_state. FAIL_TOOL makes one tool exit 1 the way the CLI does on an isError result.
 */
function installFakeDriver() {
  const bin = join(root, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const driver = join(bin, "cua-driver");
  writeFileSync(
    driver,
    `#!/usr/bin/env python3
import json, os, sys
tool, args = sys.argv[1], json.loads(sys.argv[2])
with open(os.environ["CALLS"], "a") as log:
    log.write(json.dumps({"tool": tool, "args": args}) + "\\n")
if tool == os.environ.get("FAIL_TOOL"):
    sys.stderr.write("background_unavailable: no foreground window\\n")
    sys.exit(1)
if tool == "list_windows":
    # WINDOW_PID_FILE names a file the fake app writes its pid to once its "window" is up.
    pid_file = os.environ.get("WINDOW_PID_FILE", "")
    windows = []
    if pid_file and os.path.exists(pid_file):
        with open(pid_file) as handle:
            windows = [{"window_id": 7, "pid": int(handle.read()), "app_name": "firefox", "title": "Firefox"}]
    print(json.dumps({"windows": windows}))
    print("Found windows")
elif tool == "get_desktop_state":
    with open(args["screenshot_out_file"], "wb") as png:
        png.write(b"\\x89PNG fake")
    print(json.dumps({"screenshot_width": 1280, "screenshot_height": 800, "windows": [
        {"window_id": 4, "pid": 9, "app_name": "firefox", "title": "Example", "bounds": {"x": 0, "y": 30, "width": 1280, "height": 770}}
    ]}, indent=2))
    print("Desktop screenshot 1280x800 written")
else:
    print(json.dumps({"ok": True}))
    print("Done.")
`,
  );
  chmodSync(driver, 0o755);
  return bin;
}

function run(args: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string>> = {}) {
  const result = Bun.spawnSync([python!, "-c", COMPUTER_SCRIPT, JSON.stringify(args)], {
    env: { CALLS: join(root, "calls.jsonl"), PATH: `${installFakeDriver()}:/usr/bin:/bin`, ...env },
  });
  return {
    exitCode: result.exitCode,
    output:
      result.exitCode === 0
        ? Schema.decodeUnknownSync(ComputerScriptOutput)(JSON.parse(result.stdout.toString()))
        : undefined,
    stderr: result.stderr.toString(),
  };
}

function calls(): { readonly args: Record<string, unknown>; readonly tool: string }[] {
  const path = join(root, "calls.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

describe.skipIf(!python)("computer guest script", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computer-script-"));
  });
  afterEach(() => rmSync(root, { force: true, recursive: true }));

  test("maps each action to one desktop-scoped driver call, then captures the desktop", () => {
    const screenshotPath = join(root, "shots", "call.png");
    const cases = [
      [{ action: "click", x: 10, y: 20 }, "click", { x: 10, y: 20 }],
      [{ action: "double_click", x: 1, y: 2 }, "click", { count: 2, x: 1, y: 2 }],
      [{ action: "right_click", x: 1, y: 2 }, "click", { button: "right", x: 1, y: 2 }],
      [{ action: "move", x: 5, y: 6 }, "move_cursor", { x: 5, y: 6 }],
      [
        { action: "drag", toX: 30, toY: 40, x: 10, y: 20 },
        "drag",
        { from_x: 10, from_y: 20, to_x: 30, to_y: 40 },
      ],
      [{ action: "type", text: "héllo" }, "type_text", { text: "héllo" }],
      [
        { action: "key", key: "l", modifiers: ["ctrl"] },
        "press_key",
        { key: "l", modifiers: ["ctrl"] },
      ],
      [
        { action: "scroll", amount: 5, direction: "down", x: 7, y: 8 },
        "scroll",
        { amount: 5, direction: "down", x: 7, y: 8 },
      ],
    ] as const;
    for (const [action, tool, args] of cases) {
      rmSync(join(root, "calls.jsonl"), { force: true });
      const result = run({ action, screenshotPath, settleMs: 0 });
      expect(result.stderr).toBe("");
      expect(calls()).toEqual([
        { args: { ...args, scope: "desktop", session: COMPUTER_DRIVER_SESSION }, tool },
        {
          args: { screenshot_out_file: screenshotPath, session: COMPUTER_DRIVER_SESSION },
          tool: "get_desktop_state",
        },
      ]);
    }
  });

  test("launches an app detached with its URL and waits for a window of its process tree", async () => {
    const bin = join(root, "bin");
    const marker = join(root, "launched");
    const pidFile = join(root, "window-pid");
    Bun.spawnSync(["mkdir", "-p", bin]);
    // Like Firefox, the launched process draws its window from a child after a delay, and both
    // keep running past the call.
    writeFileSync(
      join(bin, "firefox"),
      `#!/bin/sh\necho "$@" > "${marker}"\n(sleep 1.5; sh -c 'echo $$ > "${pidFile}"; sleep 5') &\nsleep 5\n`,
    );
    chmodSync(join(bin, "firefox"), 0o755);
    const screenshotPath = join(root, "shots", "a.png");

    const started = Date.now();
    const launched = run(
      {
        action: { action: "launch", app: "firefox", url: "https://example.com/" },
        screenshotPath,
        settleMs: 0,
      },
      { WINDOW_PID_FILE: pidFile },
    );
    const elapsed = Date.now() - started;

    expect(launched.output).toMatchObject({ launchStatus: "ready", status: "ok" });
    expect(launched.output).not.toHaveProperty("actionError");
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(6_000);
    expect(readFileSync(marker, "utf8")).toBe("https://example.com/\n");
    const tools = calls().map((call) => call.tool);
    expect(tools.at(-1)).toBe("get_desktop_state");
    expect(tools.slice(0, -1).every((tool) => tool === "list_windows")).toBe(true);
  });

  test("a second launch while the first is still starting waits for it instead of starting another", async () => {
    const bin = join(root, "bin");
    const starts = join(root, "starts");
    const pidFile = join(root, "window-pid");
    Bun.spawnSync(["mkdir", "-p", bin]);
    // Run straight through its shebang, the script keeps its own name as the process name, as the
    // real binary does; it shows its window 2.5 s after it starts.
    writeFileSync(
      join(bin, "slowapp"),
      `#!${python}\nimport os, time\nopen("${starts}", "a").write("start\\n")\ntime.sleep(2.5)\nopen("${pidFile}", "w").write(str(os.getpid()))\ntime.sleep(5)\n`,
    );
    chmodSync(join(bin, "slowapp"), 0o755);
    const args = (path: string) => ({
      action: { action: "launch", app: "slowapp" },
      screenshotPath: join(root, "shots", path),
      settleMs: 0,
    });

    const first = run(args("a.png"), { LAUNCH_WAIT_SECONDS: "1", WINDOW_PID_FILE: pidFile });
    const second = run(args("b.png"), { LAUNCH_WAIT_SECONDS: "5", WINDOW_PID_FILE: pidFile });

    expect(first.output).toMatchObject({ launchStatus: "starting" });
    expect(second.output).toMatchObject({ launchStatus: "ready" });
    expect(readFileSync(starts, "utf8")).toBe("start\n");
  });

  test("a launch that an open instance takes over is ready at once", () => {
    const bin = join(root, "bin");
    const pidFile = join(root, "window-pid");
    const instanceDir = join(root, "instance");
    Bun.spawnSync(["mkdir", "-p", bin, instanceDir]);
    // The open instance, named like the app, already shows a window.
    writeFileSync(
      join(instanceDir, "handoff"),
      `#!${python}\nimport os, time\nopen("${pidFile}", "w").write(str(os.getpid()))\ntime.sleep(10)\n`,
    );
    chmodSync(join(instanceDir, "handoff"), 0o755);
    const instance = Bun.spawn([join(instanceDir, "handoff")]);
    // Like a second `firefox <url>`, the launched process hands its URL over and exits 0.
    writeFileSync(join(bin, "handoff"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "handoff"), 0o755);
    try {
      for (let waited = 0; !existsSync(pidFile) && waited < 5_000; waited += 50) {
        Bun.sleepSync(50);
      }
      const started = Date.now();
      const result = run(
        {
          action: { action: "launch", app: "handoff", url: "https://example.com/" },
          screenshotPath: join(root, "shots", "a.png"),
          settleMs: 0,
        },
        { LAUNCH_WAIT_SECONDS: "5", WINDOW_PID_FILE: pidFile },
      );
      expect(result.output).toMatchObject({ launchStatus: "ready" });
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      instance.kill();
    }
  });

  test("does not take another process's window as the launched app's", () => {
    const bin = join(root, "bin");
    const pidFile = join(root, "window-pid");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "xterm"), "#!/bin/sh\nsleep 5\n");
    chmodSync(join(bin, "xterm"), 0o755);
    // A window that belongs to this test runner, not to anything the script launched.
    writeFileSync(pidFile, String(process.pid));

    const result = run(
      {
        action: { action: "launch", app: "xterm" },
        screenshotPath: join(root, "shots", "a.png"),
        settleMs: 0,
      },
      { LAUNCH_WAIT_SECONDS: "2", WINDOW_PID_FILE: pidFile },
    );

    expect(result.output).toMatchObject({ launchStatus: "starting", status: "ok" });
  });

  test("reports a missing app and an app that exits with an error", () => {
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "crashapp"), "#!/bin/sh\nexit 3\n");
    chmodSync(join(bin, "crashapp"), 0o755);
    const screenshotPath = join(root, "shots", "a.png");

    const missing = run({ action: { action: "launch", app: "gimp" }, screenshotPath, settleMs: 0 });
    const crashed = run({
      action: { action: "launch", app: "crashapp" },
      screenshotPath,
      settleMs: 0,
    });

    expect(missing.output).toMatchObject({ actionError: "no app named gimp is installed" });
    expect(missing.output).not.toHaveProperty("launchStatus");
    expect(crashed.output).toMatchObject({ actionError: "crashapp exited with status 3" });
  });

  test("reports the screen, windows, and a fresh capture, and removes earlier captures", () => {
    const shots = join(root, "shots");
    const screenshotPath = join(shots, "second.png");
    Bun.spawnSync(["mkdir", "-p", shots]);
    writeFileSync(join(shots, "first.png"), "old");

    const result = run({ screenshotPath, settleMs: 0 });

    expect(result.output).toEqual({
      screenHeight: 800,
      screenWidth: 1280,
      status: "ok",
      windows: [{ app: "firefox", height: 770, title: "Example", width: 1280, x: 0, y: 30 }],
    });
    expect(calls().map(({ tool }) => tool)).toEqual(["get_desktop_state"]);
    expect(existsSync(join(shots, "first.png"))).toBe(false);
    expect(readFileSync(screenshotPath, "latin1")).toBe("\x89PNG fake");
  });

  test("still captures the desktop when the driver refuses the action", () => {
    const result = run(
      {
        action: { action: "click", x: 1, y: 2 },
        screenshotPath: join(root, "s", "a.png"),
        settleMs: 0,
      },
      { FAIL_TOOL: "click" },
    );
    expect(result.output).toMatchObject({
      actionError: "background_unavailable: no foreground window",
      status: "ok",
    });
    expect(calls().map(({ tool }) => tool)).toEqual(["click", "get_desktop_state"]);
  });

  test("fails when the desktop cannot be captured", () => {
    const result = run(
      { screenshotPath: join(root, "s", "a.png"), settleMs: 0 },
      { FAIL_TOOL: "get_desktop_state" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Desktop capture failed: background_unavailable");
  });

  test("reports no_desktop on an image without Cua Driver", () => {
    const result = Bun.spawnSync(
      [
        python!,
        "-c",
        COMPUTER_SCRIPT,
        JSON.stringify({ screenshotPath: join(root, "a.png"), settleMs: 0 }),
      ],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    expect(JSON.parse(result.stdout.toString())).toEqual({ status: "no_desktop" });
  });
});
