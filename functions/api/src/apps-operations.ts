import {
  PutAppGrantRequest,
  SetAppPublicationRequest,
  UpdateAppRequest,
  type APPS_API_ROUTES,
  type AppsRouteName,
} from "@deployments-ai/api-contract";
import {
  AppSlug,
  Ulid,
  liveReleaseIdOf,
  type AppActor,
  type AppGrantRecord,
  type AppPageQuery,
  type AppPersistence,
  type AppRecord,
  type AppReleaseRecord,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import { makeAppDomainOperations, type AppDomainSettings } from "./app-domain-operations.ts";
import { eraseAgentBuiltApp } from "./app-erasure.ts";
import type { AppsDatabase } from "./apps-database-client.ts";
import { AppsProblem } from "./apps-problem.ts";

type AppsRoute = (typeof APPS_API_ROUTES)[number];
type AppsReadRouteName = Extract<
  AppsRoute,
  { readonly requiredAuthorization: "apps:read" }
>["name"];
type AppsPublishRouteName = Extract<
  AppsRoute,
  { readonly requiredAuthorization: "apps:publish" }
>["name"];
type AppsWriteRouteName = Exclude<AppsRouteName, AppsReadRouteName | AppsPublishRouteName>;

export interface AppsEnvironment {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
}

export interface AppsReadInvocation {
  readonly environment: AppsEnvironment;
  readonly params: Readonly<Record<string, Ulid>>;
  readonly query: AppPageQuery & { readonly slug?: string };
}

export interface AppsWriteInvocation {
  readonly body: unknown;
  readonly changedBy: Ulid;
  readonly environment: AppsEnvironment;
  readonly params: Readonly<Record<string, Ulid>>;
}

export interface AppsPublishInvocation {
  readonly actor: AppActor;
  readonly body: unknown;
  readonly environment: AppsEnvironment;
  readonly params: Readonly<Record<string, Ulid>>;
}

export interface AppsOperations {
  readonly read: {
    readonly [Name in AppsReadRouteName]: (invocation: AppsReadInvocation) => Promise<unknown>;
  };
  readonly write: {
    readonly [Name in AppsWriteRouteName]: (invocation: AppsWriteInvocation) => Promise<unknown>;
  };
  readonly publish: {
    readonly [Name in AppsPublishRouteName]: (
      invocation: AppsPublishInvocation,
    ) => Promise<unknown>;
  };
}

const strict = { onExcessProperty: "error" } as const;
const decodeUpdate = Schema.decodeUnknownSync(UpdateAppRequest, strict);
const decodePutGrant = Schema.decodeUnknownSync(PutAppGrantRequest, strict);
const decodeSetPublication = Schema.decodeUnknownSync(SetAppPublicationRequest, strict);
const decodeUlid = Schema.decodeUnknownSync(Ulid);
const decodeSlug = Schema.decodeUnknownOption(AppSlug);

function pathId(params: Readonly<Record<string, Ulid>>, name: string) {
  const value = params[name];
  if (value === undefined) {
    throw new AppsProblem(404, "resource_not_found", "The resource was not found.");
  }
  return value;
}

function grantResponse({ data }: AppGrantRecord) {
  return {
    appId: data.appId,
    createdAt: data.createdAt,
    grantedBy: data.grantedBy,
    principalId: data.principalId,
    role: data.role,
    updatedAt: data.updatedAt,
  };
}

function releaseResponse({ data }: AppReleaseRecord, liveReleaseId: Ulid | null) {
  return {
    appId: data.appId,
    bundleSha256: data.bundleSha256,
    bytes: data.bytes,
    createdAt: data.createdAt,
    files: data.files,
    id: data.id,
    live: data.id === liveReleaseId,
    runId: data.runId,
  };
}

export function makeAppsOperations(dependencies: {
  readonly appDomains: AppDomainSettings;
  readonly apps: AppPersistence;
  readonly appsDomain: string;
  readonly appsDatabase: Pick<AppsDatabase, "convergence" | "erase">;
}): AppsOperations {
  const { apps, appsDatabase, appsDomain } = dependencies;

  function appResponse({ data }: AppRecord) {
    return {
      access: data.access,
      agentDefinitionId: data.agentDefinitionId,
      createdAt: data.createdAt,
      createdBy: data.createdBy,
      environmentId: data.environmentId,
      id: data.id,
      lifecycle: data.lifecycle,
      name: data.name,
      organizationId: data.organizationId,
      projectId: data.projectId,
      publication: data.publication,
      slug: data.slug,
      updatedAt: data.updatedAt,
      url: `https://${data.slug}.${appsDomain}`,
      workspaceId: data.workspaceId,
    };
  }

  async function appIn(
    environment: AppsEnvironment,
    params: Readonly<Record<string, Ulid>>,
  ): Promise<AppRecord> {
    const app = await apps.getApp(pathId(params, "appId"));
    if (app?.data.environmentId !== environment.environmentId) {
      throw new AppsProblem(404, "app_not_found", "The app was not found.");
    }
    return app;
  }

  const domains = makeAppDomainOperations({ apps, appIn, settings: dependencies.appDomains });

  return {
    read: {
      ...domains.read,
      async listApps({ environment, query: { slug, ...query } }) {
        if (slug !== undefined) {
          // One read of the slug's reservation instead of paging every app in the environment. A slug that is not
          // valid, or names an app in another environment, matches nothing.
          const decoded = decodeSlug(slug);
          const app = Option.isSome(decoded) ? await apps.findAppBySlug(decoded.value) : undefined;
          const here =
            app?.data.environmentId === environment.environmentId &&
            app.data.organizationId === environment.organizationId;
          return { items: here ? [appResponse(app)] : [], nextCursor: null };
        }
        const page = await apps.pageEnvironmentApps({ ...environment, ...query });
        return { items: page.items.map(appResponse), nextCursor: page.nextCursor };
      },
      async getApp({ environment, params }) {
        return appResponse(await appIn(environment, params));
      },
      async listAppGrants({ environment, params, query }) {
        const app = await appIn(environment, params);
        const page = await apps.pageGrants({ app, ...query });
        return { items: page.items.map(grantResponse), nextCursor: page.nextCursor };
      },
      async listAppReleases({ environment, params, query }) {
        const app = await appIn(environment, params);
        const live = liveReleaseIdOf(app.data.lifecycle);
        const page = await apps.pageReleases({ app, ...query });
        return {
          items: page.items.map((release) => releaseResponse(release, live)),
          nextCursor: page.nextCursor,
        };
      },
    },
    write: {
      async updateApp({ body, changedBy, environment, params }) {
        const request = decodeUpdate(body);
        let app = await appIn(environment, params);
        const agentDefinitionId =
          request.agentDefinitionId === undefined
            ? undefined
            : decodeUlid(request.agentDefinitionId);
        if (
          agentDefinitionId !== undefined &&
          !(await apps.agentDefinitionReaches({ agentDefinitionId, app }))
        ) {
          throw new AppsProblem(
            422,
            "agent_definition_unavailable",
            "agentDefinitionId must name an active agent definition in the app's environment and workspace.",
          );
        }
        if (request.name !== undefined) {
          app = await apps.renameApp({ app, changedBy, name: request.name });
        }
        if (request.access !== undefined) {
          app = await apps.setAccess({
            app,
            changedBy,
            organizationMembers: request.access.organizationMembers,
          });
        }
        if (agentDefinitionId !== undefined) {
          app = await apps.setAgentDefinition({ agentDefinitionId, app, changedBy });
        }
        return appResponse(app);
      },
      async archiveApp({ changedBy, environment, params }) {
        const app = await appIn(environment, params);
        if (app.data.lifecycle.state === "archived") return appResponse(app);
        return appResponse(
          await apps.transitionApp({
            actor: { id: changedBy, type: "principal" },
            app,
            transition: { to: "archived" },
          }),
        );
      },
      async eraseApp({ changedBy, environment, params }) {
        return appResponse(
          await eraseAgentBuiltApp(
            { apps, appsDatabase },
            { actor: { id: changedBy, type: "principal" }, app: await appIn(environment, params) },
          ),
        );
      },
      async putAppGrant({ body, changedBy, environment, params }) {
        const { role } = decodePutGrant(body);
        const app = await appIn(environment, params);
        const principalId = pathId(params, "principalId");
        if (
          !(await apps.isActiveMember({ organizationId: app.data.organizationId, principalId }))
        ) {
          throw new AppsProblem(
            422,
            "not_an_organization_member",
            "App grants apply only to active members of the app's organization.",
          );
        }
        const { grant } = await apps.putGrant({ app, changedBy, principalId, role });
        return grantResponse(grant);
      },
      async removeAppGrant({ changedBy, environment, params }) {
        const app = await appIn(environment, params);
        const principalId = pathId(params, "principalId");
        const grant = await apps.getGrant({ app, principalId });
        if (!grant) {
          throw new AppsProblem(404, "grant_not_found", "The principal has no grant on this app.");
        }
        await apps.removeGrant({ app, changedBy, principalId });
        return grantResponse(grant);
      },
      async promoteAppRelease({ changedBy, environment, params }) {
        const app = await appIn(environment, params);
        return appResponse(
          await apps.promoteRelease({
            actor: { id: changedBy, type: "principal" },
            app,
            releaseId: pathId(params, "releaseId"),
          }),
        );
      },
    },
    publish: {
      ...domains.publish,
      async setAppPublication({ actor, body, environment, params }) {
        const request = decodeSetPublication(body);
        const app = await appIn(environment, params);
        return appResponse(
          await apps.setPublication({
            actor,
            app,
            database: appsDatabase.convergence,
            publication: {
              audience: request.audience ?? app.data.publication.audience,
              serving: request.serving ?? app.data.publication.serving,
            },
          }),
        );
      },
    },
  };
}
