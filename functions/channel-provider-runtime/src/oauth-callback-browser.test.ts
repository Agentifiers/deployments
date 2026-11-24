import { describe, expect, test } from "bun:test";
import { ProviderApplicationRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import {
  CODE_PROVIDER_DEFINITION_INPUTS,
  parsePlatformOAuthAppRegistry,
  type ProviderDefinitionInput,
} from "@deployments-ai/providers";
import { Schema } from "effect";

import { handleOAuthApi } from "./oauth-callbacks.ts";
import type { OAuthHttpResponse } from "./oauth-validation.ts";
import {
  jsonResponse,
  NOW,
  notionInput,
  oauthHarness,
  putRecord,
  RETURN_ORIGIN,
  RETURN_TO,
  SCOPE,
  seedVendorAttempt,
  STATE,
  ulid,
  type OAuthHarness,
} from "./oauth-test-support.ts";

const NOTION_ISSUER = "https://mcp.notion.example";
const GOOGLE_APPLICATION_ID = ulid(30);

function callbackEvent(provider: string, query: Readonly<Record<string, string>>) {
  return {
    pathParameters: { provider },
    queryStringParameters: query,
    requestContext: {
      http: { method: "GET", path: `/public/provider-connections/oauth/callback/${provider}` },
    },
  };
}

function expectCallbackHeaders(result: OAuthHttpResponse) {
  expect(result.headers).toMatchObject({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function expectHtmlPage(result: OAuthHttpResponse, statusCode: number) {
  expect(result.statusCode).toBe(statusCode);
  expectCallbackHeaders(result);
  expect(result.headers).not.toHaveProperty("location");
  expect(result.headers?.["content-type"]).toBe("text/html; charset=utf-8");
  const nonce =
    /^default-src 'none'; style-src 'nonce-([A-Za-z0-9+/=]+)'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'$/u.exec(
      String(result.headers?.["content-security-policy"]),
    )?.[1];
  expect(nonce).toBeDefined();
  expect(result.body).toContain(`<style nonce="${nonce}">`);
  expect(result.body).not.toContain("<script");
  return String(result.body);
}

function redirectParameters(result: OAuthHttpResponse) {
  expect(result.statusCode).toBe(303);
  expect(result.body).toBeUndefined();
  expectCallbackHeaders(result);
  const location = new URL(String(result.headers?.location));
  expect(location.origin).toBe(RETURN_ORIGIN);
  expect(location.pathname).toBe("/settings/connections");
  return Object.fromEntries(location.searchParams);
}

/** Google Search Console through the OpenTofu-configured platform_oauth registry. */
function googleHarness() {
  const searchConsole = CODE_PROVIDER_DEFINITION_INPUTS.find(
    (input) => input.key === "google_search_console",
  );
  if (!searchConsole) throw new Error("google_search_console definition is missing.");
  const harness = oauthHarness([searchConsole], {
    platformApps: parsePlatformOAuthAppRegistry(
      JSON.stringify({
        google: {
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          clientAuthentication: "client_secret_post",
          clientId: "configured-client-id",
          redirectUri:
            "https://channels.example.test/public/provider-connections/oauth/callback/google",
          refreshTokenRequired: true,
          tokenEndpoint: "https://oauth2.googleapis.com/token",
        },
      }),
    ),
  });
  const secretId = ulid(31);
  harness.vaultEntries.set(secretId, {
    document: {
      createdAt: NOW.toISOString(),
      generation: 0,
      schemaVersion: 1,
      updatedAt: NOW.toISOString(),
      values: { clientSecret: "google-secret" },
    },
    ownerId: GOOGLE_APPLICATION_ID,
    purpose: "provider-oauth-client-secret",
  });
  putRecord(
    harness,
    Schema.decodeUnknownSync(ProviderApplicationRecord)(
      withCanonicalRecordKeys({
        itemType: "provider-application" as const,
        data: {
          ...SCOPE,
          clientId: "google-client",
          clientSecretRef: { credentialId: secretId, generation: 0, store: "dynamodb-kms" },
          createdAt: NOW.toISOString(),
          displayName: "Google Search Console",
          id: GOOGLE_APPLICATION_ID,
          providerKey: "google_search_console",
          redirectUris: [],
          requestedScopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
          status: "active",
          updatedAt: NOW.toISOString(),
          version: 0,
        },
      }),
    ),
  );
  return harness;
}

function seedGoogleAttempt(harness: OAuthHarness, data: Readonly<Record<string, unknown>>) {
  seedVendorAttempt(harness, {
    oauthClientId: undefined,
    oauthClientRegistration: undefined,
    oauthIssParameterSupported: undefined,
    oauthIssuer: undefined,
    providerApplicationId: GOOGLE_APPLICATION_ID,
    providerKey: "google_search_console",
    requestedResource: undefined,
    requestedScopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    ...data,
  });
}

const googleToken = () =>
  jsonResponse({
    access_token: "google-access",
    expires_in: 3599,
    refresh_token: "google-refresh",
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    token_type: "Bearer",
  });

describe("OAuth callback: untrusted state", () => {
  const cases: readonly {
    readonly name: string;
    readonly query: Readonly<Record<string, string>>;
    readonly prepare: (harness: OAuthHarness) => void;
  }[] = [
    { name: "missing state", prepare: (harness) => seedVendorAttempt(harness, {}), query: {} },
    {
      name: "unparseable state",
      prepare: (harness) => seedVendorAttempt(harness, {}),
      query: { state: "not-a-state" },
    },
    { name: "unknown attempt", prepare: () => undefined, query: { state: STATE } },
    {
      name: "mismatched state hash",
      prepare: (harness) => seedVendorAttempt(harness, {}),
      query: { state: STATE.replace(/\.[^.]+$/u, ".forged-nonce") },
    },
    {
      name: "expired attempt",
      prepare: (harness) => {
        seedVendorAttempt(harness, {});
        harness.clock = new Date(NOW.getTime() + 11 * 60_000);
      },
      query: { state: STATE },
    },
    {
      name: "replayed attempt",
      prepare: (harness) => seedVendorAttempt(harness, { status: "completed" }),
      query: { state: STATE },
    },
  ];

  for (const { name, prepare, query } of cases) {
    test(`renders a 400 page without redirecting for a ${name}`, async () => {
      const harness = oauthHarness();
      prepare(harness);
      const result = await handleOAuthApi(
        callbackEvent("notion", {
          ...query,
          code: "auth-code",
          error: "access_denied",
          error_description: "Mallory",
          iss: NOTION_ISSUER,
        }),
        harness.dependencies,
      );
      const body = expectHtmlPage(result, 400);
      expect(body).not.toContain(RETURN_ORIGIN);
      expect(body).not.toContain("Mallory");
      expect(harness.fetches).toEqual([]);
      expect(harness.authorizations).toEqual([]);
    });
  }
});

describe("OAuth callback: vendor_mcp browser responses", () => {
  test("redirects to returnTo with the connection, preserving its query", async () => {
    const harness = oauthHarness();
    seedVendorAttempt(harness, {});
    harness.respond = async () => jsonResponse({ access_token: "access-1", token_type: "Bearer" });
    const result = await handleOAuthApi(
      callbackEvent("notion", { code: "auth-code", iss: NOTION_ISSUER, state: STATE }),
      harness.dependencies,
    );
    expect(redirectParameters(result)).toEqual({
      connection_id: ulid(40),
      provider: "notion",
      tab: "apps",
    });
    expect(result.headers?.location).toBe(`${RETURN_TO}&connection_id=${ulid(40)}&provider=notion`);
  });

  test("renders an escaped success page without returnTo", async () => {
    const acme = {
      ...notionInput,
      displayName: `Acme <img src=x> & "Co"`,
      key: "acme_docs",
      oauthProviderKey: "acme-docs",
    } satisfies ProviderDefinitionInput;
    const harness = oauthHarness([acme]);
    seedVendorAttempt(harness, { providerKey: "acme_docs", returnTo: undefined });
    harness.respond = async () => jsonResponse({ access_token: "access-1", token_type: "Bearer" });
    const result = await handleOAuthApi(
      callbackEvent("acme-docs", { code: "auth-code", iss: NOTION_ISSUER, state: STATE }),
      harness.dependencies,
    );
    const body = expectHtmlPage(result, 200);
    expect(body).toContain(
      "Connected Acme &lt;img src=x&gt; &amp; &quot;Co&quot;. You can close this window.",
    );
    expect(body).not.toContain("<img");
    expect(harness.authorizations).toHaveLength(1);
  });

  test("renders a generic 400 page for a provider error without returnTo", async () => {
    const harness = oauthHarness();
    seedVendorAttempt(harness, { returnTo: undefined });
    const result = await handleOAuthApi(
      callbackEvent("notion", {
        error: "access_denied",
        error_description: "Mallory <b>was here</b>",
        iss: NOTION_ISSUER,
        state: STATE,
      }),
      harness.dependencies,
    );
    const body = expectHtmlPage(result, 400);
    expect(body).not.toContain("Mallory");
    expect(body).not.toContain("access_denied");
  });

  test("redirects authorization_failed when the token exchange fails", async () => {
    const harness = oauthHarness();
    seedVendorAttempt(harness, {});
    harness.respond = async () =>
      jsonResponse({ error: "invalid_grant", error_description: "Mallory" }, 400);
    const result = await handleOAuthApi(
      callbackEvent("notion", { code: "auth-code", iss: NOTION_ISSUER, state: STATE }),
      harness.dependencies,
    );
    expect(redirectParameters(result)).toEqual({ error: "authorization_failed", tab: "apps" });
    expect(harness.fetches).toHaveLength(1);
    expect(harness.authorizations).toEqual([]);
  });
});

describe("OAuth callback: platform_oauth browser responses", () => {
  test("redirects to returnTo with the connection after the code exchange", async () => {
    const harness = googleHarness();
    seedGoogleAttempt(harness, {});
    harness.respond = async () => googleToken();
    const result = await handleOAuthApi(
      callbackEvent("google", { code: "auth-code", state: STATE }),
      harness.dependencies,
    );
    expect(redirectParameters(result)).toEqual({
      connection_id: ulid(40),
      provider: "google_search_console",
      tab: "apps",
    });
    expect(harness.fetches.map((fetched) => fetched.url)).toEqual([
      "https://oauth2.googleapis.com/token",
    ]);
    expect(harness.authorizations).toHaveLength(1);
  });

  test("renders a success page without returnTo", async () => {
    const harness = googleHarness();
    seedGoogleAttempt(harness, { returnTo: undefined });
    harness.respond = async () => googleToken();
    const result = await handleOAuthApi(
      callbackEvent("google", { code: "auth-code", state: STATE }),
      harness.dependencies,
    );
    expect(expectHtmlPage(result, 200)).toContain(
      "Connected Google Search Console. You can close this window.",
    );
  });

  test("forwards only access_denied, never provider text", async () => {
    const harness = googleHarness();
    seedGoogleAttempt(harness, {});
    const result = await handleOAuthApi(
      callbackEvent("google", {
        error: "access_denied",
        error_description: "Mallory",
        error_uri: "https://attacker.example/explain",
        state: STATE,
      }),
      harness.dependencies,
    );
    expect(redirectParameters(result)).toEqual({ error: "access_denied", tab: "apps" });
    expect(harness.fetches).toEqual([]);
  });

  test("redirects authorization_failed when the token exchange fails", async () => {
    const harness = googleHarness();
    seedGoogleAttempt(harness, {});
    const result = await handleOAuthApi(
      callbackEvent("google", { code: "auth-code", state: STATE }),
      harness.dependencies,
    );
    expect(redirectParameters(result)).toEqual({ error: "authorization_failed", tab: "apps" });
    expect(harness.authorizations).toEqual([]);
  });

  test("redirects authorization_failed when the callback provider does not match", async () => {
    const harness = googleHarness();
    seedGoogleAttempt(harness, {});
    const result = await handleOAuthApi(
      callbackEvent("github", { code: "auth-code", state: STATE }),
      harness.dependencies,
    );
    expect(redirectParameters(result)).toEqual({ error: "authorization_failed", tab: "apps" });
    expect(harness.fetches).toEqual([]);
  });
});
