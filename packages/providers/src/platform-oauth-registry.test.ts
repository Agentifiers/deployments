import { describe, expect, test } from "bun:test";
import { assertPlatformOAuthAppConformance } from "./platform-oauth-conformance.ts";
import { parsePlatformOAuthAppRegistry } from "./platform-oauth-registry.ts";

const shopify = {
  authorizationEndpoint: "https://shopify.com/admin/oauth/authorize",
  authorizationIncludesResponseType: false,
  clientAuthentication: "client_secret_post",
  clientId: "shopify-client-id",
  pkce: false,
  redirectUri: "https://channels.example.test/public/provider-connections/oauth/callback/shopify",
  revocation: {
    eventType: "app/uninstalled",
    impact: "token",
    mode: "provider_event",
  },
  scopeSeparator: "comma",
  tokenEndpoint: "https://shopify.com/admin/oauth/access_token",
  tokenIncludesGrantType: false,
  tokenIncludesRedirectUri: false,
};

const microsoft = {
  authorizationEndpoint: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  clientAuthentication: "client_secret_post",
  clientId: "00000000-0000-0000-0000-000000000001",
  identityDisplayNamePath: "userPrincipalName",
  identityEndpoint: "https://graph.microsoft.com/v1.0/me",
  identityIdPath: "id",
  redirectUri: "https://channels.example.test/public/provider-connections/oauth/callback/microsoft",
  refreshTokenRequired: true,
  tokenEndpoint: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
};

function microsoftApp(overrides: Record<string, unknown> = {}) {
  return parsePlatformOAuthAppRegistry(
    JSON.stringify({ microsoft: { ...microsoft, ...overrides } }),
  ).microsoft!;
}

describe("parsePlatformOAuthAppRegistry", () => {
  test("accepts secret-free protocol config for secret-authenticated clients", () => {
    const registry = parsePlatformOAuthAppRegistry(JSON.stringify({ shopify }));
    const app = registry.shopify!;
    expect(app.clientAuthentication).toBe("client_secret_post");
    expect(app).not.toHaveProperty("clientSecret");
    expect(() => assertPlatformOAuthAppConformance("shopify", app)).not.toThrow();
  });

  test("rejects a reviewed profile that drifts from the provider protocol", () => {
    const registry = parsePlatformOAuthAppRegistry(
      JSON.stringify({ shopify: { ...shopify, pkce: true } }),
    );
    expect(() => assertPlatformOAuthAppConformance("shopify", registry.shopify!)).toThrow("pkce");
  });

  test("rejects keys without a reviewed conformance profile", () => {
    const registry = parsePlatformOAuthAppRegistry(
      JSON.stringify({
        github: {
          ...shopify,
          redirectUri:
            "https://channels.example.test/public/provider-connections/oauth/callback/github",
        },
      }),
    );
    expect(() => assertPlatformOAuthAppConformance("github", registry.github!)).toThrow(
      "has no reviewed provider conformance profile",
    );
  });

  test("rejects a client secret in protocol config", () => {
    expect(() =>
      parsePlatformOAuthAppRegistry(
        JSON.stringify({ shopify: { ...shopify, clientSecret: "real-secret" } }),
      ),
    ).toThrow("OAuth app shopify must not configure clientSecret");
  });

  test("rejects a provider event secret in protocol config", () => {
    expect(() =>
      parsePlatformOAuthAppRegistry(
        JSON.stringify({
          shopify: {
            ...shopify,
            revocation: { ...shopify.revocation, eventSecret: "real-secret" },
          },
        }),
      ),
    ).toThrow("OAuth app shopify revocation must not configure eventSecret");
  });

  test("accepts the reviewed Microsoft work-account profile and rejects unsafe variants", () => {
    expect(() => assertPlatformOAuthAppConformance("microsoft", microsoftApp())).not.toThrow();
    expect(() =>
      assertPlatformOAuthAppConformance(
        "microsoft",
        microsoftApp({
          authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        }),
      ),
    ).toThrow("OAuth app microsoft authorizationEndpoint must be");
    expect(() =>
      assertPlatformOAuthAppConformance("microsoft", microsoftApp({ refreshTokenRequired: false })),
    ).toThrow("OAuth app microsoft refreshTokenRequired must be true.");
    expect(() =>
      assertPlatformOAuthAppConformance(
        "microsoft",
        microsoftApp({ revocation: shopify.revocation }),
      ),
    ).toThrow("OAuth app microsoft must not configure revocation.");
  });
});
