import { constantTimeTextEqual, sha256Base64Url } from "./crypto.ts";
import { IdentityError } from "./errors.ts";

export interface OAuthClient {
  readonly allowedScopes: readonly string[];
  readonly clientId: string;
  readonly grantTypes: readonly string[];
  readonly redirectUris: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly requirePkce: boolean;
  readonly responseTypes: readonly string[];
  readonly status: "active" | "disabled";
  readonly tokenEndpointAuthMethod: "none" | "client_secret_basic";
  readonly type: "public" | "confidential";
}

const OAUTH_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

export function parseScopes(value: string | undefined): readonly string[] {
  if (!value) return [];
  const scopes = value.split(" ");
  if (scopes.some((scope) => !scope || !OAUTH_TOKEN_PATTERN.test(scope))) {
    throw new IdentityError("invalid_scope", "The scope parameter is malformed.");
  }
  return [...new Set(scopes)].sort();
}

export function validateScopes(
  client: OAuthClient,
  requested: readonly string[],
): readonly string[] {
  const allowed = new Set(client.allowedScopes);
  if (requested.some((scope) => !allowed.has(scope))) {
    throw new IdentityError("invalid_scope", "The requested scope is not registered.");
  }
  if (client.requiredScopes.some((scope) => !requested.includes(scope))) {
    throw new IdentityError("invalid_scope", "A required client scope is missing.");
  }
  return [...new Set(requested)].sort();
}

export function narrowScopes(original: readonly string[], requested?: readonly string[]) {
  if (!requested) return [...original];
  if (requested.some((scope) => !original.includes(scope))) {
    throw new IdentityError("invalid_scope", "Refresh requests may only narrow scope.");
  }
  return [...new Set(requested)].sort();
}

function isLoopbackLiteral(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * A registered `https://*.<suffix>/...` URI stands for one DNS label in place of the `*`. It lets
 * a development install accept per-sandbox hosts. Only a confidential client honors it, so a code
 * sent to a host the operator does not control is still useless without the client secret.
 */
function wildcardHostMatches(target: URL, expected: URL): boolean {
  if (!expected.hostname.startsWith("*.") || expected.protocol !== "https:") return false;
  const suffix = expected.hostname.slice(1);
  const label = target.hostname.slice(0, -suffix.length);
  return (
    target.protocol === expected.protocol &&
    target.hostname.endsWith(suffix) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label) &&
    target.port === expected.port &&
    target.pathname === expected.pathname &&
    target.search === expected.search
  );
}

export function redirectUriMatches(client: OAuthClient, requested: string): boolean {
  let target: URL;
  try {
    target = new URL(requested);
  } catch {
    return false;
  }
  if (target.username || target.password || target.hash) return false;
  for (const registered of client.redirectUris) {
    let expected: URL;
    try {
      expected = new URL(registered);
    } catch {
      continue;
    }
    if (
      client.type === "public" &&
      target.protocol === "http:" &&
      expected.protocol === "http:" &&
      isLoopbackLiteral(target.hostname) &&
      isLoopbackLiteral(expected.hostname) &&
      target.hostname === expected.hostname &&
      target.pathname === expected.pathname &&
      target.search === expected.search
    ) {
      return true;
    }
    if (client.type === "confidential" && wildcardHostMatches(target, expected)) return true;
    if (target.href === expected.href) return true;
  }
  return false;
}

export function validatePkce(input: {
  readonly challenge: string;
  readonly method: string;
  readonly verifier: string;
}): void {
  if (input.method !== "S256" || !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.verifier)) {
    throw new IdentityError("invalid_grant", "PKCE verification failed.");
  }
  if (!constantTimeTextEqual(sha256Base64Url(input.verifier), input.challenge)) {
    throw new IdentityError("invalid_grant", "PKCE verification failed.");
  }
}

export function validateAuthorizationRequest(input: {
  readonly client: OAuthClient;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
  readonly nonce?: string;
  readonly redirectUri: string;
  readonly responseType: string;
  readonly scopes: readonly string[];
}) {
  if (input.client.status !== "active")
    throw new IdentityError("unauthorized_client", "Client disabled.");
  if (!input.client.responseTypes.includes(input.responseType) || input.responseType !== "code") {
    throw new IdentityError("unsupported_response_type", "Only authorization code is supported.");
  }
  if (!redirectUriMatches(input.client, input.redirectUri)) {
    throw new IdentityError("invalid_request", "The redirect URI is not registered.");
  }
  if (
    input.client.requirePkce &&
    (input.codeChallengeMethod !== "S256" ||
      !input.codeChallenge ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge))
  ) {
    throw new IdentityError("invalid_request", "PKCE S256 is required.");
  }
  const scopes = validateScopes(input.client, input.scopes);
  const requestsOpenId = scopes.includes("openid");
  if (requestsOpenId && (!input.nonce || Buffer.byteLength(input.nonce, "utf8") > 256)) {
    throw new IdentityError("invalid_request", "A bounded nonce is required for OpenID requests.");
  }
  if (!requestsOpenId && input.nonce !== undefined) {
    throw new IdentityError("invalid_request", "Nonce is only supported for OpenID requests.");
  }
  return scopes;
}
