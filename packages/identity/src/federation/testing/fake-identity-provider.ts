import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";

import type { FederationConnection } from "../discovery.ts";
import { FederationError } from "../errors.ts";
import type { FederationHttp, FederationHttpRequest, FederationHttpResponse } from "../http.ts";

export const ISSUER = "https://idp.example.test/tenant";
export const CLIENT_ID = "client-123";
export const JWKS_URL = "https://idp.example.test/tenant/keys";
export const USERINFO_URL = "https://idp.example.test/tenant/userinfo";
export const NONCE = "expected-nonce";

export const connection: FederationConnection = {
  clientId: CLIENT_ID,
  clientSecret: "client-secret",
  endpoints: {
    authorization: "https://idp.example.test/tenant/authorize",
    jwks: JWKS_URL,
    token: "https://idp.example.test/tenant/token",
    userinfo: USERINFO_URL,
  },
  issuer: ISSUER,
  redirectUri: "https://auth.deployments.test/oauth2/federation/callback/01J8ORGANIZATION",
  signingAlgorithms: ["RS256", "ES256"],
  tokenEndpointAuthMethod: "client_secret_basic",
};

export function jsonResponse(status: number, body: unknown): FederationHttpResponse {
  return {
    body: JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
    status,
  };
}

export function recordingHttp(
  respond: (request: FederationHttpRequest) => FederationHttpResponse,
): {
  readonly http: FederationHttp;
  readonly requests: FederationHttpRequest[];
} {
  const requests: FederationHttpRequest[] = [];
  return {
    http: (request) => {
      requests.push(request);
      return Promise.resolve(respond(request));
    },
    requests,
  };
}

export interface SigningKey {
  readonly alg: "RS256" | "ES256";
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicJwk: JWK;
}

export async function signingKey(alg: SigningKey["alg"], kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  return {
    alg,
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), alg, kid, use: "sig" },
    publicKey,
  };
}

export function signIdToken(key: SigningKey, claims: JWTPayload): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "JWT" })
    .sign(key.privateKey);
}

export function fakeJwksEndpoint(initial: readonly SigningKey[]): {
  readonly http: FederationHttp;
  readonly requests: FederationHttpRequest[];
  readonly publish: (keys: readonly SigningKey[]) => void;
} {
  let published = initial;
  const { http, requests } = recordingHttp((request) =>
    request.url === JWKS_URL
      ? jsonResponse(200, { keys: published.map((key) => key.publicJwk) })
      : jsonResponse(404, {}),
  );
  return {
    http,
    publish: (keys) => {
      published = keys;
    },
    requests,
  };
}

export async function failureCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "resolved";
  } catch (error) {
    return error instanceof FederationError ? error.code : `unexpected: ${String(error)}`;
  }
}
