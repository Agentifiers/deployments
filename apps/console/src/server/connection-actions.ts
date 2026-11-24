import "@tanstack/react-start/server-only";
import type {
  ConnectionView,
  GrantView,
  VerificationView,
  WorkspaceView,
} from "../connections/connection-state.ts";
import { withToolBindings } from "../agents/runtime-config.ts";
import { isRepinnable, repinChanges, type PinStep } from "../connections/rebind.ts";
import type { EnvironmentScope } from "../scope.ts";
import { requirePublicIds } from "./console-data.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export interface ConnectionMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export interface ConnectionBodyMutation extends ConnectionMutation {
  readonly body: unknown;
}

export function createConnection({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: ConnectionBodyMutation): Promise<ConnectionView> {
  return callRoute(
    "createProviderCredential",
    {
      body: decodeRequestBody("createProviderCredential", "CreateProviderCredentialRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function rotateCredential({
  accessToken,
  body,
  connectionId,
  idempotencyKey,
  scope,
}: ConnectionBodyMutation & { readonly connectionId: string }): Promise<ConnectionView> {
  return callRoute(
    "rotateProviderCredential",
    {
      body: decodeRequestBody("rotateProviderCredential", "RotateProviderCredentialRequest", body),
      idempotencyKey,
      path: { id: connectionId },
      scope,
    },
    accessToken,
  );
}

export function verifyConnection({
  accessToken,
  connectionId,
  idempotencyKey,
  scope,
}: ConnectionMutation & { readonly connectionId: string }): Promise<VerificationView> {
  return callRoute(
    "requestConnectionVerification",
    { body: {}, idempotencyKey, path: { id: connectionId }, scope },
    accessToken,
  );
}

export function revokeConnection({
  accessToken,
  body,
  connectionId,
  idempotencyKey,
  scope,
}: ConnectionBodyMutation & { readonly connectionId: string }): Promise<ConnectionView> {
  return callRoute(
    "revokeProviderConnection",
    {
      body: decodeRequestBody(
        "revokeProviderConnection",
        "RevokeAdministrationResourceRequest",
        body,
      ),
      idempotencyKey,
      path: { id: connectionId },
      scope,
    },
    accessToken,
  );
}

export function createGrant({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: ConnectionBodyMutation): Promise<GrantView> {
  return callRoute(
    "createConnectionGrant",
    {
      body: decodeRequestBody("createConnectionGrant", "CreateConnectionGrantRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function revokeGrant({
  accessToken,
  body,
  grantId,
  idempotencyKey,
  scope,
}: ConnectionBodyMutation & { readonly grantId: string }): Promise<GrantView> {
  return callRoute(
    "revokeConnectionGrant",
    {
      body: decodeRequestBody("revokeConnectionGrant", "RevokeAdministrationResourceRequest", body),
      idempotencyKey,
      path: { id: grantId },
      scope,
    },
    accessToken,
  );
}

export function createWorkspace({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: ConnectionBodyMutation): Promise<WorkspaceView> {
  return callRoute(
    "createWorkspace",
    {
      body: decodeRequestBody("createWorkspace", "CreateWorkspaceRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

/**
 * Moves one deployment's pins to the replacement grants. The deployment is read consistently
 * right before the update, whose key carries that version, so a retry replays the same update
 * and a concurrent edit fails with 409 for the planner to retry against the new version.
 */
export async function pinDeployment({
  accessToken,
  deploymentId,
  keyPrefix,
  replacements,
  scope,
}: Omit<PinStep, "kind"> & {
  readonly accessToken: string;
  readonly scope: EnvironmentScope;
}): Promise<{ readonly changed: boolean }> {
  requirePublicIds({ ...scope, deploymentId });
  const deployment = await callRoute(
    "getAgentDeployment",
    { path: { id: deploymentId }, scope },
    accessToken,
  );
  const changes = isRepinnable(deployment)
    ? repinChanges(deployment.runtimeConfig, replacements)
    : {};
  if (Object.keys(changes).length === 0) return { changed: false };
  await callRoute(
    "updateAgentDeployment",
    {
      body: {
        expectedVersion: deployment.version,
        runtimeConfig: withToolBindings(deployment.runtimeConfig, changes),
      },
      idempotencyKey: `${keyPrefix}:${deployment.version}`,
      path: { id: deploymentId },
      scope,
    },
    accessToken,
  );
  return { changed: true };
}
