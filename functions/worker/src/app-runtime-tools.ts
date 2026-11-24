import {
  boundedRuntimeError,
  RuntimeToolPreparationRetryableError,
  requireAgentDeploymentId,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import {
  AppId,
  AppSlug as DatabaseAppSlug,
  RETRYABLE_ERROR_CODES,
  VISITOR_DATABASE_LAYOUT,
  type AppsDatabaseFailure,
} from "@deployments-ai/app-database/protocol";
import {
  AppPersistenceError,
  AppSessionId,
  AppSlug,
  deterministicUlid,
  liveReleaseIdOf,
  Ulid,
  type AppAgentScope,
  type AppDatabaseConvergence,
  type AppLifecycleState,
  type AppPersistence,
  type AppRecord,
} from "@deployments-ai/db";
import type { SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import {
  APP_DEV_TOKEN_MINUTES,
  APP_QUERY_DEFAULT_ROWS,
  APP_QUERY_MAX_ROWS,
  type AppToolName,
} from "@deployments-ai/tools";
import { Option, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import {
  APPROVAL_RULES,
  decodePublicationChange,
  type AppWriteToolName,
} from "./app-approval-rules.ts";
import { releaseDirectory, uploadRelease } from "./app-release.ts";
import type { AppReleaseObjects, InvokeAppsDatabase } from "./app-runtime-ports.ts";
import { AppToolRefusal, appToolRefusalResult } from "./app-tool-refusal.ts";
import { optionalInteger, requiredString, toolInput, ulid } from "./builtin-tool-support.ts";
import { deploymentOwnedBuiltin } from "./execution-tool-policy.ts";
import type { ExecuteRuntimeBuiltinTool, RuntimeBuiltinApproval } from "./runtime-tool-planning.ts";
import { acquireThreadSandbox } from "./sandbox-file-runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

export interface AppRuntimeServices {
  readonly apps: AppPersistence;
  readonly database: InvokeAppsDatabase;
  readonly domain: string;
  readonly now: () => Date;
  readonly objects: AppReleaseObjects;
}

export interface RuntimeAppToolOptions {
  readonly manager: SandboxManagerService;
  readonly services?: AppRuntimeServices;
  readonly threadSandbox?: ThreadSandboxWorkspace;
}

type AppToolRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];
type AppAuthorizationRequest = Parameters<NonNullable<ExecuteRuntimeBuiltinTool["approval"]>>[0];
type AppTargetToolName = Exclude<AppToolName, "app.create" | "app.list">;

const APP_CLUSTER_KEY = "default";
const MAX_FAILURE_REASON_CHARACTERS = 1_000;
const MAX_DESCRIBED_RELEASES = 20;
const NEXT_STEPS = [
  "app.migrate: create tables in public, the UI's API as BEGIN ATOMIC functions in api, and functions anonymous visitors of a public app may call in visitor.",
  "app.describe: save its client as src/platform-client.ts.",
  "app.dev_token: add its proxy entry to vite.config.ts so the sandbox dev server can call the API.",
  'Build with base "./", then app.release the build directory and app.promote the release.',
];

const READY_STATES: Readonly<Record<AppTargetToolName, readonly AppLifecycleState[]>> = {
  "app.describe": ["active", "archived"],
  "app.dev_token": ["active"],
  "app.migrate": ["active"],
  "app.promote": ["active"],
  "app.query": ["active"],
  "app.release": ["active"],
  "app.set_publication": ["provisioning", "active"],
};

const decodeAppId = Schema.decodeUnknownSync(AppId);
const decodeDatabaseSlug = Schema.decodeUnknownSync(DatabaseAppSlug);
const decodeSessionId = Schema.decodeUnknownSync(AppSessionId);
const isUlid = Schema.is(Ulid);

interface AppToolScope extends AppAgentScope {
  readonly projectId: Ulid;
}

function appToolScope(request: AppAuthorizationRequest): AppToolScope {
  if (request.workspaceId === undefined) {
    throw new AppToolRefusal(
      "workspace_required",
      "App tools work only in runs that belong to a workspace.",
    );
  }
  if (request.agentDefinitionId === undefined) {
    throw new AppToolRefusal(
      "agent_definition_required",
      "App tools work only in runs of a published agent definition.",
    );
  }
  return {
    agentDefinitionId: request.agentDefinitionId,
    environmentId: request.environmentId,
    organizationId: request.organizationId,
    projectId: request.projectId,
    workspaceId: request.workspaceId,
  };
}

function ownedBy(app: AppRecord, scope: AppToolScope) {
  return (
    app.data.organizationId === scope.organizationId &&
    app.data.environmentId === scope.environmentId &&
    app.data.workspaceId === scope.workspaceId &&
    app.data.agentDefinitionId === scope.agentDefinitionId
  );
}

async function ownedApp(apps: AppPersistence, scope: AppToolScope, appId: Ulid) {
  const app = await apps.getApp(appId);
  if (!app || !ownedBy(app, scope)) {
    throw new AppToolRefusal(
      "app_not_found",
      `App ${appId} is not one of this agent's apps in this workspace.`,
    );
  }
  return app;
}

function agentActor(request: AppToolRequest) {
  return { id: requireAgentDeploymentId(request, "Agent-built apps"), type: "agent" as const };
}

function appUrl(services: AppRuntimeServices, app: AppRecord) {
  return `https://${app.data.slug}.${services.domain}`;
}

function appSummary(services: AppRuntimeServices, app: AppRecord) {
  return {
    appId: app.data.id,
    liveReleaseId: liveReleaseIdOf(app.data.lifecycle),
    name: app.data.name,
    publication: app.data.publication,
    slug: app.data.slug,
    state: app.data.lifecycle.state,
    ...(app.data.lifecycle.state === "failed" ? { failure: app.data.lifecycle.reason } : {}),
    url: appUrl(services, app),
  };
}

function completed(output: Readonly<Record<string, unknown>>, summary: string) {
  return { output, outputSummary: summary, status: "completed" } as const;
}

function databaseRefusal(failure: AppsDatabaseFailure): never {
  throw new AppToolRefusal(failure.error.code, failure.error.message, failure.error.statement);
}

function databaseConvergence(services: AppRuntimeServices): AppDatabaseConvergence {
  return {
    converge: async (app) => {
      const provisioned = await services.database({
        appId: decodeAppId(app.data.id),
        op: "provision",
        slug: decodeDatabaseSlug(app.data.slug),
      });
      if (!provisioned.ok) databaseRefusal(provisioned);
    },
    layout: VISITOR_DATABASE_LAYOUT,
  };
}

function appExecutor(
  execute: (request: AppToolRequest) => Promise<RuntimeToolExecutionResult>,
): ExecuteRuntimeBuiltinTool {
  return async (request) => {
    try {
      return await execute(request);
    } catch (cause) {
      if (cause instanceof AppToolRefusal) return appToolRefusalResult(request.toolName, cause);
      if (
        cause instanceof AppPersistenceError &&
        (cause.reason === "illegal-state" || cause.reason === "still-provisioning")
      ) {
        return appToolRefusalResult(
          request.toolName,
          new AppToolRefusal("app_not_ready", cause.message),
        );
      }
      if (cause instanceof TypeError || cause instanceof RuntimeToolPreparationRetryableError) {
        throw cause;
      }
      throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
    }
  };
}

export function createRuntimeAppBuiltinExecutors(
  options: RuntimeAppToolOptions,
): Readonly<Record<AppToolName, ExecuteRuntimeBuiltinTool>> {
  function configured(): AppRuntimeServices {
    if (!options.services)
      throw new TypeError("Agent-built apps are not configured on this worker.");
    return options.services;
  }

  async function readyApp(request: AppAuthorizationRequest, toolName: AppTargetToolName) {
    const services = configured();
    const scope = appToolScope(request);
    const app = await ownedApp(
      services.apps,
      scope,
      ulid(toolInput(request.input ?? {}).appId, "appId"),
    );
    const states = READY_STATES[toolName];
    if (!states.includes(app.data.lifecycle.state)) {
      throw new AppToolRefusal(
        "app_not_ready",
        `App ${app.data.slug} is ${app.data.lifecycle.state}; ${toolName} needs it ${states.join(" or ")}.`,
      );
    }
    return { app, services };
  }

  function gated(
    toolName: AppWriteToolName,
    execute: (ready: {
      readonly app: AppRecord;
      readonly input: Readonly<Record<string, unknown>>;
      readonly request: AppToolRequest;
      readonly services: AppRuntimeServices;
    }) => Promise<RuntimeToolExecutionResult>,
  ) {
    const rule = APPROVAL_RULES[toolName];
    const executor = deploymentOwnedBuiltin(
      appExecutor(async (request) => {
        const { app, services } = await readyApp(request, toolName);
        const input = toolInput(request.input ?? {});
        const reason = rule === "never" ? null : rule(app, input);
        if (
          reason !== null &&
          (request.policyAction !== "require-approval" ||
            request.decision.reason !== boundedRuntimeError(reason, reason))
        ) {
          throw new AppToolRefusal(
            "approval_required",
            `${reason} The app changed after this call was authorized; call ${toolName} again to request approval.`,
          );
        }
        return execute({ app, input, request, services });
      }),
    );
    if (rule === "never") return executor;
    return Object.assign(executor, {
      approval: async (request: AppAuthorizationRequest): Promise<RuntimeBuiltinApproval> => {
        const input = toolInput(request.input ?? {});
        if (!isUlid(input.appId)) {
          return { action: "allow", reason: "The tool reports the invalid app id." };
        }
        try {
          const { app } = await readyApp(request, toolName);
          const reason = rule(app, input);
          return reason === null
            ? {
                action: "allow",
                reason: `${toolName} runs on app ${app.data.slug} without approval.`,
              }
            : { action: "require_approval", reason };
        } catch (cause) {
          if (cause instanceof AppToolRefusal) {
            return { action: "allow", reason: "The tool reports why it cannot run." };
          }
          throw cause;
        }
      },
    });
  }

  async function claimApp(
    services: AppRuntimeServices,
    request: AppToolRequest,
    input: { readonly name: string; readonly slug: AppSlug },
  ) {
    const scope = appToolScope(request);
    const actor = agentActor(request);
    try {
      return await services.apps.createApp({
        ...scope,
        actor,
        clusterKey: APP_CLUSTER_KEY,
        createdBy: { principalId: null, runId: request.runId },
        databaseLayout: VISITOR_DATABASE_LAYOUT,
        name: input.name,
        slug: input.slug,
      });
    } catch (cause) {
      if (!(cause instanceof AppPersistenceError && cause.reason === "slug-taken")) throw cause;
      const existing = await services.apps.findAppBySlug(input.slug);
      if (!existing || !ownedBy(existing, scope) || existing.data.lifecycle.state === "erasing") {
        throw new AppToolRefusal(
          "slug_taken",
          `The slug ${input.slug} is taken and slugs are never reused. Choose another slug, or call app.list to find apps you already own.`,
        );
      }
      return existing.data.lifecycle.state === "provisioning"
        ? services.apps.transitionApp({ actor, app: existing, transition: { to: "provisioning" } })
        : existing;
    }
  }

  async function provision(services: AppRuntimeServices, request: AppToolRequest, app: AppRecord) {
    const actor = agentActor(request);
    const provisioned = await services.database({
      appId: decodeAppId(app.data.id),
      op: "provision",
      slug: decodeDatabaseSlug(app.data.slug),
    });
    if (provisioned.ok) {
      return services.apps.transitionApp({ actor, app, transition: { to: "active" } });
    }
    const { code, message } = provisioned.error;
    if (RETRYABLE_ERROR_CODES[code]) {
      throw new AppToolRefusal(
        code,
        `Provisioning app ${app.data.slug} (${app.data.id}) did not finish, so the app is still provisioning. Call app.create again with slug ${JSON.stringify(app.data.slug)} and name ${JSON.stringify(app.data.name)} to resume it. Cause: ${message}`,
      );
    }
    const reason = `${code}: ${message}`;
    await services.apps.transitionApp({
      actor,
      app,
      transition: { reason: reason.slice(0, MAX_FAILURE_REASON_CHARACTERS), to: "failed" },
    });
    throw new AppToolRefusal(
      code,
      `Provisioning app ${app.data.slug} (${app.data.id}) failed: ${message}`,
    );
  }

  return {
    "app.create": deploymentOwnedBuiltin(
      appExecutor(async (request) => {
        const services = configured();
        const input = toolInput(request.input ?? {});
        const requestedSlug = requiredString(input, "slug", 64);
        if (!Schema.is(AppSlug)(requestedSlug)) {
          throw new AppToolRefusal(
            "invalid_slug",
            `${requestedSlug} is not an available app slug: slugs have 3 to 35 lowercase letters, digits, or single hyphens, start with a letter, do not start with xn-, and are not reserved words such as www, api, or admin.`,
          );
        }
        const claimed = await claimApp(services, request, {
          name: requiredString(input, "name", 80),
          slug: requestedSlug,
        });
        const app =
          claimed.data.lifecycle.state === "provisioning"
            ? await provision(services, request, claimed)
            : claimed;
        const { createdBy, lifecycle, slug } = app.data;
        const url = appUrl(services, app);
        return completed(
          {
            ...appSummary(services, app),
            ...(lifecycle.state === "active" ? { nextSteps: NEXT_STEPS } : {}),
          },
          createdBy.runId === request.runId
            ? `Created app ${slug} at ${url}.`
            : `App ${slug} at ${url} already belongs to this agent and is ${lifecycle.state}, so app.create returned it.`,
        );
      }),
    ),

    "app.list": appExecutor(async (request) => {
      const services = configured();
      const apps = await services.apps.listAppsForAgent(appToolScope(request));
      return completed(
        { apps: apps.map((app) => appSummary(services, app)) },
        `Found ${apps.length} app(s) owned by this agent in this workspace.`,
      );
    }),

    "app.describe": appExecutor(async (request) => {
      const { app, services } = await readyApp(request, "app.describe");
      const [described, releases] = await Promise.all([
        services.database({ appId: decodeAppId(app.data.id), op: "describe" }),
        services.apps.listReleases(app),
      ]);
      if (!described.ok) databaseRefusal(described);
      const liveReleaseId = liveReleaseIdOf(app.data.lifecycle);
      const visitorFunctions = described.value.functions.filter(
        (fn) => fn.schema === "visitor",
      ).length;
      return completed(
        {
          app: appSummary(services, app),
          client: described.value.client,
          functions: described.value.functions,
          migrations: described.value.migrations,
          relations: described.value.relations,
          releases: releases.slice(0, MAX_DESCRIBED_RELEASES).map((release) => ({
            bytes: release.data.bytes,
            createdAt: release.data.createdAt,
            files: release.data.files,
            live: release.data.id === liveReleaseId,
            releaseId: release.data.id,
          })),
        },
        `Described app ${app.data.slug}: ${described.value.relations.length} relation(s), ${described.value.functions.length - visitorFunctions} api and ${visitorFunctions} visitor function(s), ${releases.length} release(s).`,
      );
    }),

    "app.migrate": gated("app.migrate", async ({ app: ready, input, request, services }) => {
      const description = requiredString(input, "description", 500);
      const sql = requiredString(input, "sql", 100_000);
      const app = await services.apps.convergeDatabase({
        actor: agentActor(request),
        app: ready,
        database: databaseConvergence(services),
      });
      const migrated = await services.database({
        appId: decodeAppId(app.data.id),
        description,
        idempotencyKey: request.idempotencyKey,
        op: "migrate",
        sql,
      });
      if (!migrated.ok) databaseRefusal(migrated);
      return completed(
        { appId: app.data.id, ...migrated.value },
        `${migrated.value.replayed ? "Replayed" : "Applied"} migration ${migrated.value.migrationId} to app ${app.data.slug}.`,
      );
    }),

    "app.query": appExecutor(async (request) => {
      const { app, services } = await readyApp(request, "app.query");
      const input = toolInput(request.input ?? {});
      const queried = await services.database({
        appId: decodeAppId(app.data.id),
        maxRows:
          optionalInteger(input, "maxRows", { maximum: APP_QUERY_MAX_ROWS, minimum: 1 }) ??
          APP_QUERY_DEFAULT_ROWS,
        op: "query",
        sql: requiredString(input, "sql", 20_000),
      });
      if (!queried.ok) databaseRefusal(queried);
      return completed(
        { appId: app.data.id, ...queried.value },
        `Query returned ${queried.value.rows.length} row(s)${queried.value.truncated ? "; more exist" : ""}.`,
      );
    }),

    "app.dev_token": gated("app.dev_token", async ({ app, request, services }) => {
      const role = liveReleaseIdOf(app.data.lifecycle) === null ? "editor" : "viewer";
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(services.now().getTime() + APP_DEV_TOKEN_MINUTES * 60_000);
      await services.apps.createSession({
        appId: app.data.id,
        expiresAt,
        sessionId: decodeSessionId(createHash("sha256").update(token).digest("hex")),
        subject: { kind: "agent-dev", role, runId: request.runId },
      });
      const url = appUrl(services, app);
      return completed(
        {
          appId: app.data.id,
          expiresAt: expiresAt.toISOString(),
          role,
          token,
          url,
          viteProxy: [
            "server: {",
            "  proxy: {",
            '    "/_platform/api": {',
            `      target: ${JSON.stringify(url)},`,
            "      changeOrigin: true,",
            `      headers: { Authorization: ${JSON.stringify(`Bearer ${token}`)} },`,
            "    },",
            "  },",
            "},",
          ].join("\n"),
        },
        `Minted a ${APP_DEV_TOKEN_MINUTES}-minute ${role} dev token for app ${app.data.slug}.`,
      );
    }),

    "app.release": gated("app.release", async ({ app, input, request, services }) => {
      if (request.sandboxPolicy?.mode !== "thread-persistent") {
        throw new AppToolRefusal(
          "sandbox_required",
          "app.release publishes files from this thread's persistent sandbox, and this agent has none.",
        );
      }
      const directory = releaseDirectory(requiredString(input, "directory", 512));
      const releaseId = deterministicUlid(
        `app-release\u0000${app.data.id}\u0000${request.runId}\u0000${request.idempotencyKey}`,
      );
      let release = await services.apps.getRelease({ app, releaseId });
      if (!release) {
        const manifest = await uploadRelease({
          appId: app.data.id,
          directory,
          manager: options.manager,
          now: () => services.now().getTime(),
          objects: services.objects,
          releaseId,
          request,
          sandbox: await acquireThreadSandbox(options.threadSandbox, request, request.toolName),
        });
        ({ release } = await services.apps.createRelease({
          actor: agentActor(request),
          app,
          bundleSha256: manifest.bundleSha256,
          bytes: manifest.bytes,
          documents: manifest.documents,
          files: manifest.files.length,
          releaseId,
          runId: request.runId,
        }));
      }
      return completed(
        {
          appId: app.data.id,
          bundleSha256: release.data.bundleSha256,
          bytes: release.data.bytes,
          files: release.data.files,
          releaseId: release.data.id,
        },
        `Created release ${release.data.id} of app ${app.data.slug} with ${release.data.files} file(s); call app.promote to make it live.`,
      );
    }),

    "app.promote": gated("app.promote", async ({ app, input, request, services }) => {
      const releaseId = ulid(input.releaseId, "releaseId");
      const previousReleaseId = liveReleaseIdOf(app.data.lifecycle);
      let promoted: AppRecord;
      try {
        promoted = await services.apps.promoteRelease({
          actor: agentActor(request),
          app,
          releaseId,
        });
      } catch (cause) {
        if (cause instanceof AppPersistenceError && cause.reason === "not-found") {
          throw new AppToolRefusal("release_not_found", cause.message);
        }
        throw cause;
      }
      return completed(
        {
          appId: promoted.data.id,
          liveReleaseId: liveReleaseIdOf(promoted.data.lifecycle),
          previousReleaseId,
          url: appUrl(services, promoted),
        },
        `Release ${releaseId} is live at ${appUrl(services, promoted)}.`,
      );
    }),

    "app.set_publication": gated(
      "app.set_publication",
      async ({ app, input, request, services }) => {
        const change = decodePublicationChange(input);
        if (
          Option.isNone(change) ||
          (change.value.audience === undefined && change.value.serving === undefined)
        ) {
          throw new AppToolRefusal(
            "invalid_publication",
            "Provide audience (members or public), serving (single-page or static-site), or both.",
          );
        }
        const published = await services.apps.setPublication({
          actor: agentActor(request),
          app,
          database: databaseConvergence(services),
          publication: { ...app.data.publication, ...change.value },
        });
        const { audience, serving } = published.data.publication;
        return completed(
          appSummary(services, published),
          `App ${published.data.slug} has audience ${audience} and serving ${serving}.`,
        );
      },
    ),
  };
}
