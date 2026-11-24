import {
  MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES,
  MAX_BROWSER_SESSION_DOM_BYTES,
  browserSessionExecutionResultFromEvidence,
  makeBrowserScreenshotToolResult,
  normalizeBrowserScreenshotInput,
  type BrowserScreenshotTargetPolicy,
  type BrowserScreenshotToolResult,
  type BrowserSessionExecutionResult,
  type NormalizedBrowserScreenshotInput,
  type NormalizedBrowserSessionExecuteInput,
} from "@deployments-ai/browser-screenshot";
import {
  RuntimeToolPreparationRetryableError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import type {
  ManagedSandbox,
  SandboxManagerService,
  SandboxProviderName,
} from "@deployments-ai/sandbox-hosts";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { runSandboxJob } from "./sandbox-job-runner.ts";
import { acquireThreadSandbox, createRunEphemeralSandbox } from "./sandbox-file-runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

/** Per-call job directories live outside `/workspace`, so thread snapshots never include them. */
const BROWSER_JOB_ROOT = "/var/tmp/deployments-ai-browser";
const BROWSER_DRIVER_COMMAND = ["node", "/opt/agent-sandbox/browser/driver.ts"] as const;

/**
 * Covers the driver's 120 s Chromium launch budget and 15 s cleanup grace
 * (apps/sandbox-microvm/browser), plus 15 s for the spec upload, `start`, and the last status poll,
 * so the driver's watchdog settles a slow job before this deadline passes.
 */
const BROWSER_JOB_SLACK_MS = 150_000;
const MAX_BROWSER_SESSION_JOB_MS = 240_000;
const MAX_FAILURE_MESSAGE_CHARACTERS = 512;
const MAX_CAPTURE_RESULT_BYTES = 16 * 1024;
const MAX_SESSION_RESULT_BYTES = 256 * 1024;
const JOB_CLEANUP_TIMEOUT_MS = 30_000;

const BrowserJobStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["done", "missing", "running", "started"]) }),
  Schema.Struct({
    code: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z_]{1,64}$/u))),
    message: Schema.String,
    state: Schema.Literal("failed"),
  }),
]);
const decodeBrowserJobStatus = Schema.decodeUnknownSync(BrowserJobStatus);

const CaptureResult = Schema.Struct({
  byteSize: Schema.Number.pipe(Schema.check(Schema.isInt())),
  capturedAt: Schema.String,
  contentType: Schema.Literals(["image/jpeg", "image/png", "image/webp"]),
  finalUrl: Schema.String,
  sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});
const decodeCaptureResult = Schema.decodeUnknownSync(CaptureResult);

/**
 * What the driver may open: the exact `allowedOrigins`, plus, when `anyPublicOrigin` is set, any
 * public http(s) origin, reached through the guest egress proxy that connects only to public
 * addresses (apps/sandbox-microvm/browser/egress-proxy.ts).
 */
export interface BrowserTargets {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly anyPublicOrigin: boolean;
}

/** Origins the worker's own target checks restrict to; empty allows any public host. */
export function checkedOrigins(targets: BrowserTargets): ReadonlySet<string> {
  return targets.anyPublicOrigin ? new Set() : targets.allowedOrigins;
}

/** The spec names `anyPublicOrigin` only when set, so images without that mode fail closed. */
function specTargets(targets: BrowserTargets) {
  return {
    allowedOrigins: [...targets.allowedOrigins],
    ...(targets.anyPublicOrigin ? { anyPublicOrigin: true as const } : {}),
  };
}

type BrowserJobSpec = ReturnType<typeof specTargets> &
  (
    | { readonly input: NormalizedBrowserScreenshotInput; readonly kind: "capture" }
    | { readonly input: NormalizedBrowserSessionExecuteInput; readonly kind: "session" }
  );

type BrowserRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];

export interface BrowserSandboxOptions {
  readonly manager: SandboxManagerService;
  readonly providerName: SandboxProviderName;
  /** Absent when the worker has no thread-persistent sandbox backing; those calls then fail. */
  readonly threadSandbox?: ThreadSandboxWorkspace;
}

type ReadJobFile = (name: string, maxBytes: number) => Promise<Uint8Array>;

interface BrowserJob<T> {
  readonly budgetMs: number;
  readonly collect: (read: ReadJobFile) => Promise<T>;
  readonly spec: BrowserJobSpec;
}

/** How a driver job that ran in the sandbox settled. A failure's code and message are model-safe. */
export type BrowserJobOutcome<T> =
  | { readonly state: "done"; readonly value: T }
  | { readonly code: string; readonly message: string; readonly state: "failed" };

/**
 * The tool result for a job that failed inside the sandbox. The run continues, and the model sees
 * the driver's code and message, so it can retry or move on.
 */
export function failedBrowserJobResult(
  toolName: string,
  failure: { readonly code: string; readonly message: string },
): RuntimeToolExecutionResult {
  return {
    output: { error: { code: failure.code, message: failure.message } },
    outputSummary: `Tool ${toolName} failed: ${failure.message}`,
    status: "completed",
  };
}

export function isFailedBrowserJobResult(result: RuntimeToolExecutionResult) {
  const error = result.output?.error;
  return typeof error === "object" && error !== null;
}

export async function readSandboxFile(
  manager: SandboxManagerService,
  sandbox: ManagedSandbox,
  path: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
) {
  const stream = await Effect.runPromise(
    manager.download({ path, sandbox, ...(signal ? { signal } : {}) }),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- Stream chunks arrive sequentially.
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Sandbox file ${path} exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Nothing runs in the sandbox before `start`, so a failure here leaves the call safe to repeat. */
async function beforeStart<T>(request: BrowserRequest, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
  }
}

async function runJobInSandbox<T>(
  options: BrowserSandboxOptions,
  request: BrowserRequest,
  sandbox: ManagedSandbox,
  job: BrowserJob<T>,
): Promise<BrowserJobOutcome<T>> {
  const jobDir = `${BROWSER_JOB_ROOT}/${request.decision.toolCallId}`;
  await beforeStart(request, () =>
    Effect.runPromise(
      options.manager.upload({
        content: new TextEncoder().encode(JSON.stringify(job.spec)),
        path: `${jobDir}/spec.json`,
        sandbox,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    ),
  );
  let settled;
  try {
    settled = await runSandboxJob(
      {
        deadline: Date.now() + job.budgetMs,
        manager: options.manager,
        now: Date.now,
        sandbox,
        signal: request.signal,
      },
      {
        control: BROWSER_DRIVER_COMMAND,
        decodeStatus: decodeBrowserJobStatus,
        label: "Browser",
        startArgument: jobDir,
        statusArgument: jobDir,
        uploads: [],
      },
    );
  } catch (cause) {
    throw new Error(`${request.toolName} did not complete in the sandbox.`, { cause });
  }
  if (settled.state === "timeout") {
    throw new Error(`${request.toolName} did not finish before its deadline.`);
  }
  if (settled.state === "failed") {
    return {
      code: settled.code,
      message: settled.message.slice(0, MAX_FAILURE_MESSAGE_CHARACTERS),
      state: "failed",
    };
  }
  try {
    return {
      state: "done",
      value: await job.collect((name, maxBytes) =>
        readSandboxFile(options.manager, sandbox, `${jobDir}/${name}`, maxBytes, request.signal),
      ),
    };
  } catch (cause) {
    throw new Error(`${request.toolName} returned invalid browser evidence.`, { cause });
  }
}

/**
 * Runs one browser driver job in the sandbox the request's policy selects: the thread's
 * persistent sandbox (job directory removed afterwards) or a fresh MicroVM that is always
 * destroyed. A failure before the driver starts is a retryable preparation failure. A job that
 * settles returns its outcome. Losing a started job, or invalid evidence, throws an `Error`.
 */
async function runBrowserJob<T>(
  options: BrowserSandboxOptions,
  request: BrowserRequest,
  job: BrowserJob<T>,
): Promise<BrowserJobOutcome<T>> {
  const policy = request.sandboxPolicy;
  if (!policy || policy.mode === "none") {
    throw new TypeError(
      `${request.toolName} requires a run-ephemeral or thread-persistent sandbox policy.`,
    );
  }
  if (policy.provider !== "aws_lambda_microvm" || options.providerName !== "aws_lambda_microvm") {
    throw new TypeError(`${request.toolName} requires the aws_lambda_microvm sandbox provider.`);
  }
  if (policy.mode === "thread-persistent") {
    const sandbox = await beforeStart(request, () =>
      acquireThreadSandbox(options.threadSandbox, request, request.toolName),
    );
    try {
      return await runJobInSandbox(options, request, sandbox, job);
    } finally {
      // Best effort: the sandbox outlives the call and a leftover job directory only costs disk.
      await Effect.runPromise(
        options.manager.exec({
          command: ["rm", "-rf", "--", `${BROWSER_JOB_ROOT}/${request.decision.toolCallId}`],
          sandbox,
          timeoutMs: JOB_CLEANUP_TIMEOUT_MS,
        }),
      ).catch(() => undefined);
    }
  }
  const sandbox = await beforeStart(request, () =>
    createRunEphemeralSandbox(options.manager, request, policy, request.toolName),
  );
  let result: { readonly outcome: BrowserJobOutcome<T> } | undefined;
  let jobError: unknown;
  try {
    result = { outcome: await runJobInSandbox(options, request, sandbox, job) };
  } catch (cause) {
    jobError = cause;
  }
  try {
    await Effect.runPromise(options.manager.destroy(sandbox));
  } catch (cleanupError) {
    throw new Error(`${request.toolName} sandbox cleanup did not complete.`, {
      cause: result ? cleanupError : new AggregateError([jobError, cleanupError]),
    });
  }
  if (!result) throw jobError;
  return result.outcome;
}

function isoTimestamp(value: string) {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Browser job capturedAt is invalid.");
  }
  return value;
}

/**
 * `targets` is what the driver enforces and the final URL must satisfy; `policy` is the target
 * policy the input was normalized under (a sandbox loopback origin stays valid).
 */
export function captureScreenshotInSandbox(
  options: BrowserSandboxOptions,
  request: BrowserRequest,
  input: NormalizedBrowserScreenshotInput,
  targets: BrowserTargets,
  policy: BrowserScreenshotTargetPolicy = {},
): Promise<BrowserJobOutcome<BrowserScreenshotToolResult>> {
  return runBrowserJob(options, request, {
    budgetMs: input.timeoutMs + BROWSER_JOB_SLACK_MS,
    collect: async (read) => {
      const result = decodeCaptureResult(
        JSON.parse(new TextDecoder().decode(await read("result.json", MAX_CAPTURE_RESULT_BYTES))),
      );
      const bytes = await read(`screenshot.${input.format}`, MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES);
      if (
        bytes.byteLength !== result.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== result.sha256
      ) {
        throw new Error("Browser job screenshot does not match its recorded size and digest.");
      }
      normalizeBrowserScreenshotInput({ url: result.finalUrl }, checkedOrigins(targets), policy);
      return makeBrowserScreenshotToolResult({
        bytes,
        capturedAt: isoTimestamp(result.capturedAt),
        contentType: result.contentType,
        input,
        screenshotUrl: result.finalUrl,
        toolCallId: request.decision.toolCallId,
      });
    },
    spec: { ...specTargets(targets), input, kind: "capture" },
  });
}

export function executeBrowserSessionInSandbox(
  options: BrowserSandboxOptions,
  request: BrowserRequest,
  input: NormalizedBrowserSessionExecuteInput,
  targets: BrowserTargets,
): Promise<BrowserJobOutcome<BrowserSessionExecutionResult>> {
  return runBrowserJob(options, request, {
    budgetMs: Math.min(input.timeoutMs + BROWSER_JOB_SLACK_MS, MAX_BROWSER_SESSION_JOB_MS),
    collect: async (read) => {
      const summary: unknown = JSON.parse(
        new TextDecoder().decode(await read("result.json", MAX_SESSION_RESULT_BYTES)),
      );
      const screenshot = await read("screenshot.png", MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES);
      const dom = new TextDecoder("utf-8", { fatal: true }).decode(
        await read("dom.html", MAX_BROWSER_SESSION_DOM_BYTES),
      );
      return browserSessionExecutionResultFromEvidence(
        summary,
        { dom, screenshot },
        { actions: input.actions, allowedOrigins: checkedOrigins(targets) },
      );
    },
    spec: { ...specTargets(targets), input, kind: "session" },
  });
}
