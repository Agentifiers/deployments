import {
  MODEL_CREDENTIAL_PROVIDERS,
  type ModelCredentialProvider,
  type ModelCredentialResponse,
} from "@deployments-ai/api-contract/models";

/** One provider's organization key as the console shows it; the key itself never leaves the API. */
export type ModelKey =
  | { readonly provider: ModelCredentialProvider; readonly state: "not-enabled" | "unset" }
  | {
      readonly label?: string;
      readonly lastFour: string;
      readonly provider: ModelCredentialProvider;
      readonly setAt: string;
      readonly state: "set";
    };

/** The API answers 404 for both; the problem code says which. */
export const ABSENT_MODEL_KEY_STATES: Readonly<Record<string, "not-enabled" | "unset">> = {
  model_credential_not_found: "unset",
  model_credentials_not_enabled: "not-enabled",
};

export function modelKey(credential: ModelCredentialResponse): ModelKey {
  const { label, lastFour, provider, setAt, status } = credential;
  if (status === "revoked") return { provider, state: "unset" };
  return { lastFour, provider, setAt, state: "set", ...(label === undefined ? {} : { label }) };
}

export function isModelCredentialProvider(value: unknown): value is ModelCredentialProvider {
  return MODEL_CREDENTIAL_PROVIDERS.some((provider) => provider === value);
}
