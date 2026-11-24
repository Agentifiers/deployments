import type {
  CreateApiCredentialRequest,
  CreateServiceAccountRequest,
} from "@deployments-ai/api-contract/tenancy";
import { createServerFn } from "@tanstack/react-start";
import {
  createServiceAccount,
  issueApiKey,
  revokeApiKey,
  revokeServiceAccount,
  rotateApiKey,
} from "../server/api-key-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface BodyInput<Body> extends KeyedInput {
  readonly body: Body;
}

export const createServiceAccountFn = createServerFn({ method: "POST" })
  .validator((input: BodyInput<typeof CreateServiceAccountRequest.Encoded>) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createServiceAccount({ ...data, accessToken: await requireAccessToken() }),
  );

export const revokeServiceAccountFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly serviceAccountId: string }) =>
    keyedInput(input, ["serviceAccountId"]),
  )
  .handler(async ({ data }) =>
    revokeServiceAccount({ ...data, accessToken: await requireAccessToken() }),
  );

export const issueApiKeyFn = createServerFn({ method: "POST" })
  .validator((input: BodyInput<typeof CreateApiCredentialRequest.Encoded>) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => issueApiKey({ ...data, accessToken: await requireAccessToken() }));

export const rotateApiKeyFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly apiCredentialId: string }) =>
    keyedInput(input, ["apiCredentialId"]),
  )
  .handler(async ({ data }) => rotateApiKey({ ...data, accessToken: await requireAccessToken() }));

export const revokeApiKeyFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly apiCredentialId: string }) =>
    keyedInput(input, ["apiCredentialId"]),
  )
  .handler(async ({ data }) => revokeApiKey({ ...data, accessToken: await requireAccessToken() }));
