import type { PlatformOAuthAppConfig } from "@deployments-ai/providers";

import type { OAuthFetch } from "./oauth-runtime-dependencies.ts";
import { required } from "./required-value.ts";

const REVOCATION_TIMEOUT_MS = 10_000;

/**
 * RFC 7009 token revocation: form POST of `token` + `token_type_hint` to the pinned
 * revocation endpoint with the app's token endpoint client authentication. Throws on a
 * non-2xx response; callers treat revocation as best-effort.
 */
export async function revokeOAuthToken(input: {
  readonly config: PlatformOAuthAppConfig;
  readonly endpoint: string;
  readonly fetch: OAuthFetch;
  readonly token: string;
  readonly tokenTypeHint: "access_token" | "refresh_token";
}) {
  const { config } = input;
  const values: Record<string, string> = {
    token: input.token,
    token_type_hint: input.tokenTypeHint,
  };
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (config.clientAuthentication === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(
      `${config.clientId}:${required(config.clientSecret, "OAuth client secret")}`,
    ).toString("base64")}`;
  } else {
    values[config.tokenClientIdParameterName] = config.clientId;
    if (config.clientAuthentication !== "none") {
      values[config.tokenClientSecretParameterName] = required(
        config.clientSecret,
        "OAuth client secret",
      );
    }
  }
  const response = await input.fetch(input.endpoint, {
    body: new URLSearchParams(values).toString(),
    headers,
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`OAuth revocation endpoint returned HTTP ${response.status}.`);
  }
}
