import "@tanstack/react-start/server-only";
import { MODEL_CREDENTIAL_PROVIDERS } from "@deployments-ai/api-contract/models";
import { PlatformApiError } from "../errors.ts";
import { ABSENT_MODEL_KEY_STATES, modelKey, type ModelKey } from "../models/model-keys.ts";
import { callRoute, type PlatformApiClient } from "./platform-api.ts";

export type ModelKeyPlatform = Pick<PlatformApiClient, "callRoute">;

export const modelKeyPlatform: ModelKeyPlatform = { callRoute };

/**
 * One read per provider: the list omits providers the install has not enabled, and only the
 * single-provider read says whether a missing key is unset or not enabled.
 */
export function loadModelKeys(
  accessToken: string,
  organizationId: string,
  client: ModelKeyPlatform = modelKeyPlatform,
): Promise<readonly ModelKey[]> {
  return Promise.all(
    MODEL_CREDENTIAL_PROVIDERS.map(async (provider): Promise<ModelKey> => {
      try {
        return modelKey(
          await client.callRoute(
            "getModelCredential",
            { path: { id: organizationId, provider }, scope: { organizationId } },
            accessToken,
          ),
        );
      } catch (error) {
        const state =
          error instanceof PlatformApiError && error.problem.status === 404
            ? ABSENT_MODEL_KEY_STATES[error.problem.code ?? ""]
            : undefined;
        if (state === undefined) throw error;
        return { provider, state };
      }
    }),
  );
}
