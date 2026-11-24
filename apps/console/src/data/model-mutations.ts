import { createServerFn } from "@tanstack/react-start";
import type {
  CreateModelPolicyRequest,
  UpdateModelPolicyRequest,
} from "@deployments-ai/api-contract/models";
import {
  archiveModelPolicy,
  createModelPolicy,
  updateModelPolicy,
} from "../server/model-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface PolicyChangeInput extends KeyedInput {
  readonly expectedVersion: number;
  readonly policyId: string;
}

function policyChangeInput(input: unknown) {
  const { expectedVersion } = fields(input);
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    throw new TypeError("expectedVersion must be a non-negative integer.");
  }
  return { ...keyedInput(input, ["policyId"]), expectedVersion };
}

export const createModelPolicyFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: CreateModelPolicyRequest }) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createModelPolicy({ ...data, accessToken: await requireAccessToken() }),
  );

export const updateModelPolicyFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: PolicyChangeInput & {
        readonly body: Omit<UpdateModelPolicyRequest, "expectedVersion">;
      },
    ) => ({ ...policyChangeInput(input), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    updateModelPolicy({ ...data, accessToken: await requireAccessToken() }),
  );

export const archiveModelPolicyFn = createServerFn({ method: "POST" })
  .validator((input: PolicyChangeInput) => policyChangeInput(input))
  .handler(async ({ data }) =>
    archiveModelPolicy({ ...data, accessToken: await requireAccessToken() }),
  );
