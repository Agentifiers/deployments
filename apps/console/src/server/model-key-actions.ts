import "@tanstack/react-start/server-only";
import type { ModelCredentialProvider } from "@deployments-ai/api-contract/models";
import { modelKey, type ModelKey } from "../models/model-keys.ts";
import type { OrganizationMutation } from "./membership-actions.ts";
import { modelKeyPlatform, type ModelKeyPlatform } from "./model-key-data.ts";
import { decodeRequestBody } from "./request-body.ts";

interface ModelKeyMutation extends OrganizationMutation {
  readonly provider: ModelCredentialProvider;
}

/** The platform verifies the key with the provider before storing it; only its last four return. */
export async function setModelKey(
  {
    accessToken,
    body,
    idempotencyKey,
    provider,
    scope,
  }: ModelKeyMutation & { readonly body: unknown },
  client: ModelKeyPlatform = modelKeyPlatform,
): Promise<ModelKey> {
  return modelKey(
    await client.callRoute(
      "putModelCredential",
      {
        body: decodeRequestBody("putModelCredential", "PutModelCredentialRequest", body),
        idempotencyKey,
        path: { id: scope.organizationId, provider },
        scope,
      },
      accessToken,
    ),
  );
}

export async function removeModelKey(
  { accessToken, idempotencyKey, provider, scope }: ModelKeyMutation,
  client: ModelKeyPlatform = modelKeyPlatform,
): Promise<ModelKey> {
  return modelKey(
    await client.callRoute(
      "deleteModelCredential",
      { idempotencyKey, path: { id: scope.organizationId, provider }, scope },
      accessToken,
    ),
  );
}
