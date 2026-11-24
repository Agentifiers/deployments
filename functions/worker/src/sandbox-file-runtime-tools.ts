import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  agentRunSandboxOwner,
  redactRuntimeSensitivePrefix,
  type RuntimeSandboxPolicy,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import type { ObservabilitySourceContext } from "@deployments-ai/db";
import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import {
  SANDBOX_FILES_LIST_DEFAULT_ENTRIES,
  SANDBOX_FILES_LIST_MAX_ENTRIES,
  SANDBOX_FILES_LIST_TOOL_NAME,
  SANDBOX_FILES_PATH_MAX_CHARACTERS,
  SANDBOX_FILES_READ_DEFAULT_BYTES,
  SANDBOX_FILES_READ_MAX_BYTES,
  SANDBOX_FILES_READ_TOOL_NAME,
  SANDBOX_FILES_WRITE_MAX_BYTES,
  SANDBOX_FILES_WRITE_TOOL_NAME,
} from "@deployments-ai/tools";
import { Effect, Schema } from "effect";
import { optionalInteger, toolInput } from "./builtin-tool-support.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import {
  SANDBOX_FILES_LIST_SCRIPT,
  SANDBOX_FILES_READ_SCRIPT,
  SANDBOX_FILES_WRITE_SCRIPT,
  SandboxFilesListScriptOutput,
  SandboxFilesReadScriptOutput,
  SandboxFilesWriteScriptOutput,
} from "./sandbox-file-guest-scripts.ts";
import {
  THREAD_SANDBOX_WORKSPACE_ROOT,
  type ThreadSandboxWorkspace,
} from "./thread-sandbox/contracts.ts";

export interface RuntimeSandboxFileToolOptions {
  readonly manager: SandboxManagerService;
  readonly threadSandbox?: ThreadSandboxWorkspace;
}

type SandboxToolRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];

const GUEST_SCRIPT_TIMEOUT_MS = 30_000;
const MAX_GUEST_ERROR_CHARACTERS = 2_000;

/**
 * The run's immutable trace context, stamped on every sandbox lease the run owns and copied to
 * its sandbox meter events. Only agent runs allocate sandboxes; a request without a trace cannot.
 */
function runSandboxObservability(
  request: SandboxToolRequest,
  toolName: string,
): ObservabilitySourceContext {
  if (request.traceId === undefined) {
    throw new TypeError(`${toolName} sandboxes require the agent run's trace context.`);
  }
  return {
    captureMode: request.captureMode,
    ...(request.parentSpanId ? { parentSpanId: request.parentSpanId } : {}),
    runSpanId: request.spanId,
    sessionId: request.threadId,
    traceId: request.traceId,
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
  };
}

/**
 * Acquires the run's thread-persistent sandbox for a built-in tool call. The sandbox is
 * owned by the thread sandbox workspace and outlives the call.
 */
export async function acquireThreadSandbox(
  threadSandbox: ThreadSandboxWorkspace | undefined,
  request: SandboxToolRequest,
  toolName: string,
): Promise<ManagedSandbox> {
  if (!threadSandbox) throw new Error("Thread-persistent sandboxes are not configured.");
  const policy = request.sandboxPolicy;
  if (!policy) throw new TypeError(`${toolName} requires a thread-persistent sandbox policy.`);
  const observability = runSandboxObservability(request, toolName);
  try {
    return await threadSandbox.acquire({
      ...agentRunSandboxOwner(request),
      environmentId: request.environmentId,
      observability,
      organizationId: request.organizationId,
      policy,
      projectId: request.projectId,
      runId: request.runId,
      threadId: request.threadId,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
    });
  } catch (cause) {
    throw new Error(`Sandbox allocation for ${toolName} did not complete.`, { cause });
  }
}

/**
 * Allocates a fresh MicroVM for one built-in tool call (`allocationId` = tool call id). The
 * caller owns the sandbox and must destroy it when the call ends.
 */
export async function createRunEphemeralSandbox(
  manager: SandboxManagerService,
  request: SandboxToolRequest,
  policy: RuntimeSandboxPolicy,
  toolName: string,
): Promise<ManagedSandbox> {
  const observability = runSandboxObservability(request, toolName);
  try {
    return await Effect.runPromise(
      manager.create({
        ...agentRunSandboxOwner(request),
        allocationId: request.decision.toolCallId,
        environmentId: request.environmentId,
        isolationMode: "run-ephemeral",
        observability,
        organizationId: request.organizationId,
        projectId: request.projectId,
        runId: request.runId,
        ...(policy.accessPolicyRef ? { accessPolicyRef: policy.accessPolicyRef } : {}),
        ...(policy.imageRef ? { imageRef: policy.imageRef } : {}),
        ...(policy.minMemoryMiB !== undefined ? { minMemoryMiB: policy.minMemoryMiB } : {}),
        ...(policy.minVcpu !== undefined ? { minVcpu: policy.minVcpu } : {}),
        ...(policy.poolKey ? { poolKey: policy.poolKey } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      }),
    );
  } catch (cause) {
    throw new Error(`Sandbox allocation for ${toolName} did not complete.`, { cause });
  }
}

/**
 * Lexically jails a model-supplied path to the workspace. Symlinks inside the workspace
 * are not a boundary: the MicroVM belongs to this thread alone.
 */
export function sandboxWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("path must be a non-empty string.");
  }
  if (value.length > SANDBOX_FILES_PATH_MAX_CHARACTERS) throw new TypeError("path is too long.");
  if (value.includes("\0")) throw new TypeError("path must not contain NUL characters.");
  const normalized = posix.normalize(
    value.startsWith("/") ? value : `${THREAD_SANDBOX_WORKSPACE_ROOT}/${value}`,
  );
  const path = normalized.replace(/(?<=.)\/+$/u, "");
  if (
    path !== THREAD_SANDBOX_WORKSPACE_ROOT &&
    !path.startsWith(`${THREAD_SANDBOX_WORKSPACE_ROOT}/`)
  ) {
    throw new TypeError(`path must stay within ${THREAD_SANDBOX_WORKSPACE_ROOT}.`);
  }
  return path;
}

function requireThreadPersistent(request: SandboxToolRequest, toolName: string) {
  if (request.sandboxPolicy?.mode !== "thread-persistent") {
    throw new TypeError(`${toolName} requires a thread-persistent sandbox policy.`);
  }
}

/** Runs one guest script in `/workspace` and decodes its single JSON output line. */
export async function runGuestScript<A>(
  manager: SandboxManagerService,
  options: {
    readonly args: Readonly<Record<string, unknown>>;
    readonly decode: (value: unknown) => A;
    readonly request: SandboxToolRequest;
    readonly sandbox: ManagedSandbox;
    readonly script: string;
    readonly toolName: string;
  },
): Promise<A> {
  const { request, toolName } = options;
  let executed;
  try {
    executed = await Effect.runPromise(
      manager.exec({
        command: ["python3", "-c", options.script, JSON.stringify(options.args)],
        cwd: THREAD_SANDBOX_WORKSPACE_ROOT,
        sandbox: options.sandbox,
        timeoutMs: GUEST_SCRIPT_TIMEOUT_MS,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
  } catch (cause) {
    throw new Error(`${toolName} did not complete in the sandbox.`, { cause });
  }
  if ("operationId" in executed) {
    throw new Error(`${toolName} does not support asynchronous sandbox commands.`);
  }
  if (executed.exitCode !== 0) {
    const stderr = redactRuntimeSensitivePrefix(executed.stderr).slice(
      0,
      MAX_GUEST_ERROR_CHARACTERS,
    );
    throw new Error(`${toolName} failed in the sandbox (exit ${executed.exitCode}): ${stderr}`);
  }
  try {
    return options.decode(JSON.parse(executed.stdout));
  } catch (cause) {
    throw new Error(`${toolName} returned unexpected sandbox output.`, { cause });
  }
}

function completed(
  output: Readonly<Record<string, unknown>>,
  outputSummary: string,
): RuntimeToolExecutionResult {
  return { output, outputSummary, status: "completed" };
}

function readResult(
  path: string,
  maxBytes: number,
  result: typeof SandboxFilesReadScriptOutput.Type,
): RuntimeToolExecutionResult {
  switch (result.status) {
    case "not_found":
      return completed({ path, status: result.status }, `No file exists at ${path}.`);
    case "not_a_file":
      return completed({ path, status: result.status }, `${path} is not a regular file.`);
    case "not_utf8":
      return completed({ path, status: result.status }, `${path} is not UTF-8 text.`);
    case "ok": {
      if (new TextEncoder().encode(result.content).byteLength > maxBytes) {
        throw new Error(`${SANDBOX_FILES_READ_TOOL_NAME} returned more than ${maxBytes} bytes.`);
      }
      const { byteSize, content, truncated } = result;
      return completed(
        { byteSize, content, path, status: "ok", truncated },
        truncated
          ? `Read the first ${maxBytes} bytes of ${path} (${byteSize} bytes, truncated).`
          : `Read ${path} (${byteSize} bytes).`,
      );
    }
  }
}

function writeResult(
  path: string,
  bytes: Uint8Array,
  result: typeof SandboxFilesWriteScriptOutput.Type,
): RuntimeToolExecutionResult {
  switch (result.status) {
    case "is_a_directory":
      return completed({ path, status: result.status }, `${path} is a directory.`);
    case "parent_not_directory":
      return completed(
        { path, status: result.status },
        `A parent of ${path} exists and is not a directory.`,
      );
    case "ok": {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (result.byteSize !== bytes.byteLength || result.sha256 !== sha256) {
        throw new Error(`${SANDBOX_FILES_WRITE_TOOL_NAME} stored different bytes than uploaded.`);
      }
      return completed(
        { byteSize: bytes.byteLength, path, sha256, status: "ok" },
        `Wrote ${bytes.byteLength} bytes to ${path}.`,
      );
    }
  }
}

function listResult(
  path: string,
  limit: number,
  result: typeof SandboxFilesListScriptOutput.Type,
): RuntimeToolExecutionResult {
  switch (result.status) {
    case "not_found":
      return completed(
        { entries: [], path, status: result.status, truncated: false },
        `No directory exists at ${path}.`,
      );
    case "not_a_directory":
      return completed(
        { entries: [], path, status: result.status, truncated: false },
        `${path} is not a directory.`,
      );
    case "ok": {
      const { entries, truncated } = result;
      if (entries.length > limit || entries.some((entry) => !entry.path.startsWith(`${path}/`))) {
        throw new Error(`${SANDBOX_FILES_LIST_TOOL_NAME} returned entries outside the request.`);
      }
      const noun = entries.length === 1 ? "entry" : "entries";
      return completed(
        { entries, path, status: "ok", truncated },
        `Listed ${entries.length} ${noun} under ${path}${truncated ? " (truncated)" : ""}.`,
      );
    }
  }
}

export function createRuntimeSandboxFileBuiltinExecutors(
  options: RuntimeSandboxFileToolOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  const readFile: ExecuteRuntimeBuiltinTool = async (request) => {
    requireThreadPersistent(request, SANDBOX_FILES_READ_TOOL_NAME);
    const input = toolInput(request.input ?? {});
    const path = sandboxWorkspacePath(input.path);
    const maxBytes =
      optionalInteger(input, "maxBytes", { maximum: SANDBOX_FILES_READ_MAX_BYTES, minimum: 1 }) ??
      SANDBOX_FILES_READ_DEFAULT_BYTES;
    const sandbox = await acquireThreadSandbox(
      options.threadSandbox,
      request,
      SANDBOX_FILES_READ_TOOL_NAME,
    );
    const result = await runGuestScript(options.manager, {
      args: { maxBytes, path },
      decode: Schema.decodeUnknownSync(SandboxFilesReadScriptOutput),
      request,
      sandbox,
      script: SANDBOX_FILES_READ_SCRIPT,
      toolName: SANDBOX_FILES_READ_TOOL_NAME,
    });
    return readResult(path, maxBytes, result);
  };

  const writeFile: ExecuteRuntimeBuiltinTool = async (request) => {
    requireThreadPersistent(request, SANDBOX_FILES_WRITE_TOOL_NAME);
    const input = toolInput(request.input ?? {});
    const path = sandboxWorkspacePath(input.path);
    if (typeof input.content !== "string") throw new TypeError("content must be a string.");
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > SANDBOX_FILES_WRITE_MAX_BYTES) {
      throw new TypeError(`content must be at most ${SANDBOX_FILES_WRITE_MAX_BYTES} UTF-8 bytes.`);
    }
    const sandbox = await acquireThreadSandbox(
      options.threadSandbox,
      request,
      SANDBOX_FILES_WRITE_TOOL_NAME,
    );
    const source = `/tmp/deployments-ai-write-${request.decision.toolCallId}`;
    try {
      await Effect.runPromise(
        options.manager.upload({
          content: bytes,
          path: source,
          sandbox,
          ...(request.signal ? { signal: request.signal } : {}),
        }),
      );
    } catch (cause) {
      throw new Error(`${SANDBOX_FILES_WRITE_TOOL_NAME} did not complete in the sandbox.`, {
        cause,
      });
    }
    const result = await runGuestScript(options.manager, {
      args: { path, source },
      decode: Schema.decodeUnknownSync(SandboxFilesWriteScriptOutput),
      request,
      sandbox,
      script: SANDBOX_FILES_WRITE_SCRIPT,
      toolName: SANDBOX_FILES_WRITE_TOOL_NAME,
    });
    return writeResult(path, bytes, result);
  };

  const listFiles: ExecuteRuntimeBuiltinTool = async (request) => {
    requireThreadPersistent(request, SANDBOX_FILES_LIST_TOOL_NAME);
    const input = toolInput(request.input ?? {});
    const path =
      input.path === undefined ? THREAD_SANDBOX_WORKSPACE_ROOT : sandboxWorkspacePath(input.path);
    if (input.recursive !== undefined && typeof input.recursive !== "boolean") {
      throw new TypeError("recursive must be a boolean.");
    }
    const recursive = input.recursive ?? false;
    const limit =
      optionalInteger(input, "limit", { maximum: SANDBOX_FILES_LIST_MAX_ENTRIES, minimum: 1 }) ??
      SANDBOX_FILES_LIST_DEFAULT_ENTRIES;
    const sandbox = await acquireThreadSandbox(
      options.threadSandbox,
      request,
      SANDBOX_FILES_LIST_TOOL_NAME,
    );
    const result = await runGuestScript(options.manager, {
      args: { limit, path, recursive },
      decode: Schema.decodeUnknownSync(SandboxFilesListScriptOutput),
      request,
      sandbox,
      script: SANDBOX_FILES_LIST_SCRIPT,
      toolName: SANDBOX_FILES_LIST_TOOL_NAME,
    });
    return listResult(path, limit, result);
  };

  return {
    [SANDBOX_FILES_LIST_TOOL_NAME]: listFiles,
    [SANDBOX_FILES_READ_TOOL_NAME]: readFile,
    [SANDBOX_FILES_WRITE_TOOL_NAME]: writeFile,
  };
}
