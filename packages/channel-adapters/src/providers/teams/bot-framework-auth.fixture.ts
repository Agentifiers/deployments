import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

import {
  TEAMS_BOT_FRAMEWORK_OPENID_METADATA_URL,
  TEAMS_BOT_FRAMEWORK_TOKEN_ISSUER,
} from "./bot-framework-auth.ts";

export const TEST_APP_ID = "00000000-0000-4000-8000-000000000001";
export const TEST_SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const TEST_JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";

export interface TestSigningKey {
  readonly jwk: JWK & { readonly endorsements?: readonly string[] };
  sign(input?: {
    readonly audience?: string;
    readonly claims?: Readonly<Record<string, unknown>>;
    readonly expiresAt?: number;
    readonly issuer?: string;
    readonly notBefore?: number;
  }): Promise<string>;
}

export async function testSigningKey(
  kid: string,
  endorsements: readonly string[] = ["msteams"],
): Promise<TestSigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), endorsements, kid, kty: "RSA", use: "sig" };
  return {
    jwk,
    sign: (input = {}) => {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      return new SignJWT({ serviceUrl: TEST_SERVICE_URL, ...input.claims })
        .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
        .setIssuer(input.issuer ?? TEAMS_BOT_FRAMEWORK_TOKEN_ISSUER)
        .setAudience(input.audience ?? TEST_APP_ID)
        .setIssuedAt(nowSeconds - 60)
        .setNotBefore(input.notBefore ?? nowSeconds - 60)
        .setExpirationTime(input.expiresAt ?? nowSeconds + 3_600)
        .sign(privateKey);
    },
  };
}

/**
 * Fake Bot Framework OpenID endpoints serving a mutable key set. Counts every outbound request
 * and JWKS download; `unavailable` makes the metadata endpoint answer 503.
 */
export function fakeBotFrameworkKeyServer(initialKeys: readonly TestSigningKey["jwk"][]) {
  const state = { jwksRequests: 0, keys: [...initialKeys], requests: 0, unavailable: false };
  const fetchImpl = (async (input: string | URL | Request) => {
    state.requests += 1;
    const url = input instanceof Request ? input.url : String(input);
    if (url === TEAMS_BOT_FRAMEWORK_OPENID_METADATA_URL) {
      if (state.unavailable) return new Response("unavailable", { status: 503 });
      return Response.json({ issuer: TEAMS_BOT_FRAMEWORK_TOKEN_ISSUER, jwks_uri: TEST_JWKS_URL });
    }
    if (url === TEST_JWKS_URL) {
      state.jwksRequests += 1;
      return Response.json({ keys: state.keys });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, state };
}
