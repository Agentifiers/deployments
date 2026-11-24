import {
  boundedRuntimeError,
  type RuntimeToolAllowedDecision,
  type RuntimeToolDecision,
} from "@deployments-ai/agent-runtime";
import type { AppsDatabaseRequest } from "@deployments-ai/app-database/protocol";
import {
  AppSlug,
  dataBoundaryOf,
  makeAppPersistence,
  makeIdGenerator,
  Ulid,
  type AppRecord,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import {
  evaluationMemoryDatabase,
  withCreateOnlyPutRecord,
} from "@deployments-ai/db/evaluation-testing";
import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { findPlatformToolAdapterDefinition, type AppToolName } from "@deployments-ai/tools";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AppReleaseObject,
  InvokeAppsDatabase,
  StoredAppReleaseObject,
} from "./app-runtime-ports.ts";
import { createRuntimeAppBuiltinExecutors } from "./app-runtime-tools.ts";
import { createDynamoRuntimeProviderMutationClaimStore } from "./provider-mutation-claims.ts";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import type { RuntimeToolBindingRequest } from "./runtime-tool-planning.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

export const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
export const AGENT = id("01");
export const DEPLOYMENT = id("02");
export const ENVIRONMENT = id("04");
export const ORGANIZATION = id("05");
export const PROJECT = id("06");
export const RUN = id("07");
export const WORKSPACE = id("10");
export const OTHER_AGENT = id("11");
export const START = Date.parse("2026-10-09T12:00:00.000Z");
const PYTHON = Bun.which("python3");

type ExecInput = Parameters<SandboxManagerService["exec"]>[0];
type DatabaseAnswer = (request: AppsDatabaseRequest) => unknown;

const DEFAULT_ANSWERS: Readonly<Record<AppsDatabaseRequest["op"], DatabaseAnswer>> = {
  describe: () => ({
    client: "export async function listOrders() {}\n",
    functions: [],
    migrations: [],
    relations: [],
  }),
  erase: () => ({}),
  export: () => ({}),
  migrate: () => ({ appliedAt: "2026-10-09T12:00:00.000Z", migrationId: 1, replayed: false }),
  provision: (request) => ({ appId: request.appId }),
  query: () => ({ columns: [{ name: "id", type: "integer" }], rows: [["1"]], truncated: false }),
};

function localGuest(options: {
  readonly stored: Map<string, StoredAppReleaseObject>;
  readonly uploadJob: () => "real" | "simulated";
}) {
  const root = mkdtempSync(join(tmpdir(), "app-tools-"));
  const local = (text: string) =>
    text
      .replaceAll("/workspace", join(root, "workspace"))
      .replaceAll("/var/tmp", join(root, "var"));
  const result = (stdout: string) =>
    Effect.succeed({ durationMs: 1, exitCode: 0, stderr: "", stdout });
  const run = (command: readonly string[]) => {
    const child = Bun.spawnSync([PYTHON!, ...command.slice(1).map(local)]);
    return Effect.succeed({
      durationMs: 1,
      exitCode: child.exitCode ?? 137,
      stderr: child.stderr.toString(),
      stdout: child.stdout.toString(),
    });
  };
  const simulateUpload = (specPath: string) => {
    const spec = JSON.parse(readFileSync(local(specPath), "utf8")) as {
      readonly files: readonly { readonly path: string; readonly url: string }[];
      readonly root: string;
    };
    for (const file of spec.files) {
      const bytes = readFileSync(join(spec.root, file.path));
      options.stored.set(new URL(file.url).pathname.slice(1), {
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  const manager = {
    exec: (input: ExecInput) => {
      const command = input.command;
      if (command[1] === "-c" || options.uploadJob() === "real") return run(command);
      if (command[2] === "start") {
        simulateUpload(command[3]!);
        return result('{"state":"started"}');
      }
      return result('{"state":"done"}');
    },
    upload: (input: { readonly content: unknown; readonly path: string }) =>
      Effect.sync(() => {
        const target = local(input.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, local(new TextDecoder().decode(input.content as Uint8Array)));
      }),
  } as unknown as SandboxManagerService;
  const sandbox = { lease: {}, record: {} } as unknown as ManagedSandbox;
  return {
    files: (directory: string) => readdirSync(local(directory)).toSorted(),
    manager,
    remove: () => rmSync(root, { force: true, recursive: true }),
    symlink: (path: string, target: string) => {
      const file = join(root, "workspace", path);
      mkdirSync(dirname(file), { recursive: true });
      symlinkSync(target, file);
    },
    threadSandbox: { acquire: async () => sandbox } as unknown as ThreadSandboxWorkspace,
    write: (path: string, content: string) => {
      const file = join(root, "workspace", path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
  };
}

export function appToolHarness() {
  const memory = evaluationMemoryDatabase();
  const database: DynamoDatabaseService = withCreateOnlyPutRecord(memory.database);
  let clock = START;
  const now = () => new Date(clock);
  const apps = makeAppPersistence({ database, generateId: makeIdGenerator().generate, now });
  let nextSlugLookup: ((found: AppRecord | undefined) => Promise<void>) | undefined;
  const requests: AppsDatabaseRequest[] = [];
  const answers: Partial<Record<AppsDatabaseRequest["op"], DatabaseAnswer>> = {};
  const invoke: InvokeAppsDatabase = async (request) => {
    requests.push(request);
    const answer = answers[request.op];
    return (
      answer ? answer(request) : { ok: true, value: DEFAULT_ANSWERS[request.op](request) }
    ) as never;
  };
  const stored = new Map<string, StoredAppReleaseObject>();
  const presigned: AppReleaseObject[] = [];
  let uploadJob: "real" | "simulated" = "simulated";
  let headFailures = 0;
  const guest = localGuest({ stored, uploadJob: () => uploadJob });
  const idGenerator = makeIdGenerator();
  const service = createRuntimeToolService({
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    builtinExecutors: createRuntimeAppBuiltinExecutors({
      manager: guest.manager,
      services: {
        apps: {
          ...apps,
          findAppBySlug: async (slug) => {
            const found = await apps.findAppBySlug(slug);
            const hook = nextSlugLookup;
            nextSlugLookup = undefined;
            await hook?.(found);
            return found;
          },
        },
        database: invoke,
        domain: "apps.example.com",
        now,
        objects: {
          head: async (key) => {
            if (headFailures-- > 0) throw new Error("SlowDown");
            return stored.get(key);
          },
          presignCreate: async (object) => {
            presigned.push(object);
            return {
              headers: { "content-type": object.contentType, "if-none-match": "*" },
              url: `${uploadJob === "real" ? "http" : "https"}://apps-bucket.example/${object.key}`,
            };
          },
        },
      },
      threadSandbox: guest.threadSandbox,
    }),
    generateId: async () => idGenerator.generate(),
    mutationClaims: createDynamoRuntimeProviderMutationClaimStore(database, { now }),
    resolveAuthorizationContext: async () => undefined,
    resolveProviderCredential: async () => {
      throw new Error("App tools never load provider credentials.");
    },
  });
  let callIndex = 0;

  function runRequest(
    toolName: AppToolName,
    input: Readonly<Record<string, unknown>>,
    overrides: Readonly<Record<string, unknown>> = {},
  ): RuntimeToolBindingRequest {
    return {
      agentDefinitionId: AGENT,
      agentDeploymentId: DEPLOYMENT,
      agentManifestHash: "sha256:manifest",
      agentReleaseId: id("03"),
      captureMode: "metadata-only",
      effect: findPlatformToolAdapterDefinition(toolName)!.effect,
      environmentId: ENVIRONMENT,
      idempotencyKey: `${RUN}:model-tool:${callIndex++}:0`,
      input,
      inputSummary: toolName,
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      requiredScopes: [],
      runId: RUN,
      sandboxPolicy: {
        minMemoryMiB: 2_048,
        mode: "thread-persistent",
        poolKey: "agents",
        provider: "aws_lambda_microvm",
      },
      spanId: "0123456789abcdef",
      threadId: id("08"),
      toolName,
      traceId: "0123456789abcdef0123456789abcdef",
      workspaceId: WORKSPACE,
      ...overrides,
    };
  }

  async function call(
    toolName: AppToolName,
    input: Readonly<Record<string, unknown>>,
    overrides: Readonly<Record<string, unknown>> = {},
  ) {
    const request = runRequest(toolName, input, overrides);
    const decision = await service.authorizeToolCall(request);
    if (decision.action !== "allow") return { decision, request } as const;
    return { decision, request, result: await execute(request, decision) } as const;
  }

  function execute(
    request: RuntimeToolBindingRequest,
    decision: RuntimeToolAllowedDecision,
    approvalId?: Ulid,
  ) {
    return service.executeToolCall({
      ...request,
      ...(approvalId ? { approvalId } : {}),
      decision,
      policyAction: approvalId ? "require-approval" : "allow",
    });
  }

  async function createApp(slug = "orders") {
    const created = await call("app.create", { name: "Orders", slug });
    const appId = created.result?.output?.appId;
    if (typeof appId !== "string") {
      throw new Error(`app.create failed: ${created.result?.outputSummary}`);
    }
    return Schema.decodeUnknownSync(Ulid)(appId);
  }

  async function firstLayoutApp() {
    const template = (await apps.getApp(await createApp("template")))!.data;
    const app = await apps.createApp({
      actor: { type: "system" },
      agentDefinitionId: template.agentDefinitionId,
      clusterKey: template.clusterKey,
      createdBy: template.createdBy,
      databaseLayout: 1,
      environmentId: template.environmentId,
      name: "Orders",
      organizationId: template.organizationId,
      projectId: template.projectId,
      slug: Schema.decodeUnknownSync(AppSlug)("orders"),
      workspaceId: template.workspaceId,
    });
    await apps.transitionApp({ actor: { type: "system" }, app, transition: { to: "active" } });
    requests.splice(0);
    return app.data.id;
  }

  async function release(appId: Ulid, title: string) {
    guest.write("dist/index.html", `<!doctype html><title>${title}</title>`);
    const released = await call("app.release", { appId, directory: "dist" });
    return Schema.decodeUnknownSync(Ulid)(released.result?.output?.releaseId);
  }

  async function liveApp() {
    const appId = await createApp();
    const releaseId = await release(appId, "Orders");
    await call("app.promote", { appId, releaseId });
    return { appId, releaseId };
  }

  return {
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    afterNextSlugLookup: (hook: (found: AppRecord | undefined) => Promise<void>) => {
      nextSlugLookup = hook;
    },
    answers,
    apps,
    call,
    createApp,
    execute,
    failNextHead: () => {
      headFailures = 1;
    },
    firstLayoutApp,
    guest,
    liveApp,
    presigned,
    release,
    requests,
    runRequest,
    service,
    stored,
    useRealUploadJob: () => {
      uploadJob = "real";
    },
  };
}

export function approved(decision: RuntimeToolDecision) {
  if (decision.action !== "require-approval") {
    throw new Error(`Expected approval, got ${decision.action}.`);
  }
  return {
    approvalId: decision.approvalId,
    decision: {
      action: "allow" as const,
      ...(decision.executionBinding ? { executionBinding: decision.executionBinding } : {}),
      reason: boundedRuntimeError(decision.reason, decision.reason),
      toolCallId: decision.toolCallId,
    },
  };
}
