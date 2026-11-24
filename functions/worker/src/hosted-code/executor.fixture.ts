import type { S3Client } from "@aws-sdk/client-s3";
import type { Ulid } from "@deployments-ai/db";
import {
  createLambdaMicrovmProvider,
  SandboxOperationError,
  type ManagedSandbox,
  type SandboxManagerService,
} from "@deployments-ai/sandbox-hosts";
import type {
  ToolAdapterDefinition,
  ToolAdapterPinnedHostedCodeExecution,
} from "@deployments-ai/tools";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeRunLogRegistry } from "../runtime-log-emitter.ts";
import { createRuntimeHostedCodeExecutor, type HostedCodeSecretReadRequest } from "./executor.ts";

/** Shared fakes for hosted code executor tests: pinned tools, artifact storage, and sandboxes. */

export const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
export const TOOL_ADAPTER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const TOOL_CALL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ARTIFACT_BUCKET = "platform-artifacts";
export const PYTHON = Bun.which("python3");
const NODE = Bun.which("node") ?? process.execPath;

type ExecInput = Parameters<SandboxManagerService["exec"]>[0];
type UploadInput = Parameters<SandboxManagerService["upload"]>[0];
type ExecOutcome = Effect.Effect<unknown, unknown>;
/** Hosted code stages whole files, never streams. */
interface StagedFile {
  readonly content: Uint8Array;
  readonly path: string;
}

export type SandboxCall =
  | { readonly create: unknown }
  | { readonly destroy: true }
  | { readonly exec: ExecInput }
  | { readonly upload: StagedFile };

export interface HostedCodeTool {
  readonly bytes: Uint8Array;
  readonly definition: ToolAdapterDefinition & {
    readonly execution: ToolAdapterPinnedHostedCodeExecution;
    readonly toolAdapterId: Ulid;
  };
}

export function hostedCodeTool(
  source: string,
  options: {
    readonly bucket?: string;
    readonly credential?: { readonly credentialId: string; readonly generation: number };
    readonly effect?: "execute" | "read" | "write";
    readonly execution?: Partial<ToolAdapterPinnedHostedCodeExecution>;
    readonly inputSchema?: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
  } = {},
): HostedCodeTool {
  const bytes = new TextEncoder().encode(source);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const language = options.execution?.language ?? "javascript";
  const effect = options.effect ?? "execute";
  return {
    bytes,
    definition: {
      defaultPolicyAction: "allow",
      description: "Look up an order.",
      effect,
      execution: {
        artifact: {
          bucket: options.bucket ?? ARTIFACT_BUCKET,
          byteSize: bytes.byteLength,
          key: `organizations/${ID}/hosted-code-artifacts/${hex}.${language === "python" ? "py" : "mjs"}`,
          versionId: "object-version-1",
        },
        contentHash: `sha256:${hex}`,
        ...(options.credential
          ? {
              credential: {
                credentialId: options.credential.credentialId as Ulid,
                generation: options.credential.generation,
              },
            }
          : {}),
        entrypoint: "handler",
        language,
        memoryMiB: 256,
        network: "none",
        secretNames: [],
        sourceLanguage: language,
        timeoutMs: 5_000,
        type: "hosted_code",
        ...options.execution,
      },
      inputSchema: options.inputSchema ?? {
        properties: { orderId: { type: "string" } },
        type: "object",
      },
      outputSchema: options.outputSchema ?? { type: "object" },
      providerOutboundMutation: effect !== "read",
      requiredScopes: [],
      status: "active",
      toolAdapterId: TOOL_ADAPTER_ID,
      toolName: "orders.lookup",
    },
  };
}

export function hostedCodeRequest(
  input: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    agentDefinitionId: ID,
    agentDeploymentId: ID,
    agentManifestHash: "sha256:manifest",
    agentReleaseId: ID,
    captureMode: "metadata-only" as const,
    decision: { action: "allow" as const, reason: "test", toolCallId: TOOL_CALL_ID },
    effect: "execute" as const,
    environmentId: ID,
    idempotencyKey: "model-call-0",
    input,
    inputSummary: "look up an order",
    organizationId: ID,
    projectId: ID,
    requiredScopes: [],
    runId: ID,
    sandboxPolicy: {
      minMemoryMiB: 2_048,
      minVcpu: 1,
      mode: "run-ephemeral" as const,
      provider: "aws_lambda_microvm" as const,
    },
    spanId: "0123456789abcdef",
    threadId: ID,
    traceId: "0123456789abcdef0123456789abcdef",
    toolName: "orders.lookup",
    ...overrides,
  };
}

const lease = {
  environmentId: ID,
  executionTargetId: ID,
  executionTargetKind: "agent-deployment" as const,
  externalSandboxId: "microvm-hosted-code",
  isolationMode: "run-ephemeral" as const,
  organizationId: ID,
  projectId: ID,
  provider: "aws_lambda_microvm" as const,
  runId: ID,
  status: "ready" as const,
};
const sandbox = { lease, record: { data: { id: TOOL_CALL_ID } } } as unknown as ManagedSandbox;

function sandboxManager(
  calls: SandboxCall[],
  exec: (input: ExecInput) => ExecOutcome,
  upload: (file: StagedFile) => void = () => undefined,
): SandboxManagerService {
  return {
    create: (input: unknown) => {
      calls.push({ create: input });
      return Effect.succeed(sandbox);
    },
    destroy: () => {
      calls.push({ destroy: true });
      return Effect.succeed({});
    },
    exec: (input: ExecInput) => {
      calls.push({ exec: input });
      return exec(input);
    },
    upload: (input: UploadInput) => {
      const { content, path } = input;
      if (!(content instanceof Uint8Array)) throw new TypeError("Expected staged file bytes.");
      calls.push({ upload: { content, path } });
      return Effect.sync(() => upload({ content, path }));
    },
  } as unknown as SandboxManagerService;
}

/** Returns a canned exec result; nothing runs. */
export function scriptedSandbox(
  calls: SandboxCall[] = [],
  exec: (input: ExecInput) => ExecOutcome = () =>
    Effect.succeed({ durationMs: 3, exitCode: 0, stderr: "", stdout: '{"ok":true,"output":{}}' }),
) {
  return sandboxManager(calls, exec);
}

/**
 * Runs the staged runner with the local interpreters, mapping guest paths under `root`. macOS
 * rejects RLIMIT_AS, which the Linux guest enforces, so the Python runner's limit call is a no-op
 * there.
 */
export function localSandbox(root: string, calls: SandboxCall[] = []) {
  const pythonShim = join(root, ".python-guest-shim");
  if (process.platform === "darwin") {
    mkdirSync(pythonShim, { recursive: true });
    writeFileSync(
      join(pythonShim, "sitecustomize.py"),
      [
        "import resource",
        "_setrlimit = resource.setrlimit",
        "resource.setrlimit = lambda which, limits: None if which == resource.RLIMIT_AS else _setrlimit(which, limits)",
        "",
      ].join("\n"),
    );
  }
  return sandboxManager(
    calls,
    (input) =>
      Effect.sync(() => {
        const [interpreter, path] = input.command;
        const started = performance.now();
        const child = Bun.spawnSync(
          [interpreter === "python3" ? PYTHON! : NODE, join(root, String(path))],
          {
            env: {
              PATH: process.env.PATH ?? "",
              ...(interpreter === "python3" && process.platform === "darwin"
                ? { PYTHONPATH: pythonShim }
                : {}),
              ...input.env,
            },
          },
        );
        return {
          durationMs: Math.round(performance.now() - started),
          exitCode: child.exitCode ?? 137,
          stderr: child.stderr.toString(),
          stdout: child.stdout.toString(),
        };
      }),
    (input) => {
      const target = join(root, input.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, input.content);
    },
  );
}

/**
 * The managed sandbox wraps provider failures in `SandboxOperationError`; the provider error here
 * is the real Lambda MicroVM control client's reaction to `status`.
 */
export function sandboxRefusingExec(status: number, calls: SandboxCall[] = []) {
  const provider = createLambdaMicrovmProvider({
    client: {
      async send(command) {
        const name = command.constructor.name;
        if (name === "GetMicrovmCommand") return { endpoint: "microvm-hosted.lambda-microvms.aws" };
        if (name === "CreateMicrovmAuthTokenCommand") {
          return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
        }
        throw new Error(`Unexpected command ${name}`);
      },
    },
    fetch: async () =>
      new Response(JSON.stringify({ error: "Network isolation is unavailable." }), {
        headers: { "content-type": "application/json" },
        status,
      }),
    imageIdentifier: "lambda-image",
  });
  return sandboxManager(calls, (input) =>
    Effect.tryPromise({
      catch: (cause) =>
        new SandboxOperationError({
          cause,
          message: "Sandbox exec failed for provider aws_lambda_microvm.",
          operation: "exec",
          provider: "aws_lambda_microvm",
        }),
      try: () =>
        provider.exec({
          command: input.command,
          lease,
          ...(input.network ? { network: input.network } : {}),
        }),
    }),
  );
}

export function withExecutor(
  tool: HostedCodeTool,
  options: {
    readonly manager: SandboxManagerService;
    /** Bytes served for the pinned object version; `"missing"` makes the read fail. */
    readonly objects?: Uint8Array | "missing";
    readonly readSecrets?: (
      request: HostedCodeSecretReadRequest,
    ) => Promise<Readonly<Record<string, string>>>;
    readonly runtimeLogs?: RuntimeRunLogRegistry;
  },
) {
  const s3Reads: unknown[] = [];
  const execute = createRuntimeHostedCodeExecutor({
    artifactBuckets: [ARTIFACT_BUCKET],
    artifactS3: {
      send: async (command: { readonly input: unknown }) => {
        s3Reads.push(command.input);
        if (options.objects === "missing") throw new Error("NoSuchVersion");
        const bytes = options.objects ?? tool.bytes;
        return { Body: { transformToByteArray: async () => bytes } };
      },
    } as unknown as Pick<S3Client, "send">,
    manager: options.manager,
    providerName: "aws_lambda_microvm",
    readSecrets:
      options.readSecrets ??
      (async () => {
        throw new Error("Secrets must not be read for tools without pinned secret names.");
      }),
    ...(options.runtimeLogs ? { runtimeLogs: options.runtimeLogs } : {}),
  });
  return { execute, s3Reads };
}
