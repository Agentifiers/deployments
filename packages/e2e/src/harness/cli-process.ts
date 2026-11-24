import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { CliProcessError } from "./errors.ts";
import { cliEntryPoint, repositoryRoot } from "./paths.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 5 * 1_024 * 1_024;

interface CliInvocation {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

export interface CliResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CliProcessService {
  readonly run: (invocation: CliInvocation) => Effect.Effect<CliResult, CliProcessError>;
}

export class CliProcess extends Context.Service<CliProcess, CliProcessService>()(
  "@deployments-ai/e2e/CliProcess",
) {}

function appendBounded(current: string, chunk: Buffer | string, stream: string): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) > MAX_CAPTURE_BYTES) {
    throw new CliProcessError({
      message: `CLI ${stream} exceeded ${String(MAX_CAPTURE_BYTES)} bytes.`,
    });
  }
  return next;
}

function runCli(invocation: CliInvocation): Effect.Effect<CliResult, CliProcessError> {
  return Effect.callback<CliResult, CliProcessError>((resume) => {
    let stdout = "";
    let stderr = "";
    let captureError: CliProcessError | undefined;
    let settled = false;
    const command = process.env.DEPLOYMENTS_E2E_BUN_BIN?.trim() || "bun";
    const child = spawn(command, [cliEntryPoint, ...invocation.args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...invocation.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      captureError = new CliProcessError({
        message: `CLI exceeded its ${String(invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms deadline.`,
      });
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (captureError) return;
      try {
        stdout = appendBounded(stdout, chunk, "stdout");
      } catch (cause) {
        captureError = cause as CliProcessError;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (captureError) return;
      try {
        stderr = appendBounded(stderr, chunk, "stderr");
      } catch (cause) {
        captureError = cause as CliProcessError;
        child.kill("SIGTERM");
      }
    });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resume(
        Effect.fail(
          new CliProcessError({ cause, message: `Unable to start CLI with ${command}.` }),
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (captureError) {
        resume(Effect.fail(captureError));
        return;
      }
      resume(
        Effect.succeed({
          exitCode: exitCode ?? 1,
          signal,
          stderr,
          stdout,
        }),
      );
    });

    return Effect.sync(() => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (!settled) child.kill("SIGTERM");
    });
  });
}

export const CliProcessLive = Layer.succeed(CliProcess, { run: runCli });

export const makeTemporaryCliConfig = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "deployments-e2e-cli-")),
    catch: (cause) =>
      new CliProcessError({ cause, message: "Unable to create a temporary CLI config directory." }),
  }),
  (directory) =>
    Effect.tryPromise({
      try: () => rm(directory, { force: true, recursive: true }),
      catch: (cause) =>
        new CliProcessError({
          cause,
          message: "Unable to remove the temporary CLI config directory.",
        }),
    }).pipe(Effect.orDie),
);
