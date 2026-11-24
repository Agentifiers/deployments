import { Ulid } from "@deployments-ai/db";
import type { OAuthTokenSet, OidcClient } from "@deployments-ai/web-bff-auth";
import { Schema } from "effect";
import { decodeJwt } from "jose";

export interface PlatformIdentity {
  readonly email: string | null;
  readonly principalId: Ulid;
  readonly tokenSessionId: Ulid;
}

export interface AuthorizationRequest {
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly organizationHint: Ulid;
  readonly state: string;
}

export type PlatformSignInRefusal =
  | "issuer-mismatch"
  | "token-exchange-failed"
  | "token-response-invalid";

export type PlatformSignInOutcome =
  | { readonly identity: PlatformIdentity; readonly kind: "signed-in" }
  | { readonly kind: "refused"; readonly reason: PlatformSignInRefusal };

export interface PlatformSignIn {
  readonly authorizationUrl: (request: AuthorizationRequest) => Promise<string>;
  readonly redeemCode: (input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly iss: string | null;
    readonly nonceHash: string;
  }) => Promise<PlatformSignInOutcome>;
}

const SCOPES = "email openid profile";

export function makePlatformSignIn(config: {
  readonly clientId: string;
  readonly issuer: string;
  readonly oidc: OidcClient;
  readonly redirectUri: string;
}): PlatformSignIn {
  const { oidc } = config;
  return {
    async authorizationUrl(request) {
      const url = new URL((await oidc.metadata()).authorizationEndpoint);
      const parameters = {
        client_id: config.clientId,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        nonce: request.nonce,
        organization_hint: request.organizationHint,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: SCOPES,
        state: request.state,
      };
      for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
      return url.href;
    },

    async redeemCode(input) {
      // RFC 9207: a response that names another issuer is a mix-up, not this sign-in.
      if (input.iss !== config.issuer) return { kind: "refused", reason: "issuer-mismatch" };
      let tokens: OAuthTokenSet;
      try {
        tokens = await oidc.exchangeCode({ code: input.code, codeVerifier: input.codeVerifier });
      } catch {
        return { kind: "refused", reason: "token-exchange-failed" };
      }
      try {
        if (!tokens.idToken) throw new Error("The token response has no ID token.");
        const claims = await oidc.verifyIdTokenClaims(tokens.idToken, {
          code: input.code,
          nonceHash: input.nonceHash,
        });
        // OIDC Core 3.1.3.7: the direct TLS token response stands in for a signature check.
        const access = decodeJwt(tokens.accessToken);
        const principalId = Schema.decodeUnknownSync(Ulid)(claims.sub);
        if (access.sub !== principalId) throw new Error("The access token names another subject.");
        return {
          identity: {
            email:
              claims.email_verified === true && typeof claims.email === "string" && claims.email
                ? claims.email
                : null,
            principalId,
            tokenSessionId: Schema.decodeUnknownSync(Ulid)(access.sid),
          },
          kind: "signed-in",
        };
      } catch {
        return { kind: "refused", reason: "token-response-invalid" };
      }
    },
  };
}
