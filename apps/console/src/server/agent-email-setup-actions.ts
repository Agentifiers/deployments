import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

interface Mutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export function createDomain({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: Mutation & { readonly body: unknown }) {
  return callRoute(
    "createAgentEmailDomain",
    {
      body: decodeRequestBody("createAgentEmailDomain", "CreateAgentEmailDomainRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function refreshDomain({
  accessToken,
  domainId,
  idempotencyKey,
  scope,
}: Mutation & { readonly domainId: string }) {
  return callRoute(
    "refreshAgentEmailDomain",
    { idempotencyKey, path: { domainId }, scope },
    accessToken,
  );
}

export function revokeDomain({
  accessToken,
  domainId,
  idempotencyKey,
  scope,
}: Mutation & { readonly domainId: string }) {
  return callRoute(
    "revokeAgentEmailDomain",
    { idempotencyKey, path: { domainId }, scope },
    accessToken,
  );
}

export function createPlacement({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: Mutation & { readonly body: unknown }) {
  const { dedicatedPool: _dedicatedPool, ...placement } = decodeRequestBody(
    "createAgentEmailPlacement",
    "CreateAgentEmailPlacementRequest",
    body,
  );
  return callRoute(
    "createAgentEmailPlacement",
    { body: placement, idempotencyKey, scope },
    accessToken,
  );
}

export function updatePlacement({
  accessToken,
  body,
  idempotencyKey,
  placementId,
  scope,
}: Mutation & { readonly body: unknown; readonly placementId: string }) {
  const { dedicatedPool: _dedicatedPool, ...changes } = decodeRequestBody(
    "updateAgentEmailPlacement",
    "UpdateAgentEmailPlacementRequest",
    body,
  );
  return callRoute(
    "updateAgentEmailPlacement",
    { body: changes, idempotencyKey, path: { placementId }, scope },
    accessToken,
  );
}

export function updatePolicy({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: Mutation & { readonly body: unknown }) {
  return callRoute(
    "updateAgentEmailPolicy",
    {
      body: decodeRequestBody("updateAgentEmailPolicy", "UpdateAgentEmailPolicyRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function createSuppression({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: Mutation & { readonly body: unknown }) {
  return callRoute(
    "createAgentEmailSuppression",
    {
      body: decodeRequestBody(
        "createAgentEmailSuppression",
        "CreateAgentEmailSuppressionRequest",
        body,
      ),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function removeSuppression({
  accessToken,
  idempotencyKey,
  scope,
  suppressionId,
}: Mutation & { readonly suppressionId: string }) {
  return callRoute(
    "removeAgentEmailSuppression",
    { idempotencyKey, path: { suppressionId }, scope },
    accessToken,
  );
}
