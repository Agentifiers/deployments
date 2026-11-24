import "@tanstack/react-start/server-only";
import type {
  AppDomainResponse,
  AppGrantResponse,
  AppResponse,
} from "@deployments-ai/api-contract";
import type { EnvironmentScope } from "../scope.ts";
import { appsPlatform, type AppsPlatform } from "./app-data.ts";
import { decodeRequestBody } from "./request-body.ts";

export interface AppMutation {
  readonly accessToken: string;
  readonly appId: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export function updateApp(
  { accessToken, appId, body, idempotencyKey, scope }: AppMutation & { readonly body: unknown },
  client: AppsPlatform = appsPlatform,
): Promise<AppResponse> {
  return client.callRoute(
    "updateApp",
    {
      body: decodeRequestBody("updateApp", "UpdateAppRequest", body),
      idempotencyKey,
      path: { appId },
      scope,
    },
    accessToken,
  );
}

export function archiveApp(
  { accessToken, appId, idempotencyKey, scope }: AppMutation,
  client: AppsPlatform = appsPlatform,
): Promise<AppResponse> {
  return client.callRoute("archiveApp", { idempotencyKey, path: { appId }, scope }, accessToken);
}

export function eraseApp(
  { accessToken, appId, idempotencyKey, scope }: AppMutation,
  client: AppsPlatform = appsPlatform,
): Promise<AppResponse> {
  return client.callRoute("eraseApp", { idempotencyKey, path: { appId }, scope }, accessToken);
}

export function putAppGrant(
  {
    accessToken,
    appId,
    body,
    idempotencyKey,
    principalId,
    scope,
  }: AppMutation & { readonly body: unknown; readonly principalId: string },
  client: AppsPlatform = appsPlatform,
): Promise<AppGrantResponse> {
  return client.callRoute(
    "putAppGrant",
    {
      body: decodeRequestBody("putAppGrant", "PutAppGrantRequest", body),
      idempotencyKey,
      path: { appId, principalId },
      scope,
    },
    accessToken,
  );
}

export function removeAppGrant(
  {
    accessToken,
    appId,
    idempotencyKey,
    principalId,
    scope,
  }: AppMutation & {
    readonly principalId: string;
  },
  client: AppsPlatform = appsPlatform,
): Promise<AppGrantResponse> {
  return client.callRoute(
    "removeAppGrant",
    { idempotencyKey, path: { appId, principalId }, scope },
    accessToken,
  );
}

export function promoteAppRelease(
  {
    accessToken,
    appId,
    idempotencyKey,
    releaseId,
    scope,
  }: AppMutation & {
    readonly releaseId: string;
  },
  client: AppsPlatform = appsPlatform,
): Promise<AppResponse> {
  return client.callRoute(
    "promoteAppRelease",
    { idempotencyKey, path: { appId, releaseId }, scope },
    accessToken,
  );
}

export function setAppPublication(
  { accessToken, appId, body, idempotencyKey, scope }: AppMutation & { readonly body: unknown },
  client: AppsPlatform = appsPlatform,
): Promise<AppResponse> {
  return client.callRoute(
    "setAppPublication",
    {
      body: decodeRequestBody("setAppPublication", "SetAppPublicationRequest", body),
      idempotencyKey,
      path: { appId },
      scope,
    },
    accessToken,
  );
}

export function attachAppDomain(
  { accessToken, appId, body, idempotencyKey, scope }: AppMutation & { readonly body: unknown },
  client: AppsPlatform = appsPlatform,
): Promise<AppDomainResponse> {
  return client.callRoute(
    "attachAppDomain",
    {
      body: decodeRequestBody("attachAppDomain", "AttachAppDomainRequest", body),
      idempotencyKey,
      path: { appId },
      scope,
    },
    accessToken,
  );
}

export function refreshAppDomain(
  {
    accessToken,
    appId,
    domainId,
    scope,
  }: Omit<AppMutation, "idempotencyKey"> & { readonly domainId: string },
  client: AppsPlatform = appsPlatform,
): Promise<AppDomainResponse> {
  return client.callRoute("refreshAppDomain", { path: { appId, domainId }, scope }, accessToken);
}

export function detachAppDomain(
  {
    accessToken,
    appId,
    domainId,
    idempotencyKey,
    scope,
  }: AppMutation & { readonly domainId: string },
  client: AppsPlatform = appsPlatform,
): Promise<AppDomainResponse> {
  return client.callRoute(
    "detachAppDomain",
    { idempotencyKey, path: { appId, domainId }, scope },
    accessToken,
  );
}
