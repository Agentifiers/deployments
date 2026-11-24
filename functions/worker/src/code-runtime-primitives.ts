import {
  redactRuntimeSensitivePrefix,
  type RuntimeArtifact,
  type RuntimeSandboxPolicy,
} from "@deployments-ai/agent-runtime";
import type {
  ExecResult,
  ManagedSandbox,
  SandboxManagerService,
  SandboxProviderName,
} from "@deployments-ai/sandbox-hosts";
import { Effect } from "effect";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { acquireThreadSandbox, createRunEphemeralSandbox } from "./sandbox-file-runtime-tools.ts";
import {
  THREAD_SANDBOX_WORKSPACE_ROOT,
  type ThreadSandboxWorkspace,
} from "./thread-sandbox/contracts.ts";

/**
 * Sandboxed execution primitives shared by `code.execute` (model-authored source) and hosted code
 * tools (release-pinned customer source): staging, bounded output, structured results, and the
 * ephemeral/thread sandbox lifecycle.
 */

const MAX_CODE_ARTIFACT_STREAM_BYTES = 20 * 1024;
const MAX_CODE_OUTPUT_BYTES = 64 * 1024;
const MAX_CODE_STRUCTURED_OUTPUT_BYTES = 96 * 1024;
const MAX_CODE_SUMMARY_CHARACTERS = 3_500;
const TRUNCATION_MARKER = "\n...[truncated]";

export type CodeLanguage = "bash" | "javascript" | "python";

export type StructuredCodeOutput = Readonly<Record<string, unknown>> & {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
};

type CodeRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];

function commandFor(languageName: CodeLanguage, path: string): readonly string[] {
  switch (languageName) {
    case "bash":
      return ["bash", path];
    case "javascript":
      return ["node", path];
    case "python":
      return ["python3", path];
  }
}

export interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

export interface RenderedCodeResult {
  readonly artifact: string;
  readonly stderr: BoundedText;
  readonly stdout: BoundedText;
}

function boundedOutput(value: string, maximum = MAX_CODE_OUTPUT_BYTES): BoundedText {
  const redacted = redactRuntimeSensitivePrefix(value);
  const encoded = new TextEncoder().encode(redacted);
  if (encoded.byteLength <= maximum) return { text: redacted, truncated: false };
  const markerBytes = new TextEncoder().encode(TRUNCATION_MARKER).byteLength;
  let end = Math.max(0, maximum - markerBytes);
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) end -= 1;
  return {
    text: `${new TextDecoder().decode(encoded.subarray(0, end))}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

export function resultText(result: {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}): RenderedCodeResult {
  const stdout = boundedOutput(result.stdout, MAX_CODE_ARTIFACT_STREAM_BYTES);
  const stderr = boundedOutput(result.stderr, MAX_CODE_ARTIFACT_STREAM_BYTES);
  return {
    artifact: [
      `exitCode: ${result.exitCode}`,
      `durationMs: ${result.durationMs}`,
      `stdout${stdout.truncated ? " (truncated)" : ""}:`,
      stdout.text || "[empty]",
      `stderr${stderr.truncated ? " (truncated)" : ""}:`,
      stderr.text || "[empty]",
    ].join("\n"),
    stderr,
    stdout,
  };
}

/** Model-visible summary: a caller header followed by as much of `detail` as fits. */
export function summary(header: string, detail: string) {
  const remaining = MAX_CODE_SUMMARY_CHARACTERS - header.length - 1;
  return `${header}\n${boundedOutput(detail, Math.max(0, remaining)).text}`;
}

/**
 * Bounded structured result. `extra` fields (already bounded by the caller) are kept intact while
 * stdout and stderr shrink until the whole result fits the structured output boundary.
 */
export function structuredOutput(
  result: {
    readonly durationMs: number;
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
  },
  extra: Readonly<Record<string, unknown>> = {},
): StructuredCodeOutput {
  let stderrMaximum = MAX_CODE_OUTPUT_BYTES;
  let stdoutMaximum = MAX_CODE_OUTPUT_BYTES;
  for (;;) {
    const stderr = boundedOutput(result.stderr, stderrMaximum);
    const stdout = boundedOutput(result.stdout, stdoutMaximum);
    const output = {
      ...extra,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      stderr: stderr.text,
      stderrTruncated: stderr.truncated,
      stdout: stdout.text,
      stdoutTruncated: stdout.truncated,
    };
    if (
      new TextEncoder().encode(JSON.stringify(output)).byteLength <=
      MAX_CODE_STRUCTURED_OUTPUT_BYTES
    ) {
      return output;
    }
    if (stdoutMaximum >= stderrMaximum && stdoutMaximum > 0) {
      stdoutMaximum = Math.floor(stdoutMaximum / 2);
    } else if (stderrMaximum > 0) {
      stderrMaximum = Math.floor(stderrMaximum / 2);
    } else {
      throw new Error("Sandboxed code output could not fit the structured result boundary.");
    }
  }
}

export function persistedCodeOutput(value: unknown): StructuredCodeOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Persisted sandboxed code output is invalid.");
  }
  const output = value as Readonly<Record<string, unknown>>;
  if (
    typeof output.durationMs !== "number" ||
    !Number.isSafeInteger(output.durationMs) ||
    output.durationMs < 0 ||
    typeof output.exitCode !== "number" ||
    !Number.isSafeInteger(output.exitCode) ||
    typeof output.stderr !== "string" ||
    typeof output.stderrTruncated !== "boolean" ||
    typeof output.stdout !== "string" ||
    typeof output.stdoutTruncated !== "boolean"
  ) {
    throw new TypeError("Persisted sandboxed code output is invalid.");
  }
  return {
    ...output,
    durationMs: output.durationMs,
    exitCode: output.exitCode,
    stderr: output.stderr,
    stderrTruncated: output.stderrTruncated,
    stdout: output.stdout,
    stdoutTruncated: output.stdoutTruncated,
  };
}

export function codeOutputArtifact(options: {
  readonly fileNamePrefix: string;
  readonly label: string;
  readonly languageName: CodeLanguage;
  readonly rendered: RenderedCodeResult;
  readonly result: Pick<StructuredCodeOutput, "durationMs" | "exitCode">;
  readonly toolCallId: string;
}): RuntimeArtifact {
  return {
    content: options.rendered.artifact,
    contentType: "text/plain; charset=utf-8",
    fileName: `${options.fileNamePrefix}-${options.toolCallId}.txt`,
    label: options.label,
    metadata: {
      durationMs: options.result.durationMs,
      exitCode: options.result.exitCode,
      language: options.languageName,
      stderrTruncated: options.rendered.stderr.truncated,
      stdoutTruncated: options.rendered.stdout.truncated,
    },
    type: "deploy_log",
    visibility: "private",
  };
}

/**
 * Uploads the entry source (and any supporting files) into the guest instead of placing source on
 * the command line, then runs it with the language interpreter.
 */
export async function runSource(
  manager: SandboxManagerService,
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly files?: readonly { readonly content: Uint8Array; readonly path: string }[];
    readonly languageName: CodeLanguage;
    readonly network?: "none";
    readonly path: string;
    readonly sandbox: ManagedSandbox;
    readonly signal?: AbortSignal;
    readonly source: string;
    readonly timeoutMs: number;
  },
): Promise<ExecResult> {
  const signal = options.signal ? { signal: options.signal } : {};
  for (const file of [
    ...(options.files ?? []),
    { content: new TextEncoder().encode(options.source), path: options.path },
  ]) {
    await Effect.runPromise(
      manager.upload({
        content: file.content,
        path: file.path,
        sandbox: options.sandbox,
        ...signal,
      }),
    );
  }
  const executed = await Effect.runPromise(
    manager.exec({
      command: commandFor(options.languageName, options.path),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.network ? { network: options.network } : {}),
      sandbox: options.sandbox,
      timeoutMs: options.timeoutMs,
      ...signal,
    }),
  );
  if ("operationId" in executed) {
    throw new Error("Sandboxed code does not support asynchronous sandbox commands.");
  }
  return executed;
}

/**
 * Runs one call in the agent's sandbox. `run-ephemeral` allocates a sandbox keyed by the tool call
 * (so retries converge) and always attempts destruction; `thread-persistent` reuses the thread
 * sandbox, which is snapshotted and destroyed at run exit.
 */
export async function executeInAgentSandbox(options: {
  readonly manager: SandboxManagerService;
  readonly providerName: SandboxProviderName;
  readonly request: CodeRequest;
  readonly run: (
    sandbox: ManagedSandbox,
    placement: { readonly cwd?: string; readonly threadToolCallId?: string },
  ) => Promise<ExecResult>;
  readonly threadSandbox?: ThreadSandboxWorkspace;
  readonly toolName: string;
}): Promise<ExecResult> {
  const { manager, request, toolName } = options;
  const policy: RuntimeSandboxPolicy | undefined = request.sandboxPolicy;
  if (!policy || policy.mode === "none") {
    throw new TypeError(
      `${toolName} requires a run-ephemeral or thread-persistent sandbox policy.`,
    );
  }
  if (policy.provider !== options.providerName) {
    throw new TypeError(
      `${toolName} requires ${String(policy.provider)}, but the worker configured ${String(options.providerName)}.`,
    );
  }
  if (policy.mode === "thread-persistent") {
    const sandbox = await acquireThreadSandbox(options.threadSandbox, request, toolName);
    try {
      return await options.run(sandbox, {
        cwd: THREAD_SANDBOX_WORKSPACE_ROOT,
        threadToolCallId: request.decision.toolCallId,
      });
    } catch (cause) {
      throw new Error("Sandboxed code execution did not complete.", { cause });
    }
  }

  const sandbox = await createRunEphemeralSandbox(manager, request, policy, toolName);
  let result: ExecResult | undefined;
  let executionError: unknown;
  try {
    result = await options.run(sandbox, {});
  } catch (cause) {
    executionError = cause;
  }
  let cleanupError: unknown;
  try {
    await Effect.runPromise(manager.destroy(sandbox));
  } catch (cause) {
    cleanupError = cause;
  }
  if (executionError !== undefined || cleanupError !== undefined) {
    const causes = [executionError, cleanupError].filter(
      (cause): cause is NonNullable<typeof cause> => cause !== undefined,
    );
    throw new Error("Sandboxed code execution did not reach a clean terminal state.", {
      cause:
        causes.length === 1
          ? causes[0]
          : new AggregateError(causes, "Code execution and sandbox cleanup both failed."),
    });
  }
  if (!result) throw new Error("Sandboxed code execution returned no result.");
  return result;
}
