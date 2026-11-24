import type { APPS_API_SCHEMAS } from "./apps-schemas.ts";
import type { PublicApiQueryParameter, PublicApiRouteContract } from "./route-contract.ts";

type AppsSchemaName = keyof typeof APPS_API_SCHEMAS;

const pageQuery = [
  { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
  { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
] as const satisfies readonly PublicApiQueryParameter[];

function readRoute<
  const Route extends {
    readonly name: string;
    readonly path: string;
    readonly queryParameters?: readonly PublicApiQueryParameter[];
    readonly responseBody: AppsSchemaName;
  },
>(route: Route) {
  return {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404, 422],
    idempotency: "none",
    method: "GET",
    principals: ["human", "service-account"],
    requiredAuthorization: "apps:read",
    scopeHeaders: "environment",
    successStatus: 200,
    tag: "Apps",
    ...route,
  } as const;
}

interface AppsWriteRouteInput {
  readonly errors?: readonly number[];
  readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
  readonly name: string;
  readonly path: string;
  readonly requestBody?: AppsSchemaName;
  readonly responseBody: AppsSchemaName;
  readonly successStatus?: number;
}

const WRITE = { principals: ["human"], requiredAuthorization: "apps:write" } as const;
const PUBLISH = {
  principals: ["human", "service-account"],
  requiredAuthorization: "apps:publish",
} as const;

function mutationRoute<
  const Authorization extends typeof PUBLISH | typeof WRITE,
  const Idempotency extends "none" | "required",
  const Route extends AppsWriteRouteInput,
>(authorization: Authorization, idempotency: Idempotency, route: Route) {
  return {
    authentication: "platform-bearer",
    idempotency,
    scopeHeaders: "environment",
    tag: "Apps",
    ...authorization,
    ...route,
    errors: route.errors ?? [400, 401, 403, 404, 409, 422, 429],
    successStatus: route.successStatus ?? 200,
  } as const;
}

function writeRoute<const Route extends AppsWriteRouteInput>(route: Route) {
  return mutationRoute(WRITE, "required", route);
}

function publishRoute<const Route extends AppsWriteRouteInput>(route: Route) {
  return mutationRoute(PUBLISH, "required", route);
}

function observationRoute<const Route extends AppsWriteRouteInput>(route: Route) {
  return mutationRoute(PUBLISH, "none", route);
}

const APPS = "/v1/apps";
const APP = `${APPS}/:appId`;

export const APPS_API_ROUTES = [
  readRoute({
    name: "listApps",
    path: APPS,
    queryParameters: [
      ...pageQuery,
      {
        description:
          "Only the app with this exact slug. The list then holds that app, or nothing when no app in the environment has the slug.",
        name: "slug",
        schema: { maxLength: 35, minLength: 1, type: "string" },
      },
    ],
    responseBody: "ListAppsResponse",
  }),
  readRoute({ name: "getApp", path: APP, responseBody: "AppResponse" }),
  writeRoute({
    method: "PATCH",
    name: "updateApp",
    path: APP,
    requestBody: "UpdateAppRequest",
    responseBody: "AppResponse",
  }),
  publishRoute({
    method: "PATCH",
    name: "setAppPublication",
    path: `${APP}/publication`,
    requestBody: "SetAppPublicationRequest",
    responseBody: "AppResponse",
  }),
  writeRoute({
    method: "POST",
    name: "archiveApp",
    path: `${APP}/archive`,
    responseBody: "AppResponse",
  }),
  writeRoute({
    errors: [400, 401, 403, 404, 409, 422, 429, 501],
    method: "DELETE",
    name: "eraseApp",
    path: APP,
    responseBody: "AppResponse",
    successStatus: 202,
  }),
  readRoute({
    name: "listAppGrants",
    path: `${APP}/grants`,
    queryParameters: pageQuery,
    responseBody: "ListAppGrantsResponse",
  }),
  writeRoute({
    method: "PUT",
    name: "putAppGrant",
    path: `${APP}/grants/:principalId`,
    requestBody: "PutAppGrantRequest",
    responseBody: "AppGrantResponse",
  }),
  writeRoute({
    method: "DELETE",
    name: "removeAppGrant",
    path: `${APP}/grants/:principalId`,
    responseBody: "AppGrantResponse",
    standing: "remediation",
  }),
  readRoute({
    name: "listAppReleases",
    path: `${APP}/releases`,
    queryParameters: pageQuery,
    responseBody: "ListAppReleasesResponse",
  }),
  writeRoute({
    method: "POST",
    name: "promoteAppRelease",
    path: `${APP}/releases/:releaseId/promote`,
    responseBody: "AppResponse",
  }),
  readRoute({
    name: "listAppDomains",
    path: `${APP}/domains`,
    queryParameters: pageQuery,
    responseBody: "ListAppDomainsResponse",
  }),
  publishRoute({
    method: "POST",
    name: "attachAppDomain",
    path: `${APP}/domains`,
    requestBody: "AttachAppDomainRequest",
    responseBody: "AppDomainResponse",
  }),
  observationRoute({
    errors: [400, 401, 403, 404, 409, 422, 429, 503],
    method: "POST",
    name: "refreshAppDomain",
    path: `${APP}/domains/:domainId/refresh`,
    responseBody: "AppDomainResponse",
  }),
  publishRoute({
    method: "DELETE",
    name: "detachAppDomain",
    path: `${APP}/domains/:domainId`,
    responseBody: "AppDomainResponse",
  }),
] as const satisfies readonly PublicApiRouteContract[];

export type AppsRouteName = (typeof APPS_API_ROUTES)[number]["name"];
