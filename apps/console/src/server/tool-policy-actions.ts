import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import type { ToolPolicyView } from "../tool-policies/policy-state.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

interface PolicyMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export function createToolPolicy({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: PolicyMutation & { readonly body: unknown }): Promise<ToolPolicyView> {
  return callRoute(
    "createToolPolicy",
    {
      body: decodeRequestBody("createToolPolicy", "CreateToolPolicyRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function updateToolPolicy({
  accessToken,
  body,
  idempotencyKey,
  policyId,
  scope,
}: PolicyMutation & {
  readonly body: unknown;
  readonly policyId: string;
}): Promise<ToolPolicyView> {
  return callRoute(
    "updateToolPolicy",
    {
      body: decodeRequestBody("updateToolPolicy", "UpdateToolPolicyRequest", body),
      idempotencyKey,
      path: { id: policyId },
      scope,
    },
    accessToken,
  );
}

export function archiveToolPolicy({
  accessToken,
  expectedVersion,
  idempotencyKey,
  policyId,
  scope,
}: PolicyMutation & {
  readonly expectedVersion: number;
  readonly policyId: string;
}): Promise<ToolPolicyView> {
  return callRoute(
    "archiveToolPolicy",
    { body: { expectedVersion }, idempotencyKey, path: { id: policyId }, scope },
    accessToken,
  );
}
