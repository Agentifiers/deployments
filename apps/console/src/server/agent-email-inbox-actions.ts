import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

interface Mutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export function createInbox({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: Mutation & { readonly body: unknown }) {
  return callRoute(
    "createAgentEmailInbox",
    {
      body: decodeRequestBody("createAgentEmailInbox", "CreateAgentEmailInboxRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function updateInbox({
  accessToken,
  body,
  idempotencyKey,
  inboxId,
  scope,
}: Mutation & { readonly body: unknown; readonly inboxId: string }) {
  return callRoute(
    "updateAgentEmailInbox",
    {
      body: decodeRequestBody("updateAgentEmailInbox", "UpdateAgentEmailInboxRequest", body),
      idempotencyKey,
      path: { inboxId },
      scope,
    },
    accessToken,
  );
}

export function createBinding({
  accessToken,
  body,
  idempotencyKey,
  inboxId,
  scope,
}: Mutation & { readonly body: unknown; readonly inboxId: string }) {
  return callRoute(
    "createAgentEmailBinding",
    {
      body: decodeRequestBody("createAgentEmailBinding", "CreateAgentEmailBindingRequest", body),
      idempotencyKey,
      path: { inboxId },
      scope,
    },
    accessToken,
  );
}

export function deleteBinding({
  accessToken,
  bindingId,
  idempotencyKey,
  scope,
}: Mutation & { readonly bindingId: string }) {
  return callRoute(
    "deleteAgentEmailBinding",
    { idempotencyKey, path: { bindingId }, scope },
    accessToken,
  );
}
