import type {
  CreateToolPolicyRequest,
  UpdateToolPolicyRequest,
} from "@deployments-ai/api-contract/tooling";
import { createServerFn } from "@tanstack/react-start";
import { requireAccessToken } from "../server/session.ts";
import {
  archiveToolPolicy,
  createToolPolicy,
  updateToolPolicy,
} from "../server/tool-policy-actions.ts";
import { fields, keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface KeyedPolicyInput extends KeyedInput {
  readonly policyId: string;
}

export const createToolPolicyFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: typeof CreateToolPolicyRequest.Type }) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createToolPolicy({ ...data, accessToken: await requireAccessToken() }),
  );

export const updateToolPolicyFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedPolicyInput & { readonly body: typeof UpdateToolPolicyRequest.Type }) => ({
      ...keyedInput(input, ["policyId"]),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) =>
    updateToolPolicy({ ...data, accessToken: await requireAccessToken() }),
  );

export const archiveToolPolicyFn = createServerFn({ method: "POST" })
  .validator((input: KeyedPolicyInput & { readonly expectedVersion: number }) => {
    const { expectedVersion } = fields(input);
    if (
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0
    ) {
      throw new TypeError("expectedVersion must be a non-negative integer.");
    }
    return { ...keyedInput(input, ["policyId"]), expectedVersion };
  })
  .handler(async ({ data }) =>
    archiveToolPolicy({ ...data, accessToken: await requireAccessToken() }),
  );
