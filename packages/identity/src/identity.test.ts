import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PASSWORD_PROFILE,
  assertDeviceScopes,
  emailClaimValue,
  hashPassword,
  idTokenClaims,
  normalizeEmail,
  redirectUriMatches,
  sha256Base64Url,
  validateAuthorizationRequest,
  validatePasswordInput,
  validatePkce,
  verifyPasswordEqualized,
  type OAuthClient,
} from "./index.ts";

const publicClient: OAuthClient = {
  allowedScopes: ["organizations:read"],
  clientId: "deployments-cli",
  grantTypes: ["authorization_code"],
  redirectUris: ["http://127.0.0.1/callback"],
  requiredScopes: [],
  requirePkce: true,
  responseTypes: ["code"],
  status: "active",
  tokenEndpointAuthMethod: "none",
  type: "public",
};

describe("platform identity primitives", () => {
  test("normalizes email without provider-specific rewriting", () => {
    expect(normalizeEmail(" User.Name+tag@Example.com ")).toBe("user.name+tag@example.com");
    expect(emailClaimValue("user.name+tag@example.com")).toHaveLength(64);
  });

  test("enforces password input policy and verifies scrypt hashes", async () => {
    const password = "a long password with spaces";
    expect(DEFAULT_PASSWORD_PROFILE).toMatchObject({
      blockSize: 8,
      memoryCost: 131_072,
      parallelization: 1,
    });
    validatePasswordInput(password);
    expect(() => validatePasswordInput("short")).toThrow();
    const encodedHash = await hashPassword(password, DEFAULT_PASSWORD_PROFILE);
    expect(encodedHash).toContain("$N=131072$r=8$p=1$");
    expect(
      verifyPasswordEqualized({ encodedHash, password, profiles: [DEFAULT_PASSWORD_PROFILE] }),
    ).resolves.toEqual({ matched: true, needsRehash: false });
  });

  test("requires S256 PKCE and matches only IP-literal loopback callbacks", () => {
    const verifier = "a".repeat(43);
    expect(() =>
      validatePkce({ challenge: sha256Base64Url(verifier), method: "S256", verifier }),
    ).not.toThrow();
    expect(redirectUriMatches(publicClient, "http://127.0.0.1:49152/callback")).toBeTrue();
    expect(redirectUriMatches(publicClient, "http://localhost:49152/callback")).toBeFalse();
  });

  test("matches one host label for a confidential client's wildcard callback", () => {
    const webClient: OAuthClient = {
      ...publicClient,
      clientId: "deployments-web",
      redirectUris: [
        "https://app.example.com/auth/callback",
        "https://*.sandbox.dev/auth/callback",
      ],
      tokenEndpointAuthMethod: "client_secret_basic",
      type: "confidential",
    };
    expect(redirectUriMatches(webClient, "https://t-abc-p22676.sandbox.dev/auth/callback")).toBe(
      true,
    );
    expect(redirectUriMatches(webClient, "https://app.example.com/auth/callback")).toBeTrue();
    for (const rejected of [
      "https://sandbox.dev/auth/callback",
      "https://a.b.sandbox.dev/auth/callback",
      "https://evilsandbox.dev/auth/callback",
      "https://x.sandbox.dev.evil.example/auth/callback",
      "http://x.sandbox.dev/auth/callback",
      "https://x.sandbox.dev:8443/auth/callback",
      "https://x.sandbox.dev/auth/callback/extra",
      "https://x.sandbox.dev/auth/callback?next=/",
      "https://-x.sandbox.dev/auth/callback",
    ]) {
      expect(redirectUriMatches(webClient, rejected)).toBeFalse();
    }
    expect(
      redirectUriMatches(
        { ...publicClient, redirectUris: webClient.redirectUris },
        "https://x.sandbox.dev/auth/callback",
      ),
    ).toBeFalse();
  });

  test("requires a bounded nonce exactly for OpenID authorization requests", () => {
    const openIdClient = {
      ...publicClient,
      allowedScopes: ["openid"],
      requiredScopes: ["openid"],
    };
    const request = {
      client: openIdClient,
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      redirectUri: "http://127.0.0.1/callback",
      responseType: "code",
      scopes: ["openid"],
    } as const;
    expect(() => validateAuthorizationRequest(request)).toThrow("nonce is required");
    expect(() => validateAuthorizationRequest({ ...request, nonce: "n".repeat(257) })).toThrow(
      "nonce is required",
    );
    expect(validateAuthorizationRequest({ ...request, nonce: "browser-nonce" })).toEqual([
      "openid",
    ]);
    expect(() =>
      validateAuthorizationRequest({
        ...request,
        client: publicClient,
        nonce: "unexpected",
        scopes: ["organizations:read"],
      }),
    ).toThrow("Nonce is only supported");
  });

  test("keeps the first device profile OAuth-only", () => {
    expect(() => assertDeviceScopes(["openid"])).toThrow();
  });

  test("delivers the available standard profile claim only when requested", () => {
    const input = {
      authenticationMethods: ["pwd"],
      authenticationTime: new Date("2026-07-28T00:00:00.000Z"),
      clientId: "deployments-web",
      displayName: "Ada Lovelace",
      issuedAt: new Date("2026-07-28T00:05:00.000Z"),
      policy: {
        accessTokenSeconds: 300,
        idTokenSeconds: 300,
        issuer: "https://identity.example",
        resourceAudience: "deployments-api",
      },
      principalId: "principal-id",
      sessionEpoch: 0,
    } as const;

    expect(idTokenClaims({ ...input, scopes: ["openid", "profile"] })).toMatchObject({
      name: "Ada Lovelace",
    });
    expect(idTokenClaims({ ...input, scopes: ["openid"] })).not.toHaveProperty("name");
  });
});
