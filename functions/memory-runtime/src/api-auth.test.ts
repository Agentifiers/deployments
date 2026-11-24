import { describe, expect, it, mock } from "bun:test";
import { createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  authenticateMemoryApiEvent,
  createMemoryJwtVerifier,
  memoryJwtAudienceMatches,
} from "./api-auth.ts";
import { handler, handleMemoryApi } from "./api.ts";
import { MemoryApiError, type MemoryApiEvent } from "./api-support.ts";

const request: MemoryApiEvent = {
  headers: { Authorization: "Bearer signed.jwt.token" },
  rawPath: "/v1/memory/policies",
  requestContext: {
    http: { method: "GET", path: "/v1/memory/policies" },
    requestId: "request-1",
  },
};

describe("memory API application authentication", () => {
  it("preserves gateway audience precedence and client fallback", () => {
    const accepted = ["https://api.deployments.ai"];
    expect(memoryJwtAudienceMatches({ aud: accepted[0]! }, accepted)).toBe(true);
    expect(memoryJwtAudienceMatches({ aud: ["other", accepted[0]!] }, accepted)).toBe(true);
    expect(memoryJwtAudienceMatches({ client_id: accepted[0]! }, accepted)).toBe(true);
    expect(memoryJwtAudienceMatches({ aud: "other", client_id: accepted[0]! }, accepted)).toBe(
      false,
    );
  });

  it("honors an explicitly configured HTTPS JWKS endpoint", async () => {
    const createJwks = mock((_url: URL) => async () => ({}) as never);
    const verify = createMemoryJwtVerifier(
      {
        DEPLOYMENTS_AI_MEMORY_JWKS_URI: "https://keys.example.test/platform.json",
        DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES: '["https://api.deployments.ai"]',
        DEPLOYMENTS_AI_MEMORY_JWT_ISSUER: "https://auth.deployments.ai",
      },
      createJwks as never,
    );
    await verify("not-a-token").catch(() => undefined);
    expect(createJwks).toHaveBeenCalledWith(
      new URL("https://keys.example.test/platform.json"),
      expect.any(Object),
    );
  });

  it("uses OIDC discovery when the issuer publishes a non-relative JWKS endpoint", async () => {
    const createJwks = mock((_url: URL) => async () => ({}) as never);
    const fetchDiscovery = mock(async () =>
      Response.json({
        issuer: "https://accounts.example.test",
        jwks_uri: "https://keys.example.test/oauth/jwks.json",
      }),
    );
    const verify = createMemoryJwtVerifier(
      {
        DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES: '["deployments-cli"]',
        DEPLOYMENTS_AI_MEMORY_JWT_ISSUER: "https://accounts.example.test",
      },
      createJwks as never,
      fetchDiscovery as never,
    );

    await verify("not-a-token").catch(() => undefined);

    expect(fetchDiscovery).toHaveBeenCalledWith(
      new URL("https://accounts.example.test/.well-known/openid-configuration"),
    );
    expect(createJwks).toHaveBeenCalledWith(
      new URL("https://keys.example.test/oauth/jwks.json"),
      expect.any(Object),
    );
  });

  it("retries OIDC discovery after a transient failure", async () => {
    const createJwks = mock((_url: URL) => async () => ({}) as never);
    const fetchDiscovery = mock(async () =>
      fetchDiscovery.mock.calls.length === 1
        ? new Response(undefined, { status: 503 })
        : Response.json({
            issuer: "https://accounts.example.test",
            jwks_uri: "https://keys.example.test/oauth/jwks.json",
          }),
    );
    const verify = createMemoryJwtVerifier(
      {
        DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES: '["deployments-cli"]',
        DEPLOYMENTS_AI_MEMORY_JWT_ISSUER: "https://accounts.example.test",
      },
      createJwks as never,
      fetchDiscovery as never,
    );

    await verify("not-a-token").catch(() => undefined);
    await verify("still-not-a-token").catch(() => undefined);

    expect(fetchDiscovery).toHaveBeenCalledTimes(2);
    expect(createJwks).toHaveBeenCalledTimes(1);
  });

  it("retries a transient JWKS response within the verifying request", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const issuer = "https://auth.deployments.ai";
    const kid = "retry-test-key";
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid, use: "sig" };
    let cancelledBodies = 0;
    const fetchJwks = mock(async () =>
      fetchJwks.mock.calls.length === 1
        ? new Response(
            new ReadableStream({
              cancel: () => {
                cancelledBodies += 1;
              },
            }),
            { status: 503 },
          )
        : Response.json({ keys: [jwk] }),
    );
    const token = await new SignJWT({ aud: "https://api.deployments.ai" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const verify = createMemoryJwtVerifier(
      {
        DEPLOYMENTS_AI_MEMORY_JWKS_URI: `${issuer}/.well-known/jwks.json`,
        DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES: '["https://api.deployments.ai"]',
        DEPLOYMENTS_AI_MEMORY_JWT_ISSUER: issuer,
      },
      createRemoteJWKSet,
      fetchJwks as never,
    );

    expect(verify(token)).resolves.toMatchObject({ iss: issuer });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    expect(cancelledBodies).toBe(1);
  });

  it("accepts Cognito-style access tokens without an optional typ header", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const issuer = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_example";
    const token = await new SignJWT({
      client_id: "deployments-cli",
      token_use: "access",
    })
      .setProtectedHeader({ alg: "RS256", kid: "cognito-test-key" })
      .setIssuer(issuer)
      .setSubject("cognito-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const createJwks = mock(() => async () => publicKey);
    const verify = createMemoryJwtVerifier(
      {
        DEPLOYMENTS_AI_MEMORY_JWKS_URI: `${issuer}/.well-known/jwks.json`,
        DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES: '["deployments-cli"]',
        DEPLOYMENTS_AI_MEMORY_JWT_ISSUER: issuer,
      },
      createJwks as never,
    );

    expect(verify(token)).resolves.toMatchObject({
      client_id: "deployments-cli",
      sub: "cognito-user",
      token_use: "access",
    });
  });

  it("rejects signed tokens issued beyond the allowed clock skew", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const issuer = "https://auth.deployments.ai";
    const token = await new SignJWT({ aud: "https://api.deployments.ai" })
      .setProtectedHeader({ alg: "RS256", kid: "future-token-key" })
      .setIssuer(issuer)
      .setIssuedAt(Math.floor(Date.now() / 1_000) + 120)
      .setExpirationTime("5m")
      .sign(privateKey);
    const verify = createMemoryJwtVerifier(
      {
        DEPLOYMENTS_AI_MEMORY_JWKS_URI: `${issuer}/.well-known/jwks.json`,
        DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES: '["https://api.deployments.ai"]',
        DEPLOYMENTS_AI_MEMORY_JWT_ISSUER: issuer,
      },
      (() => async () => publicKey) as never,
    );

    expect(verify(token)).rejects.toThrow("JWT was issued in the future.");
  });

  it("requires expiration and preserves an issuer's canonical trailing slash", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const issuer = "https://auth.deployments.ai/";
    const unboundedToken = await new SignJWT({ aud: "https://api.deployments.ai" })
      .setProtectedHeader({ alg: "RS256", kid: "expiration-test-key" })
      .setIssuer(issuer)
      .setIssuedAt()
      .sign(privateKey);
    const boundedToken = await new SignJWT({ aud: "https://api.deployments.ai" })
      .setProtectedHeader({ alg: "RS256", kid: "expiration-test-key" })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const verify = createMemoryJwtVerifier(
      {
        DEPLOYMENTS_AI_MEMORY_JWKS_URI: `${issuer}.well-known/jwks.json`,
        DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES: '["https://api.deployments.ai"]',
        DEPLOYMENTS_AI_MEMORY_JWT_ISSUER: issuer,
      },
      (() => async () => publicKey) as never,
    );

    expect(verify(unboundedToken)).rejects.toThrow("JWT expiration is required.");
    expect(verify(boundedToken)).resolves.toMatchObject({ iss: issuer });
  });

  it("keeps unauthenticated requests out of the memory handler", async () => {
    expect(handler).not.toBe(handleMemoryApi);
    expect(handler({ ...request, headers: {} })).resolves.toMatchObject({
      body: expect.stringContaining('"code":"unauthorized"'),
      statusCode: 401,
    });
  });

  it("verifies a bearer before projecting only JWT claims into the API Gateway event shape", async () => {
    const verify = mock(async () => ({
      aud: "https://api.example.com",
      client_id: "deployments-cli",
      exp: 1_800_000_000,
      ignored: { secret: "not-a-claim" },
      scope: "memory:admin memory:read",
      sub: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    }));

    const authenticated = await authenticateMemoryApiEvent(request, verify);

    expect(verify).toHaveBeenCalledWith("signed.jwt.token");
    expect(authenticated.requestContext?.authorizer?.jwt?.claims).toEqual({
      aud: "https://api.example.com",
      client_id: "deployments-cli",
      exp: "1800000000",
      scope: "memory:admin memory:read",
      sub: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(request.requestContext?.authorizer).toBeUndefined();
  });

  it("fails closed for missing, malformed, and rejected bearers", async () => {
    const rejected = mock(async () => {
      throw new Error("signature detail must not escape");
    });
    for (const event of [
      { ...request, headers: {} },
      { ...request, headers: { authorization: "Basic credential" } },
      request,
    ]) {
      try {
        await authenticateMemoryApiEvent(event, rejected);
        throw new Error("Expected authentication to fail.");
      } catch (cause) {
        expect(cause).toBeInstanceOf(MemoryApiError);
        expect(cause).toMatchObject({ code: "unauthorized", statusCode: 401 });
        expect((cause as Error).message).toBe("A valid platform access token is required.");
      }
    }
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});
