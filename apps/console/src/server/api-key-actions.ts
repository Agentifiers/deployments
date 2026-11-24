import "@tanstack/react-start/server-only";
import type { ApiKeyView, ServiceAccountView } from "../api-keys/directory.ts";
import type { EnvironmentScope } from "../scope.ts";
import type { ShownOnce } from "../shown-once.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export interface AccessMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export interface AccessBodyMutation extends AccessMutation {
  readonly body: unknown;
}

export function shownOnceKey({
  secret,
  secretVisibleOnce: _visibleOnce,
  ...view
}: RouteResponse<"createApiCredential">): ShownOnce<ApiKeyView> {
  return { secret, view };
}

export function createServiceAccount({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: AccessBodyMutation): Promise<ServiceAccountView> {
  return callRoute(
    "createServiceAccount",
    {
      body: decodeRequestBody("createServiceAccount", "CreateServiceAccountRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function revokeServiceAccount({
  accessToken,
  idempotencyKey,
  scope,
  serviceAccountId,
}: AccessMutation & { readonly serviceAccountId: string }): Promise<ServiceAccountView> {
  return callRoute(
    "revokeServiceAccount",
    { idempotencyKey, path: { id: serviceAccountId }, scope },
    accessToken,
  );
}

export async function issueApiKey({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: AccessBodyMutation): Promise<ShownOnce<ApiKeyView>> {
  return shownOnceKey(
    await callRoute(
      "createApiCredential",
      {
        body: decodeRequestBody("createApiCredential", "CreateApiCredentialRequest", body),
        idempotencyKey,
        scope,
      },
      accessToken,
    ),
  );
}

export async function rotateApiKey({
  accessToken,
  apiCredentialId,
  idempotencyKey,
  scope,
}: AccessMutation & { readonly apiCredentialId: string }): Promise<ShownOnce<ApiKeyView>> {
  return shownOnceKey(
    await callRoute(
      "rotateApiCredential",
      { idempotencyKey, path: { id: apiCredentialId }, scope },
      accessToken,
    ),
  );
}

export function revokeApiKey({
  accessToken,
  apiCredentialId,
  idempotencyKey,
  scope,
}: AccessMutation & { readonly apiCredentialId: string }): Promise<ApiKeyView> {
  return callRoute(
    "revokeApiCredential",
    { idempotencyKey, path: { id: apiCredentialId }, scope },
    accessToken,
  );
}
