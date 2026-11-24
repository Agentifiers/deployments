import { describe, expect, test } from "bun:test";

import type { VerifiedIdTokenClaims } from "./id-token.ts";
import { makeFederationJwksCache } from "./jwks.ts";
import type { EmailClaims } from "./profile.ts";
import { claimSource, redeemFederationCode } from "./redeem.ts";
import {
  CLIENT_ID,
  ISSUER,
  JWKS_URL,
  NONCE,
  USERINFO_URL,
  connection,
  failureCode,
  jsonResponse,
  recordingHttp,
  signIdToken,
  signingKey,
} from "./testing/fake-identity-provider.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1_000;
const TOKEN_URL = connection.endpoints.token;
const rsa = await signingKey("RS256", "rsa-1");

function verified(
  emailClaims: EmailClaims,
  entraEmailDomainOwnerVerified?: boolean,
): VerifiedIdTokenClaims {
  return {
    emailClaims,
    ...(entraEmailDomainOwnerVerified === undefined ? {} : { entraEmailDomainOwnerVerified }),
    issuedAt: NOW,
    issuer: ISSUER,
    subject: "00u1federated",
  };
}

async function redeem(input: {
  readonly idTokenClaims: Readonly<Record<string, unknown>>;
  readonly userinfo: Readonly<Record<string, unknown>>;
}) {
  const idToken = await signIdToken(rsa, {
    aud: CLIENT_ID,
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS,
    iss: ISSUER,
    sub: "00u1federated",
    ...input.idTokenClaims,
  });
  const idp = recordingHttp((request) => {
    switch (request.url) {
      case TOKEN_URL:
        return jsonResponse(200, { access_token: "at-1", id_token: idToken, token_type: "Bearer" });
      case JWKS_URL:
        return jsonResponse(200, { keys: [rsa.publicJwk] });
      case USERINFO_URL:
        return jsonResponse(200, input.userinfo);
      default:
        return jsonResponse(404, {});
    }
  });
  const result = redeemFederationCode({
    binding: { codeVerifier: "verifier", nonce: NONCE },
    code: "auth-code",
    connection,
    http: idp.http,
    jwks: makeFederationJwksCache({ http: idp.http, now: () => NOW }),
    now: NOW,
  });
  return { requested: () => idp.requests.map((request) => request.url), result };
}

describe("claimSource", () => {
  test("asks userinfo only when the ID token states no verdict and a Bearer token can reach it", () => {
    const bearer = { bearerAccessToken: "at-1" };
    const silent = verified({ email: "ada@example.com" });
    const source = (
      claims: VerifiedIdTokenClaims,
      endpoints: typeof connection.endpoints = connection.endpoints,
      tokens: { readonly bearerAccessToken?: string } = bearer,
    ) => claimSource({ claims, endpoints, tokens }).kind;
    const withoutUserinfo = {
      authorization: connection.endpoints.authorization,
      jwks: JWKS_URL,
      token: TOKEN_URL,
    };

    expect([
      source(verified({ email: "ada@example.com", emailVerified: true })),
      source(verified({ email: "ada@example.com", emailVerified: false })),
      source(verified({ email: "ada@example.com" }, true)),
      source(verified({ email: "ada@example.com" }, false)),
      source(verified({ emailVerified: true }, false)),
      source(silent),
      source(verified({})),
      source(silent, withoutUserinfo),
      source(silent, connection.endpoints, {}),
    ]).toEqual([
      "id_token",
      "id_token",
      "id_token",
      "id_token",
      "id_token",
      "userinfo",
      "userinfo",
      "id_token",
      "id_token",
    ]);
    expect(
      claimSource({ claims: silent, endpoints: connection.endpoints, tokens: bearer }),
    ).toEqual({ bearerAccessToken: "at-1", endpoint: USERINFO_URL, kind: "userinfo" });
  });
});

describe("redeemFederationCode", () => {
  test("takes the email bundle from userinfo and keeps identity and name from the ID token", async () => {
    const { requested, result } = await redeem({
      idTokenClaims: { email: "ada@old.example", name: "Ada Lovelace", nonce: NONCE },
      userinfo: {
        email: "ada@example.com",
        email_verified: true,
        name: "A. L.",
        sub: "00u1federated",
      },
    });

    expect(await result).toStrictEqual({
      email: "ada@example.com",
      emailVerified: true,
      issuer: ISSUER,
      protocol: "oidc",
      name: "Ada Lovelace",
      subject: "00u1federated",
    });
    expect(requested()).toEqual([TOKEN_URL, JWKS_URL, USERINFO_URL]);
  });

  test("never pairs a userinfo response's silence with the ID token's address", async () => {
    const { result } = await redeem({
      idTokenClaims: { email: "ada@example.com", hd: "example.com", nonce: NONCE },
      userinfo: { email_verified: true, name: "Ada Lovelace", sub: "00u1federated" },
    });

    expect(await result).toStrictEqual({
      emailVerified: true,
      issuer: ISSUER,
      protocol: "oidc",
      name: "Ada Lovelace",
      subject: "00u1federated",
    });
  });

  test("an ID token with a verdict or a foreign nonce never reaches userinfo", async () => {
    const stated = await redeem({
      idTokenClaims: {
        email: "ada@example.com",
        email_verified: false,
        nonce: NONCE,
        xms_edov: true,
      },
      userinfo: { email: "ada@example.com", email_verified: true, sub: "00u1federated" },
    });
    const replayed = await redeem({
      idTokenClaims: { email: "ada@example.com", nonce: "another-nonce" },
      userinfo: { email: "ada@example.com", email_verified: true, sub: "00u1federated" },
    });

    expect(await stated.result).toStrictEqual({
      email: "ada@example.com",
      emailVerified: false,
      entraEmailDomainOwnerVerified: true,
      issuer: ISSUER,
      protocol: "oidc",
      subject: "00u1federated",
    });
    expect(await failureCode(replayed.result)).toBe("id_token_nonce_mismatch");
    expect([stated.requested(), replayed.requested()]).toEqual([
      [TOKEN_URL, JWKS_URL],
      [TOKEN_URL, JWKS_URL],
    ]);
  });
});
