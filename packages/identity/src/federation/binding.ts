import { createHash } from "node:crypto";

import type { FederationConnection } from "./discovery.ts";

export interface FederationBinding {
  readonly lookupHash: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  /** The AuthnRequest ID. An xs:ID may not start with a digit or "-", hence the "_" prefix. */
  readonly samlRequestId: string;
}

type BindingLabel = "lookup" | "state" | "nonce" | "pkce" | "saml-request";

function labelledHash(label: BindingLabel, token: string): string {
  return createHash("sha256")
    .update(`deployments-ai/federation-binding/v1\0${label}\0`, "utf8")
    .update(token, "utf8")
    .digest("base64url");
}

export function federationBinding(token: string): FederationBinding {
  // A base64url SHA-256 digest is 43 characters, inside RFC 7636's 43..128 verifier range.
  const codeVerifier = labelledHash("pkce", token);
  return {
    codeChallenge: createHash("sha256").update(codeVerifier, "ascii").digest("base64url"),
    codeVerifier,
    lookupHash: labelledHash("lookup", token),
    nonce: labelledHash("nonce", token),
    samlRequestId: `_${labelledHash("saml-request", token)}`,
    state: labelledHash("state", token),
  };
}

export function federationAuthorizationUrl(input: {
  readonly connection: Pick<FederationConnection, "clientId" | "endpoints" | "redirectUri">;
  readonly binding: FederationBinding;
  readonly loginHint?: string;
  readonly forceLogin: boolean;
}): string {
  const url = new URL(input.connection.endpoints.authorization);
  const parameters = {
    response_type: "code",
    scope: "openid email profile",
    client_id: input.connection.clientId,
    redirect_uri: input.connection.redirectUri,
    state: input.binding.state,
    nonce: input.binding.nonce,
    code_challenge: input.binding.codeChallenge,
    code_challenge_method: "S256",
    ...(input.loginHint === undefined ? {} : { login_hint: input.loginHint }),
    ...(input.forceLogin ? { prompt: "login", max_age: "0" } : {}),
  };
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.href;
}
