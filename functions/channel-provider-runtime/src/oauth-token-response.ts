import { readBoundedRawBody } from "@deployments-ai/net-security";
import type { PlatformOAuthAppConfig } from "@deployments-ai/providers";

const MAX_OAUTH_TOKEN_RESPONSE_BYTES = 64 * 1024;

export function oauthTokenFetchInit(request: {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}): RequestInit {
  return { ...request, method: "POST", redirect: "error" };
}

export function oauthRefreshResource(expected: string | undefined, returned: string | undefined) {
  const resource = returned ?? expected;
  if (expected && resource !== expected) {
    throw new Error("OAuth refresh returned a different resource binding.");
  }
  return resource;
}

export function assertRotatedRefreshToken(
  config: Pick<PlatformOAuthAppConfig, "refreshTokenRotationRequired">,
  currentRefreshToken: string,
  returnedRefreshToken: string | undefined,
) {
  if (
    config.refreshTokenRotationRequired &&
    (!returnedRefreshToken || returnedRefreshToken === currentRefreshToken)
  ) {
    throw new Error("OAuth provider omitted the required rotated refresh token.");
  }
}

/** Non-2xx token endpoint response; `status` drives refresh failure classification. */
export class OAuthTokenEndpointError extends Error {
  constructor(readonly status: number) {
    super(`OAuth token endpoint returned HTTP ${status}.`);
    this.name = "OAuthTokenEndpointError";
  }
}

export async function parseOAuthTokenEndpointResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new OAuthTokenEndpointError(response.status);
  }
  const bytes = await readBoundedRawBody(response.body, {
    contentLengthHeader: response.headers.get("content-length"),
    maxBytes: MAX_OAUTH_TOKEN_RESPONSE_BYTES,
  });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error("OAuth token endpoint response was not valid UTF-8.", { cause });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error("OAuth token endpoint response was not valid JSON.", { cause });
  }
}
