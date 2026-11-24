import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { RuntimeSandboxPolicy } from "@deployments-ai/agent-runtime";
import { normalizeBrowserScreenshotInput } from "@deployments-ai/browser-screenshot";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { Effect } from "effect";
import {
  createRuntimeBrowserBuiltinExecutors,
  type RuntimeBrowserToolOptions,
} from "./browser-runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

export const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;

export const ALLOWED_ORIGIN = "https://example.com";

export const request = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentManifestHash: "sha256:manifest",
  agentReleaseId: id("03"),
  captureMode: "metadata-only" as const,
  decision: { action: "allow" as const, reason: "test", toolCallId: id("09") },
  effect: "read" as const,
  environmentId: id("04"),
  idempotencyKey: "browser-test",
  inputSummary: "test",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  spanId: "0123456789abcdef",
  threadId: id("08"),
  traceId: "0123456789abcdef0123456789abcdef",
  toolName: "browser.dom_snapshot.capture",
};

export const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

export function sandboxPolicy(
  mode: RuntimeSandboxPolicy["mode"],
  provider: RuntimeSandboxPolicy["provider"] = "aws_lambda_microvm",
): RuntimeSandboxPolicy {
  return { mode, provider };
}

export function database(records: readonly PlatformRecord[] = []): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: () => Promise.resolve(undefined),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: records }),
    transactWrite: async () => {},
  };
}

export function planArtifact(options: {
  readonly reverseTargetKeys?: boolean;
  readonly runId?: Ulid;
  readonly sessionPlanId?: Ulid;
  readonly targetInput?: Parameters<typeof normalizeBrowserScreenshotInput>[0];
  readonly url?: string;
}) {
  const sessionPlanId = options.sessionPlanId ?? request.decision.toolCallId;
  const target = normalizeBrowserScreenshotInput(
    options.targetInput ?? { url: options.url ?? `${ALLOWED_ORIGIN}/page` },
    new Set([ALLOWED_ORIGIN]),
  );
  return {
    data: {
      agentDeploymentId: request.agentDeploymentId,
      environmentId: request.environmentId,
      id: id("10"),
      metadata: {
        source: {
          kind: "browser-session-plan",
          runId: options.runId ?? request.runId,
          sessionPlanId,
          target: options.reverseTargetKeys
            ? Object.fromEntries(Object.entries(target).reverse())
            : target,
        },
      },
      organizationId: request.organizationId,
      projectId: request.projectId,
      privateAccess: "runtime-only",
      runId: options.runId ?? request.runId,
      status: "available",
      visibility: "private",
    },
    itemType: "artifact",
    pk: "test",
    sk: "test",
  } as unknown as PlatformRecord;
}

const encoder = new TextEncoder();

function reply(value: unknown) {
  return { durationMs: 1, exitCode: 0, stderr: "", stdout: `${JSON.stringify(value)}\n` };
}

export interface FakeSandbox {
  readonly calls: {
    readonly acquired: unknown[];
    readonly cleanups: string[];
    readonly commands: (readonly string[])[];
    readonly creates: Record<string, unknown>[];
    readonly destroyed: string[];
    readonly specs: { readonly path: string; readonly spec: Record<string, unknown> }[];
  };
  readonly manager: SandboxManagerService;
  readonly threadSandbox: ThreadSandboxWorkspace;
}

/**
 * Fakes the in-sandbox browser driver: `spec.json` uploads define the job, `start` launches it,
 * `status` reports `status`, and downloads serve `files` from the job directory.
 */
export function fakeSandbox(
  options: {
    readonly destroyFails?: boolean;
    readonly files?: Readonly<Record<string, string | Uint8Array>>;
    readonly status?: Readonly<Record<string, unknown>>;
    readonly uploadFails?: boolean;
  } = {},
): FakeSandbox {
  const calls: FakeSandbox["calls"] = {
    acquired: [],
    cleanups: [],
    commands: [],
    creates: [],
    destroyed: [],
    specs: [],
  };
  const sandbox = (leaseId: string) =>
    ({ lease: { id: leaseId }, record: { data: { id: leaseId } } }) as unknown as ManagedSandbox;
  const leaseId = (value: ManagedSandbox) => value.record.data.id;
  const manager = {
    create: (input: Record<string, unknown>) =>
      Effect.sync(() => {
        calls.creates.push(input);
        return sandbox("ephemeral");
      }),
    destroy: (value: ManagedSandbox) =>
      Effect.suspend(() => {
        if (options.destroyFails) return Effect.fail(new Error("terminate failed"));
        calls.destroyed.push(leaseId(value));
        return Effect.succeed({});
      }),
    download: (input: { readonly path: string }) =>
      Effect.sync(() => {
        const name = input.path.slice(input.path.lastIndexOf("/") + 1);
        const content = options.files?.[name];
        if (content === undefined) throw new Error(`missing ${input.path}`);
        const bytes = typeof content === "string" ? encoder.encode(content) : content;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }),
    exec: (input: { readonly command: readonly string[] }) =>
      Effect.sync(() => {
        calls.commands.push(input.command);
        if (input.command[0] === "rm") {
          calls.cleanups.push(input.command.at(-1)!);
          return reply({});
        }
        return reply(
          input.command[2] === "start"
            ? { state: "started" }
            : (options.status ?? { state: "done" }),
        );
      }),
    upload: (input: { readonly content: Uint8Array; readonly path: string }) =>
      Effect.suspend(() => {
        if (options.uploadFails) return Effect.fail(new Error("control server unreachable"));
        calls.specs.push({
          path: input.path,
          spec: JSON.parse(new TextDecoder().decode(input.content)) as Record<string, unknown>,
        });
        return Effect.void;
      }),
  } as unknown as SandboxManagerService;
  const threadSandbox = {
    acquire: async (input: unknown) => {
      calls.acquired.push(input);
      return sandbox("thread");
    },
  } as unknown as ThreadSandboxWorkspace;
  return { calls, manager, threadSandbox };
}

interface StoredObject {
  readonly body: Uint8Array;
  readonly metadata: Record<string, string>;
}

/** In-memory S3 honoring create-only puts, for the session evidence store. */
export function fakeS3(objects = new Map<string, StoredObject>()) {
  const calls = { gets: 0, puts: 0 };
  const client: Pick<S3Client, "send"> = {
    send: (async (command: { readonly input: Record<string, unknown> }) => {
      const key = String(command.input.Key);
      if (command instanceof PutObjectCommand) {
        calls.puts += 1;
        if (objects.has(key)) {
          throw Object.assign(new Error("exists"), {
            $metadata: { httpStatusCode: 412 },
            name: "PreconditionFailed",
          });
        }
        objects.set(key, {
          body: command.input.Body as Uint8Array,
          metadata: command.input.Metadata as Record<string, string>,
        });
        return { VersionId: "v1" };
      }
      calls.gets += 1;
      const stored = objects.get(key);
      if (!stored) {
        throw Object.assign(new Error("missing"), {
          $metadata: { httpStatusCode: 404 },
          name: "NoSuchKey",
        });
      }
      return {
        Body: { transformToByteArray: async () => stored.body },
        ContentLength: stored.body.byteLength,
        Metadata: stored.metadata,
      };
    }) as unknown as S3Client["send"],
  };
  return { calls, client, objects };
}

export function browserExecutors(
  overrides: Partial<RuntimeBrowserToolOptions> & {
    readonly records?: readonly PlatformRecord[];
  } = {},
) {
  const { records, ...options } = overrides;
  const sandbox = fakeSandbox();
  return createRuntimeBrowserBuiltinExecutors({
    artifactBucket: "artifacts",
    artifactKmsKeyId: "arn:aws:kms:us-east-2:123456789012:key/test",
    artifactS3: fakeS3().client,
    database: database(records),
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    loadScreenshotConfig: () => ({ allowedOrigins: [ALLOWED_ORIGIN], kind: "origins" }),
    manager: sandbox.manager,
    providerName: "aws_lambda_microvm",
    threadSandbox: sandbox.threadSandbox,
    ...options,
  });
}
