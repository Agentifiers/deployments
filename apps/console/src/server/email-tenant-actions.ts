import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

interface Mutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export function createTenant({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: Mutation & { readonly body: unknown }) {
  return callRoute(
    "createEmailTenant",
    {
      body: decodeRequestBody("createEmailTenant", "CreateEmailTenantRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function updateTenant({
  accessToken,
  body,
  idempotencyKey,
  scope,
  tenantId,
}: Mutation & { readonly body: unknown; readonly tenantId: string }) {
  return callRoute(
    "updateEmailTenant",
    {
      body: decodeRequestBody("updateEmailTenant", "UpdateEmailTenantRequest", body),
      idempotencyKey,
      path: { tenantId },
      scope,
    },
    accessToken,
  );
}

export function createTenantDomain({
  accessToken,
  body,
  idempotencyKey,
  scope,
  tenantId,
}: Mutation & { readonly body: unknown; readonly tenantId: string }) {
  return callRoute(
    "createEmailDomain",
    {
      body: decodeRequestBody("createEmailDomain", "CreateEmailDomainRequest", body),
      idempotencyKey,
      path: { tenantId },
      scope,
    },
    accessToken,
  );
}

export function refreshTenantDomain({
  accessToken,
  domainId,
  idempotencyKey,
  scope,
}: Mutation & { readonly domainId: string }) {
  return callRoute(
    "refreshEmailDomain",
    { idempotencyKey, path: { domainId }, scope },
    accessToken,
  );
}

export function revokeTenantDomain({
  accessToken,
  domainId,
  idempotencyKey,
  scope,
}: Mutation & { readonly domainId: string }) {
  return callRoute("revokeEmailDomain", { idempotencyKey, path: { domainId }, scope }, accessToken);
}

export function sendTenantEmail({
  accessToken,
  body,
  idempotencyKey,
  scope,
  tenantId,
}: Mutation & { readonly body: unknown; readonly tenantId: string }) {
  return callRoute(
    "sendEmail",
    {
      body: decodeRequestBody("sendEmail", "SendEmailRequest", body),
      idempotencyKey,
      path: { tenantId },
      scope,
    },
    accessToken,
  );
}
