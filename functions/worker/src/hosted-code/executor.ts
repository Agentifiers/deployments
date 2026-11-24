import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  RuntimeToolPreparationRetryableError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import type { Ulid } from "@deployments-ai/db";
import {
  SandboxNetworkIsolationUnavailableError,
  type SandboxManagerService,
  type SandboxProviderName,
} from "@deployments-ai/sandbox-hosts";
import type {
  ToolAdapterDefinition,
  ToolAdapterPinnedHostedCodeExecution,
} from "@deployments-ai/tools";
import Ajv, { type ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import { toolInput } from "../builtin-tool-support.ts";
import {
  codeOutputArtifact,
  executeInAgentSandbox,
  persistedCodeOutput,
  resultText,
  runSource,
  structuredOutput,
  summary,
  type StructuredCodeOutput,
} from "../code-runtime-primitives.ts";
import type { RuntimeRunLogRegistry } from "../runtime-log-emitter.ts";
import type { ExecuteRuntimeBuiltinTool } from "../runtime-tools.ts";
import { HOSTED_CODE_NODE_RUNNER, HOSTED_CODE_PYTHON_RUNNER } from "./runners.ts";

/** Largest handler return value, as UTF-8 JSON, kept in the structured tool result. */
const MAX_HOSTED_CODE_OUTPUT_BYTES = 64 * 1024;
const MAX_HOSTED_CODE_ARTIFACT_BYTES = 1024 * 1024;
/** Values shorter than this cannot be told apart from ordinary output, so they are not redacted. */
const MIN_REDACTED_SECRET_CHARACTERS = 4;
const REDACTED_SECRET = "[redacted secret]";

const schemaValidator = new Ajv({ allErrors: true, strict: false });
const validators = new WeakMap<object, ValidateFunction>();

export interface HostedCodeSecretReadRequest {
  readonly credential: { readonly credentialId: Ulid; readonly generation: number };
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly toolAdapterId: Ulid;
}

export interface RuntimeHostedCodeExecutorOptions {
  /** Buckets the worker may read pinned artifacts from (the platform artifact bucket family). */
  readonly artifactBuckets: readonly string[];
  readonly artifactS3: Pick<S3Client, "send">;
  readonly manager: SandboxManagerService;
  readonly providerName: SandboxProviderName;
  readonly readSecrets: (
    request: HostedCodeSecretReadRequest,
  ) => Promise<Readonly<Record<string, string>>>;
  /** Receives what the code printed, already stripped of its secrets, as the run's runtime logs. */
  readonly runtimeLogs?: RuntimeRunLogRegistry;
}

type HostedCodeRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];

interface HostedCodeEnvelope {
  readonly error?: { readonly message: string; readonly name: string };
  readonly ok: boolean;
  readonly output?: unknown;
}

function hostedExecution(definition: ToolAdapterDefinition): ToolAdapterPinnedHostedCodeExecution {
  const execution = definition.execution;
  if (execution?.type !== "hosted_code") {
    throw new TypeError(`${definition.toolName} is not a hosted code tool.`);
  }
  if (!execution.artifact) {
    throw new TypeError(`${definition.toolName} has no pinned hosted code artifact.`);
  }
  return execution;
}

function assertMatchesSchema(schema: unknown, value: unknown, failure: string) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError(`${failure}: the tool has no object schema.`);
  }
  let validate = validators.get(schema);
  if (!validate) {
    try {
      validate = schemaValidator.compile(schema);
    } catch (cause) {
      throw new TypeError(`${failure}: the tool schema is invalid.`, { cause });
    }
    validators.set(schema, validate);
  }
  if (!validate(value)) {
    throw new TypeError(`${failure}: ${schemaValidator.errorsText(validate.errors)}`);
  }
}

/** Reads the exact pinned object version and proves its bytes are the release-pinned content. */
async function pinnedArtifactBytes(
  options: RuntimeHostedCodeExecutorOptions,
  definition: ToolAdapterDefinition,
  execution: ToolAdapterPinnedHostedCodeExecution,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (!options.artifactBuckets.includes(execution.artifact.bucket)) {
    throw new TypeError("Hosted code artifact is outside the platform artifact bucket.");
  }
  let bytes: Uint8Array;
  try {
    const object = await options.artifactS3.send(
      new GetObjectCommand({
        Bucket: execution.artifact.bucket,
        Key: execution.artifact.key,
        VersionId: execution.artifact.versionId,
      }),
      signal ? { abortSignal: signal } : undefined,
    );
    if (!object.Body) throw new Error("Hosted code artifact object has no body.");
    bytes = await object.Body.transformToByteArray();
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(definition.toolName, cause);
  }
  if (
    bytes.byteLength !== execution.artifact.byteSize ||
    bytes.byteLength > MAX_HOSTED_CODE_ARTIFACT_BYTES ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== execution.contentHash
  ) {
    throw new TypeError("Hosted code artifact bytes do not match the release-pinned content hash.");
  }
  return bytes;
}

async function declaredSecrets(
  options: RuntimeHostedCodeExecutorOptions,
  request: HostedCodeRequest,
  definition: ToolAdapterDefinition,
  execution: ToolAdapterPinnedHostedCodeExecution,
): Promise<Readonly<Record<string, string>>> {
  if (execution.secretNames.length === 0) return {};
  if (!execution.credential || !definition.toolAdapterId) {
    throw new TypeError(`Hosted code tool ${definition.toolName} has no configured secrets.`);
  }
  let values: Readonly<Record<string, string>>;
  try {
    values = await options.readSecrets({
      credential: execution.credential,
      environmentId: request.environmentId,
      organizationId: request.organizationId,
      projectId: request.projectId,
      toolAdapterId: definition.toolAdapterId,
    });
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    throw new RuntimeToolPreparationRetryableError(definition.toolName, cause);
  }
  // Only the release-pinned names reach the process, even if the vault entry holds more.
  return Object.fromEntries(
    execution.secretNames.map((name) => {
      const value = values[name];
      if (typeof value !== "string") {
        throw new TypeError(`Hosted code secret ${name} is no longer configured for this tool.`);
      }
      return [name, value];
    }),
  );
}

function redactSecrets(text: string, secrets: Readonly<Record<string, string>>) {
  let redacted = text;
  for (const value of Object.values(secrets)) {
    if (value.length < MIN_REDACTED_SECRET_CHARACTERS) continue;
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) {
      redacted = redacted.replaceAll(form, REDACTED_SECRET);
    }
  }
  return redacted;
}

/**
 * The provider refuses an isolated exec it cannot enforce (an image whose control server predates
 * isolated exec, or a guest that cannot create a network namespace); the code then never started,
 * so retrying on the same image cannot succeed. An exec whose outcome is unknown (transport
 * failure, 5xx) may have run and is left to the caller's retry/recovery path.
 */
function networkIsolationRefused(cause: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = cause;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SandboxNetworkIsolationUnavailableError) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function parseEnvelope(stdout: string): HostedCodeEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const envelope = parsed as Readonly<Record<string, unknown>>;
  if (envelope.ok === true) return { ok: true, output: envelope.output };
  const error = envelope.error as Readonly<Record<string, unknown>> | undefined;
  return envelope.ok === false && error
    ? {
        error: {
          message: typeof error.message === "string" ? error.message : "",
          name: typeof error.name === "string" ? error.name : "Error",
        },
        ok: false,
      }
    : undefined;
}

function objectOutput(envelope: HostedCodeEnvelope | undefined) {
  if (!envelope?.ok) throw new TypeError("Hosted code exited without returning a result.");
  const output = envelope.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("Hosted code entrypoints must return a JSON object.");
  }
  return output as Readonly<Record<string, unknown>>;
}

function renderedResult(output: StructuredCodeOutput) {
  const handlerOutput = output.output;
  return resultText({
    durationMs: output.durationMs,
    exitCode: output.exitCode,
    stderr: output.stderr,
    stdout: handlerOutput === undefined ? "" : JSON.stringify(handlerOutput),
  });
}

function hostedCodeArtifact(
  execution: ToolAdapterPinnedHostedCodeExecution,
  output: StructuredCodeOutput,
  toolCallId: string,
) {
  return codeOutputArtifact({
    fileNamePrefix: "hosted-code",
    label: "Hosted code tool output",
    languageName: execution.language,
    rendered: renderedResult(output),
    result: output,
    toolCallId,
  });
}

/**
 * The sandbox policy hosted code runs under: always a dedicated MicroVM created and destroyed for
 * this one call, on the manifest's provider. A thread-persistent sandbox is shared with the
 * model's own `code.execute` as the same guest user, so it could capture the injected secrets or
 * swap the interpreter before the pinned code runs.
 */
function dedicatedSandboxRequest(request: HostedCodeRequest): HostedCodeRequest {
  const policy = request.sandboxPolicy;
  return policy?.mode === "thread-persistent"
    ? { ...request, sandboxPolicy: { ...policy, mode: "run-ephemeral" } }
    : request;
}

/**
 * Executes a release-pinned hosted code tool in a dedicated per-call sandbox. The model supplies
 * only the validated input; code, entrypoint, limits, network mode, and secret names come from
 * the pin.
 */
export function createRuntimeHostedCodeExecutor(
  options: RuntimeHostedCodeExecutorOptions,
): ExecuteRuntimeBuiltinTool {
  const execute = async (
    request: HostedCodeRequest,
    definition: ToolAdapterDefinition,
  ): Promise<RuntimeToolExecutionResult> => {
    const execution = hostedExecution(definition);
    const input = toolInput(request.input ?? {});
    assertMatchesSchema(
      definition.inputSchema,
      input,
      "Hosted code input does not match its schema",
    );
    const artifact = await pinnedArtifactBytes(options, definition, execution, request.signal);
    const secrets = await declaredSecrets(options, request, definition, execution);
    const extension = execution.language === "python" ? "py" : "mjs";
    const directory = `/tmp/deployments-ai-hosted-code/${request.decision.toolCallId}`;
    const spec = { entrypoint: execution.entrypoint, input, memoryMiB: execution.memoryMiB };

    const result = await executeInAgentSandbox({
      manager: options.manager,
      providerName: options.providerName,
      request: dedicatedSandboxRequest(request),
      run: (sandbox, placement) =>
        runSource(options.manager, {
          ...(placement.cwd ? { cwd: placement.cwd } : {}),
          env: {
            ...secrets,
            ...(execution.language === "javascript"
              ? { NODE_OPTIONS: `--max-old-space-size=${execution.memoryMiB}` }
              : {}),
          },
          files: [
            { content: artifact, path: `${directory}/tool.${extension}` },
            {
              content: new TextEncoder().encode(JSON.stringify(spec)),
              path: `${directory}/input.json`,
            },
          ],
          languageName: execution.language,
          ...(execution.network === "none" ? { network: "none" as const } : {}),
          path: `${directory}/runner.${extension}`,
          sandbox,
          ...(request.signal ? { signal: request.signal } : {}),
          source:
            execution.language === "python" ? HOSTED_CODE_PYTHON_RUNNER : HOSTED_CODE_NODE_RUNNER,
          timeoutMs: execution.timeoutMs,
        }),
      toolName: definition.toolName,
    }).catch((cause: unknown) => {
      if (execution.network === "none" && networkIsolationRefused(cause)) {
        throw new TypeError(
          "The sandbox could not isolate hosted code from the network, so the code did not run.",
          { cause },
        );
      }
      throw cause;
    });

    const stderr = redactSecrets(result.stderr, secrets);
    const runLogger = options.runtimeLogs?.logger(request.runId);
    if (runLogger) {
      const time = new Date().toISOString();
      const toolCallId = request.decision.toolCallId;
      runLogger.processOutput({
        level: "info",
        source: "hosted-code",
        text: stderr,
        time,
        toolCallId,
      });
      runLogger.log({
        attributes: {
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          toolName: definition.toolName,
        },
        level: result.exitCode === 0 ? "info" : "error",
        message: `Hosted code tool ${definition.toolName} exited ${result.exitCode} in ${result.durationMs} ms.`,
        source: "hosted-code",
        time,
        toolCallId,
      });
    }
    const envelope = parseEnvelope(redactSecrets(result.stdout, secrets));
    const handlerOutput = result.exitCode === 0 ? objectOutput(envelope) : undefined;
    if (handlerOutput) {
      if (
        new TextEncoder().encode(JSON.stringify(handlerOutput)).byteLength >
        MAX_HOSTED_CODE_OUTPUT_BYTES
      ) {
        throw new TypeError(
          `Hosted code output exceeds ${MAX_HOSTED_CODE_OUTPUT_BYTES} bytes of JSON.`,
        );
      }
      assertMatchesSchema(
        definition.outputSchema,
        handlerOutput,
        "Hosted code output does not match its schema",
      );
    }
    const output = structuredOutput(
      { durationMs: result.durationMs, exitCode: result.exitCode, stderr, stdout: "" },
      {
        ...(envelope?.error ? { error: envelope.error } : {}),
        ...(handlerOutput ? { output: handlerOutput } : {}),
        ...(result.exitCode === 124 ? { timedOut: true } : {}),
      },
    );
    const outcome = envelope?.error
      ? `${envelope.error.name}: ${envelope.error.message}\n${output.stderr}`
      : result.exitCode === 0
        ? JSON.stringify(output.output)
        : output.stderr || "[no output]";
    return {
      artifacts: [hostedCodeArtifact(execution, output, request.decision.toolCallId)],
      output,
      outputSummary: summary(
        `Hosted code tool ${definition.toolName} exited ${result.exitCode} in ${result.durationMs} ms.`,
        outcome,
      ),
      status: "completed",
    };
  };

  return Object.assign(execute, {
    mutationClaimResult: (result: RuntimeToolExecutionResult) => ({
      artifacts: [],
      ...(result.output ? { output: result.output } : {}),
      ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}),
      status: result.status,
    }),
    refreshReplay: async (
      request: HostedCodeRequest,
      definition: ToolAdapterDefinition,
      persisted: RuntimeToolExecutionResult,
    ) => {
      const output = persistedCodeOutput(persisted.output);
      return {
        ...persisted,
        artifacts: [
          hostedCodeArtifact(hostedExecution(definition), output, request.decision.toolCallId),
        ],
        output,
      };
    },
  });
}
