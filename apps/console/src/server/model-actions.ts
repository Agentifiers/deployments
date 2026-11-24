import "@tanstack/react-start/server-only";
import type { ModelPolicyResponse } from "@deployments-ai/api-contract/models";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export interface ModelPolicyMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export interface ModelPolicyChange extends ModelPolicyMutation {
  readonly expectedVersion: number;
  readonly policyId: string;
}

export function createModelPolicy({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: ModelPolicyMutation & { readonly body: unknown }): Promise<ModelPolicyResponse> {
  return callRoute(
    "createModelPolicy",
    {
      body: decodeRequestBody("createModelPolicy", "CreateModelPolicyRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function updateModelPolicy({
  accessToken,
  body,
  expectedVersion,
  idempotencyKey,
  policyId,
  scope,
}: ModelPolicyChange & { readonly body: unknown }): Promise<ModelPolicyResponse> {
  return callRoute(
    "updateModelPolicy",
    {
      body: decodeRequestBody(
        "updateModelPolicy",
        "UpdateModelPolicyRequest",
        Object.assign({}, body, { expectedVersion }),
      ),
      idempotencyKey,
      path: { id: policyId },
      scope,
    },
    accessToken,
  );
}

export function archiveModelPolicy({
  accessToken,
  expectedVersion,
  idempotencyKey,
  policyId,
  scope,
}: ModelPolicyChange): Promise<ModelPolicyResponse> {
  return callRoute(
    "archiveModelPolicy",
    { body: { expectedVersion }, idempotencyKey, path: { id: policyId }, scope },
    accessToken,
  );
}
