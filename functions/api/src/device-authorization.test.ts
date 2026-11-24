import { describe, expect, test } from "bun:test";
import {
  BRAIN_API_ROUTES,
  CREDENTIAL_REFERENCE_API_ROUTES,
  MODEL_API_ROUTES,
} from "@deployments-ai/api-contract";
import { PLATFORM_CLI_SCOPES, SUPPORTED_OAUTH_SCOPES } from "@deployments-ai/identity";
import { capabilities } from "./api-request-authorization.ts";
import { createDeviceAuthorizationService } from "./device-authorization.ts";

function requestUrl(input: string | URL | Request) {
  return input instanceof Request ? input.url : String(input);
}

function formBody(body: RequestInit["body"]) {
  if (!(body instanceof URLSearchParams)) throw new TypeError("Expected a form-encoded body.");
  return body.toString();
}

describe("OIDC device authorization", () => {
  test("registers every tenancy API capability as a CLI or privileged scope", () => {
    const allowed = new Set<string>(SUPPORTED_OAUTH_SCOPES);
    expect(
      [...new Set(Object.values(capabilities))].filter((scope) => !allowed.has(scope)),
    ).toEqual([]);
    expect(
      [...MODEL_API_ROUTES, ...CREDENTIAL_REFERENCE_API_ROUTES]
        .map((route) => route.requiredAuthorization)
        .filter((scope) => !(PLATFORM_CLI_SCOPES as readonly string[]).includes(scope)),
    ).toEqual([]);
    expect(PLATFORM_CLI_SCOPES).not.toContain("managed-skills:admin");
    expect(PLATFORM_CLI_SCOPES).not.toContain("memory:execute");
    expect(SUPPORTED_OAUTH_SCOPES).toContain("managed-skills:admin");
    expect(SUPPORTED_OAUTH_SCOPES).toContain("memory:execute");
    expect(PLATFORM_CLI_SCOPES).toContain("agent-email:read");
    expect(PLATFORM_CLI_SCOPES).toContain("agent-email:write");
    expect(PLATFORM_CLI_SCOPES).toContain("agent-email:admin");
    expect(PLATFORM_CLI_SCOPES).toContain("providers:read");
    expect(PLATFORM_CLI_SCOPES).toContain("providers:write");
    expect(PLATFORM_CLI_SCOPES).toContain("tools:read");
    expect(PLATFORM_CLI_SCOPES).toContain("tools:write");
    expect(PLATFORM_CLI_SCOPES).toContain("observability:read");
    expect(PLATFORM_CLI_SCOPES).toContain("observability:write");
    for (const scope of [
      "approvals:read",
      "approvals:write",
      "artifacts:read",
      "artifacts:write",
      "memory:admin",
      "memory:read",
      "memory:write",
      "runs:read",
      "runs:write",
      "schedules:read",
      "schedules:write",
      "webhooks:read",
      "webhooks:write",
    ]) {
      expect(PLATFORM_CLI_SCOPES as readonly string[]).toContain(scope);
    }
  });

  test("grants CLI users every Brain route capability", () => {
    const cliScopes = new Set<string>(PLATFORM_CLI_SCOPES);
    const brainScopes = [...new Set(BRAIN_API_ROUTES.map((route) => route.requiredAuthorization))];
    expect(brainScopes.toSorted()).toEqual([
      "brains:admin",
      "brains:create",
      "brains:read",
      "brains:write",
    ]);
    expect(brainScopes.filter((scope) => !cliScopes.has(scope))).toEqual([]);
  });

  test("discovers RFC 8628 endpoints and returns the platform access-token bearer", async () => {
    const requests: Array<{ body?: string; url: string }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, ...(init?.body ? { body: formBody(init.body) } : {}) });
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: "https://identity.example/oauth/device",
          revocation_endpoint: "https://identity.example/oauth/revoke",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      if (url.endsWith("/oauth/device")) {
        return Response.json({
          device_code: "secret-device-code",
          expires_in: 600,
          interval: 5,
          user_code: "ABCD-EFGH",
          verification_uri: "https://identity.example/device",
        });
      }
      return Response.json({
        access_token: "header.payload.signature",
        expires_in: 3600,
        refresh_token: "refresh-token",
        token_type: "Bearer",
      });
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "access_token",
      clientId: "client-id",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "https://identity.example",
      scopes: ["offline_access", "organizations:read"],
    });

    expect(service.start()).resolves.toMatchObject({
      deviceCode: "secret-device-code",
      userCode: "ABCD-EFGH",
    });
    expect(service.exchange("secret-device-code")).resolves.toEqual({
      bearerToken: "header.payload.signature",
      expiresIn: 3600,
      refreshToken: "refresh-token",
      tokenType: "Bearer",
    });
    expect(service.refresh("refresh-token")).resolves.toMatchObject({
      bearerToken: "header.payload.signature",
      expiresIn: 3600,
      refreshToken: "refresh-token",
    });
    expect(requests[0]?.url).toBe("https://identity.example/.well-known/openid-configuration");
    expect(requests[1]?.body).toContain("client_id=client-id");
    expect(requests[1]?.body).toContain("scope=offline_access+organizations%3Aread");
    expect(requests[2]?.body).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
    );
    expect(requests[3]?.body).toContain("grant_type=refresh_token");
    expect(requests[3]?.body).toContain("refresh_token=refresh-token");
  });

  test("revokes refresh tokens through the discovered RFC 7009 endpoint", async () => {
    const requests: Array<{ body?: string; url: string }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, ...(init?.body ? { body: formBody(init.body) } : {}) });
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: "https://identity.example/oauth/device",
          revocation_endpoint: "https://identity.example/oauth/revoke",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      return new Response(null, { status: 200 });
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "access_token",
      clientId: "deployments-cli",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "https://identity.example",
    });

    expect(service.revoke("refresh-token")).resolves.toBeUndefined();
    expect(requests[1]).toEqual({
      body: "client_id=deployments-cli&token=refresh-token&token_type_hint=refresh_token",
      url: "https://identity.example/oauth/revoke",
    });
  });

  test("rejects missing access tokens and invalid access-token lifetimes", async () => {
    const tokenResponses = [
      { expires_in: 3600 },
      { access_token: "", expires_in: 3600 },
      { access_token: "access-token", expires_in: 0 },
    ];
    const fetch = async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: "https://identity.example/oauth/device",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      return Response.json(tokenResponses.shift());
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "access_token",
      clientId: "client-id",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "https://identity.example",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(service.refresh("refresh-token")).rejects.toMatchObject({
        code: "device_authorization_unavailable",
        status: 503,
      });
    }
  });

  test("returns fresh ID-token bearers for legacy exchange and refresh", async () => {
    const now = Date.UTC(2026, 6, 28, 12, 0, 0);
    const idToken = (subject: string) => {
      const payload = Buffer.from(
        JSON.stringify({ exp: now / 1_000 + 900, sub: subject }),
      ).toString("base64url");
      return `header.${payload}.signature`;
    };
    const tokenResponses = [
      {
        access_token: "cognito-access-token",
        expires_in: 3600,
        id_token: idToken("exchange-user"),
        refresh_token: "refresh-token",
      },
      {
        access_token: "fresh-cognito-access-token",
        expires_in: 3600,
        id_token: idToken("refresh-user"),
        refresh_token: "rotated-refresh-token",
      },
    ];
    const fetch = async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: "https://identity.example/oauth/device",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      return Response.json(tokenResponses.shift());
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "id_token",
      clientId: "legacy-client",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "https://identity.example",
      now: () => now,
    });

    expect(service.exchange("device-code")).resolves.toEqual({
      bearerToken: idToken("exchange-user"),
      expiresIn: 900,
      refreshToken: "refresh-token",
      tokenType: "Bearer",
    });
    expect(service.refresh("refresh-token")).resolves.toEqual({
      bearerToken: idToken("refresh-user"),
      expiresIn: 900,
      refreshToken: "rotated-refresh-token",
      tokenType: "Bearer",
    });
  });

  test("fails closed when a legacy provider omits or malforms its ID token", async () => {
    const tokenResponses = [
      { access_token: "access-token", expires_in: 3600 },
      { access_token: "access-token", expires_in: 3600, id_token: "not-a-jwt" },
      {
        access_token: "access-token",
        expires_in: 3600,
        id_token: `header.${Buffer.from(JSON.stringify({ exp: "later" })).toString("base64url")}.sig`,
      },
    ];
    const fetch = async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: "https://identity.example/oauth/device",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      return Response.json(tokenResponses.shift());
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "id_token",
      clientId: "legacy-client",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "https://identity.example",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(service.refresh("refresh-token")).rejects.toMatchObject({
        code: "device_authorization_unavailable",
        status: 503,
      });
    }
  });

  test("preserves pending and slow-down protocol errors", async () => {
    const fetch = async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: "https://identity.example/oauth/device",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      return Response.json(
        { error: "authorization_pending", error_description: "Approval is pending." },
        { status: 400 },
      );
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "access_token",
      clientId: "client-id",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "https://identity.example",
    });

    expect(service.exchange("secret-device-code")).rejects.toMatchObject({
      code: "authorization_pending",
      status: 400,
    });
  });

  test("preserves definitive refresh-token rejection errors", async () => {
    const fetch = async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: "https://identity.example/oauth/device",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      return Response.json(
        { error: "invalid_grant", error_description: "The refresh token is no longer valid." },
        { status: 400 },
      );
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "access_token",
      clientId: "client-id",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "https://identity.example",
    });

    expect(service.refresh("revoked-refresh-token")).rejects.toMatchObject({
      code: "invalid_grant",
      status: 400,
    });
  });

  test("retries discovery after a transient failure", async () => {
    let discoveryCalls = 0;
    const fetch = async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith("/.well-known/openid-configuration")) {
        discoveryCalls += 1;
        if (discoveryCalls === 1) throw new Error("temporary outage");
        return Response.json({
          device_authorization_endpoint: "https://identity.example/oauth/device",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      return Response.json({
        device_code: "secret-device-code",
        expires_in: 600,
        user_code: "ABCD-EFGH",
        verification_uri: "https://identity.example/device",
      });
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "access_token",
      clientId: "client-id",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "https://identity.example",
    });

    expect(service.start()).rejects.toMatchObject({
      code: "device_authorization_unavailable",
    });
    expect(service.start()).resolves.toMatchObject({ deviceCode: "secret-device-code" });
    expect(discoveryCalls).toBe(2);
  });

  test("bounds discovery and token requests to the identity provider", async () => {
    for (const stalledRequest of [1, 2]) {
      let requests = 0;
      let stalledSignal: AbortSignal | undefined;
      const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests += 1;
        if (
          requests === 1 &&
          stalledRequest === 2 &&
          requestUrl(input).endsWith("/.well-known/openid-configuration")
        ) {
          return Promise.resolve(
            Response.json({
              device_authorization_endpoint: "https://identity.example/oauth/device",
              token_endpoint: "https://identity.example/oauth/token",
            }),
          );
        }
        stalledSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error("test timeout")), 50);
          stalledSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(fallback);
              reject(stalledSignal?.reason);
            },
            { once: true },
          );
        });
      };
      const service = createDeviceAuthorizationService({
        bearerTokenSource: "access_token",
        clientId: "client-id",
        fetch: fetch as typeof globalThis.fetch,
        issuer: "https://identity.example",
        requestTimeoutMs: 1,
      });

      expect(service.start()).rejects.toMatchObject({
        code: "device_authorization_unavailable",
        status: 503,
      });
      expect(requests).toBe(stalledRequest);
      expect(stalledSignal).toBeInstanceOf(AbortSignal);
      expect(stalledSignal?.aborted).toBeTrue();
    }
  });

  test("rejects non-loopback cleartext endpoints discovered from a local issuer", async () => {
    let remoteCalls = 0;
    const fetch = async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: "http://attacker.example/oauth/device",
          token_endpoint: "http://attacker.example/oauth/token",
        });
      }
      remoteCalls += 1;
      return Response.json({
        device_code: "secret-device-code",
        expires_in: 600,
        user_code: "ABCD-EFGH",
        verification_uri: "http://localhost/device",
      });
    };
    const service = createDeviceAuthorizationService({
      bearerTokenSource: "access_token",
      clientId: "client-id",
      fetch: fetch as typeof globalThis.fetch,
      issuer: "http://localhost:8080",
    });

    expect(service.start()).rejects.toMatchObject({
      code: "device_authorization_unavailable",
      status: 503,
    });
    expect(remoteCalls).toBe(0);
  });
});
