import type {
  ModelCredentialProvider,
  PutModelCredentialRequest,
} from "@deployments-ai/api-contract/models";
import { createServerFn } from "@tanstack/react-start";
import { isModelCredentialProvider } from "../models/model-keys.ts";
import { removeModelKey, setModelKey } from "../server/model-key-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, keyedInputAt, requireBody, type KeyedInputAt } from "./server-input.ts";

type ModelKeyInput = KeyedInputAt<"organization"> & { readonly provider: ModelCredentialProvider };

function modelKeyInput(input: unknown) {
  const { provider } = fields(input);
  if (!isModelCredentialProvider(provider)) throw new TypeError("provider is not a key provider.");
  return { ...keyedInputAt("organization", input), provider };
}

export const setModelKeyFn = createServerFn({ method: "POST" })
  .validator(
    (input: ModelKeyInput & { readonly body: typeof PutModelCredentialRequest.Encoded }) => ({
      ...modelKeyInput(input),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => setModelKey({ ...data, accessToken: await requireAccessToken() }));

export const removeModelKeyFn = createServerFn({ method: "POST" })
  .validator((input: ModelKeyInput) => modelKeyInput(input))
  .handler(async ({ data }) =>
    removeModelKey({ ...data, accessToken: await requireAccessToken() }),
  );
