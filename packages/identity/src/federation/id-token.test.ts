import { describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, exportSPKI, type JWTPayload } from "jose";

import { verifyFederationIdToken } from "./id-token.ts";
import { makeFederationJwksCache } from "./jwks.ts";
import {
  CLIENT_ID,
  ISSUER,
  NONCE,
  connection,
  failureCode,
  fakeJwksEndpoint,
  signIdToken,
  signingKey,
  type SigningKey,
} from "./testing/fake-identity-provider.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1_000;

const rsa = await signingKey("RS256", "rsa-1");
const ec = await signingKey("ES256", "ec-1");

function claims(overrides: Readonly<Record<string, unknown>> = {}): JWTPayload {
  return {
    aud: CLIENT_ID,
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS - 30,
    iss: ISSUER,
    nonce: NONCE,
    sub: "00u1federated",
    ...overrides,
  };
}

function unsigned(payload: JWTPayload): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function verify(idToken: string, options: { readonly forceLoginSince?: Date } = {}) {
  const idp = fakeJwksEndpoint([rsa, ec]);
  const result = verifyFederationIdToken({
    connection,
    idToken,
    jwks: makeFederationJwksCache({ http: idp.http, now: () => NOW }),
    nonce: NONCE,
    now: NOW,
    ...options,
  });
  return { requests: idp.requests, result };
}

async function code(idToken: Promise<string> | string, options = {}) {
  return failureCode(verify(await idToken, options).result);
}

describe("verifyFederationIdToken", () => {
  test("returns the mapped claims of a valid RS256 token", async () => {
    const token = await signIdToken(
      rsa,
      claims({
        auth_time: NOW_SECONDS - 60,
        email: "Ada@Example.com",
        email_verified: true,
        hd: "example.com",
        name: "Ada Lovelace",
        xms_edov: false,
      }),
    );
    expect(await verify(token).result).toEqual({
      authenticatedAt: new Date("2026-10-08T11:59:00.000Z"),
      emailClaims: { email: "Ada@Example.com", emailVerified: true, hostedDomain: "example.com" },
      entraEmailDomainOwnerVerified: false,
      issuedAt: new Date("2026-10-08T11:59:30.000Z"),
      issuer: ISSUER,
      name: "Ada Lovelace",
      subject: "00u1federated",
    });
  });

  test("maps boolean claims only when they are literally boolean", async () => {
    const token = await signIdToken(
      ec,
      claims({ email: "ada@example.com", email_verified: "true", xms_edov: "1" }),
    );
    expect(await verify(token).result).toEqual({
      emailClaims: { email: "ada@example.com" },
      issuedAt: new Date("2026-10-08T11:59:30.000Z"),
      issuer: ISSUER,
      subject: "00u1federated",
    });
  });

  test("rejects alg none and HS256 keyed with the RSA public key before any key fetch", async () => {
    const pem = new TextEncoder().encode(await exportSPKI(rsa.publicKey));
    const jwkBytes = new TextEncoder().encode(JSON.stringify(await exportJWK(rsa.publicKey)));
    const hmac = (secret: Uint8Array) =>
      new SignJWT(claims()).setProtectedHeader({ alg: "HS256", kid: rsa.kid }).sign(secret);

    for (const token of [unsigned(claims()), await hmac(pem), await hmac(jwkBytes)]) {
      const { requests, result } = verify(token);
      expect({ code: await failureCode(result), keyFetches: requests.length }).toEqual({
        code: "id_token_signature_invalid",
        keyFetches: 0,
      });
    }
  });

  test("rejects a signature from a key the provider did not publish", async () => {
    const impostor: SigningKey = { ...(await signingKey("RS256", "x")), kid: rsa.kid };
    expect(await code(signIdToken(impostor, claims()))).toBe("id_token_signature_invalid");
  });

  test("enforces issuer, audience, and authorized party", async () => {
    const outcomes = await Promise.all(
      [
        claims({ iss: "https://idp.example.test/other" }),
        claims({ aud: "someone-else" }),
        claims({ aud: [CLIENT_ID, "someone-else"] }),
        claims({ azp: "someone-else" }),
        claims({ aud: [CLIENT_ID, "someone-else"], azp: "someone-else" }),
        claims({ aud: [CLIENT_ID, "someone-else"], azp: CLIENT_ID }),
        claims({ azp: CLIENT_ID }),
      ].map((payload) => code(signIdToken(rsa, payload))),
    );
    expect(outcomes).toEqual([
      "id_token_issuer_mismatch",
      "id_token_audience_mismatch",
      "id_token_audience_mismatch",
      "id_token_audience_mismatch",
      "id_token_audience_mismatch",
      "resolved",
      "resolved",
    ]);
  });

  test("allows 60 seconds of clock skew on exp, nbf, and iat", async () => {
    const token = (overrides: Readonly<Record<string, unknown>>) =>
      signIdToken(rsa, claims(overrides));
    const outcomes = await Promise.all(
      [
        { exp: NOW_SECONDS - 59, iat: NOW_SECONDS - 120 },
        { exp: NOW_SECONDS - 61, iat: NOW_SECONDS - 120 },
        { iat: NOW_SECONDS - 659 },
        { iat: NOW_SECONDS - 661 },
        { nbf: NOW_SECONDS + 59 },
        { nbf: NOW_SECONDS + 61 },
        { iat: NOW_SECONDS + 59 },
        { iat: NOW_SECONDS + 61 },
      ].map((overrides) => code(token(overrides))),
    );
    expect(outcomes).toEqual([
      "resolved",
      "id_token_expired",
      "resolved",
      "id_token_stale",
      "resolved",
      "id_token_not_yet_valid",
      "resolved",
      "id_token_not_yet_valid",
    ]);
    const oldest = await verify(await token({ iat: NOW_SECONDS - 659 })).result;
    expect(oldest.issuedAt).toEqual(new Date("2026-10-08T11:49:01.000Z"));
  });

  test("requires the expected nonce and a subject", async () => {
    const outcomes = await Promise.all(
      [
        claims({ nonce: "other-nonce" }),
        claims({ nonce: undefined }),
        claims({ sub: undefined }),
        claims({ sub: "" }),
        claims({ exp: undefined }),
      ].map((payload) => code(signIdToken(rsa, payload))),
    );
    expect(outcomes).toEqual([
      "id_token_nonce_mismatch",
      "id_token_nonce_mismatch",
      "id_token_claims_invalid",
      "id_token_claims_invalid",
      "id_token_claims_invalid",
    ]);
  });

  test("requires auth_time no earlier than 60 seconds before a forced login", async () => {
    const forceLoginSince = new Date("2026-10-08T11:58:00.000Z");
    const since = forceLoginSince.getTime() / 1_000;
    const outcomes = await Promise.all(
      [claims({ auth_time: since - 61 }), claims(), claims({ auth_time: since - 59 })].map(
        (payload) => code(signIdToken(rsa, payload), { forceLoginSince }),
      ),
    );
    expect(outcomes).toEqual([
      "id_token_reauthentication_missing",
      "id_token_reauthentication_missing",
      "resolved",
    ]);
    const accepted = await verify(await signIdToken(rsa, claims({ auth_time: since - 59 })), {
      forceLoginSince,
    }).result;
    expect(accepted.authenticatedAt).toEqual(new Date("2026-10-08T11:57:01.000Z"));
  });
});
