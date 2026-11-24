import { describe, expect, test } from "bun:test";
import type { PlatformOAuthAppConfig, PlatformOAuthTokenBundle } from "@deployments-ai/providers";

import {
  assertOAuthRefreshIdentity,
  oauthRefreshScopes,
  resolveProviderRequestHeaderReferences,
  resolveOAuthExternalIdentity,
  resolveOAuthRefreshIdentity,
  tokenWithConfiguredIdentity,
  validatedOAuthResource,
} from "./oauth-identity.ts";

function config(overrides: Partial<PlatformOAuthAppConfig> = {}): PlatformOAuthAppConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    identityBodyFormat: "form",
    identityClientAuthentication: "none",
    identityCredentialPlacement: "bearer",
    identityHeaders: {},
    identityMethod: "GET",
    identityParameterName: "access_token",
    identityParams: {},
    identityScopesRequired: false,
    identityScopeSeparator: "space",
    allowedResourceHostSuffixes: [],
    allowedResources: [],
    tokenIdentityIdPaths: [],
    ...overrides,
  } as PlatformOAuthAppConfig;
}

const token: PlatformOAuthTokenBundle = {
  accessToken: "access-token",
  scopes: ["repo"],
};

describe("OAuth provider identity", () => {
  test("resolves provider request header references from encrypted application credentials", () => {
    expect(
      resolveProviderRequestHeaderReferences(
        {
          google_ads: {
            "developer-token": "credential:googleAdsDeveloperToken",
          },
        },
        { googleAdsDeveloperToken: "developer-secret" },
      ),
    ).toEqual({ google_ads: { "developer-token": "developer-secret" } });
    expect(() =>
      resolveProviderRequestHeaderReferences(
        { google_ads: { "developer-token": "plaintext-secret" } },
        {},
      ),
    ).toThrow("must reference an encrypted credential or the OAuth client ID");
    expect(
      resolveProviderRequestHeaderReferences(
        { trustpilot: { apikey: "configured-client-id" } },
        {},
        { configured: "configured-client-id", persisted: "persisted-client-id" },
      ),
    ).toEqual({ trustpilot: { apikey: "persisted-client-id" } });
  });

  test("extracts the stable account identity from configured token response paths", () => {
    expect(
      tokenWithConfiguredIdentity(
        config({
          tokenIdentityDisplayNamePath: "account.name",
          tokenIdentityIdPaths: ["account.id"],
        }),
        { account: { id: 12345, name: "Production" } },
        token,
      ),
    ).toEqual({
      ...token,
      providerIdentityDisplayName: "Production",
      providerIdentityId: "12345",
    });
  });

  test("allows refresh responses to omit identity metadata", () => {
    expect(
      tokenWithConfiguredIdentity(
        config({ tokenIdentityIdPaths: ["account.id"] }),
        {},
        token,
        undefined,
        false,
      ),
    ).toEqual(token);
  });

  test("uses a validated resource origin as the stable account identity fallback", async () => {
    expect(
      resolveOAuthExternalIdentity({
        config: config(),
        fallbackId: "connection-id",
        fallbackName: "Shopify",
        token: { ...token, resource: "https://shop.example.myshopify.com" },
      }),
    ).resolves.toEqual({
      displayName: "Shopify",
      externalAccountId: "https://shop.example.myshopify.com",
      scopes: ["repo"],
    });
  });

  test("extracts and validates the provider resource from the token response", () => {
    expect(
      tokenWithConfiguredIdentity(
        config({
          allowedResources: ["https://example.my.salesforce.com"],
          tokenResourcePath: "instance_url",
        }),
        { instance_url: "https://example.my.salesforce.com/" },
        token,
      ),
    ).toEqual({ ...token, resource: "https://example.my.salesforce.com" });
    expect(() =>
      tokenWithConfiguredIdentity(
        config({
          allowedResources: ["https://example.my.salesforce.com"],
          tokenResourcePath: "instance_url",
        }),
        { instance_url: "https://attacker.example" },
        token,
      ),
    ).toThrow("invalid or not allowed");
    expect(() =>
      validatedOAuthResource(
        "https://attacker.example",
        config({ allowedResources: ["https://example.my.salesforce.com"] }),
      ),
    ).toThrow("invalid or not allowed");
  });

  test("resolves the stable account identity and verified scopes from the identity endpoint", async () => {
    let requestInput: string | undefined;
    let requestInit: Parameters<typeof globalThis.fetch>[1];
    const identity = await resolveOAuthExternalIdentity({
      config: config({
        identityDisplayNamePath: "profile.name",
        identityEndpoint: "https://provider.example.test/me",
        identityIdPath: "profile.id",
        identityScopesPath: "permissions",
        identityScopesRequired: true,
      }),
      fallbackId: "connection-id",
      fallbackName: "Provider",
      fetch: (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init: Parameters<typeof globalThis.fetch>[1],
      ) => {
        requestInput = input instanceof Request ? input.url : String(input);
        requestInit = init;
        return Response.json({
          permissions: ["write", "read", "write"],
          profile: { id: "account-123", name: "Production" },
        });
      }) as unknown as typeof globalThis.fetch,
      token,
    });

    expect(identity).toEqual({
      displayName: "Production",
      externalAccountId: "account-123",
      scopes: ["read", "write"],
    });
    expect(requestInput).toBe("https://provider.example.test/me");
    expect(requestInit).toEqual({
      headers: {
        accept: "application/json",
        authorization: "Bearer access-token",
      },
      method: "GET",
      redirect: "error",
    });
  });

  test("bounds successful identity responses and classifies errors before decoding", async () => {
    const identityConfig = config({
      identityEndpoint: "https://provider.example.test/me",
      identityIdPath: "profile.id",
    });
    expect(
      resolveOAuthExternalIdentity({
        config: identityConfig,
        fallbackId: "connection-id",
        fallbackName: "Provider",
        fetch: (async () => new Response("not-json", { status: 401 })) as unknown as typeof fetch,
        token,
      }),
    ).rejects.toThrow("returned HTTP 401");
    expect(
      resolveOAuthExternalIdentity({
        config: identityConfig,
        fallbackId: "connection-id",
        fallbackName: "Provider",
        fetch: (async () =>
          new Response(JSON.stringify({ profile: { id: "x".repeat(300_000) } }), {
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
        token,
      }),
    ).rejects.toThrow("maximum of 262144 bytes");
  });

  test("binds an explicitly selected account from the provider-authorized account list", async () => {
    const authorizedToken = tokenWithConfiguredIdentity(
      config({ tokenAuthorizedAccountIdsPath: "data.advertiser_ids" }),
      { data: { advertiser_ids: [123, "456"] } },
      token,
    );

    expect(authorizedToken.authorizedAccountIds).toEqual(["123", "456"]);
    expect(
      await resolveOAuthExternalIdentity({
        config: config(),
        fallbackId: "connection-id",
        fallbackName: "TikTok Ads advertiser",
        requestedExternalAccountId: "456",
        token: authorizedToken,
      }),
    ).toEqual({
      displayName: "TikTok Ads advertiser 456",
      externalAccountId: "456",
      scopes: ["repo"],
    });
    expect(
      resolveOAuthExternalIdentity({
        config: config(),
        fallbackId: "connection-id",
        fallbackName: "TikTok Ads advertiser",
        token: authorizedToken,
      }),
    ).rejects.toThrow("requestedResource is required");
  });

  test("rejects empty configured account lists and preserves them during refresh parsing", async () => {
    const accountConfig = config({ tokenAuthorizedAccountIdsPath: "data.advertiser_ids" });
    expect(() =>
      tokenWithConfiguredIdentity(accountConfig, { data: { advertiser_ids: [] } }, token),
    ).toThrow("missing configured authorized accounts");

    const refreshed = tokenWithConfiguredIdentity(
      accountConfig,
      { data: { advertiser_ids: [] } },
      token,
      undefined,
      false,
    );
    expect(refreshed.authorizedAccountIds).toEqual([]);
    expect(() => assertOAuthRefreshIdentity(refreshed, "connected-account")).toThrow(
      "no longer authorizes",
    );
    expect(
      resolveOAuthExternalIdentity({
        config: accountConfig,
        fallbackId: "connection-id",
        fallbackName: "TikTok Ads advertiser",
        token: refreshed,
      }),
    ).rejects.toThrow("did not authorize any external accounts");
  });

  test("preserves existing scopes when a refresh response omits scope", () => {
    expect(oauthRefreshScopes([], ["write", "read"], ["fallback"])).toEqual(["read", "write"]);
    expect(oauthRefreshScopes(["new"], ["old"], ["fallback"])).toEqual(["new"]);
  });

  test("rejects refresh responses bound to a different provider account", () => {
    expect(() =>
      assertOAuthRefreshIdentity(
        { ...token, providerIdentityId: "different-account" },
        "connected-account",
      ),
    ).toThrow("different provider account identity");
    expect(() =>
      assertOAuthRefreshIdentity(
        { ...token, authorizedAccountIds: ["other-account"] },
        "connected-account",
      ),
    ).toThrow("no longer authorizes the connected provider account");
  });

  test("preserves the connection identity when refresh metadata is absent or matching", () => {
    expect(() => assertOAuthRefreshIdentity(token, "connected-account")).not.toThrow();
    expect(() =>
      assertOAuthRefreshIdentity(
        {
          ...token,
          authorizedAccountIds: ["other-account", "connected-account"],
          providerIdentityId: "connected-account",
        },
        "connected-account",
      ),
    ).not.toThrow();
  });

  test("revalidates persisted identity and scopes through the provider endpoint on refresh", async () => {
    let requests = 0;
    const identityConfig = config({
      identityDisplayNamePath: "profile.name",
      identityEndpoint: "https://provider.example.test/me",
      identityIdPath: "profile.id",
      identityScopesPath: "permissions",
      identityScopesRequired: true,
    });
    const refreshed = await resolveOAuthRefreshIdentity({
      config: identityConfig,
      externalAccountId: "account-1",
      fallbackId: "connection-id",
      fallbackName: "Provider",
      fetch: (async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            permissions: ["read"],
            profile: { id: "account-1", name: "Production" },
          }),
        );
      }) as unknown as typeof globalThis.fetch,
      token: { ...token, providerIdentityId: "account-1", scopes: ["stale"] },
    });

    expect(requests).toBe(1);
    expect(refreshed).toEqual({
      displayName: "Production",
      externalAccountId: "account-1",
      scopes: ["read"],
    });
    expect(
      resolveOAuthRefreshIdentity({
        config: identityConfig,
        externalAccountId: "account-1",
        fallbackId: "connection-id",
        fallbackName: "Provider",
        fetch: (async () =>
          new Response(
            JSON.stringify({ permissions: ["read"], profile: { id: "account-2" } }),
          )) as unknown as typeof globalThis.fetch,
        token: { ...token, providerIdentityId: "account-1", scopes: ["stale"] },
      }),
    ).rejects.toThrow("different provider account identity");
  });

  test("uses the connection identity only when the provider has no identity contract", async () => {
    expect(
      await resolveOAuthExternalIdentity({
        config: config(),
        fallbackId: "connection-id",
        fallbackName: "Provider",
        token,
      }),
    ).toEqual({
      displayName: "Provider",
      externalAccountId: "connection-id",
      scopes: ["repo"],
    });
  });
});
