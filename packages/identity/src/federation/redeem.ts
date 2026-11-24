import type { FederationBinding } from "./binding.ts";
import type { FederationConnection, FederationEndpoints } from "./discovery.ts";
import type { FederationHttp } from "./http.ts";
import { verifyFederationIdToken, type VerifiedIdTokenClaims } from "./id-token.ts";
import type { FederationJwksCache } from "./jwks.ts";
import type { EmailClaims, FederationProfile } from "./profile.ts";
import { exchangeFederationCode, type FederationTokens } from "./token.ts";
import { requestFederationUserinfo } from "./userinfo.ts";

export interface FederatedClaims extends EmailClaims {
  readonly issuer: string;
  readonly protocol: "oidc";
  readonly subject: string;
  readonly entraEmailDomainOwnerVerified?: boolean;
  readonly name?: string;
}

export type ClaimSource =
  | { readonly kind: "id_token" }
  | { readonly kind: "userinfo"; readonly endpoint: string; readonly bearerAccessToken: string };

export function claimSource(input: {
  readonly claims: VerifiedIdTokenClaims;
  readonly endpoints: FederationEndpoints;
  readonly tokens: Pick<FederationTokens, "bearerAccessToken">;
}): ClaimSource {
  const { claims, endpoints, tokens } = input;
  const idTokenStatesEmailVerdict =
    claims.emailClaims.emailVerified !== undefined ||
    claims.entraEmailDomainOwnerVerified !== undefined;
  if (
    idTokenStatesEmailVerdict ||
    endpoints.userinfo === undefined ||
    tokens.bearerAccessToken === undefined
  ) {
    return { kind: "id_token" };
  }
  return {
    bearerAccessToken: tokens.bearerAccessToken,
    endpoint: endpoints.userinfo,
    kind: "userinfo",
  };
}

async function sourcedProfile(input: {
  readonly claims: VerifiedIdTokenClaims;
  readonly http: FederationHttp;
  readonly source: ClaimSource;
}): Promise<FederationProfile> {
  const { claims, source } = input;
  switch (source.kind) {
    case "id_token":
      return claims;
    case "userinfo":
      return requestFederationUserinfo({
        bearerAccessToken: source.bearerAccessToken,
        endpoint: source.endpoint,
        http: input.http,
        subject: claims.subject,
      });
    default: {
      const unhandled: never = source;
      return unhandled;
    }
  }
}

export async function redeemFederationCode(input: {
  readonly binding: Pick<FederationBinding, "codeVerifier" | "nonce">;
  readonly code: string;
  readonly connection: FederationConnection;
  readonly http: FederationHttp;
  readonly jwks: FederationJwksCache;
  readonly now: Date;
  readonly forceLoginSince?: Date;
}): Promise<FederatedClaims> {
  const { binding, connection, http } = input;
  const tokens = await exchangeFederationCode({
    code: input.code,
    codeVerifier: binding.codeVerifier,
    connection,
    http,
  });
  const claims = await verifyFederationIdToken({
    connection,
    idToken: tokens.idToken,
    jwks: input.jwks,
    nonce: binding.nonce,
    now: input.now,
    ...(input.forceLoginSince === undefined ? {} : { forceLoginSince: input.forceLoginSince }),
  });
  const source = claimSource({ claims, endpoints: connection.endpoints, tokens });
  const profile = await sourcedProfile({ claims, http, source });
  const name = claims.name ?? profile.name;
  return {
    issuer: claims.issuer,
    protocol: "oidc",
    subject: claims.subject,
    ...profile.emailClaims,
    ...(claims.entraEmailDomainOwnerVerified === undefined
      ? {}
      : { entraEmailDomainOwnerVerified: claims.entraEmailDomainOwnerVerified }),
    ...(name === undefined ? {} : { name }),
  };
}
