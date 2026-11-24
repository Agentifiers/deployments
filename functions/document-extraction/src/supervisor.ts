import { execFile, spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  childStdoutLimit,
  decodeChildOutput,
  encodeChildInput,
  SANDBOX_UNAVAILABLE_EXIT_CODE,
  type ChildInput,
} from "./child-protocol.ts";
import type { ChildResult, ExtractedDocument } from "./engine/registry.ts";
import { LIMITS } from "./limits.ts";

const NODE_INVALID_ARGUMENT_EXIT_CODE = 9;

export class ExtractionEnvironmentError extends Error {
  override readonly name = "ExtractionEnvironmentError";
}

export interface ChildLimits {
  readonly deadlineMs: number;
  readonly maxResidentBytes: number;
}

export interface ChildRun extends ChildInput {
  readonly program: ChildProgram;
  readonly limits: ChildLimits;
}

export interface ChildProgram {
  readonly nodePath: string;
  readonly entry: string;
}

type Termination = "deadline" | "memory" | "output";

const runFile = promisify(execFile);

async function residentBytes(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const kib = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1];
    return kib === undefined ? undefined : Number(kib) * 1024;
  }
  const { stdout } = await runFile("ps", ["-o", "rss=", "-p", String(pid)]).catch(() => ({
    stdout: "",
  }));
  const kib = Number.parseInt(stdout.trim(), 10);
  return Number.isNaN(kib) ? undefined : kib * 1024;
}

const unusable = (reason: "limits_exceeded" | "unreadable", detail: string): ExtractedDocument => ({
  status: "unusable",
  reason,
  detail,
});

function terminationVerdict(
  termination: Termination,
  limits: ChildLimits & { readonly maxStdoutBytes: number },
) {
  switch (termination) {
    case "deadline":
      return unusable(
        "limits_exceeded",
        `extraction did not finish within ${limits.deadlineMs} ms`,
      );
    case "memory":
      return unusable(
        "limits_exceeded",
        `extraction used more than ${limits.maxResidentBytes} bytes of memory`,
      );
    case "output":
      return unusable(
        "limits_exceeded",
        `extraction wrote more than ${limits.maxStdoutBytes} bytes`,
      );
    default: {
      const unhandled: never = termination;
      return unhandled;
    }
  }
}

export function runChild(
  input: ChildRun & { readonly scans: "ignore" },
): Promise<ExtractedDocument>;
export function runChild(input: ChildRun): Promise<ChildResult>;
export async function runChild(input: ChildRun): Promise<ChildResult> {
  const { program } = input;
  const limits = { ...input.limits, maxStdoutBytes: childStdoutLimit(input.scans) };
  // The permission model checks real paths, so a symlinked directory (macOS /tmp) would deny the
  // child its own entry script.
  const entry = await realpath(program.entry);
  const child = spawn(
    program.nodePath,
    [
      "--permission",
      `--allow-fs-read=${dirname(entry)}/*`,
      "--disallow-code-generation-from-strings",
      `--max-old-space-size=${LIMITS.child.maxOldSpaceMiB}`,
      entry,
    ],
    { env: {}, stdio: ["pipe", "pipe", "ignore"] },
  );
  let termination: Termination | undefined;
  const terminate = (reason: Termination) => {
    if (termination !== undefined) return;
    termination = reason;
    child.kill("SIGKILL");
  };

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > limits.maxStdoutBytes) terminate("output");
    else stdout.push(chunk);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(encodeChildInput(input));

  const deadline = setTimeout(() => terminate("deadline"), limits.deadlineMs);
  let exited = false;
  const watch = async () => {
    if (exited || child.pid === undefined) return;
    const resident = await residentBytes(child.pid);
    if (resident !== undefined && resident > limits.maxResidentBytes) terminate("memory");
    if (!exited) watchdog = setTimeout(watch, LIMITS.child.residentPollMs);
  };
  let watchdog = setTimeout(watch, LIMITS.child.residentPollMs);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", (cause) =>
        reject(new ExtractionEnvironmentError("The extraction child could not start.", { cause })),
      );
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => {
    exited = true;
    clearTimeout(deadline);
    clearTimeout(watchdog);
  });

  if (termination !== undefined) return terminationVerdict(termination, limits);
  if (
    exit.code === SANDBOX_UNAVAILABLE_EXIT_CODE ||
    exit.code === NODE_INVALID_ARGUMENT_EXIT_CODE
  ) {
    throw new ExtractionEnvironmentError(
      `The extraction child refused to run unsandboxed (exit ${exit.code}).`,
    );
  }
  if (exit.signal !== null) {
    return unusable("limits_exceeded", `the parser was stopped by ${exit.signal}`);
  }
  if (exit.code !== 0) return unusable("unreadable", `the parser crashed (exit ${exit.code})`);
  return decodeChildOutput(Buffer.concat(stdout), input.scans);
}
