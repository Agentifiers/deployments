// Sandbox browser job driver (Node 26 type stripping):
//   node driver.ts start <jobDir>   → {"state":"started"}; spawns a detached `run`
//   node driver.ts status <jobDir>  → {"state":"running"|"done"|"failed"|"missing", ...}
//   node driver.ts run <jobDir>     → internal; executes <jobDir>/spec.json and writes status.json
//   node driver.ts warm             → one launch and render; exits 0 once Chromium has rendered
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  BROWSER_LAUNCH_TIMEOUT_MS,
  failureStatus,
  parseBrowserJobSpec,
  publicFailureMessage,
} from "./job-rules.ts";

const SPEC_FILE = "spec.json";
const STATUS_FILE = "status.json";
const PID_FILE = "run.pid";
const OUTPUT_FILES = [
  STATUS_FILE,
  PID_FILE,
  "result.json",
  "dom.html",
  "screenshot.png",
  "screenshot.jpeg",
  "screenshot.webp",
];
/** Time allowed past the page deadline for closing Chromium before the watchdog gives up. */
const CLEANUP_GRACE_MS = 15_000;
const PREVIOUS_JOB_TERMINATION_MS = 5_000;

type JobStatus =
  | { readonly state: "done" }
  | { readonly code: string; readonly message: string; readonly state: "failed" };

function print(value: object) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeStatus(jobDirectory: string, status: JobStatus) {
  const target = join(jobDirectory, STATUS_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(status));
  renameSync(temporary, target);
}

/** The pid is live and still this driver's `run` for the job directory (guards against pid reuse). */
function isJobProcess(pid: number, jobDirectory: string) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const commandLinePath = `/proc/${pid}/cmdline`;
  if (!existsSync(commandLinePath)) return true;
  const argv = readFileSync(commandLinePath, "utf8").split("\0");
  return argv.includes("run") && argv.includes(jobDirectory);
}

function readJobPid(jobDirectory: string) {
  try {
    const pid = Number(readFileSync(join(jobDirectory, PID_FILE), "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function stopPreviousJob(jobDirectory: string) {
  const pid = readJobPid(jobDirectory);
  if (pid === undefined || !isJobProcess(pid, jobDirectory)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + PREVIOUS_JOB_TERMINATION_MS;
  while (Date.now() < deadline && isJobProcess(pid, jobDirectory)) await sleep(100);
  if (isJobProcess(pid, jobDirectory)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
}

async function start(jobDirectory: string) {
  mkdirSync(jobDirectory, { recursive: true });
  await stopPreviousJob(jobDirectory);
  for (const file of OUTPUT_FILES) rmSync(join(jobDirectory, file), { force: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", jobDirectory], {
    cwd: jobDirectory,
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("Browser job process did not start.");
  writeFileSync(join(jobDirectory, PID_FILE), String(child.pid));
  child.unref();
  print({ state: "started" });
}

function status(jobDirectory: string) {
  try {
    print(JSON.parse(readFileSync(join(jobDirectory, STATUS_FILE), "utf8")));
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const pid = readJobPid(jobDirectory);
  if (pid === undefined) {
    print({ state: "missing" });
    return;
  }
  // Re-check status.json: the job may have finished between the two reads.
  if (existsSync(join(jobDirectory, STATUS_FILE))) {
    status(jobDirectory);
    return;
  }
  print(
    isJobProcess(pid, jobDirectory)
      ? { state: "running" }
      : {
          code: "job_exited",
          message: "Browser job process exited without a status.",
          state: "failed",
        },
  );
}

async function run(jobDirectory: string) {
  const startedAt = Date.now();
  let emergencyCleanup: (() => void) | undefined;
  const abort = (failure: JobStatus, exitCode: number) => {
    try {
      emergencyCleanup?.();
    } finally {
      writeStatus(jobDirectory, failure);
      process.exit(exitCode);
    }
  };
  process.once("SIGTERM", () =>
    abort({ code: "internal", message: "Browser job was terminated.", state: "failed" }, 143),
  );
  try {
    const spec = parseBrowserJobSpec(
      await readFile(join(jobDirectory, SPEC_FILE), "utf8").catch(() => ""),
    );
    setTimeout(
      () => abort({ code: "timeout", message: "Browser job timed out.", state: "failed" }, 1),
      startedAt + BROWSER_LAUNCH_TIMEOUT_MS + spec.input.timeoutMs + CLEANUP_GRACE_MS - Date.now(),
    ).unref();
    // Loaded only here so `start`/`status` polls stay cheap (no puppeteer import).
    const { runCaptureJob, runSessionJob } = await import("./browser-jobs.ts");
    const context = {
      jobDirectory,
      registerEmergencyCleanup: (cleanup: () => void) => {
        emergencyCleanup = cleanup;
      },
      targets: {
        allowedOrigins: new Set(spec.allowedOrigins),
        anyPublicOrigin: spec.anyPublicOrigin,
      },
    };
    if (spec.kind === "capture") await runCaptureJob(context, spec.input);
    else await runSessionJob(context, spec.input);
    writeStatus(jobDirectory, { state: "done" });
  } catch (error) {
    writeStatus(jobDirectory, failureStatus(error));
  }
  process.exit(0);
}

async function warm() {
  const { runWarmUp } = await import("./browser-jobs.ts");
  await runWarmUp();
  process.exit(0);
}

const [command, jobDirectoryArgument] = process.argv.slice(2);
try {
  if (command === "warm") {
    await warm();
  } else if (jobDirectoryArgument && ["run", "start", "status"].includes(command ?? "")) {
    const jobDirectory = resolve(jobDirectoryArgument);
    if (command === "start") await start(jobDirectory);
    else if (command === "status") status(jobDirectory);
    else await run(jobDirectory);
  } else {
    process.stderr.write("usage: node driver.ts <start|status|run> <jobDir> | warm\n");
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(
    `${publicFailureMessage(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exit(1);
}
